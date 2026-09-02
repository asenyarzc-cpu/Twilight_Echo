#include "WasapiSharedBackend.h"

#include "WasapiCommon.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <propidl.h>
#include <propsys.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#endif

namespace twilight::audio {
namespace {

bool looksLikeDsdOrDopRequest(const AudioFormat& format) {
  const bool dsdRate = format.sampleRate == 2822400 || format.sampleRate == 5644800;
  const bool dopCarrierRate = format.sampleRate == 176400 || format.sampleRate == 352800;
  const bool dopCarrierFormat =
      format.bitDepth == 24 &&
      (format.sampleFormat == AudioSampleFormat::Int24Interleaved ||
       format.sampleFormat == AudioSampleFormat::Int24In32Interleaved);
  return dsdRate || (dopCarrierRate && dopCarrierFormat);
}

AudioFormat dopCandidateForRequestedFormat(const AudioFormat& requestedFormat) {
  if (isDopCarrierFormat(requestedFormat)) return requestedFormat;

  AudioFormat candidate;
  candidate.channelCount = requestedFormat.channelCount;
  candidate.bitDepth = 24;
  candidate.sampleFormat = AudioSampleFormat::Int24Interleaved;
  switch (requestedFormat.sampleRate) {
    case 2822400:
      candidate.sampleRate = 176400;
      return candidate;
    case 5644800:
      candidate.sampleRate = 352800;
      return candidate;
    default:
      return {};
  }
}

std::string sharedPerfectReason(const AudioFormat& requestedFormat) {
  if (looksLikeDsdOrDopRequest(requestedFormat)) {
    return "WASAPI 共享输出经过系统混音；DSD/DoP carrier 不能在 Shared mixer 中保持 outputPerfect";
  }
  return "WASAPI 共享输出经过系统混音";
}

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
double referenceTimeToMilliseconds(REFERENCE_TIME duration) {
  return duration > 0 ? static_cast<double>(duration) / 10000.0 : 0.0;
}

std::string hresultMessage(const char* message, HRESULT hr) {
  char buffer[160] = {};
  std::snprintf(buffer, sizeof(buffer), "%s (错误码 0x%08lx)", message, static_cast<unsigned long>(hr));
  return buffer;
}
#endif

}  // namespace

struct WasapiSharedBackend::Impl {
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  OutputInfo::Diagnostics diagnostics;
  DopRuntimeFacts dopRuntimeFacts;
  std::string deviceName = "系统默认";
  mutable std::mutex infoMutex;

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  Microsoft::WRL::ComPtr<IMMDevice> device;
  Microsoft::WRL::ComPtr<IAudioClient> audioClient;
  Microsoft::WRL::ComPtr<IAudioRenderClient> renderClient;
  HANDLE samplesReadyEvent = nullptr;
  std::mutex threadMutex;
  std::thread renderThread;
  std::atomic<bool> running{false};
  UINT32 bufferFrameCount = 0;
  RenderCallback callback;
  OutputEventCallback eventCallback;
  bool ownerComInitialized = false;
  std::atomic<bool> deviceInvalidatedEventQueued{false};
  std::atomic<HRESULT> deferredRenderFailureHr{S_OK};
  std::atomic<const char*> deferredRenderFailureMessage{nullptr};

  static std::wstring utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    if (size <= 0) return {};
    std::wstring wide(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), size);
    if (!wide.empty() && wide.back() == L'\0') wide.pop_back();
    return wide;
  }

  static std::string wideToUtf8(const wchar_t* value) {
    if (!value) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string out(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr);
    if (!out.empty() && out.back() == '\0') out.pop_back();
    return out;
  }

  bool succeeded(HRESULT hr, std::string* error, const char* message, const char* reasonCode) {
    if (SUCCEEDED(hr)) return true;
    if (reasonCode && std::strcmp(reasonCode, "device_lost") == 0) {
      ++diagnostics.deviceLostCount;
    }
    recordFailure(reasonCode, hresultMessage(message, hr), error);
    return false;
  }

  static bool isDeviceInvalidated(HRESULT hr) {
    return hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == AUDCLNT_E_RESOURCES_INVALIDATED ||
           hr == AUDCLNT_E_SERVICE_NOT_RUNNING;
  }

  bool loadDeviceName() {
    Microsoft::WRL::ComPtr<IPropertyStore> properties;
    if (!device || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return false;
    PROPVARIANT value;
    PropVariantInit(&value);
    if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
      deviceName = wideToUtf8(value.pwszVal);
    }
    PropVariantClear(&value);
    return true;
  }

  void resetOutputInfo() {
    OutputInfo::Diagnostics lifetime = diagnostics;
    diagnostics = {};
    diagnostics.lifetimeUnderrunCount = lifetime.lifetimeUnderrunCount;
    diagnostics.lifetimeBufferDropCount = lifetime.lifetimeBufferDropCount;
    diagnostics.lifetimeRecoveryCount = lifetime.lifetimeRecoveryCount;
    diagnostics.driverRestartCount = lifetime.driverRestartCount;
    diagnostics.deviceLostCount = lifetime.deviceLostCount;
    deferredRenderFailureHr.store(S_OK, std::memory_order_relaxed);
    deferredRenderFailureMessage.store(nullptr, std::memory_order_relaxed);

    std::lock_guard lock(infoMutex);
    outputInfo = {};
    outputInfo.exclusive = false;
    outputInfo.accessMode = "shared";
    outputInfo.supportsOutputPerfect = false;
    outputInfo.sourceExact = false;
    outputInfo.outputPerfect = false;
    outputInfo.pcmPassthrough = false;
    outputInfo.backend = "wasapi";
    outputInfo.actualBackend = "wasapi";
    outputInfo.devicePathKind = "default";
    outputInfo.deviceName = deviceName;
    outputInfo.actualDeviceName = deviceName;
    outputInfo.diagnostics = diagnostics;
  }

  void recordFailure(const char* reasonCode, const std::string& reason, std::string* error = nullptr) {
    deferredRenderFailureHr.store(S_OK, std::memory_order_relaxed);
    deferredRenderFailureMessage.store(nullptr, std::memory_order_relaxed);
    diagnostics.lastError = reason;
    std::lock_guard lock(infoMutex);
    outputInfo.perfectReasonCode = reasonCode ? reasonCode : "backend_open_failure";
    outputInfo.capabilityReason = reason;
    outputInfo.perfectReason = reason;
    outputInfo.diagnostics = diagnostics;
    if (error) *error = reason;
  }

  void recordRenderFailure(HRESULT hr, const char* message) {
    deferredRenderFailureHr.store(S_OK, std::memory_order_relaxed);
    deferredRenderFailureMessage.store(nullptr, std::memory_order_relaxed);
    const std::string reason = hresultMessage(message, hr);
    if (isDeviceInvalidated(hr)) {
      ++diagnostics.deviceLostCount;
      recordFailure("device_lost", reason);
      return;
    }
    ++diagnostics.sessionBufferDropCount;
    ++diagnostics.lifetimeBufferDropCount;
    recordFailure("render_failure", reason);
  }

  void recordRenderFailureFromRenderThread(HRESULT hr, const char* message) noexcept {
    deferredRenderFailureHr.store(hr, std::memory_order_relaxed);
    deferredRenderFailureMessage.store(message, std::memory_order_relaxed);

    // Keep the MMCSS render thread free of dynamic text assignments and copies.
    // Human-readable failure details are materialized by outputInfo().
    std::unique_lock lock(infoMutex, std::try_to_lock);
    if (!lock.owns_lock()) return;
    if (isDeviceInvalidated(hr)) {
      ++diagnostics.deviceLostCount;
    } else {
      ++diagnostics.sessionBufferDropCount;
      ++diagnostics.lifetimeBufferDropCount;
    }
  }

  bool renderSucceeded(HRESULT hr, std::string* error, const char* message) {
    if (SUCCEEDED(hr)) return true;
    recordRenderFailure(hr, message);
    if (error) *error = diagnostics.lastError;
    return false;
  }

  bool chooseFloatMixFormat(WAVEFORMATEX* mix, std::vector<uint8_t>* formatBytes, std::string* error) {
    if (!mix || !formatBytes) return false;

    const GUID ieeeFloatSubFormat = {
        0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
    const WORD channels = mix->nChannels;
    const DWORD sampleRate = mix->nSamplesPerSec;
    DWORD channelMask = 0;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
      const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix);
      channelMask = extensible->dwChannelMask;
    }

    WAVEFORMATEXTENSIBLE desired{};
    desired.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    desired.Format.nChannels = channels;
    desired.Format.nSamplesPerSec = sampleRate;
    desired.Format.wBitsPerSample = 32;
    desired.Format.nBlockAlign = static_cast<WORD>(channels * sizeof(float));
    desired.Format.nAvgBytesPerSec = desired.Format.nSamplesPerSec * desired.Format.nBlockAlign;
    desired.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    desired.Samples.wValidBitsPerSample = 32;
    desired.dwChannelMask = channelMask;
    desired.SubFormat = ieeeFloatSubFormat;

    WAVEFORMATEX* closest = nullptr;
    HRESULT hr = audioClient->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, &desired.Format, &closest);
    if (closest) CoTaskMemFree(closest);

    if (hr == S_OK) {
      formatBytes->resize(sizeof(WAVEFORMATEXTENSIBLE));
      std::memcpy(formatBytes->data(), &desired, sizeof(WAVEFORMATEXTENSIBLE));
      return true;
    }

    const bool mixIsFloat =
        mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
        (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
         IsEqualGUID(reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mix)->SubFormat, ieeeFloatSubFormat));
    if (!mixIsFloat) {
      if (error) *error = "共享输出混音格式不是 32 位浮点，且设备拒绝 32 位浮点共享输出";
      return false;
    }

    const size_t bytes = sizeof(WAVEFORMATEX) + mix->cbSize;
    formatBytes->resize(bytes);
    std::memcpy(formatBytes->data(), mix, bytes);
    return true;
  }

  void renderLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    DWORD taskIndex = 0;
    HANDLE mmcssHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    while (running.load()) {
      const DWORD waitResult = WaitForSingleObject(samplesReadyEvent, 2000);
      if (!running.load()) break;
      if (waitResult != WAIT_OBJECT_0) continue;

      UINT32 padding = 0;
      HRESULT hr = audioClient->GetCurrentPadding(&padding);
      if (FAILED(hr)) {
        recordRenderFailureFromRenderThread(hr, "无法读取共享输出缓冲状态");
        if (isDeviceInvalidated(hr)) {
          deviceInvalidatedEventQueued.store(true);
          running = false;
          break;
        }
        continue;
      }
      const UINT32 framesAvailable = bufferFrameCount > padding ? bufferFrameCount - padding : 0;
      if (framesAvailable == 0) continue;

      BYTE* data = nullptr;
      hr = renderClient->GetBuffer(framesAvailable, &data);
      if (FAILED(hr)) {
        recordRenderFailureFromRenderThread(hr, "无法获取共享输出缓冲区");
        if (isDeviceInvalidated(hr)) {
          deviceInvalidatedEventQueued.store(true);
          running = false;
          break;
        }
        continue;
      }

      wasapi::renderFloatCallbackWithTailSilence(
          reinterpret_cast<float*>(data),
          framesAvailable,
          outputFormat.channelCount,
          callback);
      hr = renderClient->ReleaseBuffer(framesAvailable, 0);
      if (FAILED(hr)) {
        recordRenderFailureFromRenderThread(hr, "无法提交共享输出缓冲区");
        if (isDeviceInvalidated(hr)) {
          deviceInvalidatedEventQueued.store(true);
          running = false;
          break;
        }
      }
    }

    if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
    CoUninitialize();
    if (deviceInvalidatedEventQueued.exchange(false) && eventCallback) {
      eventCallback(OutputBackendEvent::DeviceInvalidated, "输出设备已失效");
    }
  }

  void launchRenderThread() {
    std::lock_guard lock(threadMutex);
    renderThread = std::thread([this] { renderLoop(); });
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

  void stop() {
    running = false;
    if (samplesReadyEvent) SetEvent(samplesReadyEvent);
    joinRenderThread();
    // Soft mute residual free space after the render thread stops so Stop() does not
    // leave non-zero samples at the device boundary (device-switch click/pop).
    if (audioClient && renderClient && bufferFrameCount > 0 && outputFormat.channelCount > 0) {
      UINT32 padding = 0;
      if (SUCCEEDED(audioClient->GetCurrentPadding(&padding))) {
        const UINT32 framesAvailable = bufferFrameCount > padding ? bufferFrameCount - padding : 0;
        if (framesAvailable > 0) {
          BYTE* data = nullptr;
          if (SUCCEEDED(renderClient->GetBuffer(framesAvailable, &data)) && data) {
            std::memset(
                data,
                0,
                static_cast<size_t>(framesAvailable) * static_cast<size_t>(outputFormat.channelCount) *
                    sizeof(float));
            (void)renderClient->ReleaseBuffer(framesAvailable, AUDCLNT_BUFFERFLAGS_SILENT);
          }
        }
      }
    }
    if (audioClient) audioClient->Stop();
  }

  void close() {
    stop();
    renderClient.Reset();
    audioClient.Reset();
    device.Reset();
    if (samplesReadyEvent) {
      CloseHandle(samplesReadyEvent);
      samplesReadyEvent = nullptr;
    }
    bufferFrameCount = 0;
    callback = nullptr;
    eventCallback = nullptr;
    if (ownerComInitialized) {
      CoUninitialize();
      ownerComInitialized = false;
    }
  }
#else
  void stop() {}
  void close() {}
#endif
};

WasapiSharedBackend::WasapiSharedBackend() : impl_(std::make_unique<Impl>()) {}

WasapiSharedBackend::~WasapiSharedBackend() {
  close();
}

const char* WasapiSharedBackend::id() const {
  return "wasapi";
}

bool WasapiSharedBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  close();
  impl_->outputFormat = {};
  impl_->resetOutputInfo();
  impl_->dopRuntimeFacts = {};

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool shouldUninitialize = SUCCEEDED(hr);
  impl_->ownerComInitialized = shouldUninitialize;
  auto failAfterCom = [&]() {
    impl_->close();
    return false;
  };
  if (hr == RPC_E_CHANGED_MODE) {
    hr = S_OK;
  }
  if (!impl_->succeeded(hr, error, "无法初始化音频输出所需环境", "backend_open_failure")) return false;

  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (!impl_->succeeded(hr, error, "无法创建设备枚举器", "backend_open_failure")) {
    (void)shouldUninitialize;
    return failAfterCom();
  }

  const bool usesDefaultDevice = wasapi::isDefaultDeviceAlias(deviceId);
  auto selectOutputDevice = [&]() {
    impl_->device.Reset();
    if (usesDefaultDevice) {
      return enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &impl_->device);
    }
    const std::wstring id = Impl::utf8ToWide(deviceId);
    return enumerator->GetDevice(id.c_str(), &impl_->device);
  };
  hr = selectOutputDevice();
  if (!impl_->succeeded(hr, error, "无法打开输出设备", "device_not_found")) {
    return failAfterCom();
  }
  impl_->loadDeviceName();

  auto activateAudioClient = [&]() {
    impl_->audioClient.Reset();
    return impl_->device->Activate(
        __uuidof(IAudioClient), CLSCTX_ALL, nullptr, &impl_->audioClient);
  };
  hr = activateAudioClient();
  if (usesDefaultDevice && hr == AUDCLNT_E_DEVICE_INVALIDATED) {
    hr = selectOutputDevice();
    if (!impl_->succeeded(hr, error, "无法重新打开系统默认输出设备", "device_not_found")) {
      return failAfterCom();
    }
    impl_->loadDeviceName();
    hr = activateAudioClient();
  }
  if (!impl_->succeeded(hr, error, "无法激活输出设备音频客户端", "backend_open_failure")) {
    return failAfterCom();
  }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = impl_->audioClient->GetMixFormat(&mixFormat);
  if (!impl_->succeeded(hr, error, "无法读取共享输出混音格式", "backend_open_failure")) {
    return failAfterCom();
  }

  std::vector<uint8_t> activeFormatBytes;
  const bool choseFormat = impl_->chooseFloatMixFormat(mixFormat, &activeFormatBytes, error);
  CoTaskMemFree(mixFormat);
  if (!choseFormat) {
    impl_->recordFailure("format_not_supported", error ? *error : "共享输出格式协商失败");
    return failAfterCom();
  }

  auto* activeFormat = reinterpret_cast<WAVEFORMATEX*>(activeFormatBytes.data());
  constexpr REFERENCE_TIME kBufferDuration = 1000000;  // 100 ms.
  hr = impl_->audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
      kBufferDuration,
      0,
      activeFormat,
      nullptr);
  if (!impl_->succeeded(hr, error, "无法初始化共享输出音频流", "backend_open_failure")) {
    return failAfterCom();
  }

  impl_->samplesReadyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!impl_->samplesReadyEvent) {
    impl_->recordFailure("backend_open_failure", "无法创建输出事件", error);
    return failAfterCom();
  }
  hr = impl_->audioClient->SetEventHandle(impl_->samplesReadyEvent);
  if (!impl_->succeeded(hr, error, "无法绑定输出事件", "backend_open_failure")) {
    return failAfterCom();
  }

  hr = impl_->audioClient->GetBufferSize(&impl_->bufferFrameCount);
  if (!impl_->succeeded(hr, error, "无法读取输出缓冲区大小", "backend_open_failure")) {
    return failAfterCom();
  }
  hr = impl_->audioClient->GetService(IID_PPV_ARGS(&impl_->renderClient));
  if (!impl_->succeeded(hr, error, "无法获取输出渲染客户端", "backend_open_failure")) {
    return failAfterCom();
  }

  impl_->outputFormat.sampleRate = static_cast<int>(activeFormat->nSamplesPerSec);
  impl_->outputFormat.channelCount = static_cast<int>(activeFormat->nChannels);
  impl_->outputFormat.bitDepth = 32;
  impl_->outputFormat.sampleFormat = AudioSampleFormat::Float32Interleaved;
  impl_->outputInfo.exclusive = false;
  impl_->outputInfo.accessMode = "shared";
  impl_->outputInfo.supportsOutputPerfect = false;
  impl_->outputInfo.sourceExact = false;
  impl_->outputInfo.outputPerfect = false;
  impl_->outputInfo.pcmPassthrough = false;
  impl_->outputInfo.resampled = requestedFormat.sampleRate != impl_->outputFormat.sampleRate ||
                                requestedFormat.channelCount != impl_->outputFormat.channelCount ||
                                requestedFormat.bitDepth != impl_->outputFormat.bitDepth;
  impl_->outputInfo.perfectReasonCode = "shared_mixer";
  impl_->outputInfo.perfectReason = sharedPerfectReason(requestedFormat);
  impl_->outputInfo.capabilityReason = impl_->outputInfo.perfectReason;
  impl_->outputInfo.outputSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.outputBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.backend = "wasapi";
  impl_->outputInfo.actualBackend = "wasapi";
  impl_->outputInfo.devicePathKind = "default";
  impl_->outputInfo.deviceName = impl_->deviceName;
  impl_->outputInfo.actualDeviceName = impl_->deviceName;
  impl_->outputInfo.actualOutputFormat = sampleFormatToString(impl_->outputFormat.sampleFormat);
  impl_->outputInfo.actualSampleRate = impl_->outputFormat.sampleRate;
  impl_->outputInfo.actualBitDepth = impl_->outputFormat.bitDepth;
  impl_->outputInfo.actualChannels = impl_->outputFormat.channelCount;
  impl_->outputInfo.bufferSizeFrames = static_cast<int>(impl_->bufferFrameCount);
  impl_->outputInfo.latencyInfo.bufferLatencyMs =
      impl_->outputFormat.sampleRate > 0
          ? static_cast<double>(impl_->bufferFrameCount) * 1000.0 / static_cast<double>(impl_->outputFormat.sampleRate)
          : 0.0;
  REFERENCE_TIME streamLatency = 0;
  hr = impl_->audioClient->GetStreamLatency(&streamLatency);
  if (SUCCEEDED(hr)) {
    const double streamLatencyMs = referenceTimeToMilliseconds(streamLatency);
    impl_->outputInfo.latencyInfo.outputLatencyMs =
        std::max(0.0, streamLatencyMs - impl_->outputInfo.latencyInfo.bufferLatencyMs);
    impl_->outputInfo.latencyInfo.totalLatencyMs =
        impl_->outputInfo.latencyInfo.bufferLatencyMs + impl_->outputInfo.latencyInfo.outputLatencyMs;
  } else {
    impl_->outputInfo.latencyInfo.outputLatencyMs = 0.0;
    impl_->outputInfo.latencyInfo.totalLatencyMs = impl_->outputInfo.latencyInfo.bufferLatencyMs;
  }
  impl_->outputInfo.latencyMs = impl_->outputInfo.latencyInfo.totalLatencyMs;
  impl_->dopRuntimeFacts = {};
  if (looksLikeDsdOrDopRequest(requestedFormat) || isDopCarrierFormat(impl_->outputFormat)) {
    impl_->dopRuntimeFacts.state = DopRuntimeFactState::Unproven;
    impl_->dopRuntimeFacts.candidateFormat = dopCandidateForRequestedFormat(requestedFormat);
    impl_->dopRuntimeFacts.actualFormat = isDopCarrierFormat(impl_->outputFormat) ? impl_->outputFormat : AudioFormat{};
    impl_->dopRuntimeFacts.reason = "WASAPI shared mixer cannot prove DoP passthrough";
  }

  return true;
#else
  (void)deviceId;
  (void)requestedFormat;
  if (error) *error = "当前构建未启用系统音频输出";
  return false;
#endif
}

bool WasapiSharedBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)config;
  (void)error;
  return true;
}

bool WasapiSharedBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  if (!impl_->audioClient || !impl_->renderClient) {
    impl_->recordFailure("backend_start_failure", "共享输出后端尚未打开", error);
    return false;
  }
  if (impl_->running.load()) {
    impl_->recordFailure("backend_start_failure", "共享输出后端已经在运行", error);
    return false;
  }

  impl_->callback = std::move(callback);
  impl_->eventCallback = std::move(eventCallback);

  BYTE* data = nullptr;
  HRESULT hr = impl_->renderClient->GetBuffer(impl_->bufferFrameCount, &data);
  if (!impl_->renderSucceeded(hr, error, "无法预填充输出缓冲区")) return false;
  // Prefill with silence so Start() does not attack at full level after a device rebind.
  // Still pull one buffer of samples from the decoder so the stream position stays aligned.
  if (data) {
    wasapi::renderFloatCallbackWithLeadingSilence(
        reinterpret_cast<float*>(data),
        impl_->bufferFrameCount,
        impl_->outputFormat.channelCount,
        impl_->callback,
        impl_->bufferFrameCount);
  }
  hr = impl_->renderClient->ReleaseBuffer(impl_->bufferFrameCount, AUDCLNT_BUFFERFLAGS_SILENT);
  if (!impl_->renderSucceeded(hr, error, "无法提交预填充输出缓冲区")) return false;

  impl_->running = true;
  impl_->launchRenderThread();

  hr = impl_->audioClient->Start();
  const char* startReasonCode = Impl::isDeviceInvalidated(hr) ? "device_lost" : "backend_start_failure";
  if (!impl_->succeeded(hr, error, "无法启动共享输出音频流", startReasonCode)) {
    impl_->stop();
    return false;
  }
  return true;
#else
  (void)callback;
  (void)eventCallback;
  if (error) *error = "当前构建未启用系统音频输出";
  return false;
#endif
}

void WasapiSharedBackend::stop() {
  impl_->stop();
}

void WasapiSharedBackend::close() {
  impl_->close();
}

AudioFormat WasapiSharedBackend::outputFormat() const {
  return impl_->outputFormat;
}

OutputInfo WasapiSharedBackend::outputInfo() const {
  OutputInfo info;
  HRESULT deferredRenderFailureHr = S_OK;
  const char* deferredRenderFailureMessage = nullptr;
  {
    std::lock_guard lock(impl_->infoMutex);
    info = impl_->outputInfo;
    info.diagnostics = impl_->diagnostics;
    deferredRenderFailureHr = impl_->deferredRenderFailureHr.load(std::memory_order_relaxed);
    deferredRenderFailureMessage = impl_->deferredRenderFailureMessage.load(std::memory_order_relaxed);
  }
  if (deferredRenderFailureMessage && FAILED(deferredRenderFailureHr)) {
    const std::string reason = hresultMessage(deferredRenderFailureMessage, deferredRenderFailureHr);
    info.perfectReasonCode =
        wasapi::isDeviceInvalidated(deferredRenderFailureHr) ? "device_lost" : "render_failure";
    info.diagnostics.lastError = reason;
    info.capabilityReason = reason;
    info.perfectReason = reason;
  }
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts WasapiSharedBackend::dopRuntimeFacts() const {
  return impl_->dopRuntimeFacts;
}

NativeDsdRuntimeFacts WasapiSharedBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("WASAPI shared output does not support Native DSD");
}

std::string WasapiSharedBackend::deviceName() const {
  return impl_->deviceName;
}

bool wasapiSharedBackendAvailable() {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
