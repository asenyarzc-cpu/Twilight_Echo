#include "../output/miniaudio/MiniaudioPcmBackend.h"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using namespace twilight::audio;
using namespace twilight::audio::miniaudio_backend_detail;

namespace {

struct FakeDevice {
  DeviceConfig config;
};

struct FakeRuntime {
  DeviceState state;
  int initializeResult = 0;
  int readStateResult = 0;
  int startResult = 0;
  int stopResult = 0;
  int createCalls = 0;
  int destroyCalls = 0;
  int initializeCalls = 0;
  int readStateCalls = 0;
  int startCalls = 0;
  int stopCalls = 0;
  int uninitializeCalls = 0;
  FakeDevice* device = nullptr;

  FakeRuntime() {
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
  *state = runtime->state;
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
  assert(api.createDevice == nullptr);
  assert(api.destroyDevice == nullptr);
  assert(api.initializeDevice == nullptr);
  assert(api.readDeviceState == nullptr);
  assert(api.startDevice == nullptr);
  assert(api.stopDevice == nullptr);
  assert(api.uninitializeDevice == nullptr);
#endif
}

void testDefaultOnlyAndDsdRejection() {
  FakeRuntime runtime;
  MiniaudioPcmBackend backend(fakeApi(&runtime));
  std::string error;

  assert(!backend.open("endpoint-id", pcmFormat(), &error));
  assert(error.find("MA-103") != std::string::npos);
  assert(runtime.createCalls == 0);

  error.clear();
  AudioFormat dsd = pcmFormat();
  dsd.sampleRate = 2822400;
  dsd.sampleFormat = AudioSampleFormat::DsdInt8Msb1;
  dsd.bitDepth = 1;
  assert(!backend.open("auto", dsd, &error));
  assert(error.find("DSD/DoP") != std::string::npos);
  assert(runtime.createCalls == 0);
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
  assert(runtime.device->config.sampleRate == 48000);
  assert(runtime.device->config.channels == 2);

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
  assert(info.actualOutputFormat == "int16");
  assert(info.actualSampleRate == 44100);
  assert(info.actualBitDepth == 16);
  assert(info.actualChannels == 2);
  assert(info.resampled);
  assert(info.conversionInfo.sampleRateConverted);
  assert(info.conversionInfo.sampleFormatConverted);
  assert(!info.conversionInfo.channelLayoutConverted);
  assert(info.conversionInfo.source == "backend-runtime");
  assert(info.perfectReasonCode == "shared_mixer");
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

}  // namespace

int main() {
  testProductionApiIsLinked();
  testDefaultOnlyAndDsdRejection();
  testOpenUsesSharedFloatCallbackAndObservedFacts();
  testShortRenderIsSilencedAndCounted();
  testRenderErrorIsDeferred();
  testNotificationIsDeferredAndRerouteRefreshesFacts();
  testNotificationCallbackCanCloseAndReopen();
  testResultMappingAndLifecycleErrors();
  return 0;
}
