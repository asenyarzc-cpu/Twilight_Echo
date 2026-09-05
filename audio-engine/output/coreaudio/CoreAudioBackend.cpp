#include "CoreAudioBackend.h"

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

CoreAudioStreamBasicDescription streamDescriptionForSharedOutput(const AudioFormat& requested, int channelCount, int sampleRate) {
  CoreAudioStreamBasicDescription format;
  format.sampleRate = static_cast<double>(sampleRate);
  format.formatID = 0x6c70636d;
  format.formatFlags = 0x1;
  format.framesPerPacket = 1;
  format.channelsPerFrame = static_cast<uint32_t>(std::max(1, channelCount));
  format.bitsPerChannel = 32;
  format.bytesPerPacket = format.channelsPerFrame * sizeof(float);
  format.bytesPerFrame = format.channelsPerFrame * sizeof(float);
  (void)requested;
  return format;
}

std::string coreAudioSharedReason(const AudioFormat& requested, const AudioFormat& actual) {
  std::string reason = "CoreAudio 默认输出使用系统混音路径，未启用 Hog Mode/Exclusive";
  if (requested.sampleRate != actual.sampleRate) {
    reason += "; actual sample rate " + std::to_string(actual.sampleRate) + "Hz";
  }
  if (requested.channelCount != actual.channelCount) {
    reason += "; actual channels " + std::to_string(actual.channelCount);
  }
  if (requested.sampleFormat != actual.sampleFormat ||
      effectivePcmBitDepth(requested) != effectivePcmBitDepth(actual)) {
    reason += "; actual format " + sampleFormatToString(actual.sampleFormat) + " " +
              std::to_string(effectivePcmBitDepth(actual)) + "bit";
  }
  return reason;
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

struct CoreAudioBackend::Impl {
  explicit Impl(std::unique_ptr<ICoreAudioHost> host) : host(std::move(host)) {}

  std::unique_ptr<ICoreAudioHost> host;
  mutable std::mutex mutex;
  RenderCallback callback;
  OutputEventCallback eventCallback;
  OutputConfig outputConfig;
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  DopRuntimeFacts dopRuntimeFacts;
  std::string deviceName = "CoreAudio";
  std::atomic<bool> running{false};
  CoreAudioAudioUnit unit = 0;
  CoreAudioDeviceID deviceId = 0;
  CoreAudioListenerToken listenerToken = 0;
  std::vector<float> renderScratch;
  bool underrunObserved = false;

  void resetState() {
    outputFormat = {};
    outputInfo = {};
    dopRuntimeFacts = {};
    deviceName = "CoreAudio";
    underrunObserved = false;
  }

  void handleDeviceLost(const std::string& message) {
    {
      std::lock_guard lock(mutex);
      ++outputInfo.diagnostics.deviceLostCount;
      outputInfo.diagnostics.lastError = message;
      outputInfo.deviceRecovered = false;
      outputInfo.diagnostics.sessionUnderrunCount += 0;
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

    RenderCallback renderCallback;
    int channels = 0;
    {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (!lock.owns_lock()) {
        fillOutputSilence();
        return 0;
      }
      renderCallback = callback;
      channels = std::max(1, outputFormat.channelCount);
    }

    const size_t frames = static_cast<size_t>(frameCount);
    const size_t samples = frames * static_cast<size_t>(channels);

    if (ioData->bufferCount() == 1) {
      auto& buffer = ioData->bufferAt(0);
      auto* out = reinterpret_cast<float*>(buffer.writableData());
      const size_t writableFrames = std::min(frames, buffer.byteSize() / sizeof(float) / static_cast<size_t>(channels));
      const size_t rendered =
          coreaudio::renderFloatCallbackWithTailSilence(out, writableFrames, channels, renderCallback);
      if (rendered < frames || writableFrames < frames) {
        std::unique_lock lock(mutex, std::try_to_lock);
        if (lock.owns_lock()) {
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
      buffer.dataByteSize = static_cast<uint32_t>(std::min(buffer.byteSize(), samples * sizeof(float)));
      return rendered;
    }

    const size_t scratchFrames = std::min(frames, renderScratch.size() / static_cast<size_t>(channels));
    const size_t rendered =
        coreaudio::renderFloatCallbackWithTailSilence(renderScratch.data(), scratchFrames, channels, renderCallback);
    if (rendered < frames || scratchFrames < frames) {
      std::unique_lock lock(mutex, std::try_to_lock);
      if (lock.owns_lock()) {
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

    for (size_t index = 0; index < ioData->bufferCount(); ++index) {
      auto& buffer = ioData->bufferAt(index);
      if (buffer.hasData()) {
        const size_t bytes = std::min(buffer.byteSize(), renderScratch.size() * sizeof(float));
        std::memcpy(buffer.writableData(), renderScratch.data(), bytes);
        buffer.dataByteSize = static_cast<uint32_t>(bytes);
      }
    }
    return rendered;
  }
};

CoreAudioBackend::CoreAudioBackend() : CoreAudioBackend(createRealCoreAudioHost()) {}

CoreAudioBackend::CoreAudioBackend(std::unique_ptr<ICoreAudioHost> host)
    : impl_(std::make_unique<Impl>(std::move(host))) {}

CoreAudioBackend::~CoreAudioBackend() {
  close();
}

const char* CoreAudioBackend::id() const {
  return "coreaudio";
}

bool CoreAudioBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
  close();
  if (!impl_->host) {
    if (error) *error = "当前构建未启用 CoreAudio 输出";
    return false;
  }
  if (requestedFormat.sampleRate <= 0 || requestedFormat.channelCount <= 0) {
    if (error) *error = "请求的 CoreAudio 输出格式无效";
    return false;
  }

  CoreAudioDeviceID selectedDevice = 0;
  if (!impl_->host->findOutputDevice(deviceId, &selectedDevice, error)) return false;
  if (selectedDevice == 0) {
    if (error) *error = "CoreAudio 默认输出设备不可用";
    return false;
  }

  if (!impl_->host->findHalOutputUnit(error)) return false;

  const int deviceChannels = impl_->host->outputChannelCount(selectedDevice);
  const int channels = deviceChannels > 0 ? std::min(requestedFormat.channelCount, deviceChannels)
                                          : requestedFormat.channelCount;

  CoreAudioStreamBasicDescription deviceFormat{};
  if (!impl_->host->deviceOutputStreamFormat(selectedDevice, &deviceFormat, error)) return false;
  AudioFormat actualFormat = audioFormatFromStreamDescription(deviceFormat);
  if (actualFormat.sampleRate <= 0) actualFormat.sampleRate = requestedFormat.sampleRate;
  if (actualFormat.channelCount <= 0) actualFormat.channelCount = channels;

  impl_->deviceId = selectedDevice;
  impl_->deviceName = impl_->host->deviceName(selectedDevice);
  if (impl_->deviceName.empty()) impl_->deviceName = "CoreAudio Default Output";

  const double currentRate = impl_->host->getNominalSampleRate(selectedDevice);
  bool sampleRateMatched = std::abs(currentRate - requestedFormat.sampleRate) < 0.5;
  if (!sampleRateMatched && impl_->host->supportsNominalSampleRate(selectedDevice, static_cast<double>(requestedFormat.sampleRate))) {
    std::string rateError;
    if (impl_->host->setNominalSampleRate(selectedDevice, static_cast<double>(requestedFormat.sampleRate), &rateError)) {
      sampleRateMatched = true;
      actualFormat.sampleRate = requestedFormat.sampleRate;
    } else if (error) {
      *error = rateError.empty() ? "无法设置 CoreAudio 设备标称采样率" : rateError;
    }
  }

  if (!impl_->host->newAudioUnit(&impl_->unit, error)) {
    impl_->deviceId = 0;
    return false;
  }
  if (!impl_->host->enableIOBus(impl_->unit, false, true, error) ||
      !impl_->host->enableIOBus(impl_->unit, true, false, error) ||
      !impl_->host->bindDevice(impl_->unit, selectedDevice, error)) {
    close();
    return false;
  }
  impl_->host->applyBufferSize(selectedDevice, impl_->outputConfig.preferredBufferSize, error);

  const CoreAudioStreamBasicDescription outputFormat =
      streamDescriptionForSharedOutput(requestedFormat, channels, actualFormat.sampleRate);
  if (!impl_->host->setStreamFormat(impl_->unit, true, outputFormat, error)) {
    close();
    return false;
  }
  if (!impl_->host->setRenderCallback(
          impl_->unit,
          [this](uint32_t frameCount, CoreAudioBufferList& ioData) {
            return impl_->render(frameCount, &ioData);
          },
          error)) {
    close();
    return false;
  }
  if (!impl_->host->audioUnitInitialize(impl_->unit, error)) {
    close();
    return false;
  }

  const CoreAudioListenerToken token = impl_->host->addDeviceLostListener(
      selectedDevice,
      [this](const std::string& message) { impl_->handleDeviceLost(message); },
      error);
  if (token == 0) {
    close();
    return false;
  }
  impl_->listenerToken = token;

  const uint32_t bufferFrames =
      resolvedCoreAudioBufferFrames(*impl_->host, selectedDevice, impl_->outputConfig.preferredBufferSize);
  impl_->outputFormat = actualFormat;
  impl_->outputFormat.sampleRate = actualFormat.sampleRate;
  impl_->outputFormat.channelCount = channels;
  impl_->outputFormat.bitDepth = effectivePcmBitDepth(impl_->outputFormat);
  impl_->renderScratch.resize(static_cast<size_t>(bufferFrames) * static_cast<size_t>(std::max(1, channels)));
  impl_->outputInfo = {};
  impl_->outputInfo.exclusive = false;
  impl_->outputInfo.accessMode = "shared";
  impl_->outputInfo.supportsOutputPerfect = false;
  impl_->outputInfo.sourceExact = false;
  impl_->outputInfo.outputPerfect = false;
  impl_->outputInfo.pcmPassthrough = false;
  impl_->outputInfo.resampled = requestedFormat.sampleRate != impl_->outputFormat.sampleRate ||
                                requestedFormat.channelCount != impl_->outputFormat.channelCount ||
                                effectivePcmBitDepth(requestedFormat) != effectivePcmBitDepth(impl_->outputFormat) ||
                                requestedFormat.sampleFormat != impl_->outputFormat.sampleFormat;
  impl_->outputInfo.outputSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.outputBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.outputChannels = impl_->outputFormat.channelCount;
  impl_->outputInfo.backend = "coreaudio";
  impl_->outputInfo.actualBackend = "coreaudio";
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
  impl_->outputInfo.perfectReasonCode = "shared_mixer";
  impl_->outputInfo.perfectReason = coreAudioSharedReason(requestedFormat, impl_->outputFormat);
  impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  impl_->outputInfo.diagnostics = {};
  impl_->dopRuntimeFacts = unprovenCoreAudioDopRuntimeFacts(
      requestedFormat,
      impl_->outputFormat,
      "CoreAudio shared system path cannot prove DoP passthrough");
  return true;
}

bool CoreAudioBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)error;
  std::lock_guard lock(impl_->mutex);
  impl_->outputConfig = config;
  impl_->outputInfo.channelRoutingMode = channelRoutingModeToString(impl_->outputConfig.routingMode);
  return true;
}

bool CoreAudioBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
  if (!impl_->unit) {
    if (error) *error = "CoreAudio 后端尚未打开";
    return false;
  }
  if (impl_->running.exchange(true)) {
    if (error) *error = "CoreAudio 后端已经在运行";
    return false;
  }
  {
    std::lock_guard lock(impl_->mutex);
    impl_->callback = std::move(callback);
    impl_->eventCallback = std::move(eventCallback);
  }
  if (!impl_->host->audioUnitStart(impl_->unit, error)) {
    impl_->running = false;
    return false;
  }
  return true;
}

void CoreAudioBackend::stop() {
  const bool wasRunning = impl_->running.exchange(false);
  if (wasRunning && impl_->unit) impl_->host->audioUnitStop(impl_->unit);
}

void CoreAudioBackend::close() {
  if (!impl_->host) {
    impl_->running = false;
    std::lock_guard lock(impl_->mutex);
    impl_->resetState();
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
  impl_->running = false;
  impl_->deviceId = 0;
  std::lock_guard lock(impl_->mutex);
  impl_->callback = nullptr;
  impl_->eventCallback = nullptr;
  impl_->renderScratch.clear();
  impl_->resetState();
}

AudioFormat CoreAudioBackend::outputFormat() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->outputFormat;
}

OutputInfo CoreAudioBackend::outputInfo() const {
  std::lock_guard lock(impl_->mutex);
  OutputInfo info = impl_->outputInfo;
  if (info.diagnostics.lastError.empty() && info.diagnostics.sessionUnderrunCount > 0) {
    info.diagnostics.lastError = "CoreAudio IOProc underrun";
  }
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts CoreAudioBackend::dopRuntimeFacts() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->dopRuntimeFacts;
}

NativeDsdRuntimeFacts CoreAudioBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("CoreAudio has no native DSD path");
}

std::string CoreAudioBackend::deviceName() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->deviceName;
}

bool coreAudioBackendAvailable() {
#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
