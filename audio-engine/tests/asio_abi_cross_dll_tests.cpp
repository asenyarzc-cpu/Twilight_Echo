#include "../output/asio/abi/AsioAbi.h"

#include <Windows.h>

#include <array>
#include <cstdlib>
#include <iostream>
#include <string>

using namespace twilight::audio::asio_abi;

namespace {

using CreateDriver = AsioDriver* (*)();
using CreateDriverWithIoFormatMode = AsioDriver* (*)(int);
using ContractVersion = int (*)();
using LiveDriverCount = long (*)();

struct CallbackState {
  int bufferSwitches = 0;
  int rateChanges = 0;
  AsioSampleRate latestSampleRate = 0;
  int engineVersionMessages = 0;
  int resetMessages = 0;
  int timeInfoSwitches = 0;
};

CallbackState callbackState;

void onBufferSwitch(int32_t bufferIndex, AsioBool processNow) {
  if (bufferIndex == 0 && processNow == kAsioTrue) ++callbackState.bufferSwitches;
}

void onSampleRateChanged(AsioSampleRate sampleRate) {
  ++callbackState.rateChanges;
  callbackState.latestSampleRate = sampleRate;
}

int32_t onMessage(int32_t selector, int32_t, void*, double*) {
  if (selector == kSelectorEngineVersion) ++callbackState.engineVersionMessages;
  if (selector == kSelectorResetRequest) ++callbackState.resetMessages;
  return kAsioTrue;
}

AsioTime* onBufferSwitchTimeInfo(AsioTime* time, int32_t bufferIndex, AsioBool processNow) {
  if (time && bufferIndex == 1 && processNow == kAsioTrue) ++callbackState.timeInfoSwitches;
  return time;
}

std::wstring widePath(const char* value) {
  if (!value || !*value) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
  if (size <= 1) return {};
  std::wstring result(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value, -1, result.data(), size);
  result.pop_back();
  return result;
}

bool expect(bool condition, const char* message) {
  if (condition) return true;
  std::cerr << "ASIO cross-DLL ABI check failed: " << message << '\n';
  return false;
}

}  // namespace

int main() {
  const char* fixturePath = std::getenv("TAE_ASIO_FAKE_DRIVER_PATH");
  if (!fixturePath || !*fixturePath) {
    std::cout << "ASIO cross-DLL fixture not configured\n";
    return 77;
  }

  const std::wstring path = widePath(fixturePath);
  HMODULE module = path.empty() ? nullptr : LoadLibraryW(path.c_str());
  if (!expect(module != nullptr, "fixture DLL could not be loaded")) return 1;

  const auto create = reinterpret_cast<CreateDriver>(GetProcAddress(module, "TwilightCreateFakeAsioDriver"));
  const auto createWithIoFormatMode = reinterpret_cast<CreateDriverWithIoFormatMode>(
      GetProcAddress(module, "TwilightCreateFakeAsioDriverWithIoFormatMode"));
  const auto contractVersion =
      reinterpret_cast<ContractVersion>(GetProcAddress(module, "TwilightFakeAsioAbiContractVersion"));
  const auto liveDriverCount =
      reinterpret_cast<LiveDriverCount>(GetProcAddress(module, "TwilightFakeAsioLiveDriverCount"));
  if (!expect(create && createWithIoFormatMode && contractVersion && liveDriverCount, "fixture exports are incomplete") ||
      !expect(contractVersion() == kAsioAbiContractVersion, "fixture contract version differs")) {
    FreeLibrary(module);
    return 1;
  }

  AsioDriver* driver = create();
  if (!expect(driver != nullptr, "fixture did not create a driver") ||
      !expect(liveDriverCount() == 1, "fixture driver lifetime was not recorded")) {
    FreeLibrary(module);
    return 1;
  }

  bool passed = true;
  void* unknown = nullptr;
  passed &= expect(driver->QueryInterface(IID_IUnknown, &unknown) == S_OK && unknown != nullptr, "IUnknown round trip failed");
  if (unknown) static_cast<IUnknown*>(unknown)->Release();

  int systemReference = 1;
  passed &= expect(driver->init(&systemReference) == kAsioTrue, "init failed");
  std::array<char, 32> name{};
  driver->getDriverName(name.data());
  passed &= expect(std::string(name.data()) == "Twilight fake ABI driver", "driver name differs");
  passed &= expect(driver->getDriverVersion() == 1, "driver version differs");
  std::array<char, 124> error{};
  driver->getErrorMessage(error.data());
  passed &= expect(std::string(error.data()) == "fake driver error", "driver error message differs");

  int32_t inputChannels = -1;
  int32_t outputChannels = -1;
  passed &= expect(driver->getChannels(&inputChannels, &outputChannels) == kAsioOk && inputChannels == 0 && outputChannels == 2, "channel query differs");
  int32_t inputLatency = -1;
  int32_t outputLatency = -1;
  passed &= expect(driver->getLatencies(&inputLatency, &outputLatency) == kAsioOk && inputLatency == 0 && outputLatency == 32, "latency query differs");
  int32_t minimum = 0;
  int32_t maximum = 0;
  int32_t preferred = 0;
  int32_t granularity = 0;
  passed &= expect(
      driver->getBufferSize(&minimum, &maximum, &preferred, &granularity) == kAsioOk && minimum == 64 && maximum == 256 &&
          preferred == 128 && granularity == -1,
      "buffer-size query differs");
  passed &= expect(driver->canSampleRate(48000.0) == kAsioOk, "supported sample rate was rejected");
  passed &= expect(driver->canSampleRate(44100.0) != kAsioOk, "unsupported sample rate was accepted");
  passed &= expect(driver->setSampleRate(48000.0) == kAsioOk, "sample-rate set failed");
  AsioSampleRate sampleRate = 0;
  passed &= expect(driver->getSampleRate(&sampleRate) == kAsioOk && sampleRate == 48000.0, "sample-rate query differs");

  AsioIoFormat originalIoFormat{};
  passed &= expect(
      driver->future(kFutureGetIoFormat, &originalIoFormat) == kAsioOk &&
          originalIoFormat.formatType == kAsioIoFormatPcm,
      "initial PCM I/O format query differs");
  AsioIoFormat invalidIoFormat{};
  invalidIoFormat.formatType = 99;
  passed &= expect(
      driver->future(kFutureCanDoIoFormat, &invalidIoFormat) != kAsioOk &&
          driver->future(kFutureSetIoFormat, &invalidIoFormat) != kAsioOk,
      "unsupported I/O format was accepted");
  AsioIoFormat dsdIoFormat{};
  dsdIoFormat.formatType = kAsioIoFormatDsd;
  passed &= expect(driver->future(kFutureCanDoIoFormat, &dsdIoFormat) == kAsioOk, "Native DSD I/O format was rejected");
  passed &= expect(driver->future(kFutureSetIoFormat, &dsdIoFormat) == kAsioOk, "Native DSD I/O format set failed");
  AsioIoFormat activeIoFormat{};
  passed &= expect(
      driver->future(kFutureGetIoFormat, &activeIoFormat) == kAsioOk &&
          activeIoFormat.formatType == kAsioIoFormatDsd,
      "Native DSD I/O format verification differs");
  passed &= expect(driver->canSampleRate(2822400.0) == kAsioOk, "DSD64 semantic rate was rejected");
  passed &= expect(driver->setSampleRate(2822400.0) == kAsioOk, "DSD64 semantic rate set failed");
  passed &= expect(
      driver->getSampleRate(&sampleRate) == kAsioOk && sampleRate == 2822400.0,
      "DSD64 semantic rate differs");
  passed &= expect(driver->canSampleRate(22579200.0) == kAsioOk, "DSD512 semantic rate was rejected");
  passed &= expect(driver->setSampleRate(22579200.0) == kAsioOk, "DSD512 semantic rate set failed");
  passed &= expect(
      driver->getSampleRate(&sampleRate) == kAsioOk && sampleRate == 22579200.0,
      "DSD512 semantic rate differs");

  std::array<AsioClockSource, 1> clocks{};
  int32_t clockCount = static_cast<int32_t>(clocks.size());
  passed &= expect(
      driver->getClockSources(clocks.data(), &clockCount) == kAsioOk && clockCount == 1 && clocks[0].index == 0,
      "clock-source query differs");
  passed &= expect(driver->setClockSource(0) == kAsioOk, "clock-source selection failed");
  AsioSamples samplePosition = 0;
  AsioTimeStamp systemTime = 0;
  passed &= expect(
      driver->getSamplePosition(&samplePosition, &systemTime) == kAsioOk && samplePosition == 128 && systemTime == 256,
      "sample-position query differs");

  AsioChannelInfo channel{};
  channel.channel = 0;
  channel.isInput = kAsioFalse;
  passed &= expect(
      driver->getChannelInfo(&channel) == kAsioOk && channel.type == kAsioSampleDsdInt8Lsb1,
      "Native DSD channel-info query differs");

  std::array<AsioBufferInfo, 2> buffers{};
  for (int32_t channelIndex = 0; channelIndex < static_cast<int32_t>(buffers.size()); ++channelIndex) {
    buffers[static_cast<size_t>(channelIndex)].isInput = kAsioFalse;
    buffers[static_cast<size_t>(channelIndex)].channelNum = channelIndex;
  }
  AsioCallbacks callbacks{
      .bufferSwitch = onBufferSwitch,
      .sampleRateDidChange = onSampleRateChanged,
      .asioMessage = onMessage,
      .bufferSwitchTimeInfo = onBufferSwitchTimeInfo};
  passed &= expect(driver->createBuffers(buffers.data(), static_cast<int32_t>(buffers.size()), 128, &callbacks) == kAsioOk, "create-buffers failed");
  passed &= expect(buffers[0].buffers[0] && buffers[0].buffers[1] && buffers[1].buffers[0] && buffers[1].buffers[1], "driver did not supply both buffer pairs");
  passed &= expect(driver->start() == kAsioOk, "start failed");
  passed &= expect(
      callbackState.bufferSwitches == 1 && callbackState.rateChanges == 1 && callbackState.latestSampleRate == 22579200.0 &&
          callbackState.engineVersionMessages == 1 &&
          callbackState.resetMessages == 1 && callbackState.timeInfoSwitches == 1,
      "callbacks did not cross the DLL boundary");
  passed &= expect(driver->outputReady() == kAsioOk, "output-ready failed");
  passed &= expect(driver->stop() == kAsioOk, "stop failed");
  passed &= expect(driver->disposeBuffers() == kAsioOk, "dispose-buffers failed");
  passed &= expect(driver->future(kFutureSetIoFormat, &originalIoFormat) == kAsioOk, "PCM I/O format restore failed");
  passed &= expect(driver->setSampleRate(48000.0) == kAsioOk, "PCM sample-rate restore failed");
  AsioIoFormat restoredIoFormat{};
  passed &= expect(
      driver->future(kFutureGetIoFormat, &restoredIoFormat) == kAsioOk &&
          restoredIoFormat.formatType == kAsioIoFormatPcm,
      "PCM I/O format was not restored");
  passed &= expect(driver->getSampleRate(&sampleRate) == kAsioOk && sampleRate == 48000.0, "PCM sample rate was not restored");
  channel = {};
  channel.channel = 0;
  channel.isInput = kAsioFalse;
  passed &= expect(
      driver->getChannelInfo(&channel) == kAsioOk && channel.type == kAsioSampleFloat32Lsb,
      "PCM channel-info was not restored");
  passed &= expect(driver->controlPanel() == kAsioOk, "control-panel call failed");

  driver->Release();
  passed &= expect(liveDriverCount() == 0, "driver was not released");

  int failureSystemReference = 1;
  AsioIoFormat failureDsdIoFormat{};
  failureDsdIoFormat.formatType = kAsioIoFormatDsd;

  AsioDriver* unsupportedDriver = createWithIoFormatMode(1);
  passed &= expect(unsupportedDriver != nullptr, "unsupported-format fixture did not create a driver");
  if (unsupportedDriver) {
    passed &= expect(unsupportedDriver->init(&failureSystemReference) == kAsioTrue, "unsupported-format fixture init failed");
    passed &= expect(
        unsupportedDriver->future(kFutureCanDoIoFormat, &failureDsdIoFormat) != kAsioOk,
        "unsupported-format fixture accepted Native DSD");
    unsupportedDriver->Release();
    passed &= expect(liveDriverCount() == 0, "unsupported-format fixture was not released");
  }

  AsioDriver* mismatchDriver = createWithIoFormatMode(2);
  passed &= expect(mismatchDriver != nullptr, "format-mismatch fixture did not create a driver");
  if (mismatchDriver) {
    AsioIoFormat original{};
    AsioIoFormat reported{};
    passed &= expect(mismatchDriver->init(&failureSystemReference) == kAsioTrue, "format-mismatch fixture init failed");
    passed &= expect(
        mismatchDriver->future(kFutureGetIoFormat, &original) == kAsioOk && original.formatType == kAsioIoFormatPcm,
        "format-mismatch fixture initial PCM query differs");
    passed &= expect(
        mismatchDriver->future(kFutureCanDoIoFormat, &failureDsdIoFormat) == kAsioOk &&
            mismatchDriver->future(kFutureSetIoFormat, &failureDsdIoFormat) == kAsioOk &&
            mismatchDriver->future(kFutureGetIoFormat, &reported) == kAsioOk &&
            reported.formatType == kAsioIoFormatPcm,
        "format-mismatch fixture did not report PCM after the DSD switch");
    passed &= expect(
        mismatchDriver->future(kFutureSetIoFormat, &original) == kAsioOk,
        "format-mismatch fixture PCM restore failed");
    mismatchDriver->Release();
    passed &= expect(liveDriverCount() == 0, "format-mismatch fixture was not released");
  }

  AsioDriver* failedSetDriver = createWithIoFormatMode(3);
  passed &= expect(failedSetDriver != nullptr, "set-failure fixture did not create a driver");
  if (failedSetDriver) {
    AsioIoFormat original{};
    AsioIoFormat reported{};
    passed &= expect(failedSetDriver->init(&failureSystemReference) == kAsioTrue, "set-failure fixture init failed");
    passed &= expect(
        failedSetDriver->future(kFutureGetIoFormat, &original) == kAsioOk && original.formatType == kAsioIoFormatPcm,
        "set-failure fixture initial PCM query differs");
    passed &= expect(
        failedSetDriver->future(kFutureSetIoFormat, &failureDsdIoFormat) != kAsioOk &&
            failedSetDriver->future(kFutureGetIoFormat, &reported) == kAsioOk &&
            reported.formatType == kAsioIoFormatDsd,
        "set-failure fixture did not leave the simulated partial DSD state");
    passed &= expect(
        failedSetDriver->future(kFutureSetIoFormat, &original) == kAsioOk,
        "set-failure fixture PCM cleanup failed");
    reported = {};
    passed &= expect(
        failedSetDriver->future(kFutureGetIoFormat, &reported) == kAsioOk &&
            reported.formatType == kAsioIoFormatPcm,
        "set-failure fixture PCM cleanup was not verified");
    failedSetDriver->Release();
    passed &= expect(liveDriverCount() == 0, "set-failure fixture was not released");
  }

  // Some real drivers omit GetIoFormat while still accepting the complete
  // Native DSD negotiation. The optional probe must not be treated as a
  // capability failure when CanDo/Set, channel type, and semantic rate work.
  AsioDriver* getUnsupportedDriver = createWithIoFormatMode(4);
  passed &= expect(getUnsupportedDriver != nullptr, "get-format-unsupported fixture did not create a driver");
  if (getUnsupportedDriver) {
    AsioIoFormat reported{};
    AsioChannelInfo dsdChannel{};
    dsdChannel.channel = 0;
    dsdChannel.isInput = kAsioFalse;
    passed &= expect(getUnsupportedDriver->init(&failureSystemReference) == kAsioTrue, "get-format-unsupported fixture init failed");
    passed &= expect(getUnsupportedDriver->future(kFutureGetIoFormat, &reported) != kAsioOk, "get-format-unsupported fixture unexpectedly implemented GetIoFormat");
    passed &= expect(getUnsupportedDriver->future(kFutureCanDoIoFormat, &failureDsdIoFormat) == kAsioOk, "GetIoFormat-unsupported fixture rejected Native DSD capability");
    passed &= expect(getUnsupportedDriver->future(kFutureSetIoFormat, &failureDsdIoFormat) == kAsioOk, "GetIoFormat-unsupported fixture rejected Native DSD set");
    passed &= expect(getUnsupportedDriver->canSampleRate(2822400.0) == kAsioOk, "GetIoFormat-unsupported fixture rejected DSD64 rate");
    passed &= expect(getUnsupportedDriver->setSampleRate(2822400.0) == kAsioOk, "GetIoFormat-unsupported fixture rejected DSD64 rate set");
    passed &= expect(getUnsupportedDriver->getChannelInfo(&dsdChannel) == kAsioOk && dsdChannel.type == kAsioSampleDsdInt8Lsb1, "GetIoFormat-unsupported fixture did not expose a DSD channel type");
    getUnsupportedDriver->Release();
    passed &= expect(liveDriverCount() == 0, "get-format-unsupported fixture was not released");
  }

  // Some drivers change their valid buffer-size range once the DSD I/O format
  // is active; a PCM-mode size then fails createBuffers with
  // ASE_InvalidParameter. The session must re-read the range after the DSD
  // switch instead of trusting the PCM-mode values.
  AsioDriver* dsdRangeDriver = createWithIoFormatMode(5);
  passed &= expect(dsdRangeDriver != nullptr, "dsd-buffer-range fixture did not create a driver");
  if (dsdRangeDriver) {
    AsioIoFormat dsdFormat{};
    dsdFormat.formatType = kAsioIoFormatDsd;
    AsioIoFormat pcmFormat{};
    pcmFormat.formatType = kAsioIoFormatPcm;
    passed &= expect(dsdRangeDriver->init(&failureSystemReference) == kAsioTrue, "dsd-buffer-range fixture init failed");
    passed &= expect(
        dsdRangeDriver->getBufferSize(&minimum, &maximum, &preferred, &granularity) == kAsioOk &&
            minimum == 64 && maximum == 256,
        "dsd-buffer-range fixture PCM buffer range differs");
    passed &= expect(
        dsdRangeDriver->future(kFutureCanDoIoFormat, &dsdFormat) == kAsioOk &&
            dsdRangeDriver->future(kFutureSetIoFormat, &dsdFormat) == kAsioOk,
        "dsd-buffer-range fixture rejected the DSD switch");
    passed &= expect(
        dsdRangeDriver->getBufferSize(&minimum, &maximum, &preferred, &granularity) == kAsioOk &&
            minimum == 256 && maximum == 2048 && preferred == 1024 && granularity == 0,
        "dsd-buffer-range fixture did not report the DSD-mode buffer range");
    passed &= expect(dsdRangeDriver->setSampleRate(2822400.0) == kAsioOk, "dsd-buffer-range fixture rejected the DSD64 rate");
    std::array<AsioBufferInfo, 2> dsdRangeBuffers{};
    for (int32_t channelIndex = 0; channelIndex < static_cast<int32_t>(dsdRangeBuffers.size()); ++channelIndex) {
      dsdRangeBuffers[static_cast<size_t>(channelIndex)].isInput = kAsioFalse;
      dsdRangeBuffers[static_cast<size_t>(channelIndex)].channelNum = channelIndex;
    }
    passed &= expect(
        dsdRangeDriver->createBuffers(
            dsdRangeBuffers.data(), static_cast<int32_t>(dsdRangeBuffers.size()), 128, &callbacks) != kAsioOk,
        "dsd-buffer-range fixture accepted a PCM-mode buffer size in DSD mode");
    passed &= expect(
        dsdRangeDriver->createBuffers(
            dsdRangeBuffers.data(), static_cast<int32_t>(dsdRangeBuffers.size()), 1024, &callbacks) == kAsioOk,
        "dsd-buffer-range fixture rejected the DSD-mode buffer size");
    passed &= expect(dsdRangeDriver->disposeBuffers() == kAsioOk, "dsd-buffer-range fixture dispose failed");
    passed &= expect(
        dsdRangeDriver->future(kFutureSetIoFormat, &pcmFormat) == kAsioOk &&
            dsdRangeDriver->getBufferSize(&minimum, &maximum, &preferred, &granularity) == kAsioOk &&
            minimum == 64 && maximum == 256,
        "dsd-buffer-range fixture did not restore the PCM buffer range");
    dsdRangeDriver->Release();
    passed &= expect(liveDriverCount() == 0, "dsd-buffer-range fixture was not released");
  }

  FreeLibrary(module);
  return passed ? 0 : 1;
}
