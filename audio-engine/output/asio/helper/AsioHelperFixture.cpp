#include "AsioHelperServer.h"

#include <Windows.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

namespace twilight::audio::asio_helper {
namespace {

std::string fixtureMode() {
  std::array<char, 128> value{};
  const DWORD length = GetEnvironmentVariableA(
      "TAE_ASIO_HELPER_FIXTURE_MODE", value.data(), static_cast<DWORD>(value.size()));
  return length > 0 && length < value.size() ? std::string(value.data(), length) : "normal";
}

class FixtureHost final : public IAsioHost {
 public:
  explicit FixtureHost(std::string mode) : mode_(std::move(mode)) {}

  ~FixtureHost() override {
    close();
  }

  std::vector<AsioDeviceInfo> enumerateDevices() override {
    return {deviceInfo()};
  }

  AsioHostDiagnostics diagnostics() const override {
    AsioHostDiagnostics result;
    result.processArchitecture = "x64";
    result.buildEnabled = true;
    result.registeredDriverCount64 = 1;
    result.loadableDriverCount64 = 1;
    return result;
  }

  bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) override {
    if (deviceId != "asio:fixture" || !info) {
      if (error) *error = "fixture device was not found";
      return false;
    }
    *info = deviceInfo();
    return true;
  }

  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) override {
    if (mode_ == "open-restore-failure") {
      closeError_ = "fixture failed to restore format during open";
      if (result) result->failureKind = AsioOpenFailureKind::Format;
      if (error) *error = "fixture rejected the open after changing format";
      return false;
    }
    if (mode_ == "device-reject") {
      if (result) result->failureKind = AsioOpenFailureKind::Driver;
      if (error) *error = "fixture rejected the device";
      return false;
    }
    if (config.deviceId != "asio:fixture" || config.format.channelCount != 2 ||
        config.format.sampleRate <= 0) {
      if (result) result->failureKind = AsioOpenFailureKind::Format;
      if (error) *error = "fixture rejected the open format";
      return false;
    }
    opened_ = true;
    closeError_.clear();
    if (result) {
      result->actualFormat = config.format;
      result->bufferSizeFrames = kFrames;
      result->latencyFrames = kFrames;
      result->driverName = "Twilight ASIO fixture";
      result->driverVersion = 1;
      result->failureKind = AsioOpenFailureKind::None;
    }
    return true;
  }

  bool createBuffers(
      AsioBufferSwitchCallback bufferSwitch,
      AsioEventCallback eventCallback,
      std::string* error) override {
    if (!opened_) {
      if (error) *error = "fixture session is not open";
      return false;
    }
    bufferSwitch_ = std::move(bufferSwitch);
    eventCallback_ = std::move(eventCallback);
    buffersCreated_ = true;
    outputReadyCalls_.store(0, std::memory_order_release);
    for (auto& channel : buffers_) {
      for (auto& buffer : channel) buffer.fill(0);
    }
    return true;
  }

  bool start(std::string* error) override {
    if (!buffersCreated_ || started_.exchange(true, std::memory_order_acq_rel)) {
      if (error) *error = "fixture buffers are not ready";
      return false;
    }
    callbackThread_ = std::thread([this] {
      if (mode_ == "callback-backlog") {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        for (int callbackCount = 0; callbackCount < 3; ++callbackCount) {
          if (bufferSwitch_) bufferSwitch_(0);
        }
        return;
      }
      long bufferIndex = 0;
      int callbackCount = 0;
      while (started_.load(std::memory_order_acquire)) {
        if (mode_ == "callback-stop" && callbackCount >= 4) return;
        if (mode_ == "delayed-callback" && callbackCount == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }
        if (bufferSwitch_) bufferSwitch_(bufferIndex);
        bufferIndex = 1 - bufferIndex;
        ++callbackCount;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    });
    return true;
  }

  void stop() override {
    started_.store(false, std::memory_order_release);
    if (callbackThread_.joinable()) callbackThread_.join();
  }

  void close() override {
    stop();
    const bool hadSession = opened_;
    buffersCreated_ = false;
    opened_ = false;
    bufferSwitch_ = nullptr;
    eventCallback_ = nullptr;
    closeError_ = mode_ == "restore-failure" && hadSession
        ? "fixture failed to restore the retained PCM format"
        : "";
  }

  void* outputBuffer(long channel, long bufferIndex) override {
    if (channel < 0 || channel >= 2 || bufferIndex < 0 || bufferIndex > 1) return nullptr;
    return buffers_[static_cast<size_t>(channel)][static_cast<size_t>(bufferIndex)].data();
  }

  AudioSampleFormat outputSampleFormat(long) const override {
    return AudioSampleFormat::Float32Interleaved;
  }

  AsioChannelFormat outputChannelFormat(long) const override {
    return {};
  }

  bool outputReady() override {
    const int calls = outputReadyCalls_.fetch_add(1, std::memory_order_acq_rel) + 1;
    if (mode_ == "output-ready-false") {
      if (calls > 1 && eventCallback_) {
        eventCallback_(AsioHostEvent::Xrun, "fixture outputReady was called again");
      }
      return false;
    }
    return started_.load(std::memory_order_acquire);
  }

  long activeBufferSize() const override {
    return kFrames;
  }

  std::string lastCloseError() const override {
    return closeError_;
  }

 private:
  static constexpr long kFrames = 64;

  static AsioDeviceInfo deviceInfo() {
    AsioDeviceInfo info;
    info.id = "asio:fixture";
    info.name = "Twilight ASIO fixture";
    info.driverName = info.name;
    info.driverVersion = 1;
    info.outputChannels = 2;
    info.supportedSampleRates = {44100, 48000, 96000};
    info.bitDepths = {32};
    info.sampleFormats = {AudioSampleFormat::Float32Interleaved};
    info.defaultSampleRate = 48000;
    info.defaultBitDepth = 32;
    info.defaultSampleFormat = AudioSampleFormat::Float32Interleaved;
    info.minBufferSize = kFrames;
    info.maxBufferSize = kFrames;
    info.preferredBufferSize = kFrames;
    info.outputLatencyFrames = kFrames;
    info.capabilityProbed = true;
    return info;
  }

  std::string mode_;
  std::string closeError_;
  AsioBufferSwitchCallback bufferSwitch_;
  AsioEventCallback eventCallback_;
  std::array<std::array<std::array<uint8_t, kFrames * sizeof(float)>, 2>, 2> buffers_{};
  std::thread callbackThread_;
  std::atomic<bool> started_{false};
  std::atomic<int> outputReadyCalls_{0};
  bool opened_ = false;
  bool buffersCreated_ = false;
};

struct Arguments {
  std::wstring mapping;
  std::wstring requestEvent;
  std::wstring responseEvent;
};

bool parseArguments(int argc, wchar_t* argv[], Arguments* result) {
  if (!result || argc != 8 || std::wstring_view(argv[1]) != L"--serve") return false;
  for (int index = 2; index < argc; index += 2) {
    const std::wstring_view key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--shared-memory") result->mapping = value;
    else if (key == L"--request-event") result->requestEvent = value;
    else if (key == L"--response-event") result->responseEvent = value;
    else return false;
  }
  return !result->mapping.empty() && !result->requestEvent.empty() &&
      !result->responseEvent.empty();
}

}  // namespace
}  // namespace twilight::audio::asio_helper

int wmain(int argc, wchar_t* argv[]) {
  using namespace twilight::audio;
  using namespace twilight::audio::asio_helper;
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") {
    std::cout << "{\"kind\":\"twilight-asio-helper-fixture\",\"status\":\"ready\"}";
    return 0;
  }
  Arguments arguments;
  if (!parseArguments(argc, argv, &arguments)) return 64;
  const std::string mode = fixtureMode();
  AsioHelperServerOptions options;
  options.beforeCommand = [mode](Command command) {
    if (command == Command::GetDiagnostics) {
      if (mode == "control-timeout") Sleep(10000);
      if (mode == "abnormal-exit") TerminateProcess(GetCurrentProcess(), 91);
    }
    if (command == Command::Stop && mode == "stop-timeout") Sleep(10000);
  };
  return runAsioHelperServer(
      arguments.mapping,
      arguments.requestEvent,
      arguments.responseEvent,
      std::make_unique<FixtureHost>(mode),
      std::move(options));
}
