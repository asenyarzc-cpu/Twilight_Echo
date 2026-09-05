#include "../output/miniaudio/MiniaudioPcmBackend.h"
#include "../output/OutputBackendFactory.h"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {
void runDeviceCatalogTests();
}

using namespace twilight::audio;
using namespace twilight::audio::miniaudio_backend_detail;

namespace {

struct FakeDevice {
  DeviceConfig config;
  std::string selectedDeviceId;
};

DeviceDescriptor fakeDescriptor(const std::string& id, const std::string& label, bool isDefault = false) {
  DeviceDescriptor descriptor;
  descriptor.platformStableId = id;
  descriptor.label = label;
  descriptor.isDefault = isDefault;
  descriptor.adapterDeviceId[0] = 1;
  descriptor.adapterDeviceIdSize = 1;
  return descriptor;
}

struct FakeRuntime {
  DeviceState state;
  std::vector<DeviceDescriptor> devices;
  int enumerateResult = 0;
  int initializeResult = 0;
  int readStateResult = 0;
  int startResult = 0;
  int stopResult = 0;
  int createCalls = 0;
  int enumerateCalls = 0;
  int destroyCalls = 0;
  int initializeCalls = 0;
  int readStateCalls = 0;
  int startCalls = 0;
  int stopCalls = 0;
  int uninitializeCalls = 0;
  FakeDevice* device = nullptr;

  FakeRuntime() {
    devices.push_back(fakeDescriptor("endpoint-id", "Fake Default Device", true));
    state.callbackSampleRate = 48000;
    state.callbackFormat = DeviceFormat::F32;
    state.callbackChannels = 2;
    state.internalSampleRate = 44100;
    state.internalFormat = DeviceFormat::S16;
    state.internalChannels = 2;
    state.internalPeriodSizeFrames = 240;
    state.internalPeriods = 2;
    state.bufferSizeFrames = 480;
    state.conversionInfoAvailable = true;
    state.sampleFormatConverted = true;
    state.sampleRateConverted = true;
    state.channelLayoutConverted = false;
    std::strncpy(state.deviceName, "Fake Default Device", sizeof(state.deviceName) - 1);
  }

  void fireData(void* output, uint32_t frames) {
    assert(device != nullptr);
    assert(device->config.callbackContext != nullptr);
    device->config.callbackContext->dataCallback(
        device->config.callbackContext->userData,
        output,
        frames);
  }

  void fireNotification(NotificationType type) {
    assert(device != nullptr);
    assert(device->config.callbackContext != nullptr);
    device->config.callbackContext->notificationCallback(
        device->config.callbackContext->userData,
        type);
  }
};

int fakeEnumerate(void* userData, std::vector<DeviceDescriptor>* devices) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->enumerateCalls;
  if (runtime->enumerateResult != 0) return runtime->enumerateResult;
  *devices = runtime->devices;
  return 0;
}

void* fakeCreate(void* userData) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->createCalls;
  runtime->device = new FakeDevice();
  return runtime->device;
}

void fakeDestroy(void* userData, void* device) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->destroyCalls;
  assert(runtime->device == device);
  runtime->device = nullptr;
  delete static_cast<FakeDevice*>(device);
}

int fakeInitialize(void* userData, void* device, const DeviceConfig* config, DeviceState* state) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->initializeCalls;
  if (runtime->initializeResult != 0) return runtime->initializeResult;
  auto* fakeDevice = static_cast<FakeDevice*>(device);
  fakeDevice->config = *config;
  fakeDevice->selectedDeviceId = config->selectedDevice ? config->selectedDevice->platformStableId : "";
  fakeDevice->config.selectedDevice = nullptr;
  *state = runtime->state;
  std::strncpy(state->deviceId, fakeDevice->selectedDeviceId.c_str(), sizeof(state->deviceId) - 1);
  return 0;
}

int fakeReadState(void* userData, void*, DeviceState* state) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->readStateCalls;
  if (runtime->readStateResult != 0) return runtime->readStateResult;
  *state = runtime->state;
  return 0;
}

int fakeStart(void* userData, void*) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->startCalls;
  return runtime->startResult;
}

int fakeStop(void* userData, void*) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->stopCalls;
  return runtime->stopResult;
}

void fakeUninitialize(void* userData, void*) {
  auto* runtime = static_cast<FakeRuntime*>(userData);
  ++runtime->uninitializeCalls;
}

Api fakeApi(FakeRuntime* runtime) {
  Api api;
  api.userData = runtime;
  api.enumeratePlaybackDevices = fakeEnumerate;
  api.createDevice = fakeCreate;
  api.destroyDevice = fakeDestroy;
  api.initializeDevice = fakeInitialize;
  api.readDeviceState = fakeReadState;
  api.startDevice = fakeStart;
  api.stopDevice = fakeStop;
  api.uninitializeDevice = fakeUninitialize;
  return api;
}

AudioFormat pcmFormat(int sampleRate = 48000, int channels = 2) {
  AudioFormat format;
  format.sampleRate = sampleRate;
  format.channelCount = channels;
  format.bitDepth = 24;
  format.sampleFormat = AudioSampleFormat::Int24Interleaved;
  return format;
}

void testProductionApiIsLinked() {
  const Api& api = realApi();
#if defined(TAE_ENABLE_MINIAUDIO)
  assert(api.enumeratePlaybackDevices != nullptr);
  assert(api.createDevice != nullptr);
  assert(api.destroyDevice != nullptr);
  assert(api.initializeDevice != nullptr);
  assert(api.readDeviceState != nullptr);
  assert(api.startDevice != nullptr);
  assert(api.stopDevice != nullptr);
  assert(api.uninitializeDevice != nullptr);

  void* device = api.createDevice(api.userData);
  assert(device != nullptr);
  api.destroyDevice(api.userData, device);
#else
  assert(api.enumeratePlaybackDevices == nullptr);
  assert(api.createDevice == nullptr);
  assert(api.destroyDevice == nullptr);
  assert(api.initializeDevice == nullptr);
  assert(api.readDeviceState == nullptr);
  assert(api.startDevice == nullptr);
  assert(api.stopDevice == nullptr);
  assert(api.uninitializeDevice == nullptr);
#endif
}

void testDsdRejection() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;
  AudioFormat dsd = pcmFormat();
  dsd.sampleRate = 2822400;
  dsd.sampleFormat = AudioSampleFormat::DsdInt8Msb1;
  dsd.bitDepth = 1;
  assert(!backend.open("auto", dsd, &error));
  assert(error.find("DSD/DoP") != std::string::npos);
  assert(runtime.createCalls == 0);
}

void testExplicitDeviceUsesStableIdCatalogSelection() {
  FakeRuntime runtime;
  runtime.devices = {
      fakeDescriptor("endpoint-a", "Duplicate DAC", true),
      fakeDescriptor("endpoint-b", "Duplicate DAC", false)};
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;

  assert(backend.open("endpoint-b", pcmFormat(), &error));
  assert(error.empty());
  assert(runtime.enumerateCalls == 1);
  assert(runtime.createCalls == 1);
  assert(runtime.initializeCalls == 1);
  assert(runtime.device != nullptr);
  assert(runtime.device->selectedDeviceId == "endpoint-b");
  backend.close();
}

void testExplicitDeviceNeverFallsBackToDefault() {
  {
    FakeRuntime runtime;
    runtime.devices.clear();
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("stale-endpoint", pcmFormat(), &error));
    assert(error.find("stale-endpoint") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "device_not_found");
    assert(runtime.createCalls == 0);
  }

  {
    FakeRuntime runtime;
    runtime.devices = {
        fakeDescriptor("duplicate-id", "First"),
        fakeDescriptor("duplicate-id", "Second")};
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("duplicate-id", pcmFormat(), &error));
    assert(error.find("重复") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "device_id_ambiguous");
    assert(runtime.createCalls == 0);
  }

  {
    FakeRuntime runtime;
    runtime.devices = {fakeDescriptor("removed-during-open", "Transient DAC")};
    runtime.initializeResult = -204;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("removed-during-open", pcmFormat(), &error));
    assert(error.find("result -204") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "device_not_found");
    assert(runtime.initializeCalls == 1);
    assert(runtime.destroyCalls == 1);
  }
}

void testMiniaudioCatalogUsesStableIdsAndRefreshesDefaultRole() {
  FakeRuntime runtime;
  runtime.devices = {
      fakeDescriptor("endpoint-a", "Duplicate DAC", true),
      fakeDescriptor("endpoint-b", "Duplicate DAC", false),
      fakeDescriptor("", "Invalid")};
  Api api = fakeApi(&runtime);
  std::string error;

  auto devices = enumerateMiniaudioPcmDevices(api, &error);
  assert(error.empty());
  assert(devices.size() == 2);
  assert(devices[0].platformStableId == "endpoint-a");
  assert(devices[1].platformStableId == "endpoint-b");
  assert(devices[0].label == devices[1].label);
  assert(devices[0].isDefault);
  assert(!devices[1].isDefault);

  runtime.devices[0].isDefault = false;
  runtime.devices[1].isDefault = true;
  devices = enumerateMiniaudioPcmDevices(api, &error);
  assert(!devices[0].isDefault);
  assert(devices[1].isDefault);
  assert(runtime.enumerateCalls == 2);
}

void testOpenUsesSharedFloatCallbackAndObservedFacts() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;

  assert(backend.open("auto", pcmFormat(), &error));
  assert(runtime.device != nullptr);
  assert(runtime.device->config.shared);
  assert(runtime.device->config.noFixedSizedCallback);
  assert(runtime.device->config.noAutoConvertSRC);
  assert(!runtime.device->config.allowAutomaticReroute);
  assert(runtime.device->config.sampleRate == 48000);
  assert(runtime.device->config.channels == 2);
  assert(runtime.device->selectedDeviceId == "endpoint-id");

  const AudioFormat callbackFormat = backend.outputFormat();
  assert(callbackFormat.sampleRate == 48000);
  assert(callbackFormat.channelCount == 2);
  assert(callbackFormat.bitDepth == 32);
  assert(callbackFormat.sampleFormat == AudioSampleFormat::Float32Interleaved);

  const OutputInfo info = backend.outputInfo();
  assert(info.providerImplementation == "miniaudio");
  assert(info.backend == "wasapi");
  assert(info.actualBackend == "wasapi");
  assert(info.accessMode == "shared");
  assert(!info.exclusive);
  assert(!info.supportsOutputPerfect);
  assert(!info.outputPerfect);
  assert(info.outputSampleRate == 48000);
  assert(info.outputBitDepth == 32);
  assert(info.outputChannels == 2);
  assert(info.outputSampleFormat == "float32");
  assert(info.actualOutputFormat == "int16");
  assert(info.actualSampleRate == 44100);
  assert(info.actualBitDepth == 16);
  assert(info.actualChannels == 2);
  assert(info.actualDeviceId == "endpoint-id");
  assert(info.resampled);
  assert(info.conversionInfo.sampleRateConverted);
  assert(info.conversionInfo.sampleFormatConverted);
  assert(!info.conversionInfo.channelLayoutConverted);
  assert(info.conversionInfo.source == "backend-runtime");
  assert(info.perfectReasonCode == "shared_mixer");
}

void testOpenReportsCallbackAndInternalChannelFactsSeparately() {
  FakeRuntime runtime;
  runtime.state.internalChannels = 6;
  runtime.state.channelLayoutConverted = true;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;

  assert(backend.open("auto", pcmFormat(), &error));

  const OutputInfo info = backend.outputInfo();
  assert(info.outputChannels == 2);
  assert(info.actualChannels == 6);
  assert(info.conversionInfo.channelLayoutConverted);
  assert(info.conversionInfo.source == "backend-runtime");

  backend.close();
}

void testShortRenderIsSilencedAndCounted() {
  FakeRuntime runtime;
  runtime.state.internalSampleRate = 48000;
  runtime.state.internalFormat = DeviceFormat::F32;
  runtime.state.sampleFormatConverted = false;
  runtime.state.sampleRateConverted = false;
  runtime.state.conversionInfoAvailable = true;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;
  assert(backend.open("default", pcmFormat(), &error));

  std::atomic<bool> typedCalled{false};
  assert(backend.startTyped(
      [&](PcmBlock&) {
        typedCalled.store(true, std::memory_order_release);
        return static_cast<size_t>(0);
      },
      [](float* output, size_t frames) {
        for (size_t i = 0; i < frames * 2; ++i) output[i] = 0.25f;
        return static_cast<size_t>(2);
      },
      nullptr,
      &error));

  std::vector<float> output(5 * 2, -1.0f);
  runtime.fireData(output.data(), 5);
  for (size_t i = 0; i < 4; ++i) assert(output[i] == 0.25f);
  for (size_t i = 4; i < output.size(); ++i) assert(output[i] == 0.0f);
  assert(!typedCalled.load(std::memory_order_acquire));
  assert(backend.outputInfo().diagnostics.sessionUnderrunCount == 1);

  backend.stop();
  backend.stop();
  assert(runtime.stopCalls == 1);
}

void testRenderErrorIsDeferred() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;
  std::atomic<bool> renderError{false};
  assert(backend.open("auto", pcmFormat(), &error));
  assert(backend.start(
      [](float*, size_t frames) { return frames + 1; },
      [&](OutputBackendEvent event, const std::string& message) {
        renderError.store(
            event == OutputBackendEvent::RenderError && message.find("miniaudio") != std::string::npos,
            std::memory_order_release);
      },
      &error));

  std::vector<float> output(4 * 2, -1.0f);
  runtime.fireData(output.data(), 4);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
  while (!renderError.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(renderError.load(std::memory_order_acquire));
  backend.close();
}

void testNotificationIsDeferredAndRerouteRefreshesFacts() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;
  std::atomic<bool> invalidated{false};
  assert(backend.open("auto", pcmFormat(), &error));
  assert(backend.start(
      [](float*, size_t frames) { return frames; },
      [&](OutputBackendEvent event, const std::string& message) {
        invalidated.store(
            event == OutputBackendEvent::DeviceInvalidated && message.find("miniaudio") != std::string::npos,
            std::memory_order_release);
      },
      &error));

  runtime.state.internalSampleRate = 48000;
  runtime.state.internalFormat = DeviceFormat::F32;
  runtime.state.sampleFormatConverted = false;
  runtime.state.sampleRateConverted = false;
  runtime.fireNotification(NotificationType::Rerouted);

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
  while (!invalidated.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(invalidated.load(std::memory_order_acquire));
  assert(runtime.readStateCalls >= 1);
  assert(!backend.outputInfo().resampled);
  backend.close();
}

void testUnexpectedStopInvalidatesButExplicitStopIgnoresNotification() {
  {
    FakeRuntime runtime;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    std::atomic<bool> invalidated{false};
    assert(backend.open("auto", pcmFormat(), &error));
    assert(backend.start(
        [](float*, size_t frames) { return frames; },
        [&](OutputBackendEvent event, const std::string&) {
          invalidated.store(event == OutputBackendEvent::DeviceInvalidated, std::memory_order_release);
        },
        &error));
    runtime.fireNotification(NotificationType::Stopped);

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
    while (!invalidated.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(invalidated.load(std::memory_order_acquire));
    backend.close();
  }

  {
    FakeRuntime runtime;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    std::atomic<bool> invalidated{false};
    assert(backend.open("auto", pcmFormat(), &error));
    assert(backend.start(
        [](float*, size_t frames) { return frames; },
        [&](OutputBackendEvent event, const std::string&) {
          invalidated.store(event == OutputBackendEvent::DeviceInvalidated, std::memory_order_release);
        },
        &error));
    backend.stop();
    runtime.fireNotification(NotificationType::Stopped);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    assert(!invalidated.load(std::memory_order_acquire));
    backend.close();
  }
}

void testNotificationCallbackCanCloseAndReopen() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;
  std::atomic<bool> closedFromCallback{false};
  assert(backend.open("auto", pcmFormat(), &error));
  assert(backend.start(
      [](float*, size_t frames) { return frames; },
      [&](OutputBackendEvent event, const std::string&) {
        if (event == OutputBackendEvent::DeviceInvalidated) {
          backend.close();
          closedFromCallback.store(true, std::memory_order_release);
        }
      },
      &error));

  runtime.fireNotification(NotificationType::Rerouted);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
  while (!closedFromCallback.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(closedFromCallback.load(std::memory_order_acquire));
  assert(runtime.device == nullptr);

  error.clear();
  assert(backend.open("auto", pcmFormat(), &error));
  backend.close();
}

void testResultMappingAndLifecycleErrors() {
  {
    FakeRuntime runtime;
    runtime.initializeResult = -200;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("auto", pcmFormat(), &error));
    assert(error.find("result -200") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "format_not_supported");
    assert(runtime.destroyCalls == 1);
  }

  {
    FakeRuntime runtime;
    runtime.initializeResult = -206;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("auto", pcmFormat(), &error));
    assert(error.find("result -206") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "backend_open_failure");
    assert(runtime.destroyCalls == 1);
  }

  {
    FakeRuntime runtime;
    runtime.initializeResult = -7;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(!backend.open("auto", pcmFormat(), &error));
    assert(error.find("result -7") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "backend_open_failure");
    assert(runtime.destroyCalls == 1);
  }

  {
    FakeRuntime runtime;
    runtime.startResult = -402;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(backend.open("auto", pcmFormat(), &error));
    assert(!backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    assert(error.find("result -402") != std::string::npos);
    assert(backend.outputInfo().perfectReasonCode == "backend_start_failure");
    backend.close();
    assert(runtime.uninitializeCalls == 1);
    assert(runtime.destroyCalls == 1);
  }

  {
    FakeRuntime runtime;
    runtime.stopResult = -402;
    MiniaudioPcmBackend backend(fakeApi(&runtime));
    std::string error;
    assert(backend.open("auto", pcmFormat(), &error));
    assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    backend.stop();
    assert(runtime.stopCalls == 1);
    assert(backend.outputInfo().perfectReasonCode == "backend_stop_failure");
    backend.close();
    assert(runtime.uninitializeCalls == 1);
    assert(runtime.destroyCalls == 1);
  }
}

#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
void testFactorySelectsMiniaudioOnlyForSharedWasapi() {
  assert(_putenv_s("TWILIGHT_AUDIO_PCM_PROVIDER", "miniaudio") == 0);

  std::string error;
  auto shared = createOutputBackend("wasapi", &error);
  assert(shared);
  assert(error.empty());
  assert(std::string(shared->id()) == "wasapi");
  assert(shared->outputInfo().providerImplementation == "miniaudio");

  auto exclusive = createOutputBackend("wasapi-exclusive", &error);
  assert(exclusive);
  assert(std::string(exclusive->id()) == "wasapi-exclusive");
  assert(exclusive->outputInfo().providerImplementation == "legacy-native");
}
#endif

}  // namespace

int main() {
  runDeviceCatalogTests();
  testProductionApiIsLinked();
  testDsdRejection();
  testExplicitDeviceUsesStableIdCatalogSelection();
  testExplicitDeviceNeverFallsBackToDefault();
  testMiniaudioCatalogUsesStableIdsAndRefreshesDefaultRole();
  testOpenUsesSharedFloatCallbackAndObservedFacts();
  testOpenReportsCallbackAndInternalChannelFactsSeparately();
  testShortRenderIsSilencedAndCounted();
  testRenderErrorIsDeferred();
  testNotificationIsDeferredAndRerouteRefreshesFacts();
  testUnexpectedStopInvalidatesButExplicitStopIgnoresNotification();
  testNotificationCallbackCanCloseAndReopen();
  testResultMappingAndLifecycleErrors();
#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
  testFactorySelectsMiniaudioOnlyForSharedWasapi();
#endif
  return 0;
}
