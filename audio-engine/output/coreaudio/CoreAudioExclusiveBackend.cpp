#include "CoreAudioExclusiveBackend.h"
#include "CoreAudioRenderUtils.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace twilight::audio {
namespace {

AudioFormat audioFormatFromStreamDescription(const CoreAudioStreamBasicDescription& format) {
  AudioFormat out;
  out.sampleRate = format.sampleRate > 0.0 ? static_cast<int>(format.sampleRate + 0.5) : 0;
  out.channelCount = static_cast<int>(std::max<uint32_t>(1, format.channelsPerFrame));
  if ((format.formatFlags & 0x1) != 0 && format.bitsPerChannel == 32) {
    out.sampleFormat = AudioSampleFormat::Float32Interleaved;
  } else if (format.bitsPerChannel <= 16) {
    out.sampleFormat = AudioSampleFormat::Int16Interleaved;
  } else if (format.bitsPerChannel == 24 && format.bytesPerFrame == format.channelsPerFrame * 3) {
    out.sampleFormat = AudioSampleFormat::Int24Interleaved;
  } else if (format.bitsPerChannel == 24) {
    out.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
  } else {
    out.sampleFormat = AudioSampleFormat::Int32Interleaved;
  }
  out.bitDepth = effectivePcmBitDepth(out);
  if (out.bitDepth <= 0) out.bitDepth = static_cast<int>(format.bitsPerChannel > 0 ? format.bitsPerChannel : 32);
  return out;
}

std::string exclusiveReason(
    const AudioFormat& requested,
    const AudioFormat& actual,
    bool hogAcquired,
    bool sampleRateMatched) {
  if (!hogAcquired) return "CoreAudio Hog Mode 获取失败，无法进入独占路径";
  if (!sampleRateMatched) {
    return "CoreAudio 设备不支持请求的采样率 " + std::to_string(requested.sampleRate) +
           "Hz，实际 " + std::to_string(actual.sampleRate) + "Hz";
  }
  if (requested.sampleFormat != actual.sampleFormat ||
      effectivePcmBitDepth(requested) != effectivePcmBitDepth(actual)) {
    return "CoreAudio 独占路径格式转换：请求 " + sampleFormatToString(requested.sampleFormat) + " " +
           std::to_string(effectivePcmBitDepth(requested)) + "bit，实际 " +
           sampleFormatToString(actual.sampleFormat) + " " +
           std::to_string(effectivePcmBitDepth(actual)) + "bit";
  }
  return "CoreAudio 独占输出已就绪";
}

DopRuntimeFacts unprovenCoreAudioDopRuntimeFacts(
    const AudioFormat& requestedFormat,
    const AudioFormat& actualFormat,
    const std::string& reason) {
  DopRuntimeFacts facts;
  const bool dopLikeRequest = requestedFormat.sampleRate >= 2500000 || isDopCarrierFormat(requestedFormat);
  if (!dopLikeRequest && !isDopCarrierFormat(actualFormat)) return facts;
  facts.candidateFormat = requestedFormat;
  facts.actualFormat = actualFormat;
  facts.explicitlyCapable = false;
  facts.state = DopRuntimeFactState::Unsupported;
  facts.reason = reason;
  return facts;
}

constexpr uint32_t kFallbackCoreAudioBufferFrames = 1024;

uint32_t resolvedCoreAudioBufferFrames(ICoreAudioHost& host, CoreAudioDeviceID deviceId, uint32_t preferredBufferSize) {
  const uint32_t currentFrames = host.currentBufferFrameSize(deviceId);
  if (currentFrames > 0) return currentFrames;
  if (preferredBufferSize > 0) return preferredBufferSize;
  return kFallbackCoreAudioBufferFrames;
}

double bufferLatencyMs(uint32_t frames, int sampleRate) {
  return sampleRate > 0 ? static_cast<double>(frames) * 1000.0 / static_cast<double>(sampleRate) : 0.0;
}

}  // namespace

struct CoreAudioExclusiveBackend::Impl {
  explicit Impl(std::unique_ptr<ICoreAudioHost> host) : host(std::move(host)) {}

  std::unique_ptr<ICoreAudioHost> host;
  mutable std::mutex mutex;
  RenderCallback callback;
  TypedRenderCallback typedCallback;
  OutputEventCallback eventCallback;
  OutputConfig outputConfig;
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  OutputInfo::Diagnostics diagnostics;
  DopRuntimeFacts dopRuntimeFacts;
  std::string deviceName = "CoreAudio";
  std::atomic<bool> running{false};
  CoreAudioAudioUnit unit = 0;
  CoreAudioDeviceID deviceId = 0;
  double savedNominalSampleRate = 0.0;
  bool hogAcquired = false;
  CoreAudioListenerToken listenerToken = 0;
  std::vector<float> floatScratch;
  std::vector<uint8_t> typedScratch;
  bool underrunObserved = false;

  void resetState() {
    outputFormat = {};
    outputInfo = {};
    diagnostics = {};
    dopRuntimeFacts = {};
    deviceName = "CoreAudio";
    underrunObserved = false;
  }

  void recordFailure(const char* reasonCode, const std::string& reason, std::string* error = nullptr) {
    diagnostics.lastError = reason;
    std::lock_guard lock(mutex);
    outputInfo.perfectReasonCode = reasonCode ? reasonCode : "backend_open_failure";
    outputInfo.capabilityReason = reason;
    outputInfo.perfectReason = reason;
    outputInfo.diagnostics = diagnostics;
    if (error) *error = reason;
  }

  bool fail(std::string* error, const std::string& reason) {
    recordFailure("backend_open_failure", reason, error);
    return false;
  }

  void handleDeviceLost(const std::string& message) {
    {
      std::lock_guard lock(mutex);
      ++diagnostics.deviceLostCount;
      diagnostics.lastError = message;
      outputInfo.diagnostics = diagnostics;
      outputInfo.deviceRecovered = false;
    }
    if (eventCallback) eventCallback(OutputBackendEvent::DeviceInvalidated, message);
  }

  size_t render(uint32_t frameCount, CoreAudioBufferList* ioData) {
    if (!ioData || frameCount == 0) return 0;
    const auto fillOutputSilence = [&]() {
      for (size_t index = 0; index < ioData->bufferCount(); ++index) {
        auto& buffer = ioData->bufferAt(index);
        if (buffer.hasData()) {
          std::memset(buffer.writableData(), 0, buffer.byteSize());
          buffer.dataByteSize = static_cast<uint32_t>(buffer.byteSize());
        }
      }
    };

    TypedRenderCallback typedCb;
    RenderCallback floatCb;
    AudioFormat format;
    {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (!lock.owns_lock()) {
        fillOutputSilence();
        return 0;
      }
      typedCb = typedCallback;
      floatCb = callback;
      format = outputFormat;
    }

    const int channels = std::max(1, format.channelCount);
    const size_t frames = static_cast<size_t>(frameCount);
    const size_t bytesPerFrame = audioFormatBytesPerFrame(format);
    const size_t byteCount = frames * bytesPerFrame;

    if (ioData->bufferCount() == 1 && ioData->bufferAt(0).hasData()) {
      auto& buffer = ioData->bufferAt(0);
      const size_t writableFrames =
          bytesPerFrame > 0 ? std::min(frames, buffer.byteSize() / bytesPerFrame) : static_cast<size_t>(0);
      const size_t writableByteCount = writableFrames * bytesPerFrame;

      size_t rendered = 0;
      if (typedCb) {
        rendered = coreaudio::renderTypedCallbackWithTailSilence(buffer.writableData(), writableFrames, format, typedCb);
      }
      if ((!typedCb || rendered == 0) && floatCb) {
        const size_t scratchFrames = std::min(writableFrames, floatScratch.size() / static_cast<size_t>(channels));
        rendered = coreaudio::renderFloatCallbackWithTailSilence(floatScratch.data(), scratchFrames, channels, floatCb);
        std::memcpy(
            buffer.writableData(),
            floatScratch.data(),
            std::min(floatScratch.size() * sizeof(float), writableByteCount));
      } else if (!typedCb && !floatCb) {
        std::memset(buffer.writableData(), 0, writableByteCount);
      }

      if (rendered < frames || writableFrames < frames) {
        std::unique_lock lock(mutex, std::try_to_lock);
        if (lock.owns_lock()) {
          ++diagnostics.sessionUnderrunCount;
          ++diagnostics.lifetimeUnderrunCount;
          ++outputInfo.diagnostics.sessionUnderrunCount;
          ++outputInfo.diagnostics.lifetimeUnderrunCount;
          outputInfo.deviceRecovered = false;
          underrunObserved = true;
        }
      } else if (underrunObserved) {
        std::unique_lock lock(mutex, std::try_to_lock);
        if (lock.owns_lock() && underrunObserved) {
          outputInfo.deviceRecovered = true;
        }
      }
      buffer.dataByteSize = static_cast<uint32_t>(writableByteCount);
      return rendered;
    }

    const size_t scratchFrames = std::min(frames, floatScratch.size() / static_cast<size_t>(channels));
    size_t rendered = scratchFrames;
    if (floatCb) {
      rendered = coreaudio::renderFloatCallbackWithTailSilence(floatScratch.data(), scratchFrames, channels, floatCb);
    } else {
      std::fill(floatScratch.begin(), floatScratch.end(), 0.0f);
    }
    if (rendered < frames || scratchFrames < frames) {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (lock.owns_lock()) {
        ++diagnostics.sessionUnderrunCount;
        ++diagnostics.lifetimeUnderrunCount;
        ++outputInfo.diagnostics.sessionUnderrunCount;
        ++outputInfo.diagnostics.lifetimeUnderrunCount;
        outputInfo.deviceRecovered = false;
        underrunObserved = true;
      }
    } else if (underrunObserved) {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (lock.owns_lock() && underrunObserved) {
        outputInfo.deviceRecovered = true;
      }
    }

    const size_t floatBytes = std::min(floatScratch.size() * sizeof(float), byteCount);
    if (!typedScratch.empty()) {
      std::fill(typedScratch.begin(), typedScratch.end(), 0);
    }
    for (size_t index = 0; index < ioData->bufferCount(); ++index) {
      auto& buffer = ioData->bufferAt(index);
      if (buffer.hasData()) {
        const size_t bytes = std::min({buffer.byteSize(), floatBytes, byteCount});
        std::memcpy(buffer.writableData(), floatScratch.data(), bytes);
        buffer.dataByteSize = static_cast<uint32_t>(bytes);
      }
    }
    return rendered;
  }
};

CoreAudioExclusiveBackend::CoreAudioExclusiveBackend() : CoreAudioExclusiveBackend(createRealCoreAudioHost()) {}

CoreAudioExclusiveBackend::CoreAudioExclusiveBackend(std::unique_ptr<ICoreAudioHost> host)
    : impl_(std::make_unique<Impl>(std::move(host))) {}

CoreAudioExclusiveBackend::~CoreAudioExclusiveBackend() {
  close();
}

const char* CoreAudioExclusiveBackend::id() const {
  return "coreaudio-exclusive";
}

bool CoreAudioExclusiveBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
  close();
  if (!impl_->host) {
    if (error) *error = "当前构建未启用 CoreAudio 独占输出";
    return false;
  }
  if (requestedFormat.sampleRate <= 0 || requestedFormat.channelCount <= 0) {
    if (error) *error = "请求的 CoreAudio 独占输出格式无效";
    return false;
  }

  CoreAudioDeviceID selectedDevice = 0;
  if (!impl_->host->findOutputDevice(deviceId, &selectedDevice, error)) return false;
  if (selectedDevice == 0) {
    if (error) *error = "CoreAudio 默认输出设备不可用";
    return false;
  }

  impl_->deviceId = selectedDevice;
  impl_->savedNominalSampleRate = impl_->host->getNominalSampleRate(selectedDevice);

  int32_t existingOwnerPid = -1;
  std::string ownerError;
  if (!impl_->host->hogModeOwnerPid(selectedDevice, &existingOwnerPid, &ownerError)) {
    return impl_->fail(error, ownerError.empty() ? "无法读取 CoreAudio Hog Mode 现有拥有者" : ownerError);
  }
  if (existingOwnerPid != -1) {
    const std::string reason = "device already hogged by pid " + std::to_string(existingOwnerPid);
    impl_->recordFailure("hog_mode_failed", reason, error);
    impl_->deviceId = 0;
    return false;
  }
  if (!impl_->host->acquireHogMode(selectedDevice, &existingOwnerPid, error)) {
    impl_->recordFailure("hog_mode_failed", error && !error->empty() ? *error : "无法获取 CoreAudio Hog Mode", error);
    impl_->deviceId = 0;
    return false;
  }
  impl_->hogAcquired = true;

  bool sampleRateMatched = std::abs(impl_->savedNominalSampleRate - requestedFormat.sampleRate) < 0.5;
  if (!sampleRateMatched) {
    const bool supported = impl_->host->supportsNominalSampleRate(selectedDevice, static_cast<double>(requestedFormat.sampleRate));
    if (supported) {
      std::string rateError;
      if (impl_->host->setNominalSampleRate(selectedDevice, static_cast<double>(requestedFormat.sampleRate), &rateError)) {
        sampleRateMatched = true;
      } else if (error) {
        *error = rateError.empty() ? "无法设置 CoreAudio 设备标称采样率" : rateError;
      }
    }
  }

  CoreAudioStreamBasicDescription deviceFormat{};
  std::string formatError;
  if (!impl_->host->deviceOutputStreamFormat(selectedDevice, &deviceFormat, &formatError)) {
    releaseResources();
    return impl_->fail(error, formatError.empty() ? "无法读取 CoreAudio 设备流格式" : formatError);
  }

  const int deviceChannels = impl_->host->outputChannelCount(selectedDevice);
  const int channels = deviceChannels > 0 ? std::min(requestedFormat.channelCount, deviceChannels)
                                          : requestedFormat.channelCount;
  AudioFormat actualFormat = audioFormatFromStreamDescription(deviceFormat);
  if (actualFormat.sampleRate <= 0) actualFormat.sampleRate = sampleRateMatched ? requestedFormat.sampleRate : static_cast<int>(impl_->savedNominalSampleRate + 0.5);
  if (actualFormat.channelCount <= 0) actualFormat.channelCount = channels;

  CoreAudioStreamBasicDescription inputFormat{};
  inputFormat.sampleRate = static_cast<double>(actualFormat.sampleRate);
  inputFormat.formatID = 0x6c70636d;
  inputFormat.formatFlags = 0x1;
  inputFormat.framesPerPacket = 1;
  inputFormat.channelsPerFrame = static_cast<uint32_t>(channels);
  inputFormat.bitsPerChannel = 32;
  inputFormat.bytesPerPacket = static_cast<uint32_t>(channels * sizeof(float));
  inputFormat.bytesPerFrame = static_cast<uint32_t>(channels * sizeof(float));

  if (!impl_->host->newAudioUnit(&impl_->unit, error)) {
    releaseResources();
    return false;
  }
  if (!impl_->host->enableIOBus(impl_->unit, false, true, error) ||
      !impl_->host->enableIOBus(impl_->unit, true, false, error) ||
      !impl_->host->bindDevice(impl_->unit, selectedDevice, error)) {
    releaseResources();
    return false;
  }
  impl_->host->applyBufferSize(selectedDevice, impl_->outputConfig.preferredBufferSize, error);

  if (!impl_->host->setStreamFormat(impl_->unit, true, inputFormat, error)) {
    releaseResources();
    return false;
  }
  if (!impl_->host->setRenderCallback(
          impl_->unit,
          [this](uint32_t frameCount, CoreAudioBufferList& ioData) {
            return impl_->render(frameCount, &ioData);
          },
          error)) {
    releaseResources();
    return false;
  }
  if (!impl_->host->audioUnitInitialize(impl_->unit, error)) {
    releaseResources();
    return false;
  }

  const CoreAudioListenerToken token = impl_->host->addDeviceLostListener(
      selectedDevice,
      [this](const std::string& message) { impl_->handleDeviceLost(message); },
      error);
  if (token == 0) {
    releaseResources();
    return false;
  }
  impl_->listenerToken = token;

  const bool formatMatched = sampleRateMatched &&
                             effectivePcmBitDepth(requestedFormat) == effectivePcmBitDepth(actualFormat) &&
                             requestedFormat.channelCount == actualFormat.channelCount &&
                             (requestedFormat.sampleFormat == actualFormat.sampleFormat ||
                              sampleFormatsSameIntegerPayload(
                                  requestedFormat.sampleFormat,
                                  actualFormat.sampleFormat));
  const bool supportsPerfect = impl_->hogAcquired && sampleRateMatched;

  const uint32_t bufferFrames =
      resolvedCoreAudioBufferFrames(*impl_->host, selectedDevice, impl_->outputConfig.preferredBufferSize);
  impl_->outputFormat = actualFormat;
  if (impl_->outputFormat.sampleRate <= 0) impl_->outputFormat.sampleRate = requestedFormat.sampleRate;
  impl_->outputFormat.channelCount = channels;
  if (impl_->outputFormat.bitDepth <= 0) impl_->outputFormat.bitDepth = effectivePcmBitDepth(impl_->outputFormat);
  if (impl_->outputFormat.bitDepth <= 0) impl_->outputFormat.bitDepth = 32;
  impl_->floatScratch.resize(static_cast<size_t>(bufferFrames) * static_cast<size_t>(std::max(1, channels)));
  impl_->typedScratch.resize(static_cast<size_t>(bufferFrames) * audioFormatBytesPerFrame(impl_->outputFormat));
  impl_->deviceName = impl_->host->deviceName(selectedDevice);
  if (impl_->deviceName.empty()) impl_->deviceName = "CoreAudio Exclusive Output";

  impl_->outputInfo = {};
  impl_->outputInfo.exclusive = true;
  impl_->outputInfo.accessMode = "exclusive";
  impl_->outputInfo.supportsOutputPerfect = supportsPerfect;
  impl_->outputInfo.sourceExact = false;
  impl_->outputInfo.outputPerfect = false;
  impl_->outputInfo.pcmPassthrough = false;
  impl_->outputInfo.resampled = !formatMatched;
  impl_->outputInfo.outputSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.outputBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.backend = "coreaudio-exclusive";
  impl_->outputInfo.actualBackend = "coreaudio-exclusive";
  impl_->outputInfo.devicePathKind = "hal";
  impl_->outputInfo.deviceName = impl_->deviceName;
  impl_->outputInfo.actualDeviceName = impl_->deviceName;
  impl_->outputInfo.actualOutputFormat = sampleFormatToString(impl_->outputFormat.sampleFormat);
  impl_->outputInfo.actualSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.actualBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.actualChannels = impl_->outputFormat.channelCount;
  impl_->outputInfo.bufferSizeFrames = bufferFrames;
  impl_->outputInfo.latencyFrames = bufferFrames;
  impl_->outputInfo.latencyInfo.bufferLatencyMs = bufferLatencyMs(bufferFrames, impl_->outputFormat.sampleRate);
  const uint32_t outputLatencyFrames = impl_->host->estimatedOutputLatencyFrames(selectedDevice);
  const double outputLatencyMsValue = bufferLatencyMs(outputLatencyFrames, impl_->outputFormat.sampleRate);
  impl_->outputInfo.latencyInfo.outputLatencyMs = outputLatencyMsValue;
  impl_->outputInfo.latencyInfo.totalLatencyMs =
      impl_->outputInfo.latencyInfo.bufferLatencyMs + impl_->outputInfo.latencyInfo.outputLatencyMs;
  impl_->outputInfo.latencyMs = impl_->outputInfo.latencyInfo.totalLatencyMs;
  impl_->outputInfo.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  impl_->outputInfo.diagnostics = impl_->diagnostics;

  if (supportsPerfect && formatMatched) {
    impl_->outputInfo.perfectReasonCode.clear();
    impl_->outputInfo.perfectReason.clear();
    impl_->outputInfo.capabilityReason = "CoreAudio 独占输出 (Hog Mode) 已就绪";
  } else if (!impl_->hogAcquired) {
    impl_->outputInfo.perfectReasonCode = "hog_mode_failed";
    impl_->outputInfo.perfectReason = exclusiveReason(requestedFormat, impl_->outputFormat, false, sampleRateMatched);
    impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  } else if (!sampleRateMatched) {
    impl_->outputInfo.perfectReasonCode = "sample_rate_unsupported";
    impl_->outputInfo.perfectReason = exclusiveReason(requestedFormat, impl_->outputFormat, true, false);
    impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  } else {
    impl_->outputInfo.perfectReasonCode = "pcm_converted";
    impl_->outputInfo.perfectReason = exclusiveReason(requestedFormat, impl_->outputFormat, true, true);
    impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  }

  if (isDopCarrierFormat(requestedFormat)) {
    impl_->dopRuntimeFacts.state = DopRuntimeFactState::Candidate;
    impl_->dopRuntimeFacts.candidateFormat = requestedFormat;
    impl_->dopRuntimeFacts.actualFormat = isDopCarrierFormat(impl_->outputFormat) ? impl_->outputFormat : AudioFormat{};
    impl_->dopRuntimeFacts.reason = "CoreAudio exclusive Hog Mode path; DoP candidate pending runtime verification";
  } else {
    impl_->dopRuntimeFacts = unprovenCoreAudioDopRuntimeFacts(
        requestedFormat,
        impl_->outputFormat,
        "CoreAudio exclusive path cannot prove DoP passthrough for non-DoP request");
  }

  return true;
}

void CoreAudioExclusiveBackend::releaseResources() {
  if (!impl_->host) {
    impl_->running = false;
    return;
  }
  if (impl_->listenerToken != 0) {
    impl_->host->removeDeviceLostListener(impl_->deviceId, impl_->listenerToken);
    impl_->listenerToken = 0;
  }
  stop();
  if (impl_->unit) {
    impl_->host->audioUnitUninitialize(impl_->unit);
    impl_->host->disposeAudioUnit(impl_->unit);
    impl_->unit = 0;
  }
  if (impl_->hogAcquired && impl_->deviceId != 0) {
    if (impl_->savedNominalSampleRate > 0.0) {
      std::string rateError;
      impl_->host->setNominalSampleRate(impl_->deviceId, impl_->savedNominalSampleRate, &rateError);
    }
    impl_->host->releaseHogMode(impl_->deviceId);
  }
  impl_->hogAcquired = false;
  impl_->deviceId = 0;
  impl_->savedNominalSampleRate = 0.0;
  std::lock_guard lock(impl_->mutex);
  impl_->callback = nullptr;
  impl_->typedCallback = nullptr;
  impl_->eventCallback = nullptr;
  impl_->floatScratch.clear();
  impl_->typedScratch.clear();
  impl_->underrunObserved = false;
}

bool CoreAudioExclusiveBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)error;
  std::lock_guard lock(impl_->mutex);
  impl_->outputConfig = config;
  impl_->outputInfo.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  return true;
}

bool CoreAudioExclusiveBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
  if (!impl_->unit) {
    if (error) *error = "CoreAudio 独占后端尚未打开";
    return false;
  }
  if (impl_->running.exchange(true)) {
    if (error) *error = "CoreAudio 独占后端已经在运行";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->callback = std::move(callback);
    impl_->typedCallback = nullptr;
    impl_->eventCallback = std::move(eventCallback);
  }
  if (!impl_->host->audioUnitStart(impl_->unit, error)) {
    impl_->running = false;
    return false;
  }
  return true;
}

bool CoreAudioExclusiveBackend::startTyped(
    TypedRenderCallback callback,
    RenderCallback fallbackCallback,
    OutputEventCallback eventCallback,
    std::string* error) {
  if (!impl_->unit) {
    if (error) *error = "CoreAudio 独占后端尚未打开";
    return false;
  }
  if (impl_->running.exchange(true)) {
    if (error) *error = "CoreAudio 独占后端已经在运行";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->typedCallback = std::move(callback);
    impl_->callback = std::move(fallbackCallback);
    impl_->eventCallback = std::move(eventCallback);
  }
  if (!impl_->host->audioUnitStart(impl_->unit, error)) {
    impl_->running = false;
    return false;
  }
  return true;
}

void CoreAudioExclusiveBackend::stop() {
  const bool wasRunning = impl_->running.exchange(false);
  if (wasRunning && impl_->unit) impl_->host->audioUnitStop(impl_->unit);
}

void CoreAudioExclusiveBackend::close() {
  releaseResources();
  impl_->resetState();
}

AudioFormat CoreAudioExclusiveBackend::outputFormat() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->outputFormat;
}

OutputInfo CoreAudioExclusiveBackend::outputInfo() const {
  std::lock_guard lock(impl_->mutex);
  OutputInfo info = impl_->outputInfo;
  if (info.diagnostics.lastError.empty() && info.diagnostics.sessionUnderrunCount > 0) {
    info.diagnostics.lastError = "CoreAudio IOProc underrun";
  }
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts CoreAudioExclusiveBackend::dopRuntimeFacts() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->dopRuntimeFacts;
}

NativeDsdRuntimeFacts CoreAudioExclusiveBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("CoreAudio has no native DSD path");
}

std::string CoreAudioExclusiveBackend::deviceName() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->deviceName;
}

bool coreAudioExclusiveBackendAvailable() {
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
