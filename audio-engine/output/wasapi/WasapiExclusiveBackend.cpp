#include "WasapiExclusiveBackend.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <charconv>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#include "WasapiCommon.h"
#include "WasapiFormatNegotiator.h"

#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <propsys.h>
#include <wrl/client.h>
#endif

namespace twilight::audio {
namespace {

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
std::string hresultSuffix(HRESULT hr) {
  std::ostringstream stream;
  stream << "0x" << std::hex << std::uppercase << static_cast<unsigned long>(hr);
  return stream.str();
}

std::string outputFormatSummary(const AudioFormat& format) {
  return std::to_string(format.sampleRate) + "Hz " + std::to_string(format.channelCount) + "ch " +
         sampleFormatToString(format.sampleFormat) + " " + std::to_string(format.bitDepth) + "bit";
}

double referenceTimeToMilliseconds(REFERENCE_TIME duration) {
  return duration > 0 ? static_cast<double>(duration) / 10000.0 : 0.0;
}

struct DopBufferObservation {
  bool observed = false;
  size_t inspectedFrames = 0;
  uint8_t startMarker = 0;
  bool startMarkerValid = false;
  size_t invalidMarkers = 0;
  size_t channelMarkerMismatches = 0;
  uint64_t hash = 0;
};

DopBufferObservation inspectDopBuffer(
    const uint8_t* data,
    size_t frames,
    const AudioFormat& format) noexcept {
  DopBufferObservation observation;
  if (!data || frames == 0 || !isDopCarrierFormat(format)) return observation;
  const size_t channels = static_cast<size_t>(std::max(1, format.channelCount));
  const size_t bytesPerSample = audioSampleFormatBytes(format.sampleFormat);
  const size_t bytesPerFrame = audioFormatBytesPerFrame(format);
  if (bytesPerSample == 0 || bytesPerFrame == 0) return observation;

  observation.observed = true;
  observation.inspectedFrames = std::min<size_t>(frames, 256);
  observation.hash = 1469598103934665603ULL;
  observation.startMarker = data[bytesPerSample - 1];
  observation.startMarkerValid = observation.startMarker == 0x05 || observation.startMarker == 0xfa;
  for (size_t frame = 0; frame < observation.inspectedFrames; ++frame) {
    const uint8_t expected =
        (frame % 2 == 0) ? observation.startMarker : (observation.startMarker == 0x05 ? 0xfa : 0x05);
    uint8_t firstMarker = 0;
    for (size_t channel = 0; channel < channels; ++channel) {
      const uint8_t* sample = data + frame * bytesPerFrame + channel * bytesPerSample;
      const uint8_t marker = sample[bytesPerSample - 1];
      if (channel == 0) firstMarker = marker;
      if (marker != expected) ++observation.invalidMarkers;
      if (channel > 0 && marker != firstMarker) ++observation.channelMarkerMismatches;
      for (size_t byte = 0; byte < bytesPerSample; ++byte) {
        observation.hash ^= sample[byte];
        observation.hash *= 1099511628211ULL;
      }
    }
  }
  return observation;
}

void appendDecimal(std::string& output, uint64_t value) {
  char digits[32] = {};
  const auto [end, error] = std::to_chars(digits, digits + sizeof(digits), value);
  if (error == std::errc{}) output.append(digits, end);
}

void appendHex(std::string& output, uint64_t value) {
  char digits[32] = {};
  const auto [end, error] = std::to_chars(digits, digits + sizeof(digits), value, 16);
  if (error == std::errc{}) output.append(digits, end);
}

std::string dopBufferSummary(const DopBufferObservation& observation) {
  if (!observation.observed) return {};
  std::string summary;
  summary.reserve(160);
  summary += "dop frames=";
  appendDecimal(summary, observation.inspectedFrames);
  summary += " startMarker=0x";
  appendHex(summary, observation.startMarker);
  summary += " startMarkerValid=";
  summary += observation.startMarkerValid ? "true" : "false";
  summary += " markerInvalid=";
  appendDecimal(summary, observation.invalidMarkers);
  summary += " channelMarkerMismatch=";
  appendDecimal(summary, observation.channelMarkerMismatches);
  summary += " fnv64=0x";
  appendHex(summary, observation.hash);
  return summary;
}
#endif

}  // namespace

struct WasapiExclusiveBackend::Impl {
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  OutputInfo::Diagnostics diagnostics;
  DopRuntimeFacts dopRuntimeFacts;
  std::string deviceName = "系统默认";
  // Buffer duration and event/push mode are consumed by the render thread and
  // by IAudioClient::Initialize. Keep the two fields the backend actually
  // owns atomic so control-plane updates cannot race the realtime callback.
  // AudioPipeline serializes topology changes by stopping/joining the backend
  // before either value is changed and reopened.
  std::atomic<uint32_t> preferredBufferSize{0};
  std::atomic<bool> wasapiExclusivePushMode{false};
  mutable std::mutex infoMutex;

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  Microsoft::WRL::ComPtr<IMMDevice> device;
  Microsoft::WRL::ComPtr<IAudioClient> audioClient;
  Microsoft::WRL::ComPtr<IAudioRenderClient> renderClient;
  wasapi::UniqueHandle samplesReadyEvent;
  std::thread renderThread;
  std::thread recoveryThread;
  std::mutex threadMutex;
  // Wakes the recovery thread's backoff waits when stop() is requested, so
  // stop()/close() are never parked for seconds inside sleep_for().
  std::condition_variable threadCv;
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  UINT32 bufferFrameCount = 0;
  REFERENCE_TIME bufferDuration = 0;
  std::atomic<double> renderBufferLatencyMs{0.0};
  RenderCallback callback;
  TypedRenderCallback typedCallback;
  OutputEventCallback eventCallback;
  std::vector<float> renderScratch;
  std::vector<uint8_t> waveFormatBytes;
  bool ownerComInitialized = false;
  DopBufferObservation firstDopBufferObservation;

  // ── 自动恢复状态 ──
  std::atomic<bool> recoveryInProgress{false};
  std::atomic<bool> recoveryQueued{false};
  int recoveryAttempts = 0;
  uint64_t recoveryCount = 0;
  std::chrono::steady_clock::time_point recoveryCooldownUntil{};
  std::deque<std::chrono::steady_clock::time_point> recoveryWindow;
  const char* queuedRecoveryReason = nullptr;
  const char* queuedRenderFailureMessage = nullptr;
  std::atomic<long> queuedRenderFailureHr{S_OK};
  std::atomic<bool> renderErrorEventQueued{false};
  std::atomic<bool> deviceInvalidatedEventQueued{false};
  // 恢复所需的上下文快照（open 时保存，reopen 时使用）
  std::string openDeviceId;
  AudioFormat openRequestedFormat;

  void resetFailureInfo() {
    OutputInfo::Diagnostics lifetime = diagnostics;
    diagnostics = {};
    diagnostics.lifetimeUnderrunCount = lifetime.lifetimeUnderrunCount;
    diagnostics.lifetimeBufferDropCount = lifetime.lifetimeBufferDropCount;
    diagnostics.lifetimeRecoveryCount = lifetime.lifetimeRecoveryCount;
    diagnostics.driverRestartCount = lifetime.driverRestartCount;
    diagnostics.deviceLostCount = lifetime.deviceLostCount;

    std::lock_guard lock(infoMutex);
    outputInfo = {};
    dopRuntimeFacts = {};
    outputInfo.exclusive = true;
    outputInfo.accessMode = "exclusive";
    outputInfo.supportsOutputPerfect = false;
    outputInfo.sourceExact = false;
    outputInfo.outputPerfect = false;
    outputInfo.pcmPassthrough = false;
    outputInfo.backend = "wasapi-exclusive";
    outputInfo.actualBackend = "wasapi-exclusive";
    outputInfo.devicePathKind = "default";
    outputInfo.deviceName = deviceName;
    outputInfo.actualDeviceName = deviceName;
    outputInfo.diagnostics = diagnostics;
    renderBufferLatencyMs.store(0.0);
    firstDopBufferObservation = {};
  }

  void recordFailure(const char* reasonCode, const std::string& reason, std::string* error = nullptr) {
    diagnostics.lastError = reason;
    std::lock_guard lock(infoMutex);
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

  bool failHr(std::string* error, const std::string& reason, HRESULT hr) {
    return fail(error, reason + " (错误码 " + hresultSuffix(hr) + ")");
  }

  bool loadDeviceName() {
    Microsoft::WRL::ComPtr<IPropertyStore> properties;
    if (!device || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return false;
    PROPVARIANT value;
    PropVariantInit(&value);
    if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
      deviceName = wasapi::wideToUtf8(value.pwszVal);
    }
    PropVariantClear(&value);
    return true;
  }

  bool activateAudioClient(std::string* error) {
    audioClient.Reset();
    renderClient.Reset();
    HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audioClient);
    if (SUCCEEDED(hr)) return true;
    return failHr(error, "WASAPI 独占 open failure：无法激活音频客户端", hr);
  }

  bool initializeAudioClient(const WAVEFORMATEX* format, REFERENCE_TIME requestedDuration, std::string* error) {
    DWORD streamFlags = AUDCLNT_STREAMFLAGS_NOPERSIST;
    if (!wasapiExclusivePushMode.load(std::memory_order_acquire)) {
      streamFlags |= AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    }
    HRESULT hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_EXCLUSIVE,
        streamFlags,
        requestedDuration,
        requestedDuration,
        format,
        nullptr);
    if (wasapi::isDeviceInUse(hr)) {
      for (int attempt = 0; attempt < 5 && wasapi::isDeviceInUse(hr); ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
        if (!activateAudioClient(error)) return false;
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            streamFlags,
            requestedDuration,
            requestedDuration,
            format,
            nullptr);
      }
    }
    if (hr == S_OK) {
      bufferDuration = requestedDuration;
      return true;
    }

    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
      UINT32 alignedFrames = 0;
      if (SUCCEEDED(audioClient->GetBufferSize(&alignedFrames)) && alignedFrames > 0) {
        if (!activateAudioClient(error)) return false;
        const REFERENCE_TIME alignedDuration =
            std::max<REFERENCE_TIME>(1, wasapi::framesToReferenceTime(alignedFrames, outputFormat.sampleRate));
        hr = audioClient->Initialize(
            AUDCLNT_SHAREMODE_EXCLUSIVE,
            streamFlags,
            alignedDuration,
            alignedDuration,
            format,
            nullptr);
        if (hr == S_OK) {
          bufferDuration = alignedDuration;
          return true;
        }
      }
    }

    return failHr(
        error,
        "WASAPI 独占 init failure：设备拒绝协商格式 " + outputFormatSummary(outputFormat),
        hr);
  }

  bool configureStream(const AudioFormat& requestedFormat, std::string* error) {
    WasapiFormatNegotiator negotiator(audioClient.Get());
    if (!negotiator.negotiate(requestedFormat, error)) {
      outputInfo = negotiator.outputInfo();
      dopRuntimeFacts = negotiator.dopRuntimeFacts();
      outputInfo.deviceName = deviceName;
      outputInfo.actualDeviceName = deviceName;
      outputInfo.diagnostics = diagnostics;
      return false;
    }

    outputFormat = negotiator.outputFormat();
    outputInfo = negotiator.outputInfo();
    dopRuntimeFacts = negotiator.dopRuntimeFacts();
    outputInfo.deviceName = deviceName;
    outputInfo.actualDeviceName = deviceName;
    outputInfo.diagnostics = diagnostics;
    waveFormatBytes.assign(
        reinterpret_cast<const uint8_t*>(negotiator.waveFormat()),
        reinterpret_cast<const uint8_t*>(negotiator.waveFormat()) + negotiator.waveFormatSize());
    const auto* waveFormat = reinterpret_cast<const WAVEFORMATEX*>(waveFormatBytes.data());
    diagnostics.dsdTransport = isDopCarrierFormat(outputFormat) ? "dop" : "pcm";
    diagnostics.requestedWireFormat = sampleFormatToString(requestedFormat.sampleFormat);
    diagnostics.actualWireFormat = sampleFormatToString(outputFormat.sampleFormat);
    diagnostics.containerBits = waveFormat ? waveFormat->wBitsPerSample : 0;
    diagnostics.validBits = outputFormat.bitDepth;
    diagnostics.blockAlign = waveFormat ? waveFormat->nBlockAlign : 0;
    diagnostics.semanticSampleRate = isDopCarrierFormat(outputFormat) ? outputFormat.sampleRate * 16 : outputFormat.sampleRate;
    diagnostics.transportSampleRate = outputFormat.sampleRate;
    diagnostics.typedRawPath = isDopCarrierFormat(outputFormat);
    diagnostics.processingBypassed = isDopCarrierFormat(outputFormat);
    outputInfo.diagnostics = diagnostics;
    const std::string negotiatedPerfectReasonCode = outputInfo.perfectReasonCode;
    const std::string negotiatedCapabilityReason = outputInfo.capabilityReason;
    const std::string negotiatedPerfectReason = outputInfo.perfectReason;
    auto restoreNegotiatedReason = [&]() {
      diagnostics.lastError.clear();
      outputInfo.perfectReasonCode = negotiatedPerfectReasonCode;
      outputInfo.capabilityReason = negotiatedCapabilityReason;
      outputInfo.perfectReason = negotiatedPerfectReason;
      outputInfo.diagnostics = diagnostics;
    };

    REFERENCE_TIME defaultPeriod = 0;
    REFERENCE_TIME minimumPeriod = 0;
    HRESULT hr = audioClient->GetDevicePeriod(&defaultPeriod, &minimumPeriod);
    if (FAILED(hr)) {
      return failHr(error, "WASAPI 独占 init failure：无法读取设备缓冲周期", hr);
    }

    REFERENCE_TIME requestedDuration = wasapi::chooseExclusiveBufferDuration(
        preferredBufferSize.load(std::memory_order_acquire),
        outputFormat.sampleRate,
        defaultPeriod,
        minimumPeriod);

    if (!initializeAudioClient(waveFormat, requestedDuration, error)) {
      if (defaultPeriod > requestedDuration && activateAudioClient(error) &&
          initializeAudioClient(waveFormat, defaultPeriod, error)) {
        restoreNegotiatedReason();
        return true;
      }
      return false;
    }

    restoreNegotiatedReason();
    return true;
  }

  bool attachEventAndRenderClient(std::string* error) {
    HRESULT hr = S_OK;
    if (!wasapiExclusivePushMode.load(std::memory_order_acquire)) {
      samplesReadyEvent.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
      if (!samplesReadyEvent) {
        return fail(error, "WASAPI 独占 init failure：无法创建事件回调句柄");
      }

      hr = audioClient->SetEventHandle(samplesReadyEvent.get());
      if (FAILED(hr)) return failHr(error, "WASAPI 独占 init failure：无法绑定事件回调", hr);
    }

    hr = audioClient->GetBufferSize(&bufferFrameCount);
    if (FAILED(hr)) return failHr(error, "WASAPI 独占 init failure：无法读取缓冲区大小", hr);
    renderScratch.resize(
        static_cast<size_t>(bufferFrameCount) * static_cast<size_t>(std::max(1, outputFormat.channelCount)));
    outputInfo.bufferSizeFrames = static_cast<int>(bufferFrameCount);
    outputInfo.latencyFrames = static_cast<int>(bufferFrameCount);
    outputInfo.latencyInfo.bufferLatencyMs =
        outputFormat.sampleRate > 0
            ? static_cast<double>(bufferFrameCount) * 1000.0 / static_cast<double>(outputFormat.sampleRate)
            : 0.0;
    REFERENCE_TIME streamLatency = 0;
    hr = audioClient->GetStreamLatency(&streamLatency);
    if (SUCCEEDED(hr)) {
      const double streamLatencyMs = referenceTimeToMilliseconds(streamLatency);
      outputInfo.latencyInfo.outputLatencyMs = std::max(0.0, streamLatencyMs - outputInfo.latencyInfo.bufferLatencyMs);
      outputInfo.latencyInfo.totalLatencyMs =
          outputInfo.latencyInfo.bufferLatencyMs + outputInfo.latencyInfo.outputLatencyMs;
    } else {
      outputInfo.latencyInfo.outputLatencyMs = 0.0;
      outputInfo.latencyInfo.totalLatencyMs = outputInfo.latencyInfo.bufferLatencyMs;
    }
    outputInfo.latencyMs = outputInfo.latencyInfo.totalLatencyMs;
    renderBufferLatencyMs.store(outputInfo.latencyInfo.bufferLatencyMs);

    hr = audioClient->GetService(IID_PPV_ARGS(&renderClient));
    if (SUCCEEDED(hr)) return true;
    return failHr(error, "WASAPI 独占 init failure：无法获取渲染客户端", hr);
  }

  HRESULT renderPacket(UINT32 frameCount) {
    if (frameCount == 0) return S_OK;

    BYTE* data = nullptr;
    HRESULT hr = renderClient->GetBuffer(frameCount, &data);
    if (FAILED(hr)) return hr;
    const size_t byteCount = static_cast<size_t>(frameCount) * audioFormatBytesPerFrame(outputFormat);

    if (typedCallback) {
      PcmBlock block;
      block.format = outputFormat;
      block.data = data;
      block.frames = frameCount;
      block.byteSize = byteCount;
      const size_t rendered = typedCallback(block);
      if (rendered > 0) {
        const size_t renderedFrames = std::min<size_t>(rendered, frameCount);
        if (isDopCarrierFormat(outputFormat)) {
          std::unique_lock lock(infoMutex, std::try_to_lock);
          if (lock.owns_lock() && !firstDopBufferObservation.observed) {
            firstDopBufferObservation = inspectDopBuffer(data, renderedFrames, outputFormat);
          }
        }
        const size_t renderedBytes = renderedFrames * audioFormatBytesPerFrame(outputFormat);
        if (data && renderedBytes < byteCount && !isDopCarrierFormat(outputFormat)) {
          std::memset(data + renderedBytes, 0, byteCount - renderedBytes);
        }
        if (renderedFrames < frameCount) {
          std::unique_lock lock(infoMutex, std::try_to_lock);
          if (lock.owns_lock()) {
            ++diagnostics.dsdShortReadCount;
            diagnostics.dsdIdleFrameCount += frameCount - renderedFrames;
          }
        }
        hr = renderClient->ReleaseBuffer(frameCount, 0);
        if (FAILED(hr)) return hr;
        return S_OK;
      }
    }

    if (outputFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
      wasapi::renderFloatCallbackWithTailSilence(
          reinterpret_cast<float*>(data),
          frameCount,
          outputFormat.channelCount,
          callback);
      hr = renderClient->ReleaseBuffer(frameCount, 0);
      if (FAILED(hr)) return hr;
      return S_OK;
    }

    const size_t sampleCount = static_cast<size_t>(frameCount) * static_cast<size_t>(outputFormat.channelCount);
    const size_t scratchFrames =
        outputFormat.channelCount > 0
            ? std::min<size_t>(frameCount, renderScratch.size() / static_cast<size_t>(outputFormat.channelCount))
            : 0;
    wasapi::renderFloatCallbackWithTailSilence(
        renderScratch.data(),
        scratchFrames,
        outputFormat.channelCount,
        callback);

    wasapi::packFloatToPcm(
        renderScratch.data(),
        scratchFrames,
        outputFormat.channelCount,
        outputFormat.sampleFormat,
        data);
    if (scratchFrames < frameCount) {
      const size_t bytesPerFrame = audioFormatBytesPerFrame(outputFormat);
      const size_t renderedBytes = scratchFrames * bytesPerFrame;
      if (data && renderedBytes < byteCount) std::memset(data + renderedBytes, 0, byteCount - renderedBytes);
    }

    hr = renderClient->ReleaseBuffer(frameCount, 0);
    if (FAILED(hr)) return hr;
    return S_OK;
  }

  void notifyFailure(HRESULT hr, const char* fallbackMessage) {
    if (wasapi::isDeviceInvalidated(hr)) {
      ++diagnostics.deviceLostCount;
      recordFailure("device_lost", fallbackMessage + std::string(" (错误码 ") + hresultSuffix(hr) + ")");
      // 不在此处通知上层 DeviceInvalidated — 由 handleRenderFailure 决定恢复或通知
      return;
    }
    char buffer[160] = {};
    std::snprintf(buffer, sizeof(buffer), "%s (错误码 0x%08lx)", fallbackMessage, static_cast<unsigned long>(hr));
    ++diagnostics.sessionBufferDropCount;
    ++diagnostics.lifetimeBufferDropCount;
    recordFailure("render_failure", buffer);
    if (eventCallback) eventCallback(OutputBackendEvent::RenderError, buffer);
  }

  void recordRenderFailureFromRenderThread(HRESULT hr) noexcept {
    // Keep the MMCSS render thread allocation-free: only fixed-size counters are
    // updated here. The human-readable error is published after MMCSS teardown.
    std::unique_lock lock(infoMutex, std::try_to_lock);
    if (!lock.owns_lock()) return;
    if (wasapi::isDeviceInvalidated(hr)) {
      ++diagnostics.deviceLostCount;
    } else {
      ++diagnostics.sessionBufferDropCount;
      ++diagnostics.lifetimeBufferDropCount;
    }
  }

  void publishQueuedRenderFailure(HRESULT hr, const char* message) {
    char buffer[160] = {};
    std::snprintf(buffer, sizeof(buffer), "%s (错误码 0x%08lx)", message, static_cast<unsigned long>(hr));

    std::lock_guard lock(infoMutex);
    diagnostics.lastError = buffer;
    outputInfo.perfectReasonCode = wasapi::isDeviceInvalidated(hr) ? "device_lost" : "render_failure";
    outputInfo.capabilityReason = buffer;
    outputInfo.perfectReason = buffer;
    outputInfo.diagnostics = diagnostics;
  }

  void recordRenderUnderrun() noexcept {
    // Diagnostics contains dynamic text, so copying it here could allocate on
    // the MMCSS render thread. The query path snapshots it under the lock.
    std::unique_lock lock(infoMutex, std::try_to_lock);
    if (!lock.owns_lock()) return;
    ++diagnostics.sessionUnderrunCount;
    ++diagnostics.lifetimeUnderrunCount;
  }

  void refreshLatencyTelemetry() {
    REFERENCE_TIME streamLatency = 0;
    if (FAILED(audioClient->GetStreamLatency(&streamLatency))) return;

    const double bufferLatencyMs = renderBufferLatencyMs.load();
    const double streamLatencyMs = referenceTimeToMilliseconds(streamLatency);
    std::unique_lock lock(infoMutex, std::try_to_lock);
    if (!lock.owns_lock()) return;
    outputInfo.latencyInfo.outputLatencyMs = std::max(0.0, streamLatencyMs - bufferLatencyMs);
    outputInfo.latencyInfo.totalLatencyMs = bufferLatencyMs + outputInfo.latencyInfo.outputLatencyMs;
    outputInfo.latencyMs = outputInfo.latencyInfo.totalLatencyMs;
  }

  void renderLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    DWORD taskIndex = 0;
    HANDLE mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    auto lastWakeTime = std::chrono::high_resolution_clock::now();
    auto lastLatencyQueryTime = lastWakeTime;

    const double initialBufferLatencyMs = renderBufferLatencyMs.load();
    const double sleepMsDouble = initialBufferLatencyMs > 0 ? initialBufferLatencyMs * 0.5 : 5.0;
    const DWORD sleepMs = std::max<DWORD>(1, static_cast<DWORD>(sleepMsDouble));
    // Push mode drives its own cadence; the default Windows timer granularity
    // (~15.6ms) exceeds a typical 10ms exclusive buffer, which turns every
    // period into an underrun. A high-resolution waitable timer keeps the
    // cadence without winmm/timeBeginPeriod. Falls back to sleep_for on
    // pre-1803 systems where the flag is unsupported.
#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif
    const wasapi::UniqueHandle highResolutionTimer(CreateWaitableTimerExW(
        nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
    const auto pushWait = [&]() {
      if (highResolutionTimer) {
        LARGE_INTEGER dueTime{};
        dueTime.QuadPart = -static_cast<LONGLONG>(sleepMs) * 10000LL;
        if (SetWaitableTimer(highResolutionTimer.get(), &dueTime, 0, nullptr, nullptr, FALSE)) {
          HANDLE waitHandles[2] = {highResolutionTimer.get(), samplesReadyEvent.get()};
          const DWORD handleCount = samplesReadyEvent ? 2 : 1;
          WaitForMultipleObjects(handleCount, waitHandles, FALSE, INFINITE);
          return;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(sleepMs));
    };

    while (running.load()) {
      if (wasapiExclusivePushMode.load(std::memory_order_acquire)) {
        pushWait();
        if (!running.load()) break;
      } else {
        const DWORD waitResult = WaitForSingleObject(samplesReadyEvent.get(), 2000);
        if (!running.load()) break;
        if (waitResult != WAIT_OBJECT_0) {
          if (waitResult == WAIT_TIMEOUT) {
             recordRenderUnderrun();
          }
          continue;
        }
      }

      auto now = std::chrono::high_resolution_clock::now();
      double elapsedMs = std::chrono::duration<double, std::milli>(now - lastWakeTime).count();
      lastWakeTime = now;

      // In exclusive mode, the expected wakeup interval is roughly bufferLatencyMs.
      // If we wake up much later than expected, we missed a deadline.
      const double bufferLatencyMs = renderBufferLatencyMs.load();
      if (!wasapiExclusivePushMode.load(std::memory_order_acquire) && bufferLatencyMs > 0 &&
          elapsedMs > bufferLatencyMs * 1.5) {
        recordRenderUnderrun();
      }

      if (std::chrono::duration<double, std::milli>(now - lastLatencyQueryTime).count() > 1000.0) {
        lastLatencyQueryTime = now;
        refreshLatencyTelemetry();
      }

      UINT32 padding = 0;
      HRESULT hr = audioClient->GetCurrentPadding(&padding);
      if (FAILED(hr)) {
        if (!handleRenderFailure(hr, "无法读取独占输出缓冲状态")) break;
        continue;
      }

      const UINT32 framesAvailable =
          wasapi::exclusiveRenderFrames(
              bufferFrameCount, padding, wasapiExclusivePushMode.load(std::memory_order_acquire));
      if (framesAvailable == 0) continue;
      const HRESULT renderHr = renderPacket(framesAvailable);
      if (FAILED(renderHr)) {
        if (!handleRenderFailure(renderHr, "独占输出渲染失败")) break;
        continue;
      }
    }

    if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
    CoUninitialize();

    const bool renderErrorQueued = renderErrorEventQueued.exchange(false);
    const bool deviceInvalidatedQueued = deviceInvalidatedEventQueued.exchange(false);
    if (renderErrorQueued || deviceInvalidatedQueued) {
      const HRESULT queuedHr = static_cast<HRESULT>(queuedRenderFailureHr.load());
      const char* queuedMessage = queuedRenderFailureMessage ? queuedRenderFailureMessage : "独占输出渲染失败";
      publishQueuedRenderFailure(queuedHr, queuedMessage);
    }

    if (recoveryQueued.load() && !stopRequested.load()) {
      startQueuedRecoveryAfterRenderExit(queuedRecoveryReason);
      return;
    }

    if (renderErrorQueued && eventCallback) {
      char buffer[160] = {};
      const char* message = queuedRenderFailureMessage ? queuedRenderFailureMessage : "独占输出渲染失败";
      std::snprintf(
          buffer,
          sizeof(buffer),
          "%s (错误码 0x%08lx)",
          message,
          static_cast<unsigned long>(queuedRenderFailureHr.load()));
      eventCallback(OutputBackendEvent::RenderError, buffer);
    }
    if (deviceInvalidatedQueued && eventCallback) {
      eventCallback(OutputBackendEvent::DeviceInvalidated, "输出设备已失效");
    }
  }

  void launchRenderThread() {
    std::lock_guard lock(threadMutex);
    renderThread = std::thread([this] { renderLoop(); });
  }

  bool startWithCallbacks(
      RenderCallback nextCallback,
      TypedRenderCallback nextTypedCallback,
      OutputEventCallback nextEventCallback,
      std::string* error) {
    if (!audioClient || !renderClient) {
      recordFailure("backend_start_failure", "独占输出后端尚未打开", error);
      return false;
    }
    if (running.load()) {
      recordFailure("backend_start_failure", "独占输出后端已经在运行", error);
      return false;
    }

    callback = std::move(nextCallback);
    typedCallback = std::move(nextTypedCallback);
    eventCallback = std::move(nextEventCallback);
    stopRequested = false;

    // Prefill with silence (and still advance the decoder) so Start() after a device rebind
    // does not attack at full level.
    {
      const UINT32 prefillFrames = wasapi::exclusiveInitialRenderFrames(
          bufferFrameCount,
          wasapiExclusivePushMode.load(std::memory_order_acquire));
      if (prefillFrames > 0 && renderClient) {
        BYTE* data = nullptr;
        HRESULT prefillHr = renderClient->GetBuffer(prefillFrames, &data);
        if (FAILED(prefillHr)) {
          if (error) *error = "无法预填充独占输出缓冲区";
          return false;
        }
        DWORD prefillFlags = AUDCLNT_BUFFERFLAGS_SILENT;
        if (data) {
          const size_t byteCount =
              static_cast<size_t>(prefillFrames) * audioFormatBytesPerFrame(outputFormat);
          std::memset(data, 0, byteCount);
          // DoP cannot use all-zero PCM silence: that removes the 0x05/0xFA marker
          // sequence and makes many DACs lose DSD lock. Let the typed callback emit
          // a valid carrier pre-roll and submit those bytes without the SILENT flag.
          if (isDopCarrierFormat(outputFormat) && typedCallback) {
            PcmBlock block;
            block.format = outputFormat;
            block.data = data;
            block.frames = prefillFrames;
            block.byteSize = byteCount;
            (void)typedCallback(block);
            prefillFlags = 0;
          } else if (outputFormat.sampleFormat == AudioSampleFormat::Float32Interleaved && callback) {
            std::vector<float> discard(
                static_cast<size_t>(prefillFrames) *
                static_cast<size_t>(std::max(1, outputFormat.channelCount)));
            (void)callback(discard.data(), prefillFrames);
          } else if (typedCallback) {
            PcmBlock block;
            block.format = outputFormat;
            block.data = data;  // already silence; typed path may overwrite — re-zero after
            block.frames = prefillFrames;
            block.byteSize = byteCount;
            (void)typedCallback(block);
            std::memset(data, 0, byteCount);
          } else if (callback && outputFormat.channelCount > 0) {
            std::vector<float> discard(
                static_cast<size_t>(prefillFrames) * static_cast<size_t>(outputFormat.channelCount));
            (void)callback(discard.data(), prefillFrames);
          }
        }
        prefillHr = renderClient->ReleaseBuffer(prefillFrames, prefillFlags);
        if (FAILED(prefillHr)) {
          if (error) *error = "无法提交独占输出预填充缓冲区";
          return false;
        }
      }
    }

    if (!wasapiExclusivePushMode.load(std::memory_order_acquire)) {
      running = true;
      launchRenderThread();
    }

    HRESULT hr = audioClient->Start();
    if (!wasapi::succeeded(hr, error, "无法启动独占输出音频流")) {
      if (wasapi::isDeviceInvalidated(hr)) ++diagnostics.deviceLostCount;
      recordFailure(
          wasapi::isDeviceInvalidated(hr) ? "device_lost" : "backend_start_failure",
          "无法启动独占输出音频流 (错误码 " + hresultSuffix(hr) + ")",
          error);
      stop();
      return false;
    }

    if (wasapiExclusivePushMode.load(std::memory_order_acquire)) {
      running = true;
      launchRenderThread();
    }

    return true;
  }

  void joinRenderThread() {
    std::thread threadToJoin;
    {
      std::lock_guard lock(threadMutex);
      if (renderThread.joinable() && renderThread.get_id() != std::this_thread::get_id()) {
        threadToJoin = std::move(renderThread);
      }
    }
    if (threadToJoin.joinable()) threadToJoin.join();
  }

  void joinRecoveryThread() {
    std::thread threadToJoin;
    {
      std::lock_guard lock(threadMutex);
      if (recoveryThread.joinable() && recoveryThread.get_id() != std::this_thread::get_id()) {
        threadToJoin = std::move(recoveryThread);
      }
    }
    if (threadToJoin.joinable()) threadToJoin.join();
  }

  void stop() {
    {
      // Under threadMutex so the recovery thread's relaunch re-check cannot
      // observe a stale stopRequested after launching a fresh render thread.
      std::lock_guard lock(threadMutex);
      stopRequested = true;
      running = false;
    }
    threadCv.notify_all();
    if (samplesReadyEvent) SetEvent(samplesReadyEvent.get());
    joinRenderThread();
    joinRecoveryThread();
    // Soft mute residual free space after the render thread stops so Stop() does not
    // leave non-zero samples at the device boundary (device-switch click/pop).
    if (audioClient && renderClient && bufferFrameCount > 0) {
      UINT32 padding = 0;
      if (SUCCEEDED(audioClient->GetCurrentPadding(&padding))) {
        const UINT32 framesAvailable = bufferFrameCount > padding ? bufferFrameCount - padding : 0;
        if (framesAvailable > 0) {
          BYTE* data = nullptr;
          if (SUCCEEDED(renderClient->GetBuffer(framesAvailable, &data)) && data) {
            const size_t byteCount =
                static_cast<size_t>(framesAvailable) * audioFormatBytesPerFrame(outputFormat);
            DWORD releaseFlags = AUDCLNT_BUFFERFLAGS_SILENT;
            if (isDopCarrierFormat(outputFormat) && typedCallback) {
              PcmBlock block;
              block.format = outputFormat;
              block.data = data;
              block.frames = framesAvailable;
              block.byteSize = byteCount;
              (void)typedCallback(block);
              releaseFlags = 0;
            } else {
              std::memset(data, 0, byteCount);
            }
            (void)renderClient->ReleaseBuffer(framesAvailable, releaseFlags);
          }
        }
      }
    }
    if (audioClient) {
      audioClient->Stop();
      audioClient->Reset();
    }
  }

  void close() {
    stop();
    renderClient.Reset();
    audioClient.Reset();
    device.Reset();
    samplesReadyEvent.reset();
    bufferFrameCount = 0;
    bufferDuration = 0;
    renderBufferLatencyMs.store(0.0);
    callback = nullptr;
    typedCallback = nullptr;
    eventCallback = nullptr;
    renderScratch.clear();
    waveFormatBytes.clear();
    if (ownerComInitialized) {
      CoUninitialize();
      ownerComInitialized = false;
    }
  }

  // ── 自动恢复：重新打开设备 ──
  bool reopenDevice() {
    if (audioClient) {
      audioClient->Stop();
      audioClient->Reset();
    }
    renderClient.Reset();
    audioClient.Reset();
    samplesReadyEvent.reset();

    // 重新枚举设备（设备可能已变化/被拔出后重新插入）
    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return false;

    device.Reset();
    if (wasapi::isDefaultDeviceAlias(openDeviceId)) {
      hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    } else {
      const std::wstring id = wasapi::utf8ToWide(openDeviceId);
      hr = enumerator->GetDevice(id.c_str(), &device);
    }
    if (FAILED(hr)) return false;

    loadDeviceName();
    if (!activateAudioClient(nullptr)) return false;
    if (!configureStream(openRequestedFormat, nullptr)) return false;
    if (!attachEventAndRenderClient(nullptr)) return false;
    return true;
  }

  void recordRecoverySuccess() {
    std::lock_guard lock(infoMutex);
    ++recoveryCount;
    ++diagnostics.sessionRecoveryCount;
    ++diagnostics.lifetimeRecoveryCount;
    outputInfo.deviceRecovered = true;
    outputInfo.recoveryCount = static_cast<int>(recoveryCount);
    outputInfo.diagnostics = diagnostics;
  }

  // ── 自动恢复：带退避/限流的重试 ──
  bool attemptRecovery(const std::string& reason) {
    static constexpr int kMaxAttempts = 3;
    static constexpr int kBackoffMs[] = {500, 1000, 2000};
    static constexpr auto kRecoveryWindow = std::chrono::seconds(10);
    static constexpr auto kRecoveryCooldown = std::chrono::seconds(10);

    const auto now = std::chrono::steady_clock::now();

    // 清理过期的窗口记录
    while (!recoveryWindow.empty() && now - recoveryWindow.front() > kRecoveryWindow) {
      recoveryWindow.pop_front();
    }

    // 已有恢复在进行中
    if (recoveryInProgress.load()) return false;

    // 冷却期内不恢复
    if (now < recoveryCooldownUntil) return false;

    // 窗口内恢复次数超限 → 进入冷却
    if (recoveryWindow.size() >= static_cast<size_t>(kMaxAttempts)) {
      recoveryCooldownUntil = now + kRecoveryCooldown;
      return false;
    }

    recoveryWindow.push_back(now);
    recoveryInProgress = true;
    recoveryAttempts = 0;

    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
      recoveryAttempts = attempt;
      // Interruptible backoff: stop()/close() must not block for the full
      // 500+1000+2000ms ladder while a user command waits on them.
      {
        std::unique_lock lock(threadMutex);
        threadCv.wait_for(
            lock, std::chrono::milliseconds(kBackoffMs[attempt]), [this] {
              return stopRequested.load();
            });
      }

      if (stopRequested.load()) {
        recoveryInProgress = false;
        return false;
      }
      if (!reopenDevice()) continue;
      if (stopRequested.load()) {
        recoveryInProgress = false;
        return false;
      }

      // 恢复成功：预填充缓冲并启动
      const UINT32 initialFrames = wasapi::exclusiveInitialRenderFrames(
          bufferFrameCount, wasapiExclusivePushMode.load(std::memory_order_acquire));
      if (FAILED(renderPacket(initialFrames))) continue;

      HRESULT startHr = audioClient->Start();
      if (FAILED(startHr)) continue;

      // 成功
      recoveryInProgress = false;
      recoveryAttempts = 0;
      recordRecoverySuccess();
      return true;
    }

    // 全部失败
    recoveryInProgress = false;
    recoveryAttempts = kMaxAttempts;
    return false;
  }

  void runQueuedRecovery(std::string reason) {
    // This runs on the dedicated recovery thread. COM is per-thread: without
    // an apartment here, every CoCreateInstance in reopenDevice fails with
    // CO_E_NOTINITIALIZED and all recovery attempts are dead on arrival.
    const wasapi::ComApartment recoveryCom;
    joinRenderThread();
    if (stopRequested.load()) {
      recoveryQueued = false;
      return;
    }

    const bool recovered = attemptRecovery(reason);
    bool relaunched = false;
    if (recovered) {
      // Re-check stopRequested while holding threadMutex (the same lock stop()
      // uses to set the flag). Without this window a stop() racing the relaunch
      // returned with a fresh render thread still playing, and the soft-mute
      // below then touched the same IAudioClient concurrently.
      std::lock_guard lock(threadMutex);
      if (!stopRequested.load()) {
        running = true;
        renderThread = std::thread([this] { renderLoop(); });
        relaunched = true;
      }
    }
    if (!relaunched && !recovered && !stopRequested.load() && eventCallback) {
      eventCallback(OutputBackendEvent::DeviceInvalidated, "输出设备已失效");
    }
    recoveryQueued = false;
    queuedRecoveryReason = nullptr;
  }

  void startQueuedRecoveryAfterRenderExit(const char* reason) {
    joinRecoveryThread();
    const char* fallbackReason = reason ? reason : "输出设备已失效";
    {
      std::lock_guard lock(threadMutex);
      recoveryThread = std::thread([this, recoveryReason = std::string(fallbackReason)] {
        runQueuedRecovery(recoveryReason);
      });
    }
  }

  bool queueRecoveryFromRenderThread(const char* reason) {
    bool expected = false;
    if (!recoveryQueued.compare_exchange_strong(expected, true)) return false;

    running = false;
    queuedRecoveryReason = reason;
    if (samplesReadyEvent) SetEvent(samplesReadyEvent.get());
    return true;
  }

  // ── 统一渲染失败处理：记录 + 恢复 + 通知 ──
  // 返回 true = 已恢复可以继续渲染；false = 需退出渲染循环
  bool handleRenderFailure(HRESULT hr, const char* message) {
    const bool devInvalidated = wasapi::isDeviceInvalidated(hr);
    recordRenderFailureFromRenderThread(hr);
    queuedRenderFailureMessage = message;
    queuedRenderFailureHr.store(hr);
    if (!devInvalidated) {
      renderErrorEventQueued.store(true);
      running = false;
      if (samplesReadyEvent) SetEvent(samplesReadyEvent.get());
      return false;
    }
    if (queueRecoveryFromRenderThread(message)) return false;
    deviceInvalidatedEventQueued.store(true);
    return false;
  }
#else
  void stop() {}
  void close() {}
#endif
};

WasapiExclusiveBackend::WasapiExclusiveBackend() : impl_(std::make_unique<Impl>()) {}

WasapiExclusiveBackend::~WasapiExclusiveBackend() {
  close();
}

const char* WasapiExclusiveBackend::id() const {
  return "wasapi-exclusive";
}

bool WasapiExclusiveBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  close();
  impl_->resetFailureInfo();

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  impl_->ownerComInitialized = SUCCEEDED(hr);
  if (hr == RPC_E_CHANGED_MODE) hr = S_OK;
  auto failAfterCom = [&]() {
    impl_->close();
    return false;
  };
  if (FAILED(hr)) {
    return impl_->failHr(error, "WASAPI 独占 open failure：无法初始化 COM 环境", hr);
  }

  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) {
    impl_->failHr(error, "WASAPI 独占 open failure：无法创建设备枚举器", hr);
    return failAfterCom();
  }

  if (wasapi::isDefaultDeviceAlias(deviceId)) {
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &impl_->device);
  } else {
    const std::wstring id = wasapi::utf8ToWide(deviceId);
    hr = enumerator->GetDevice(id.c_str(), &impl_->device);
  }
  if (FAILED(hr)) {
    impl_->failHr(error, "WASAPI 独占 open failure：无法打开输出设备", hr);
    return failAfterCom();
  }

  impl_->loadDeviceName();
  if (!impl_->activateAudioClient(error)) return failAfterCom();
  if (!impl_->configureStream(requestedFormat, error)) return failAfterCom();
  if (!impl_->attachEventAndRenderClient(error)) return failAfterCom();

  // 保存恢复所需的上下文
  impl_->openDeviceId = deviceId;
  impl_->openRequestedFormat = requestedFormat;
  impl_->recoveryInProgress = false;
  impl_->recoveryQueued = false;
  impl_->recoveryAttempts = 0;
  impl_->recoveryCount = 0;
  impl_->recoveryWindow.clear();
  impl_->recoveryCooldownUntil = {};
  impl_->queuedRecoveryReason = nullptr;
  impl_->queuedRenderFailureMessage = nullptr;
  impl_->queuedRenderFailureHr.store(S_OK);
  impl_->renderErrorEventQueued.store(false);
  impl_->deviceInvalidatedEventQueued.store(false);

  return true;
#else
  (void)deviceId;
  (void)requestedFormat;
  if (error) *error = "当前构建未启用独占输出";
  return false;
#endif
}

bool WasapiExclusiveBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  impl_->preferredBufferSize.store(config.preferredBufferSize, std::memory_order_release);
  impl_->wasapiExclusivePushMode.store(config.wasapiExclusivePushMode, std::memory_order_release);
  (void)error;
  return true;
}

bool WasapiExclusiveBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  return impl_->startWithCallbacks(std::move(callback), nullptr, std::move(eventCallback), error);
#else
  (void)callback;
  (void)eventCallback;
  if (error) *error = "当前构建未启用独占输出";
  return false;
#endif
}

bool WasapiExclusiveBackend::startTyped(
    TypedRenderCallback callback,
    RenderCallback fallbackCallback,
    OutputEventCallback eventCallback,
    std::string* error) {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  return impl_->startWithCallbacks(std::move(fallbackCallback), std::move(callback), std::move(eventCallback), error);
#else
  (void)callback;
  (void)fallbackCallback;
  (void)eventCallback;
  if (error) *error = "当前构建未启用独占输出";
  return false;
#endif
}

void WasapiExclusiveBackend::stop() {
  impl_->stop();
}

void WasapiExclusiveBackend::close() {
  impl_->close();
}

AudioFormat WasapiExclusiveBackend::outputFormat() const {
  return impl_->outputFormat;
}

OutputInfo WasapiExclusiveBackend::outputInfo() const {
  std::lock_guard lock(impl_->infoMutex);
  OutputInfo info = impl_->outputInfo;
  info.diagnostics = impl_->diagnostics;
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  if (impl_->firstDopBufferObservation.observed) {
    info.diagnostics.firstBufferSummary = dopBufferSummary(impl_->firstDopBufferObservation);
  }
#endif
  return info;
}

DopRuntimeFacts WasapiExclusiveBackend::dopRuntimeFacts() const {
  return impl_->dopRuntimeFacts;
}

NativeDsdRuntimeFacts WasapiExclusiveBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("WASAPI exclusive output supports PCM/DoP only; Native DSD is unavailable");
}

std::string WasapiExclusiveBackend::deviceName() const {
  return impl_->deviceName;
}

bool wasapiExclusiveBackendAvailable() {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
