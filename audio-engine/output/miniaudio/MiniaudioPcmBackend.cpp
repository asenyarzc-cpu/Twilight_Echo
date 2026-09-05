#include "MiniaudioPcmBackend.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <thread>
#include <utility>

#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include "../../third_party/miniaudio/miniaudio.h"
#endif

namespace twilight::audio {
namespace {

using miniaudio_backend_detail::Api;
using miniaudio_backend_detail::CallbackContext;
using miniaudio_backend_detail::DeviceConfig;
using miniaudio_backend_detail::DeviceDescriptor;
using miniaudio_backend_detail::DeviceFormat;
using miniaudio_backend_detail::DeviceState;
using miniaudio_backend_detail::NotificationType;

constexpr uint32_t kDeviceInvalidatedEvent = 1U << 0;
constexpr uint32_t kRenderErrorEvent = 1U << 1;

struct EventThreadState {
  std::atomic<uint32_t> pendingEvents{0};
  std::atomic<bool> stop{false};
  std::mutex waitMutex;
  std::condition_variable condition;
};

struct EventDispatch {
  bool valid = false;
  OutputBackendEvent event = OutputBackendEvent::DeviceInvalidated;
  uint32_t remainingEvents = 0;
  std::string message;
  OutputEventCallback callback;
};

using EventHandler = EventDispatch (*)(void* userData, uint32_t events);

void runEventLoop(std::shared_ptr<EventThreadState> state, EventHandler handler, void* userData) {
  for (;;) {
    uint32_t events = 0;
    {
      std::unique_lock waitLock(state->waitMutex);
      state->condition.wait_for(waitLock, std::chrono::milliseconds(10), [&state] {
        return state->stop.load(std::memory_order_acquire) ||
               state->pendingEvents.load(std::memory_order_acquire) != 0;
      });
      if (state->stop.load(std::memory_order_acquire)) return;
      events = state->pendingEvents.exchange(0, std::memory_order_acq_rel);
    }

    EventDispatch dispatch = handler ? handler(userData, events) : EventDispatch{};
    if (dispatch.remainingEvents != 0) {
      state->pendingEvents.fetch_or(dispatch.remainingEvents, std::memory_order_release);
    }
    if (state->stop.load(std::memory_order_acquire)) return;
    if (dispatch.valid && dispatch.callback) {
      dispatch.callback(dispatch.event, dispatch.message);
    }
  }
}

bool isDefaultDeviceAlias(const std::string& deviceId) {
  return deviceId.empty() || deviceId == "auto" || deviceId == "default" || deviceId == "System Default" ||
         deviceId == "system default" || deviceId == "system-default" || deviceId == "系统默认";
}

bool isDsdOrDopRequest(const AudioFormat& format) {
  const bool dsdRate = format.sampleRate == 2822400 || format.sampleRate == 5644800 ||
                       format.sampleRate == 11289600 || format.sampleRate == 22579200;
  return isDsdSampleFormat(format.sampleFormat) || dsdRate || isDopCarrierFormat(format);
}

std::string resultMessage(const char* operation, int result) {
  return std::string("miniaudio ") + operation + " 失败 (result " + std::to_string(result) + ")";
}

const char* resultReasonCode(const char* operation, int result) {
  if (result == -204) return "device_not_found";
  if (result == -200) return "format_not_supported";
  if (result == -203 || result == -208) return "backend_unavailable";
  return std::strcmp(operation, "start") == 0 ? "backend_start_failure" : "backend_open_failure";
}

bool toAudioFormat(DeviceFormat source, AudioFormat* target) {
  if (!target) return false;
  AudioFormat format;
  switch (source) {
    case DeviceFormat::U8:
      return false;
    case DeviceFormat::S16:
      format.bitDepth = 16;
      format.sampleFormat = AudioSampleFormat::Int16Interleaved;
      break;
    case DeviceFormat::S24:
      format.bitDepth = 24;
      format.sampleFormat = AudioSampleFormat::Int24Interleaved;
      break;
    case DeviceFormat::S32:
      format.bitDepth = 32;
      format.sampleFormat = AudioSampleFormat::Int32Interleaved;
      break;
    case DeviceFormat::F32:
      format.bitDepth = 32;
      format.sampleFormat = AudioSampleFormat::Float32Interleaved;
      break;
    case DeviceFormat::Unknown:
    default:
      return false;
  }
  *target = format;
  return true;
}

int bitDepthForDeviceFormat(DeviceFormat format) {
  switch (format) {
    case DeviceFormat::U8:
      return 8;
    case DeviceFormat::S16:
      return 16;
    case DeviceFormat::S24:
      return 24;
    case DeviceFormat::S32:
    case DeviceFormat::F32:
      return 32;
    case DeviceFormat::Unknown:
    default:
      return 0;
  }
}

#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)

std::string wasapiDeviceIdToUtf8(const ma_device_id& id) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, id.wasapi, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, id.wasapi, -1, out.data(), size, nullptr, nullptr);
  if (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

int realEnumeratePlaybackDevices(void*, std::vector<DeviceDescriptor>* devices) {
  if (!devices) return MA_INVALID_ARGS;
  devices->clear();
  static_assert(sizeof(ma_device_id) <= miniaudio_backend_detail::kAdapterDeviceIdCapacity);

  const ma_backend backends[] = {ma_backend_wasapi};
  ma_context context{};
  ma_result result = ma_context_init(backends, 1, nullptr, &context);
  if (result != MA_SUCCESS) return result;

  ma_device_info* playbackDevices = nullptr;
  ma_uint32 playbackDeviceCount = 0;
  result = ma_context_get_devices(&context, &playbackDevices, &playbackDeviceCount, nullptr, nullptr);
  if (result == MA_SUCCESS) {
    devices->reserve(playbackDeviceCount);
    for (ma_uint32 index = 0; index < playbackDeviceCount; ++index) {
      const ma_device_info& source = playbackDevices[index];
      DeviceDescriptor target;
      target.platformStableId = wasapiDeviceIdToUtf8(source.id);
      target.label = source.name;
      target.isDefault = source.isDefault == MA_TRUE;
      target.adapterDeviceIdSize = sizeof(source.id);
      std::memcpy(target.adapterDeviceId.data(), &source.id, sizeof(source.id));
      devices->push_back(std::move(target));
    }
  }
  ma_context_uninit(&context);
  return result;
}

DeviceFormat fromMiniaudioFormat(ma_format format) {
  switch (format) {
    case ma_format_u8:
      return DeviceFormat::U8;
    case ma_format_s16:
      return DeviceFormat::S16;
    case ma_format_s24:
      return DeviceFormat::S24;
    case ma_format_s32:
      return DeviceFormat::S32;
    case ma_format_f32:
      return DeviceFormat::F32;
    case ma_format_unknown:
    default:
      return DeviceFormat::Unknown;
  }
}

NotificationType fromMiniaudioNotification(ma_device_notification_type type) {
  switch (type) {
    case ma_device_notification_type_started:
      return NotificationType::Started;
    case ma_device_notification_type_stopped:
      return NotificationType::Stopped;
    case ma_device_notification_type_rerouted:
      return NotificationType::Rerouted;
    case ma_device_notification_type_interruption_began:
      return NotificationType::InterruptionBegan;
    case ma_device_notification_type_interruption_ended:
      return NotificationType::InterruptionEnded;
    case ma_device_notification_type_unlocked:
      return NotificationType::Unlocked;
    default:
      return NotificationType::Stopped;
  }
}

void copyDeviceState(const ma_device* device, DeviceState* state) {
  *state = {};
  state->callbackSampleRate = device->sampleRate;
  state->callbackFormat = fromMiniaudioFormat(device->playback.format);
  state->callbackChannels = device->playback.channels;
  state->internalSampleRate = device->playback.internalSampleRate;
  state->internalFormat = fromMiniaudioFormat(device->playback.internalFormat);
  state->internalChannels = device->playback.internalChannels;
  state->internalPeriodSizeFrames = device->playback.internalPeriodSizeInFrames;
  state->internalPeriods = device->playback.internalPeriods;
  state->bufferSizeFrames = device->wasapi.actualBufferSizeInFramesPlayback;
  if (state->bufferSizeFrames == 0) {
    const uint64_t calculatedBufferSize =
        static_cast<uint64_t>(state->internalPeriodSizeFrames) * static_cast<uint64_t>(state->internalPeriods);
    state->bufferSizeFrames = calculatedBufferSize > std::numeric_limits<uint32_t>::max()
                                  ? std::numeric_limits<uint32_t>::max()
                                  : static_cast<uint32_t>(calculatedBufferSize);
  }
  state->conversionInfoAvailable = state->callbackFormat != DeviceFormat::Unknown &&
                                   state->internalFormat != DeviceFormat::Unknown &&
                                   state->callbackSampleRate > 0 && state->internalSampleRate > 0 &&
                                   state->callbackChannels > 0 && state->internalChannels > 0;
  state->sampleFormatConverted = device->playback.converter.hasPreFormatConversion != MA_FALSE ||
                                 device->playback.converter.hasPostFormatConversion != MA_FALSE;
  state->sampleRateConverted = device->playback.converter.hasResampler != MA_FALSE;
  state->channelLayoutConverted = device->playback.converter.hasChannelConverter != MA_FALSE;
  std::strncpy(state->deviceName, device->playback.name, sizeof(state->deviceName) - 1);
  const std::string stableId = wasapiDeviceIdToUtf8(device->playback.id);
  std::strncpy(state->deviceId, stableId.c_str(), sizeof(state->deviceId) - 1);
}

void realDataCallback(ma_device* device, void* output, const void*, ma_uint32 frameCount) {
  if (!device || !device->pUserData) return;
  auto* context = static_cast<CallbackContext*>(device->pUserData);
  if (context->dataCallback) context->dataCallback(context->userData, output, frameCount);
}

void realNotificationCallback(const ma_device_notification* notification) {
  if (!notification || !notification->pDevice || !notification->pDevice->pUserData) return;
  auto* context = static_cast<CallbackContext*>(notification->pDevice->pUserData);
  if (context->notificationCallback) {
    context->notificationCallback(context->userData, fromMiniaudioNotification(notification->type));
  }
}

void* realCreateDevice(void*) {
  return new (std::nothrow) ma_device{};
}

void realDestroyDevice(void*, void* device) {
  delete static_cast<ma_device*>(device);
}

int realInitializeDevice(void*, void* storage, const DeviceConfig* config, DeviceState* state) {
  if (!storage || !config || !state || !config->callbackContext || !config->callbackContext->dataCallback ||
      !config->callbackContext->notificationCallback) {
    return MA_INVALID_ARGS;
  }
  if (!config->shared) return MA_INVALID_DEVICE_CONFIG;

  ma_device_config deviceConfig = ma_device_config_init(ma_device_type_playback);
  deviceConfig.sampleRate = config->sampleRate;
  deviceConfig.noFixedSizedCallback = config->noFixedSizedCallback ? MA_TRUE : MA_FALSE;
  deviceConfig.wasapi.noAutoConvertSRC = config->noAutoConvertSRC ? MA_TRUE : MA_FALSE;
  deviceConfig.wasapi.noAutoStreamRouting = config->allowAutomaticReroute ? MA_FALSE : MA_TRUE;
  deviceConfig.noPreSilencedOutputBuffer = MA_TRUE;
  deviceConfig.noClip = MA_TRUE;
  deviceConfig.dataCallback = realDataCallback;
  deviceConfig.notificationCallback = realNotificationCallback;
  deviceConfig.pUserData = config->callbackContext;
  ma_device_id selectedDeviceId{};
  if (config->selectedDevice) {
    if (config->selectedDevice->adapterDeviceIdSize != sizeof(selectedDeviceId)) return MA_INVALID_ARGS;
    std::memcpy(
        &selectedDeviceId,
        config->selectedDevice->adapterDeviceId.data(),
        sizeof(selectedDeviceId));
    deviceConfig.playback.pDeviceID = &selectedDeviceId;
  } else {
    deviceConfig.playback.pDeviceID = nullptr;
  }
  deviceConfig.playback.format = ma_format_f32;
  deviceConfig.playback.channels = config->channels;
  deviceConfig.playback.shareMode = ma_share_mode_shared;

  auto* device = static_cast<ma_device*>(storage);
  const ma_result result = ma_device_init(nullptr, &deviceConfig, device);
  if (result != MA_SUCCESS) return result;
  copyDeviceState(device, state);
  return MA_SUCCESS;
}

int realReadDeviceState(void*, void* storage, DeviceState* state) {
  if (!storage || !state) return MA_INVALID_ARGS;
  copyDeviceState(static_cast<const ma_device*>(storage), state);
  return MA_SUCCESS;
}

int realStartDevice(void*, void* storage) {
  return storage ? ma_device_start(static_cast<ma_device*>(storage)) : MA_INVALID_ARGS;
}

int realStopDevice(void*, void* storage) {
  return storage ? ma_device_stop(static_cast<ma_device*>(storage)) : MA_INVALID_ARGS;
}

void realUninitializeDevice(void*, void* storage) {
  if (storage) ma_device_uninit(static_cast<ma_device*>(storage));
}

#endif

}  // namespace

namespace miniaudio_backend_detail {

const Api& realApi() {
#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
  static const Api api = {
      nullptr,
      realEnumeratePlaybackDevices,
      realCreateDevice,
      realDestroyDevice,
      realInitializeDevice,
      realReadDeviceState,
      realStartDevice,
      realStopDevice,
      realUninitializeDevice};
  return api;
#else
  static const Api api{};
  return api;
#endif
}

}  // namespace miniaudio_backend_detail

struct MiniaudioPcmBackend::Impl {
  explicit Impl(const Api& selectedApi) : api(selectedApi) {
    callbackContext.dataCallback = &Impl::dataCallback;
    callbackContext.notificationCallback = &Impl::notificationCallback;
    callbackContext.userData = this;
    resetOutputInfo();
  }

  ~Impl() { close(); }

  Api api;
  CallbackContext callbackContext;
  void* device = nullptr;
  bool initialized = false;
  bool started = false;
  std::atomic<bool> stopRequested{true};
  RenderCallback callback;
  OutputEventCallback eventCallback;
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  OutputInfo::Diagnostics diagnostics;
  std::string deviceName = "系统默认";
  DopRuntimeFacts dopFacts;
  mutable std::mutex infoMutex;
  std::mutex lifecycleMutex;
  std::atomic<EventThreadState*> eventState{nullptr};
  std::shared_ptr<EventThreadState> eventStateOwner;
  std::thread eventThread;
  std::atomic<uint32_t> callbackChannels{0};
  std::atomic<uint64_t> sessionShortRenderCount{0};
  std::atomic<uint64_t> lifetimeShortRenderCount{0};

  static void dataCallback(void* userData, void* output, uint32_t frameCount) noexcept {
    auto* impl = static_cast<Impl*>(userData);
    if (!impl) return;

    const uint32_t channels = impl->callbackChannels.load(std::memory_order_relaxed);
    if (!output || channels == 0) {
      impl->queueEvent(kRenderErrorEvent, false);
      return;
    }
    if (frameCount == 0) return;

    const size_t requestedFrames = static_cast<size_t>(frameCount);
    size_t renderedFrames = 0;
    if (impl->callback) {
      renderedFrames = impl->callback(static_cast<float*>(output), requestedFrames);
    } else {
      impl->queueEvent(kRenderErrorEvent, false);
    }
    if (renderedFrames > requestedFrames) {
      renderedFrames = requestedFrames;
      impl->queueEvent(kRenderErrorEvent, false);
    }
    if (renderedFrames < requestedFrames) {
      impl->sessionShortRenderCount.fetch_add(1, std::memory_order_relaxed);
      impl->lifetimeShortRenderCount.fetch_add(1, std::memory_order_relaxed);
      const size_t sampleOffset = renderedFrames * static_cast<size_t>(channels);
      const size_t tailSamples = (requestedFrames - renderedFrames) * static_cast<size_t>(channels);
      std::memset(static_cast<float*>(output) + sampleOffset, 0, tailSamples * sizeof(float));
    }
  }

  static void notificationCallback(void* userData, NotificationType type) noexcept {
    auto* impl = static_cast<Impl*>(userData);
    if (!impl) return;
    if (type == NotificationType::Rerouted) {
      impl->queueEvent(kDeviceInvalidatedEvent, true);
    } else if (type == NotificationType::Stopped && !impl->stopRequested.load(std::memory_order_relaxed)) {
      impl->queueEvent(kDeviceInvalidatedEvent, true);
    }
  }

  void queueEvent(uint32_t event, bool wakeEventThread) noexcept {
    EventThreadState* state = eventState.load(std::memory_order_acquire);
    if (!state) return;
    state->pendingEvents.fetch_or(event, std::memory_order_release);
    if (wakeEventThread) state->condition.notify_one();
  }

  static EventDispatch prepareEvent(void* userData, uint32_t events) {
    auto* impl = static_cast<Impl*>(userData);
    EventDispatch dispatch;
    if (!impl) return dispatch;

    if ((events & kDeviceInvalidatedEvent) != 0) {
      DeviceState state;
      {
        std::lock_guard lifecycleLock(impl->lifecycleMutex);
        if (impl->device && impl->initialized && impl->api.readDeviceState) {
          const int result = impl->api.readDeviceState(impl->api.userData, impl->device, &state);
          if (result == 0) {
            impl->updateOutputInfo(state);
          } else {
            impl->recordFailure("backend_state_failure", resultMessage("读取重新路由后的设备状态", result));
          }
        }
      }
      dispatch.valid = true;
      dispatch.event = OutputBackendEvent::DeviceInvalidated;
      dispatch.message = "miniaudio 输出设备已重新路由或停止";
      dispatch.remainingEvents = events & ~kDeviceInvalidatedEvent;
    } else if ((events & kRenderErrorEvent) != 0) {
      dispatch.valid = true;
      dispatch.event = OutputBackendEvent::RenderError;
      dispatch.message = "miniaudio 输出回调失败";
    }

    if (dispatch.valid) {
      std::lock_guard lock(impl->infoMutex);
      dispatch.callback = impl->eventCallback;
    }
    return dispatch;
  }

  void startEventThread() {
    auto state = std::make_shared<EventThreadState>();
    eventStateOwner = state;
    eventState.store(state.get(), std::memory_order_release);
    eventThread = std::thread(runEventLoop, std::move(state), &Impl::prepareEvent, this);
  }

  void stopEventThread() {
    const std::shared_ptr<EventThreadState> state = eventStateOwner;
    if (state) {
      state->stop.store(true, std::memory_order_release);
      state->pendingEvents.store(0, std::memory_order_release);
      state->condition.notify_one();
    }
    if (eventThread.joinable()) {
      if (eventThread.get_id() == std::this_thread::get_id()) {
        eventThread.detach();
      } else {
        eventThread.join();
      }
    }
  }

  bool hasValidApi() const {
    return api.enumeratePlaybackDevices && api.createDevice && api.destroyDevice && api.initializeDevice &&
           api.readDeviceState && api.startDevice && api.stopDevice && api.uninitializeDevice;
  }

  void resetOutputInfo() {
    std::lock_guard lock(infoMutex);
    OutputInfo::Diagnostics lifetime = diagnostics;
    diagnostics = {};
    diagnostics.lifetimeUnderrunCount = lifetime.lifetimeUnderrunCount;
    diagnostics.lifetimeBufferDropCount = lifetime.lifetimeBufferDropCount;
    diagnostics.lifetimeRecoveryCount = lifetime.lifetimeRecoveryCount;
    diagnostics.driverRestartCount = lifetime.driverRestartCount;
    diagnostics.deviceLostCount = lifetime.deviceLostCount;
    sessionShortRenderCount.store(0, std::memory_order_relaxed);

    outputInfo = {};
    outputInfo.exclusive = false;
    outputInfo.accessMode = "shared";
    outputInfo.supportsOutputPerfect = false;
    outputInfo.sourceExact = false;
    outputInfo.outputPerfect = false;
    outputInfo.pcmPassthrough = false;
    outputInfo.providerImplementation = "miniaudio";
    outputInfo.conversionInfo.source = "unavailable";
    outputInfo.backend = "wasapi";
    outputInfo.actualBackend = "wasapi";
    outputInfo.devicePathKind = "default";
    outputInfo.deviceName = deviceName;
    outputInfo.actualDeviceName = deviceName;
    outputInfo.diagnostics = diagnostics;
  }

  void recordFailure(const char* reasonCode, const std::string& reason, std::string* error = nullptr) {
    std::lock_guard lock(infoMutex);
    diagnostics.lastError = reason;
    outputInfo.perfectReasonCode = reasonCode ? reasonCode : "backend_open_failure";
    outputInfo.capabilityReason = reason;
    outputInfo.perfectReason = reason;
    outputInfo.diagnostics = diagnostics;
    if (error) *error = reason;
  }

  void updateOutputInfo(const DeviceState& state) {
    AudioFormat callbackFormat;
    const bool callbackFormatKnown = toAudioFormat(state.callbackFormat, &callbackFormat);
    AudioFormat actualFormat;
    const bool actualFormatKnown = toAudioFormat(state.internalFormat, &actualFormat);
    const bool callbackStateKnown = callbackFormatKnown && state.callbackSampleRate > 0 && state.callbackChannels > 0;
    const bool actualStateKnown = actualFormatKnown && state.internalSampleRate > 0 && state.internalChannels > 0;
    const bool sampleRateConversion = state.conversionInfoAvailable
                                          ? state.sampleRateConverted
                                          : (callbackStateKnown && actualStateKnown &&
                                             state.callbackSampleRate != state.internalSampleRate);
    const bool sampleFormatConversion = state.conversionInfoAvailable
                                            ? state.sampleFormatConverted
                                            : (callbackFormatKnown && actualFormatKnown &&
                                               callbackFormat.sampleFormat != actualFormat.sampleFormat);
    const bool channelLayoutConversion = state.conversionInfoAvailable
                                             ? state.channelLayoutConverted
                                             : (callbackStateKnown && actualStateKnown &&
                                                state.callbackChannels != state.internalChannels);
    const uint64_t calculatedBufferFrames = static_cast<uint64_t>(state.internalPeriodSizeFrames) *
                                            static_cast<uint64_t>(state.internalPeriods);
    const uint32_t bufferFrames = state.bufferSizeFrames != 0
                                      ? state.bufferSizeFrames
                                      : calculatedBufferFrames > std::numeric_limits<uint32_t>::max()
                                          ? std::numeric_limits<uint32_t>::max()
                                          : static_cast<uint32_t>(calculatedBufferFrames);
    const int latencyRate = state.internalSampleRate > 0 ? static_cast<int>(state.internalSampleRate)
                                                         : static_cast<int>(state.callbackSampleRate);
    const std::string stateDeviceName = state.deviceName[0] != '\0' ? state.deviceName : "系统默认";

    if (callbackStateKnown) {
      callbackFormat.sampleRate = static_cast<int>(state.callbackSampleRate);
      callbackFormat.channelCount = static_cast<int>(state.callbackChannels);
    }
    if (actualStateKnown) {
      actualFormat.sampleRate = static_cast<int>(state.internalSampleRate);
      actualFormat.channelCount = static_cast<int>(state.internalChannels);
    }

    std::lock_guard lock(infoMutex);
    if (callbackStateKnown) {
      outputFormat = callbackFormat;
      callbackChannels.store(state.callbackChannels, std::memory_order_release);
    } else {
      outputFormat = {};
      callbackChannels.store(0, std::memory_order_release);
    }
    deviceName = stateDeviceName;
    outputInfo.providerImplementation = "miniaudio";
    outputInfo.exclusive = false;
    outputInfo.accessMode = "shared";
    outputInfo.supportsOutputPerfect = false;
    outputInfo.sourceExact = false;
    outputInfo.outputPerfect = false;
    outputInfo.pcmPassthrough = false;
    outputInfo.resampled = sampleRateConversion;
    outputInfo.outputSampleRate = callbackStateKnown ? callbackFormat.sampleRate : 0;
    outputInfo.outputBitDepth = callbackStateKnown ? bitDepthForDeviceFormat(state.callbackFormat) : 0;
    outputInfo.outputChannels = callbackStateKnown ? callbackFormat.channelCount : 0;
    outputInfo.outputSampleFormat =
        callbackStateKnown ? sampleFormatToString(callbackFormat.sampleFormat) : "";
    outputInfo.backend = "wasapi";
    outputInfo.actualBackend = "wasapi";
    outputInfo.devicePathKind = "default";
    outputInfo.deviceName = deviceName;
    outputInfo.actualDeviceName = deviceName;
    outputInfo.actualDeviceId = state.deviceId;
    outputInfo.actualOutputFormat = actualStateKnown ? sampleFormatToString(actualFormat.sampleFormat) : "unknown";
    outputInfo.actualSampleRate = actualStateKnown ? actualFormat.sampleRate : 0;
    outputInfo.actualBitDepth = actualStateKnown ? bitDepthForDeviceFormat(state.internalFormat) : 0;
    outputInfo.actualChannels = actualStateKnown ? actualFormat.channelCount : 0;
    outputInfo.bufferSizeFrames = static_cast<int>(bufferFrames);
    outputInfo.latencyFrames = static_cast<int>(bufferFrames);
    outputInfo.latencyInfo.bufferLatencyMs =
        latencyRate > 0 ? static_cast<double>(bufferFrames) * 1000.0 / static_cast<double>(latencyRate) : 0.0;
    outputInfo.latencyInfo.outputLatencyMs = 0.0;
    outputInfo.latencyInfo.totalLatencyMs = outputInfo.latencyInfo.bufferLatencyMs;
    outputInfo.latencyMs = outputInfo.latencyInfo.totalLatencyMs;
    outputInfo.perfectReasonCode = "shared_mixer";
    outputInfo.perfectReason = "miniaudio WASAPI Shared 输出经过系统混音";
    outputInfo.capabilityReason = outputInfo.perfectReason;
    outputInfo.conversionInfo.sampleFormatConverted = sampleFormatConversion;
    outputInfo.conversionInfo.sampleRateConverted = sampleRateConversion;
    outputInfo.conversionInfo.channelLayoutConverted = channelLayoutConversion;
    outputInfo.conversionInfo.source = state.conversionInfoAvailable && callbackStateKnown && actualStateKnown
                                            ? "backend-runtime"
                                            : "unavailable";
    outputInfo.diagnostics = diagnostics;
  }

  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
    close();
    dopFacts = {};
    resetOutputInfo();

    if (isDsdOrDopRequest(requestedFormat)) {
      const std::string reason = "miniaudio Shared PoC 不支持 DSD/DoP 输出";
      recordFailure("format_not_supported", reason, error);
      return false;
    }
    if (!hasValidApi()) {
      const std::string reason = "当前构建未启用 miniaudio Shared provider";
      recordFailure("backend_unavailable", reason, error);
      return false;
    }

    std::vector<DeviceDescriptor> devices;
    const int enumerateResult = api.enumeratePlaybackDevices(api.userData, &devices);
    if (enumerateResult != 0) {
      const std::string reason = resultMessage("枚举 Shared WASAPI 设备", enumerateResult);
      recordFailure(resultReasonCode("enumerate", enumerateResult), reason, error);
      return false;
    }
    const bool useDefaultRole = isDefaultDeviceAlias(deviceId);
    const auto matchesSelection = [&](const DeviceDescriptor& candidate) {
      return useDefaultRole ? candidate.isDefault : candidate.platformStableId == deviceId;
    };
    const size_t matchCount = static_cast<size_t>(std::count_if(devices.begin(), devices.end(), matchesSelection));
    if (matchCount == 0) {
      const std::string reason = useDefaultRole ? "miniaudio 未找到 console role 的默认输出设备"
                                                : "miniaudio 未找到显式输出设备：" + deviceId;
      recordFailure("device_not_found", reason, error);
      return false;
    }
    if (matchCount != 1) {
      const std::string reason = useDefaultRole ? "miniaudio 设备目录包含多个 console role 默认输出设备"
                                                : "miniaudio 设备目录包含重复的稳定设备 ID：" + deviceId;
      recordFailure("device_id_ambiguous", reason, error);
      return false;
    }
    const DeviceDescriptor selectedDevice = *std::find_if(devices.begin(), devices.end(), matchesSelection);
    if (selectedDevice.platformStableId.empty() || selectedDevice.adapterDeviceIdSize == 0) {
      const std::string reason = "miniaudio 设备目录返回了无效的稳定设备 ID";
      recordFailure("device_id_invalid", reason, error);
      return false;
    }

    device = api.createDevice(api.userData);
    if (!device) {
      const std::string reason = "miniaudio 创建设备存储失败";
      recordFailure("backend_open_failure", reason, error);
      return false;
    }

    DeviceConfig config;
    config.sampleRate = requestedFormat.sampleRate > 0 ? static_cast<uint32_t>(requestedFormat.sampleRate) : 0;
    config.channels = requestedFormat.channelCount > 0 ? static_cast<uint32_t>(requestedFormat.channelCount) : 0;
    config.shared = true;
    config.noFixedSizedCallback = true;
    config.noAutoConvertSRC = true;
    config.allowAutomaticReroute = false;
    config.callbackContext = &callbackContext;
    config.selectedDevice = &selectedDevice;
    DeviceState state;
    const int result = api.initializeDevice(api.userData, device, &config, &state);
    if (result != 0) {
      const std::string reason = resultMessage("初始化 Shared WASAPI 设备", result);
      recordFailure(resultReasonCode("open", result), reason, error);
      api.destroyDevice(api.userData, device);
      device = nullptr;
      return false;
    }
    initialized = true;

    if (state.callbackFormat != DeviceFormat::F32 || state.callbackSampleRate == 0 || state.callbackChannels == 0) {
      const std::string reason = "miniaudio callback format 不是有效的 Float32 interleaved PCM";
      recordFailure("format_not_supported", reason, error);
      api.uninitializeDevice(api.userData, device);
      initialized = false;
      api.destroyDevice(api.userData, device);
      device = nullptr;
      return false;
    }

    updateOutputInfo(state);
    startEventThread();
    return true;
  }

  bool start(RenderCallback renderCallback, OutputEventCallback callbackEvent, std::string* error) {
    if (!renderCallback) {
      const std::string reason = "miniaudio Shared 输出回调为空";
      recordFailure("backend_start_failure", reason, error);
      return false;
    }

    std::lock_guard lifecycleLock(lifecycleMutex);
    if (!initialized || !device) {
      const std::string reason = "miniaudio Shared 输出后端尚未打开";
      recordFailure("backend_start_failure", reason, error);
      return false;
    }
    if (started) {
      const std::string reason = "miniaudio Shared 输出后端已经在运行";
      recordFailure("backend_start_failure", reason, error);
      return false;
    }

    callback = std::move(renderCallback);
    {
      std::lock_guard lock(infoMutex);
      eventCallback = std::move(callbackEvent);
    }
    stopRequested.store(false, std::memory_order_release);
    started = true;
    const int result = api.startDevice(api.userData, device);
    if (result != 0) {
      started = false;
      stopRequested.store(true, std::memory_order_release);
      callback = nullptr;
      const std::string reason = resultMessage("启动 Shared WASAPI 设备", result);
      recordFailure(resultReasonCode("start", result), reason, error);
      return false;
    }
    return true;
  }

  void stop() {
    stopRequested.store(true, std::memory_order_release);
    std::lock_guard lifecycleLock(lifecycleMutex);
    if (!started) return;
    const int result = api.stopDevice(api.userData, device);
    started = false;
    callback = nullptr;
    if (result != 0) recordFailure("backend_stop_failure", resultMessage("停止 Shared WASAPI 设备", result));
  }

  void close() {
    stop();
    stopEventThread();
    std::lock_guard lifecycleLock(lifecycleMutex);
    if (initialized && device) {
      api.uninitializeDevice(api.userData, device);
      initialized = false;
    }
    if (device) {
      api.destroyDevice(api.userData, device);
      device = nullptr;
    }
    callback = nullptr;
    {
      std::lock_guard lock(infoMutex);
      eventCallback = nullptr;
      outputFormat = {};
    }
    eventState.store(nullptr, std::memory_order_release);
    eventStateOwner.reset();
    callbackChannels.store(0, std::memory_order_release);
  }
};

MiniaudioPcmBackend::MiniaudioPcmBackend() : impl_(std::make_unique<Impl>(miniaudio_backend_detail::realApi())) {}

MiniaudioPcmBackend::MiniaudioPcmBackend(const miniaudio_backend_detail::Api& api)
    : impl_(std::make_unique<Impl>(api)) {}

MiniaudioPcmBackend::~MiniaudioPcmBackend() = default;

const char* MiniaudioPcmBackend::id() const {
  return "wasapi";
}

bool MiniaudioPcmBackend::open(
    const std::string& deviceId,
    const AudioFormat& requestedFormat,
    std::string* error) {
  return impl_->open(deviceId, requestedFormat, error);
}

bool MiniaudioPcmBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  (void)config;
  (void)error;
  return true;
}

bool MiniaudioPcmBackend::start(
    RenderCallback callback,
    OutputEventCallback eventCallback,
    std::string* error) {
  return impl_->start(std::move(callback), std::move(eventCallback), error);
}

void MiniaudioPcmBackend::stop() {
  impl_->stop();
}

void MiniaudioPcmBackend::close() {
  impl_->close();
}

AudioFormat MiniaudioPcmBackend::outputFormat() const {
  std::lock_guard lock(impl_->infoMutex);
  return impl_->outputFormat;
}

OutputInfo MiniaudioPcmBackend::outputInfo() const {
  OutputInfo info;
  {
    std::lock_guard lock(impl_->infoMutex);
    info = impl_->outputInfo;
    info.diagnostics = impl_->diagnostics;
  }
  info.diagnostics.sessionUnderrunCount = impl_->sessionShortRenderCount.load(std::memory_order_relaxed);
  info.diagnostics.lifetimeUnderrunCount =
      info.diagnostics.lifetimeUnderrunCount + impl_->lifetimeShortRenderCount.load(std::memory_order_relaxed);
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts MiniaudioPcmBackend::dopRuntimeFacts() const {
  return impl_->dopFacts;
}

NativeDsdRuntimeFacts MiniaudioPcmBackend::nativeDsdRuntimeFacts() const {
  return unsupportedNativeDsdRuntimeFacts("miniaudio Shared provider 不支持 Native DSD");
}

std::string MiniaudioPcmBackend::deviceName() const {
  std::lock_guard lock(impl_->infoMutex);
  return impl_->deviceName;
}

bool miniaudioPcmBackendAvailable() {
#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
  return true;
#else
  return false;
#endif
}

std::vector<PcmDeviceCatalogEntry> enumerateMiniaudioPcmDevices(const Api& api, std::string* error) {
  if (!api.enumeratePlaybackDevices) {
    if (error) *error = "当前构建未启用 miniaudio 设备目录";
    return {};
  }

  std::vector<DeviceDescriptor> devices;
  const int result = api.enumeratePlaybackDevices(api.userData, &devices);
  if (result != 0) {
    if (error) *error = resultMessage("枚举 Shared WASAPI 设备", result);
    return {};
  }

  std::vector<PcmDeviceCatalogEntry> publicDevices;
  publicDevices.reserve(devices.size());
  for (const auto& device : devices) {
    publicDevices.push_back({device.platformStableId, device.label, device.isDefault});
  }
  return keepUnambiguousPcmDevices(publicDevices);
}

std::vector<PcmDeviceCatalogEntry> enumerateMiniaudioPcmDevices(std::string* error) {
  return enumerateMiniaudioPcmDevices(miniaudio_backend_detail::realApi(), error);
}

}  // namespace twilight::audio
