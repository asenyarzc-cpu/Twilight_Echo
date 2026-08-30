#include "output/asio/abi/AsioAbi.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <vector>

namespace twilight::audio::asio_abi {
namespace {

std::atomic<long> liveDrivers = 0;

enum class IoFormatMode : int {
  Supported,
  UnsupportedDsd,
  ReportPcmAfterDsdSet,
  FailAfterDsdSet,
  GetIoFormatUnsupported,
  // Models drivers whose valid buffer-size range changes once the DSD I/O
  // format is active (observed in the field: createBuffers rejects PCM-mode
  // sizes with ASE_InvalidParameter after the DSD switch).
  DsdBufferSizeRange
};

class FakeAsioDriver final : public AsioDriver {
 public:
  explicit FakeAsioDriver(IoFormatMode ioFormatMode) : ioFormatMode_(ioFormatMode) {
    liveDrivers.fetch_add(1, std::memory_order_relaxed);
  }

  ~FakeAsioDriver() {
    liveDrivers.fetch_sub(1, std::memory_order_relaxed);
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (iid != IID_IUnknown) return E_NOINTERFACE;
    *object = static_cast<IUnknown*>(this);
    AddRef();
    return S_OK;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return ++references_;
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG references = --references_;
    if (references == 0) delete this;
    return references;
  }

  AsioBool init(void* systemReference) override {
    initialized_ = systemReference != nullptr;
    return initialized_ ? kAsioTrue : kAsioFalse;
  }

  void getDriverName(char* name) override {
    copyText(name, 32, "Twilight fake ABI driver");
  }

  int32_t getDriverVersion() override {
    return 1;
  }

  void getErrorMessage(char* message) override {
    copyText(message, 124, "fake driver error");
  }

  AsioError start() override {
    if (!initialized_ || !buffersCreated_) return -1;
    started_ = true;
    if (callbacks_.bufferSwitch) callbacks_.bufferSwitch(0, kAsioTrue);
    if (callbacks_.sampleRateDidChange) callbacks_.sampleRateDidChange(sampleRate_);
    if (callbacks_.asioMessage) {
      double option = 0;
      callbacks_.asioMessage(kSelectorEngineVersion, 0, nullptr, &option);
      callbacks_.asioMessage(kSelectorResetRequest, 0, nullptr, &option);
    }
    if (callbacks_.bufferSwitchTimeInfo) {
      AsioTime time{};
      callbacks_.bufferSwitchTimeInfo(&time, 1, kAsioTrue);
    }
    return kAsioOk;
  }

  AsioError stop() override {
    started_ = false;
    return kAsioOk;
  }

  AsioError getChannels(int32_t* inputChannels, int32_t* outputChannels) override {
    if (!inputChannels || !outputChannels) return -1;
    *inputChannels = 0;
    *outputChannels = 2;
    return kAsioOk;
  }

  AsioError getLatencies(int32_t* inputLatency, int32_t* outputLatency) override {
    if (!inputLatency || !outputLatency) return -1;
    *inputLatency = 0;
    *outputLatency = 32;
    return kAsioOk;
  }

  AsioError getBufferSize(int32_t* minimum, int32_t* maximum, int32_t* preferred, int32_t* granularity) override {
    if (!minimum || !maximum || !preferred || !granularity) return -1;
    if (usesDsdBufferRange()) {
      *minimum = 256;
      *maximum = 2048;
      *preferred = 1024;
      *granularity = 0;
      return kAsioOk;
    }
    *minimum = 64;
    *maximum = 256;
    *preferred = 128;
    *granularity = -1;
    return kAsioOk;
  }

  AsioError canSampleRate(AsioSampleRate sampleRate) override {
    if (ioFormat_ == kAsioIoFormatDsd) {
      return sampleRate == 2822400.0 || sampleRate == 22579200.0 ? kAsioOk : -1;
    }
    return sampleRate == 48000.0 ? kAsioOk : -1;
  }

  AsioError getSampleRate(AsioSampleRate* sampleRate) override {
    if (!sampleRate) return -1;
    *sampleRate = sampleRate_;
    return kAsioOk;
  }

  AsioError setSampleRate(AsioSampleRate sampleRate) override {
    if (canSampleRate(sampleRate) != kAsioOk) return -1;
    sampleRate_ = sampleRate;
    return kAsioOk;
  }

  AsioError getClockSources(AsioClockSource* clocks, int32_t* count) override {
    if (!count || *count < 1 || !clocks) return -1;
    clocks[0] = {};
    clocks[0].index = 0;
    clocks[0].isCurrentSource = kAsioTrue;
    copyText(clocks[0].name, sizeof(clocks[0].name), "Fake clock");
    *count = 1;
    return kAsioOk;
  }

  AsioError setClockSource(int32_t reference) override {
    return reference == 0 ? kAsioOk : -1;
  }

  AsioError getSamplePosition(AsioSamples* samplePosition, AsioTimeStamp* systemTime) override {
    if (!samplePosition || !systemTime) return -1;
    *samplePosition = 128;
    *systemTime = 256;
    return kAsioOk;
  }

  AsioError getChannelInfo(AsioChannelInfo* channelInfo) override {
    if (!channelInfo || channelInfo->isInput != kAsioFalse || channelInfo->channel < 0 || channelInfo->channel >= 2) {
      return -1;
    }
    channelInfo->isActive = kAsioTrue;
    channelInfo->channelGroup = 0;
    channelInfo->type = ioFormat_ == kAsioIoFormatDsd ? kAsioSampleDsdInt8Lsb1 : kAsioSampleFloat32Lsb;
    copyText(channelInfo->name, sizeof(channelInfo->name), "Fake output");
    return kAsioOk;
  }

  AsioError createBuffers(
      AsioBufferInfo* bufferInfos,
      int32_t count,
      int32_t bufferSize,
      AsioCallbacks* callbacks) override {
    if (!bufferInfos || !callbacks || count != 2) return -1;
    if (bufferSize < (usesDsdBufferRange() ? 256 : 64) ||
        bufferSize > (usesDsdBufferRange() ? 2048 : 256)) {
      return -1;
    }
    callbacks_ = *callbacks;
    for (int32_t channel = 0; channel < count; ++channel) {
      if (bufferInfos[channel].isInput != kAsioFalse || bufferInfos[channel].channelNum != channel) return -1;
      for (int32_t index = 0; index < 2; ++index) {
        const size_t bytesPerSample = ioFormat_ == kAsioIoFormatDsd ? 1 : sizeof(float);
        buffers_[static_cast<size_t>(channel * 2 + index)].assign(static_cast<size_t>(bufferSize) * bytesPerSample, 0);
        bufferInfos[channel].buffers[index] = buffers_[static_cast<size_t>(channel * 2 + index)].data();
      }
    }
    buffersCreated_ = true;
    return kAsioOk;
  }

  AsioError disposeBuffers() override {
    buffersCreated_ = false;
    for (auto& buffer : buffers_) buffer.clear();
    callbacks_ = {};
    return kAsioOk;
  }

  AsioError controlPanel() override {
    return kAsioOk;
  }

  AsioError future(int32_t selector, void* option) override {
    if (!option) return -1;
    auto* format = static_cast<AsioIoFormat*>(option);
    if (!isValidIoFormatRequest(*format)) return -1;
    switch (selector) {
      case kFutureCanDoIoFormat:
        return isSupportedIoFormat(format->formatType) ? kAsioOk : -1;
      case kFutureGetIoFormat:
        if (ioFormatMode_ == IoFormatMode::GetIoFormatUnsupported) return -1;
        format->formatType = ioFormat_;
        return kAsioOk;
      case kFutureSetIoFormat:
        if (!isSupportedIoFormat(format->formatType)) return -1;
        if (format->formatType == kAsioIoFormatDsd && ioFormatMode_ == IoFormatMode::ReportPcmAfterDsdSet) {
          return kAsioOk;
        }
        ioFormat_ = format->formatType;
        if (format->formatType == kAsioIoFormatDsd && ioFormatMode_ == IoFormatMode::FailAfterDsdSet) return -1;
        return kAsioOk;
      default:
        return -1;
    }
  }

  AsioError outputReady() override {
    return started_ ? kAsioOk : -1;
  }

 private:
  bool usesDsdBufferRange() const {
    return ioFormatMode_ == IoFormatMode::DsdBufferSizeRange && ioFormat_ == kAsioIoFormatDsd;
  }

  bool isSupportedIoFormat(AsioIoFormatType format) const {
    return format == kAsioIoFormatPcm ||
           (format == kAsioIoFormatDsd && ioFormatMode_ != IoFormatMode::UnsupportedDsd);
  }

  static bool isValidIoFormatRequest(const AsioIoFormat& format) {
    return std::all_of(
        std::begin(format.reserved), std::end(format.reserved), [](uint8_t value) { return value == 0; });
  }

  static void copyText(char* destination, size_t size, const char* source) {
    if (!destination || size == 0) return;
    std::snprintf(destination, size, "%s", source);
  }

  std::atomic<ULONG> references_ = 1;
  std::array<std::vector<uint8_t>, 4> buffers_;
  AsioCallbacks callbacks_{};
  AsioSampleRate sampleRate_ = 48000.0;
  AsioIoFormatType ioFormat_ = kAsioIoFormatPcm;
  IoFormatMode ioFormatMode_ = IoFormatMode::Supported;
  bool initialized_ = false;
  bool buffersCreated_ = false;
  bool started_ = false;
};

}  // namespace

AsioDriver* createFakeDriver(IoFormatMode ioFormatMode = IoFormatMode::Supported) {
  return new FakeAsioDriver(ioFormatMode);
}

long fakeLiveDriverCount() {
  return liveDrivers.load(std::memory_order_relaxed);
}

}  // namespace twilight::audio::asio_abi

extern "C" __declspec(dllexport) twilight::audio::asio_abi::AsioDriver* TwilightCreateFakeAsioDriver() {
  return twilight::audio::asio_abi::createFakeDriver();
}

extern "C" __declspec(dllexport) twilight::audio::asio_abi::AsioDriver* TwilightCreateFakeAsioDriverWithIoFormatMode(
    int mode) {
  using twilight::audio::asio_abi::IoFormatMode;
  switch (mode) {
    case static_cast<int>(IoFormatMode::UnsupportedDsd):
      return twilight::audio::asio_abi::createFakeDriver(IoFormatMode::UnsupportedDsd);
    case static_cast<int>(IoFormatMode::ReportPcmAfterDsdSet):
      return twilight::audio::asio_abi::createFakeDriver(IoFormatMode::ReportPcmAfterDsdSet);
    case static_cast<int>(IoFormatMode::FailAfterDsdSet):
      return twilight::audio::asio_abi::createFakeDriver(IoFormatMode::FailAfterDsdSet);
    case static_cast<int>(IoFormatMode::GetIoFormatUnsupported):
      return twilight::audio::asio_abi::createFakeDriver(IoFormatMode::GetIoFormatUnsupported);
    case static_cast<int>(IoFormatMode::DsdBufferSizeRange):
      return twilight::audio::asio_abi::createFakeDriver(IoFormatMode::DsdBufferSizeRange);
    default:
      return twilight::audio::asio_abi::createFakeDriver();
  }
}

extern "C" __declspec(dllexport) int TwilightFakeAsioAbiContractVersion() {
  return twilight::audio::asio_abi::kAsioAbiContractVersion;
}

extern "C" __declspec(dllexport) long TwilightFakeAsioLiveDriverCount() {
  return twilight::audio::asio_abi::fakeLiveDriverCount();
}
