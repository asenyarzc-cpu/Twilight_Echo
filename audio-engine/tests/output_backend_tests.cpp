#include "../core/AudioTypes.h"
#include "../output/asio/AsioBackend.h"
#include "../output/asio/DeviceCapabilityCache.h"
#include "../output/asio/MockAsioHost.h"
#include "../output/asio/AsioRenderUtils.h"

#include <cassert>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <chrono>
#include <memory>
#include <string>
#include <thread>

using namespace twilight::audio;

namespace {

AudioFormat sourceFormat(int channels = 2) {
  AudioFormat format;
  format.sampleRate = 48000;
  format.channelCount = channels;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  return format;
}

// Host events are handled off the driver callback thread (see
// AsioBackend::queueRecoveryFromHostCallback), so triggerEvent() returns before the
// diagnostics it produces are visible. Poll instead of reading straight after the trigger.
template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout = std::chrono::milliseconds(8000)) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}

std::unique_ptr<MockAsioHost> makeHost(int channels = 8) {
  auto host = std::make_unique<MockAsioHost>();
  auto device = makeMockAsioDevice("asio:phase5b", {48000}, channels);
  device.minBufferSize = 64;
  device.maxBufferSize = 2048;
  device.bufferGranularity = 64;
  device.preferredBufferSize = 256;
  device.outputLatencyFrames = 96;
  host->devices.push_back(device);
  return host;
}

float readFloat(const std::vector<uint8_t>& bytes) {
  float value = 0.0f;
  std::memcpy(&value, bytes.data(), sizeof(value));
  return value;
}

float readFloatAt(const std::vector<uint8_t>& bytes, size_t frame) {
  float value = 0.0f;
  std::memcpy(&value, bytes.data() + frame * sizeof(value), sizeof(value));
  return value;
}

int16_t readInt16At(const std::vector<uint8_t>& bytes, size_t frame) {
  int16_t value = 0;
  std::memcpy(&value, bytes.data() + frame * sizeof(value), sizeof(value));
  return value;
}

int32_t readInt32At(const std::vector<int32_t>& values, size_t frame) {
  return values[frame];
}

void requireNear(float actual, float expected, const char* label) {
  if (std::fabs(actual - expected) <= 0.0001f) return;
  std::cerr << label << ": expected " << expected << ", got " << actual << "\n";
  std::abort();
}

void require(bool condition) {
  if (!condition) std::abort();
}

void testAsioInt16ChannelWriterSpecializesConversion() {
  const float input[] = {
      1.0f, -1.0f,
      0.5f, -0.5f,
      1.5f, -1.5f,
  };
  std::vector<int16_t> output(3, 123);

  asio::writeInt16ChannelFromFloatScratch(input + 1, 3, 2, output.data());

  require(output[0] == -32768);
  require(output[1] == -16384);
  require(output[2] == -32768);
}

void testAsioPackedInt24ChannelWriterSpecializesConversion() {
  const float input[] = {-1.0f, -0.5f, 0.5f, 1.0f};
  std::vector<uint8_t> output(12, 0xee);

  asio::writePackedInt24ChannelFromFloatScratch(input, 4, 1, output.data());

  const std::vector<uint8_t> expected = {
      0x00, 0x00, 0x80,
      0x00, 0x00, 0xc0,
      0x00, 0x00, 0x40,
      0xff, 0xff, 0x7f,
  };
  require(output == expected);
}

void testAsioInt24In32ChannelWriterSpecializesConversion() {
  const float input[] = {-1.0f, -0.5f, 0.5f, 1.0f};
  std::vector<int32_t> output(4, 123);

  asio::writeInt24In32ChannelFromFloatScratch(input, 4, 1, output.data());

  require(readInt32At(output, 0) == static_cast<int32_t>(0x80000000u));
  require(readInt32At(output, 1) == static_cast<int32_t>(0xc0000000u));
  require(readInt32At(output, 2) == 0x40000000);
  require(readInt32At(output, 3) == 0x7fffff00);
}

void testAsioInt32ChannelWriterSpecializesConversion() {
  const float input[] = {-1.0f, -0.5f, 0.5f, 1.0f};
  std::vector<int32_t> output(4, 123);

  asio::writeInt32ChannelFromFloatScratch(input, 4, 1, output.data());

  require(readInt32At(output, 0) == std::numeric_limits<int32_t>::min());
  require(readInt32At(output, 1) == -1073741824);
  require(readInt32At(output, 2) == 1073741824);
  require(readInt32At(output, 3) == std::numeric_limits<int32_t>::max());
}

void testBufferSizeAutoAndFallback() {
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:phase5b", sourceFormat(), &error));
    assert(rawHost->lastOpenConfig.bufferSizeFrames == 256);
    assert(backend.outputInfo().bufferSizeFrames == 256);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    OutputConfig config;
    config.preferredBufferSize = 100;
    std::string error;
    assert(!backend.setOutputConfig(config, &error));
    config.preferredBufferSize = 1024;
    assert(backend.setOutputConfig(config, &error));
    assert(backend.open("asio:phase5b", sourceFormat(), &error));
    assert(rawHost->lastOpenConfig.bufferSizeFrames == 1024);
  }
  {
    auto host = makeHost();
    host->devices[0].bufferGranularity = 128;
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    OutputConfig config;
    config.preferredBufferSize = 512;
    std::string error;
    assert(backend.setOutputConfig(config, &error));
    assert(backend.open("asio:phase5b", sourceFormat(), &error));
    assert(rawHost->lastOpenConfig.bufferSizeFrames == 448);
  }
}

void testCapabilityCacheAndVersion() {
  auto& cache = DeviceCapabilityCache::instance();
  AsioDeviceInfo info = makeMockAsioDevice("asio:cache", {44100, 48000}, 2);
  info.capabilityVersion = 7;
  info.dopCapable = true;
  info.dopCarrierSampleRates = {176400};
  info.dopCarrierSampleFormats = {AudioSampleFormat::Int24In32Interleaved};
  info.nativeDsdCapable = true;
  info.nativeDsdSampleRates = {2822400};
  cache.put(info);
  auto hit = cache.get("asio:cache");
  assert(hit);
  assert(hit->capabilityVersion == 7);
  assert(hit->dopCapable);
  assert(hit->dopCarrierSampleRates.size() == 1);
  assert(hit->dopCarrierSampleRates[0] == 176400);
  assert(hit->dopCarrierSampleFormats.size() == 1);
  assert(hit->dopCarrierSampleFormats[0] == AudioSampleFormat::Int24In32Interleaved);
  assert(hit->nativeDsdCapable);
  assert(hit->nativeDsdSampleRates.size() == 1);
  assert(hit->nativeDsdSampleRates[0] == 2822400);
  assert(!cache.dirty("asio:cache"));

  const uint64_t bumped = cache.bumpVersion("asio:cache");
  assert(bumped == 8);
  assert(cache.dirty("asio:cache"));
  assert(!cache.get("asio:cache"));
  assert(cache.version("asio:cache") == 8);
}

void testLatencyInfoAndPlaybackInfo() {
  auto host = makeHost();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:phase5b", sourceFormat(), &error));
  const OutputInfo info = backend.outputInfo();
  assert(info.actualBackend == "asio");
  assert(info.actualDeviceName == "Mock ASIO");
  assert(info.actualDriverName == "Mock ASIO");
  assert(info.supportsOutputPerfect);
  assert(info.latencyInfo.bufferLatencyMs > 5.0);
  assert(info.latencyInfo.outputLatencyMs > 0.0);
  assert(info.latencyInfo.totalLatencyMs >= info.latencyInfo.bufferLatencyMs);
}

void testChannelRouting() {
  auto host = makeHost(8);
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  OutputConfig config;
  config.routingMode = ChannelRoutingMode::StereoTo71;
  std::string error;
  assert(backend.setOutputConfig(config, &error));
  assert(backend.open("asio:phase5b", sourceFormat(2), &error));
  assert(rawHost->lastOpenConfig.format.channelCount == 8);
  assert(backend.start([](float* output, size_t frames) {
    for (size_t frame = 0; frame < frames; ++frame) {
      output[frame * 2] = 0.25f;
      output[frame * 2 + 1] = -0.5f;
    }
    return frames;
  }, nullptr, &error));
  rawHost->triggerBufferSwitch(0);
  assert(readFloat(rawHost->channelBuffers[0].buffers[0]) == 0.25f);
  assert(readFloat(rawHost->channelBuffers[1].buffers[0]) == -0.5f);
  assert(readFloat(rawHost->channelBuffers[2].buffers[0]) == 0.0f);
  assert(backend.outputInfo().channelRoutingMode == "stereo-to-7.1");
}

void testMonoRouting() {
  auto host = makeHost(6);
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  OutputConfig config;
  config.routingMode = ChannelRoutingMode::MonoToMultichannel;
  std::string error;
  assert(backend.setOutputConfig(config, &error));
  assert(backend.open("asio:phase5b", sourceFormat(1), &error));
  assert(rawHost->lastOpenConfig.format.channelCount == 6);
  assert(backend.start([](float* output, size_t frames) {
    for (size_t frame = 0; frame < frames; ++frame) output[frame] = 0.75f;
    return frames;
  }, nullptr, &error));
  rawHost->triggerBufferSwitch(0);
  assert(readFloat(rawHost->channelBuffers[0].buffers[0]) == 0.75f);
  assert(readFloat(rawHost->channelBuffers[1].buffers[0]) == 0.75f);
  assert(readFloat(rawHost->channelBuffers[2].buffers[0]) == 0.0f);
}

void testAsioFloatRenderHonorsReturnedFrameCount() {
  auto host = makeHost(2);
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  if (!backend.open("asio:phase5b", sourceFormat(2), &error)) {
    std::cerr << "failed to open ASIO mock: " << error << "\n";
    std::abort();
  }
  if (!backend.start([](float* output, size_t frames) {
    for (size_t frame = 0; frame < frames; ++frame) {
      output[frame * 2] = 0.8f;
      output[frame * 2 + 1] = -0.8f;
    }
    return size_t{1};
  }, nullptr, &error)) {
    std::cerr << "failed to start ASIO mock: " << error << "\n";
    std::abort();
  }

  rawHost->triggerBufferSwitch(0);

  requireNear(readFloatAt(rawHost->channelBuffers[0].buffers[0], 0), 0.8f, "left frame 0");
  requireNear(readFloatAt(rawHost->channelBuffers[1].buffers[0], 0), -0.8f, "right frame 0");
  requireNear(readFloatAt(rawHost->channelBuffers[0].buffers[0], 1), 0.0f, "left frame 1");
  requireNear(readFloatAt(rawHost->channelBuffers[1].buffers[0], 1), 0.0f, "right frame 1");
}

void testAsioPackedChannelHelperSpecializesFormatPerChannel() {
  const float input[] = {
      1.0f, -1.0f,
      0.5f, -0.5f,
  };
  std::vector<uint8_t> output(2 * sizeof(int16_t), 0xee);

  asio::writePackedChannelFromFloatScratch(
      input,
      2,
      2,
      1,
      ChannelRoutingMode::Auto,
      AudioSampleFormat::Int16Interleaved,
      output.data());

  assert(readInt16At(output, 0) == -32768);
  assert(readInt16At(output, 1) == -16384);
}

void testAsioPackedChannelHelperWritesSilentUnusedChannels() {
  const float input[] = {
      0.75f,
      -0.25f,
  };
  std::vector<uint8_t> output(2 * sizeof(float), 0xee);

  asio::writePackedChannelFromFloatScratch(
      input,
      2,
      1,
      4,
      ChannelRoutingMode::MonoToMultichannel,
      AudioSampleFormat::Float32Interleaved,
      output.data());

  requireNear(readFloatAt(output, 0), 0.0f, "unused channel frame 0");
  requireNear(readFloatAt(output, 1), 0.0f, "unused channel frame 1");
}

void testAsioPackedChannelHelperCopiesMonoFloatChannel() {
  const float input[] = {
      -0.5f,
      0.25f,
      0.75f,
  };
  std::vector<uint8_t> output(3 * sizeof(float), 0xee);

  const bool canCopy = asio::canCopyPackedFloatChannelFromFloatScratch(
      input,
      3,
      1,
      0,
      ChannelRoutingMode::Auto,
      AudioSampleFormat::Float32Interleaved,
      output.data());
  assert(canCopy);

  asio::writePackedChannelFromFloatScratch(
      input,
      3,
      1,
      0,
      ChannelRoutingMode::Auto,
      AudioSampleFormat::Float32Interleaved,
      output.data());

  requireNear(readFloatAt(output, 0), -0.5f, "mono copy frame 0");
  requireNear(readFloatAt(output, 1), 0.25f, "mono copy frame 1");
  requireNear(readFloatAt(output, 2), 0.75f, "mono copy frame 2");
}

void testAsioPackedChannelHelperCopiesMonoToStereoRightFloatChannel() {
  const float input[] = {
      -0.5f,
      0.25f,
      0.75f,
  };
  std::vector<uint8_t> output(3 * sizeof(float), 0xee);

  const bool canCopy = asio::canCopyPackedFloatChannelFromFloatScratch(
      input,
      3,
      1,
      1,
      ChannelRoutingMode::MonoToStereo,
      AudioSampleFormat::Float32Interleaved,
      output.data());
  require(canCopy);
}

void testAsioPackedChannelHelperCopiesMonoToMultichannelRightFloatChannel() {
  const float input[] = {
      -0.5f,
      0.25f,
      0.75f,
  };
  std::vector<uint8_t> output(3 * sizeof(float), 0xee);

  const bool canCopy = asio::canCopyPackedFloatChannelFromFloatScratch(
      input,
      3,
      1,
      1,
      ChannelRoutingMode::MonoToMultichannel,
      AudioSampleFormat::Float32Interleaved,
      output.data());
  require(canCopy);

  const bool unusedChannelCanCopy = asio::canCopyPackedFloatChannelFromFloatScratch(
      input,
      3,
      1,
      2,
      ChannelRoutingMode::MonoToMultichannel,
      AudioSampleFormat::Float32Interleaved,
      output.data());
  require(!unusedChannelCanCopy);
}

void testAsioTypedChannelHelperDeinterleavesThreeByteSamples() {
  const std::vector<uint8_t> input = {
      0x10, 0x11, 0x12,
      0x20, 0x21, 0x22,
      0x30, 0x31, 0x32,
      0x40, 0x41, 0x42,
  };
  std::vector<uint8_t> output(2 * 3, 0xee);

  asio::writeInterleavedTypedChannelToPlanar(input.data(), 2, 2, 1, 3, output.data());

  const std::vector<uint8_t> expected = {
      0x20, 0x21, 0x22,
      0x40, 0x41, 0x42,
  };
  assert(output == expected);
}

void testAsioTypedChannelHelperDeinterleavesFourByteSamples() {
  const std::vector<uint8_t> input = {
      0x10, 0x11, 0x12, 0x13,
      0x20, 0x21, 0x22, 0x23,
      0x30, 0x31, 0x32, 0x33,
      0x40, 0x41, 0x42, 0x43,
  };
  std::vector<uint8_t> output(2 * 4, 0xee);

  asio::writeInterleavedTypedChannelToPlanar(input.data(), 2, 2, 0, 4, output.data());

  const std::vector<uint8_t> expected = {
      0x10, 0x11, 0x12, 0x13,
      0x30, 0x31, 0x32, 0x33,
  };
  assert(output == expected);
}

void testAsioTypedChannelHelperCopiesMonoContiguousChannel() {
  const std::vector<uint8_t> input = {
      0x10, 0x11, 0x12, 0x13,
      0x20, 0x21, 0x22, 0x23,
      0x30, 0x31, 0x32, 0x33,
  };
  std::vector<uint8_t> output(input.size(), 0xee);

  const bool canCopy = asio::canCopyInterleavedTypedChannelToPlanar(3, 1, 0, 4);
  assert(canCopy);
  asio::writeInterleavedTypedChannelToPlanar(input.data(), 3, 1, 0, 4, output.data());

  assert(output == input);
}

void testAsioTypedChannelHelperCopiesSingleFrameFirstChannel() {
  const std::vector<uint8_t> input = {
      0x10, 0x11, 0x12,
      0x20, 0x21, 0x22,
  };
  std::vector<uint8_t> output(3, 0xee);

  const bool canCopy = asio::canCopyInterleavedTypedChannelToPlanar(1, 2, 0, 3);
  require(canCopy);
  asio::writeInterleavedTypedChannelToPlanar(input.data(), 1, 2, 0, 3, output.data());

  const std::vector<uint8_t> expected = {0x10, 0x11, 0x12};
  assert(output == expected);
}

void testDiagnostics() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:phase5b", sourceFormat(), &error));
  assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
  rawHost->failOpenCount = 1;
  rawHost->triggerEvent(AsioHostEvent::DriverRestart, "restart");
  assert(waitUntil([&] { return backend.outputInfo().deviceRecovered; }));
  const auto info = backend.outputInfo();
  assert(info.diagnostics.driverRestartCount == 1);
  assert(info.diagnostics.sessionRecoveryCount == 1);
  assert(info.diagnostics.lifetimeRecoveryCount == 1);
  assert(info.deviceRecovered);
}

void testDeviceLostAndBufferFailureDiagnostics() {
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:phase5b", sourceFormat(), &error));
    assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    rawHost->triggerEvent(AsioHostEvent::DeviceLost, "device lost");
    // deviceRecovered flips in the same critical section that bumps the recovery
    // counters, so it is the only signal that means "recovery finished".
    assert(waitUntil([&] { return backend.outputInfo().deviceRecovered; }));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.deviceLostCount == 1);
    assert(info.diagnostics.sessionRecoveryCount == 1);
    assert(info.diagnostics.lastError.find("ASIO device lost") != std::string::npos);
  }
  {
    auto host = makeHost();
    auto* rawHost = host.get();
    AsioBackend backend(std::move(host));
    std::string error;
    assert(backend.open("asio:phase5b", sourceFormat(), &error));
    assert(backend.start([](float*, size_t frames) { return frames; }, nullptr, &error));
    rawHost->triggerEvent(AsioHostEvent::BufferFailure, "buffer failed");
    assert(waitUntil([&] { return backend.outputInfo().deviceRecovered; }));
    const auto info = backend.outputInfo();
    assert(info.diagnostics.sessionUnderrunCount == 1);
    assert(info.diagnostics.lifetimeUnderrunCount == 1);
    assert(info.diagnostics.sessionRecoveryCount == 1);
    assert(info.diagnostics.lastError.find("ASIO buffer failure") != std::string::npos);
  }
}

void testAsioHelperFailureStopsWithoutRecovery() {
  auto host = makeHost();
  auto* rawHost = host.get();
  AsioBackend backend(std::move(host));
  std::string error;
  assert(backend.open("asio:phase5b", sourceFormat(), &error));
  std::atomic<int> event{-1};
  assert(backend.start(
      [](float*, size_t frames) { return frames; },
      [&](OutputBackendEvent value, const std::string&) {
        event.store(static_cast<int>(value), std::memory_order_release);
      },
      &error));
  const int openCalls = rawHost->openCalls;
  rawHost->triggerEvent(
      AsioHostEvent::HelperFailure,
      "asio_helper_process_exited: fixture helper terminated");
  assert(waitUntil([&] {
    return event.load(std::memory_order_acquire) ==
        static_cast<int>(OutputBackendEvent::RenderError);
  }));
  const auto info = backend.outputInfo();
  assert(info.perfectReasonCode == "asio_helper_process_exited");
  assert(info.recoveryCount == 0);
  assert(!info.deviceRecovered);
  assert(rawHost->openCalls == openCalls);
  assert(rawHost->stopCalls > 0);
  assert(rawHost->closeCalls > 0);
}

}  // namespace

int main() {
  testAsioInt16ChannelWriterSpecializesConversion();
  testAsioPackedInt24ChannelWriterSpecializesConversion();
  testAsioInt24In32ChannelWriterSpecializesConversion();
  testAsioInt32ChannelWriterSpecializesConversion();
  testBufferSizeAutoAndFallback();
  testCapabilityCacheAndVersion();
  testLatencyInfoAndPlaybackInfo();
  testChannelRouting();
  testMonoRouting();
  testAsioFloatRenderHonorsReturnedFrameCount();
  testAsioPackedChannelHelperSpecializesFormatPerChannel();
  testAsioPackedChannelHelperWritesSilentUnusedChannels();
  testAsioPackedChannelHelperCopiesMonoFloatChannel();
  testAsioPackedChannelHelperCopiesMonoToStereoRightFloatChannel();
  testAsioPackedChannelHelperCopiesMonoToMultichannelRightFloatChannel();
  testAsioTypedChannelHelperDeinterleavesThreeByteSamples();
  testAsioTypedChannelHelperDeinterleavesFourByteSamples();
  testAsioTypedChannelHelperCopiesMonoContiguousChannel();
  testAsioTypedChannelHelperCopiesSingleFrameFirstChannel();
  testDiagnostics();
  testDeviceLostAndBufferFailureDiagnostics();
  testAsioHelperFailureStopsWithoutRecovery();
  return 0;
}
