#include "../core/AudioPipeline.h"
#include "../dsp/Vst3BridgeProcessor.h"
#include "../output/IOutputBackend.h"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef PSAPI_VERSION
#define PSAPI_VERSION 1
#endif
#include <windows.h>
#include <psapi.h>
#endif

using namespace twilight::audio;

namespace {

constexpr int kSampleRate = 44100;
constexpr int kChannels = 2;
constexpr size_t kCallbackFrames = 512;
constexpr double kLongScenarioAudioSeconds = 180.0;
constexpr double kPipelineMeanDeadlineLoadLimitPercent = 65.0;
constexpr uint64_t kPipelineDeadlineMissLimit = 0;

struct ControlledBackendState {
  mutable std::mutex mutex;
  AudioFormat format;
  OutputInfo info;
  RenderCallback render;
  TypedRenderCallback typedRender;
  OutputEventCallback event;
  bool started = false;
  uint64_t callbackInvocations = 0;
  uint64_t callbacksWithAudio = 0;
};

class ScopedPerformanceTestThreadPriority {
 public:
  ScopedPerformanceTestThreadPriority() {
#ifdef _WIN32
    thread_ = GetCurrentThread();
    previousPriority_ = GetThreadPriority(thread_);
    if (previousPriority_ != THREAD_PRIORITY_ERROR_RETURN) {
      changed_ = SetThreadPriority(thread_, THREAD_PRIORITY_ABOVE_NORMAL) != FALSE;
    }
#endif
  }

  ~ScopedPerformanceTestThreadPriority() {
#ifdef _WIN32
    if (changed_) SetThreadPriority(thread_, previousPriority_);
#endif
  }

  ScopedPerformanceTestThreadPriority(const ScopedPerformanceTestThreadPriority&) = delete;
  ScopedPerformanceTestThreadPriority& operator=(const ScopedPerformanceTestThreadPriority&) = delete;

 private:
#ifdef _WIN32
  HANDLE thread_ = nullptr;
  int previousPriority_ = THREAD_PRIORITY_ERROR_RETURN;
  bool changed_ = false;
#endif
};

std::mutex g_backendMutex;
std::shared_ptr<ControlledBackendState> g_latestBackend;

class ControlledPumpBackend final : public IOutputBackend {
 public:
  ControlledPumpBackend() : state_(std::make_shared<ControlledBackendState>()) {
    std::lock_guard lock(g_backendMutex);
    g_latestBackend = state_;
  }

  const char* id() const override { return "controlled-pump"; }

  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string*) override {
    std::lock_guard lock(state_->mutex);
    state_->format = requestedFormat;
    state_->info = {};
    state_->info.backend = id();
    state_->info.actualBackend = id();
    state_->info.deviceName = deviceId.empty() ? "Controlled callback pump" : deviceId;
    state_->info.actualDeviceName = state_->info.deviceName;
    state_->info.driverName = "test-controlled";
    state_->info.actualDriverName = state_->info.driverName;
    state_->info.outputSampleRate = requestedFormat.sampleRate;
    state_->info.outputBitDepth = requestedFormat.bitDepth;
    state_->info.actualSampleRate = requestedFormat.sampleRate;
    state_->info.actualBitDepth = requestedFormat.bitDepth;
    state_->info.actualChannels = requestedFormat.channelCount;
    state_->info.actualOutputFormat = sampleFormatToString(requestedFormat.sampleFormat);
    state_->info.bufferSizeFrames = static_cast<int>(kCallbackFrames);
    state_->info.latencyFrames = static_cast<int>(kCallbackFrames);
    state_->info.latencyMs =
        static_cast<double>(kCallbackFrames) * 1000.0 / static_cast<double>(std::max(1, requestedFormat.sampleRate));
    state_->info.latencyInfo.bufferLatencyMs = state_->info.latencyMs;
    state_->info.latencyInfo.totalLatencyMs = state_->info.latencyMs;
    state_->started = false;
    return true;
  }

  bool setOutputConfig(const OutputConfig&, std::string*) override { return true; }

  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string*) override {
    std::lock_guard lock(state_->mutex);
    state_->render = std::move(callback);
    state_->typedRender = nullptr;
    state_->event = std::move(eventCallback);
    state_->started = true;
    return true;
  }

  bool startTyped(
      TypedRenderCallback typedCallback,
      RenderCallback fallbackCallback,
      OutputEventCallback eventCallback,
      std::string*) override {
    std::lock_guard lock(state_->mutex);
    // The gate intentionally invokes the real float render path. It does not
    // emulate a hardware typed callback or make a device claim.
    state_->typedRender = std::move(typedCallback);
    state_->render = std::move(fallbackCallback);
    state_->event = std::move(eventCallback);
    state_->started = true;
    return true;
  }

  void stop() override {
    std::lock_guard lock(state_->mutex);
    state_->started = false;
  }

  void close() override { stop(); }

  AudioFormat outputFormat() const override {
    std::lock_guard lock(state_->mutex);
    return state_->format;
  }

  OutputInfo outputInfo() const override {
    std::lock_guard lock(state_->mutex);
    return state_->info;
  }

  DopRuntimeFacts dopRuntimeFacts() const override { return {}; }

  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override {
    return unsupportedNativeDsdRuntimeFacts("Controlled callback pump does not provide Native DSD hardware");
  }

  std::string deviceName() const override {
    std::lock_guard lock(state_->mutex);
    return state_->info.deviceName;
  }

 private:
  std::shared_ptr<ControlledBackendState> state_;
};

class ScopedControlledBackendFactory {
 public:
  ScopedControlledBackendFactory() {
    AudioPipeline::setBackendFactoryForTests([](const std::string&) {
      return std::make_unique<ControlledPumpBackend>();
    });
  }

  ~ScopedControlledBackendFactory() {
    AudioPipeline::setBackendFactoryForTests({});
  }

  ScopedControlledBackendFactory(const ScopedControlledBackendFactory&) = delete;
  ScopedControlledBackendFactory& operator=(const ScopedControlledBackendFactory&) = delete;
};

std::shared_ptr<ControlledBackendState> latestBackend() {
  std::lock_guard lock(g_backendMutex);
  return g_latestBackend;
}

void resetBackend() {
  std::lock_guard lock(g_backendMutex);
  g_latestBackend.reset();
}

void writeLe16(std::ofstream& out, uint16_t value) {
  const char bytes[2] = {static_cast<char>(value & 0xff), static_cast<char>((value >> 8) & 0xff)};
  out.write(bytes, sizeof(bytes));
}

void writeLe32(std::ofstream& out, uint32_t value) {
  const char bytes[4] = {
      static_cast<char>(value & 0xff),
      static_cast<char>((value >> 8) & 0xff),
      static_cast<char>((value >> 16) & 0xff),
      static_cast<char>((value >> 24) & 0xff)};
  out.write(bytes, sizeof(bytes));
}

std::filesystem::path writePcmWav(
    const std::filesystem::path& path,
    double seconds,
    bool impulseResponse,
    double frequency = 440.0) {
  const uint64_t frameCount = static_cast<uint64_t>(std::llround(seconds * static_cast<double>(kSampleRate)));
  const uint64_t dataBytes64 = frameCount * kChannels * sizeof(int16_t);
  assert(dataBytes64 <= UINT32_MAX - 36U);
  const uint32_t dataBytes = static_cast<uint32_t>(dataBytes64);

  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  assert(out.good());
  out.write("RIFF", 4);
  writeLe32(out, 36U + dataBytes);
  out.write("WAVEfmt ", 8);
  writeLe32(out, 16);
  writeLe16(out, 1);
  writeLe16(out, kChannels);
  writeLe32(out, kSampleRate);
  writeLe32(out, kSampleRate * kChannels * sizeof(int16_t));
  writeLe16(out, kChannels * sizeof(int16_t));
  writeLe16(out, 16);
  out.write("data", 4);
  writeLe32(out, dataBytes);

  for (uint64_t frame = 0; frame < frameCount; ++frame) {
    double sample = 0.0;
    if (impulseResponse) {
      const double decay = std::exp(-static_cast<double>(frame) / static_cast<double>(kSampleRate) * 7.0);
      sample = frame == 0 ? 0.85 : ((frame % 97 == 0) ? decay * 0.18 : 0.0);
    } else {
      sample = std::sin((2.0 * 3.14159265358979323846 * frequency * static_cast<double>(frame)) /
                        static_cast<double>(kSampleRate)) *
               0.20;
    }
    const auto encoded = static_cast<int16_t>(std::clamp(sample, -1.0, 1.0) * 32767.0);
    for (int channel = 0; channel < kChannels; ++channel) writeLe16(out, static_cast<uint16_t>(encoded));
  }
  assert(out.good());
  return path;
}

struct ProcessMemorySnapshot {
  uint64_t workingSetBytes = 0;
  uint64_t peakWorkingSetBytes = 0;
};

ProcessMemorySnapshot processMemorySnapshot() {
  ProcessMemorySnapshot snapshot;
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS_EX counters{};
  counters.cb = sizeof(counters);
  if (GetProcessMemoryInfo(
          GetCurrentProcess(),
          reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
          sizeof(counters))) {
    snapshot.workingSetBytes = static_cast<uint64_t>(counters.WorkingSetSize);
    snapshot.peakWorkingSetBytes = static_cast<uint64_t>(counters.PeakWorkingSetSize);
  }
#endif
  return snapshot;
}

OutputInfo::Diagnostics diagnosticDelta(
    const OutputInfo::Diagnostics& before,
    const OutputInfo::Diagnostics& after) {
  OutputInfo::Diagnostics delta;
  delta.sessionUnderrunCount = after.sessionUnderrunCount - before.sessionUnderrunCount;
  delta.sessionBufferDropCount = after.sessionBufferDropCount - before.sessionBufferDropCount;
  delta.sessionRecoveryCount = after.sessionRecoveryCount - before.sessionRecoveryCount;
  delta.lifetimeUnderrunCount = after.lifetimeUnderrunCount - before.lifetimeUnderrunCount;
  delta.lifetimeBufferDropCount = after.lifetimeBufferDropCount - before.lifetimeBufferDropCount;
  delta.lifetimeRecoveryCount = after.lifetimeRecoveryCount - before.lifetimeRecoveryCount;
  delta.driverRestartCount = after.driverRestartCount - before.driverRestartCount;
  delta.deviceLostCount = after.deviceLostCount - before.deviceLostCount;
  delta.lastError = after.lastError;
  return delta;
}

OutputInfo::RenderPerformanceSnapshot performanceDelta(
    const OutputInfo::RenderPerformanceSnapshot& before,
    const OutputInfo::RenderPerformanceSnapshot& after) {
  OutputInfo::RenderPerformanceSnapshot delta;
  delta.callbackCount = after.callbackCount - before.callbackCount;
  delta.totalCallbackNanoseconds = after.totalCallbackNanoseconds - before.totalCallbackNanoseconds;
  delta.peakCallbackNanoseconds = after.peakCallbackNanoseconds;
  delta.totalDeadlineNanoseconds = after.totalDeadlineNanoseconds - before.totalDeadlineNanoseconds;
  delta.deadlineMissCount = after.deadlineMissCount - before.deadlineMissCount;
  return delta;
}

double meanCallbackLoadPercent(const OutputInfo::RenderPerformanceSnapshot& snapshot) {
  if (snapshot.totalDeadlineNanoseconds == 0) return 0.0;
  return static_cast<double>(snapshot.totalCallbackNanoseconds) * 100.0 /
         static_cast<double>(snapshot.totalDeadlineNanoseconds);
}

double meanCallbackMilliseconds(const OutputInfo::RenderPerformanceSnapshot& snapshot) {
  if (snapshot.callbackCount == 0) return 0.0;
  return static_cast<double>(snapshot.totalCallbackNanoseconds) /
         static_cast<double>(snapshot.callbackCount) / 1000000.0;
}

bool pumpCallback(const std::shared_ptr<ControlledBackendState>& backend, std::vector<float>* scratch) {
  assert(backend && scratch);
  RenderCallback render;
  AudioFormat format;
  {
    std::lock_guard lock(backend->mutex);
    assert(backend->started);
    render = backend->render;
    format = backend->format;
  }
  assert(render);
  scratch->assign(kCallbackFrames * static_cast<size_t>(std::max(1, format.channelCount)), 0.0f);
  const size_t written = render(scratch->data(), kCallbackFrames);
  assert(written == kCallbackFrames);
  const bool containsAudio = std::any_of(scratch->begin(), scratch->end(), [](float value) {
    return std::abs(value) > 0.0001f;
  });
  {
    std::lock_guard lock(backend->mutex);
    ++backend->callbackInvocations;
    if (containsAudio) ++backend->callbacksWithAudio;
  }
  return containsAudio;
}

struct PumpResult {
  PipelineStatus status;
  uint64_t callbackCount = 0;
  uint64_t callbacksWithAudio = 0;
};

PumpResult pumpAudioTime(
    AudioPipeline& pipeline,
    const std::shared_ptr<ControlledBackendState>& backend,
    double targetAudioSeconds,
    const std::optional<std::string>& expectedCurrentItemId = std::nullopt) {
  const uint64_t expectedFrames = static_cast<uint64_t>(targetAudioSeconds * static_cast<double>(kSampleRate));
  const uint64_t expectedCallbacks = (expectedFrames + kCallbackFrames - 1) / kCallbackFrames;
  std::vector<float> scratch;
  uint64_t callbacks = 0;
  uint64_t callbacksWithAudio = 0;
  const uint64_t callbackLimit = expectedCallbacks * 4 + 1024;

  while (callbacks < callbackLimit) {
    callbacksWithAudio += pumpCallback(backend, &scratch) ? 1U : 0U;
    ++callbacks;
    if ((callbacks % 16U) == 0U) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    const PipelineStatus status = pipeline.status();
    const bool expectedTrackPromoted =
        expectedCurrentItemId && status.currentItem.id == *expectedCurrentItemId;
    if (callbacks >= expectedCallbacks &&
        (expectedTrackPromoted || (!expectedCurrentItemId && status.positionSeconds >= targetAudioSeconds * 0.98))) {
      break;
    }
  }

  PumpResult result;
  result.status = pipeline.status();
  result.callbackCount = callbacks;
  result.callbacksWithAudio = callbacksWithAudio;
  if (expectedCurrentItemId) {
    assert(result.status.currentItem.id == *expectedCurrentItemId);
    // The 12-second transition scenarios contain eight seconds of the first
    // source, so promotion must leave several seconds of actual next-track
    // rendering rather than merely toggling a pending flag.
    assert(result.status.positionSeconds >= 2.0);
  } else {
    assert(result.status.positionSeconds >= targetAudioSeconds * 0.98);
  }
  assert(callbacksWithAudio > expectedCallbacks / 2);
  return result;
}

struct ScenarioReport {
  std::string name;
  std::string execution = "controlled-pump";
  double audioSeconds = 0.0;
  OutputInfo::RenderPerformanceSnapshot performance;
  OutputInfo::Diagnostics diagnostics;
  uint64_t workingSetBeforeBytes = 0;
  uint64_t workingSetAfterBytes = 0;
  uint64_t peakWorkingSetBytes = 0;
  uint64_t callbackPumpCount = 0;
  uint64_t callbackPumpAudioCount = 0;
  bool upcomingTrackPromoted = false;
  bool vst3ControlledHelper = false;
};

void enforcePipelineThresholds(const ScenarioReport& report) {
  assert(report.performance.callbackCount > 0);
  assert(report.performance.totalDeadlineNanoseconds > 0);
  assert(report.performance.deadlineMissCount <= kPipelineDeadlineMissLimit);
  assert(meanCallbackLoadPercent(report.performance) <= kPipelineMeanDeadlineLoadLimitPercent);
  assert(report.diagnostics.sessionUnderrunCount == 0);
  assert(report.diagnostics.sessionBufferDropCount == 0);
  assert(report.diagnostics.sessionRecoveryCount == 0);
  assert(report.diagnostics.deviceLostCount == 0);
  assert(report.diagnostics.lastError.empty());
#ifdef _WIN32
  assert(report.workingSetBeforeBytes > 0);
  assert(report.workingSetAfterBytes > 0);
  assert(report.peakWorkingSetBytes >= report.workingSetAfterBytes);
#endif
}

ScenarioReport runPipelineScenario(
    const std::string& name,
    const std::filesystem::path& source,
    double targetAudioSeconds,
    const std::string& dspConfigJson,
    const std::optional<std::filesystem::path>& upcoming = std::nullopt,
    const std::optional<std::filesystem::path>& impulseResponse = std::nullopt) {
  resetBackend();
  AudioPipeline pipeline;
  QueueItem item;
  item.id = name + "-current";
  item.source = source.string();
  std::optional<QueueItem> next;
  if (upcoming) {
    QueueItem nextItem;
    nextItem.id = name + "-next";
    nextItem.source = upcoming->string();
    next = nextItem;
  }

  std::string error;
  assert(pipeline.play(item, next, 0.0, "controlled-pump", "controlled", 0.9, dspConfigJson, true, &error) == TAE_RESULT_OK);
  const auto backend = latestBackend();
  assert(backend);
  if (impulseResponse) {
    assert(pipeline.loadImpulseResponse(impulseResponse->string(), &error));
    assert(pipeline.convolverInfo().active);
  }

  const PipelineStatus before = pipeline.status();
  const ProcessMemorySnapshot memoryBefore = processMemorySnapshot();
  const PumpResult pump = pumpAudioTime(
      pipeline,
      backend,
      targetAudioSeconds,
      next ? std::optional<std::string>(next->id) : std::nullopt);
  const PipelineStatus after = pump.status;
  const ProcessMemorySnapshot memoryAfter = processMemorySnapshot();

  ScenarioReport report;
  report.name = name;
  report.audioSeconds = targetAudioSeconds;
  report.performance = performanceDelta(before.outputInfo.renderPerformance, after.outputInfo.renderPerformance);
  report.diagnostics = diagnosticDelta(before.outputInfo.diagnostics, after.outputInfo.diagnostics);
  report.workingSetBeforeBytes = memoryBefore.workingSetBytes;
  report.workingSetAfterBytes = memoryAfter.workingSetBytes;
  report.peakWorkingSetBytes = memoryAfter.peakWorkingSetBytes;
  report.callbackPumpCount = pump.callbackCount;
  report.callbackPumpAudioCount = pump.callbacksWithAudio;
  report.upcomingTrackPromoted = next && after.currentItem.id == next->id;
  if (next) assert(report.upcomingTrackPromoted);
  enforcePipelineThresholds(report);
  pipeline.stop();
  return report;
}

#ifdef _WIN32
ScenarioReport runControlledVst3Scenario() {
  Vst3BridgeConfig config;
  config.modulePath = "controlled-vst3-helper.vst3";
  config.classId = "0123456789ABCDEF0123456789ABCDEF";
  config.parametersJson = "{}";
  Vst3BridgeProcessor bridge(config);
  AudioFormat format;
  format.sampleRate = kSampleRate;
  format.channelCount = kChannels;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  bridge.prepare(format);
  assert(bridge.isActive());

  const ProcessMemorySnapshot memoryBefore = processMemorySnapshot();
  const uint64_t callbacks = static_cast<uint64_t>(kLongScenarioAudioSeconds * kSampleRate) / kCallbackFrames;
  const uint64_t deadlineNs = (kCallbackFrames * 1000000000ULL) / kSampleRate;
  std::vector<float> samples(kCallbackFrames * kChannels, 0.1f);
  OutputInfo::RenderPerformanceSnapshot performance;
  performance.callbackCount = callbacks;
  performance.totalDeadlineNanoseconds = callbacks * deadlineNs;
  for (uint64_t index = 0; index < callbacks; ++index) {
    const auto started = std::chrono::steady_clock::now();
    bridge.process(samples.data(), kCallbackFrames);
    const uint64_t elapsed = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count());
    performance.totalCallbackNanoseconds += elapsed;
    performance.peakCallbackNanoseconds = std::max(performance.peakCallbackNanoseconds, elapsed);
    if (elapsed > deadlineNs) ++performance.deadlineMissCount;
    if ((index % 16U) == 0U) std::this_thread::yield();
  }
  assert(bridge.isActive());
  assert(bridge.processCalls() >= callbacks);
  const ProcessMemorySnapshot memoryAfter = processMemorySnapshot();

  ScenarioReport report;
  report.name = "controlled-vst3-bridge";
  report.audioSeconds = kLongScenarioAudioSeconds;
  report.performance = performance;
  report.workingSetBeforeBytes = memoryBefore.workingSetBytes;
  report.workingSetAfterBytes = memoryAfter.workingSetBytes;
  report.peakWorkingSetBytes = memoryAfter.peakWorkingSetBytes;
  report.vst3ControlledHelper = true;
  assert(report.performance.deadlineMissCount == 0);
  assert(meanCallbackLoadPercent(report.performance) <= kPipelineMeanDeadlineLoadLimitPercent);
#ifdef _WIN32
  assert(report.workingSetBeforeBytes > 0);
  assert(report.workingSetAfterBytes > 0);
  assert(report.peakWorkingSetBytes >= report.workingSetAfterBytes);
#endif
  return report;
}
#endif

void writeJsonString(std::ostream& out, const std::string& value) {
  out << '"';
  for (const char character : value) {
    if (character == '"' || character == '\\') out << '\\';
    out << character;
  }
  out << '"';
}

void writeScenarioJson(std::ostream& out, const ScenarioReport& report, bool trailingComma) {
  out << "    {\"name\":";
  writeJsonString(out, report.name);
  out << ",\"execution\":";
  writeJsonString(out, report.execution);
  out << ",\"audioSeconds\":" << report.audioSeconds
      << ",\"vst3ControlledHelper\":" << (report.vst3ControlledHelper ? "true" : "false")
      << ",\"transition\":{\"upcomingTrackPromoted\":"
      << (report.upcomingTrackPromoted ? "true" : "false")
      << ",\"callbackPumpCount\":" << report.callbackPumpCount
      << ",\"callbackPumpAudioCount\":" << report.callbackPumpAudioCount << "}"
      << ",\"renderPerformance\":{\"callbackCount\":" << report.performance.callbackCount
      << ",\"meanCallbackMilliseconds\":" << meanCallbackMilliseconds(report.performance)
      << ",\"peakCallbackNanoseconds\":" << report.performance.peakCallbackNanoseconds
      << ",\"totalDeadlineNanoseconds\":" << report.performance.totalDeadlineNanoseconds
      << ",\"deadlineMissCount\":" << report.performance.deadlineMissCount
      << ",\"callbackDeadlineLoadPercent\":" << meanCallbackLoadPercent(report.performance)
      << "},\"diagnosticDelta\":{\"sessionUnderrunCount\":" << report.diagnostics.sessionUnderrunCount
      << ",\"sessionBufferDropCount\":" << report.diagnostics.sessionBufferDropCount
      << ",\"sessionRecoveryCount\":" << report.diagnostics.sessionRecoveryCount
      << ",\"deviceLostCount\":" << report.diagnostics.deviceLostCount
      << "},\"memory\":{\"workingSetBeforeBytes\":" << report.workingSetBeforeBytes
      << ",\"workingSetAfterBytes\":" << report.workingSetAfterBytes
      << ",\"peakWorkingSetBytes\":" << report.peakWorkingSetBytes << "}}";
  if (trailingComma) out << ',';
  out << '\n';
}

}  // namespace

namespace twilight::audio {

std::unique_ptr<IOutputBackend> createOutputBackend(const std::string&, std::string*) {
  return std::make_unique<ControlledPumpBackend>();
}

}  // namespace twilight::audio

int main() {
#ifndef TAE_HAS_FFMPEG
  std::cout << "audio-performance-gate skipped: FFmpeg support is not compiled\n";
  return 77;
#else
  ScopedPerformanceTestThreadPriority performanceTestThreadPriority;
  ScopedControlledBackendFactory controlledBackendFactory;
  std::cout << std::fixed << std::setprecision(3);
  const std::filesystem::path fixtureRoot =
      std::filesystem::temp_directory_path() / "twilight-audio-performance-gate";
  std::error_code ignored;
  std::filesystem::remove_all(fixtureRoot, ignored);
  std::filesystem::create_directories(fixtureRoot);

  const auto pcmLong = writePcmWav(fixtureRoot / "pcm-long.wav", kLongScenarioAudioSeconds + 4.0, false, 311.0);
  const auto gaplessA = writePcmWav(fixtureRoot / "gapless-a.wav", 8.0, false, 421.0);
  const auto gaplessB = writePcmWav(fixtureRoot / "gapless-b.wav", 8.0, false, 523.0);
  const auto crossfadeA = writePcmWav(fixtureRoot / "crossfade-a.wav", 8.0, false, 631.0);
  const auto crossfadeB = writePcmWav(fixtureRoot / "crossfade-b.wav", 8.0, false, 733.0);
  const auto shortIr = writePcmWav(fixtureRoot / "short-ir.wav", 0.030, true);
  const auto longIr = writePcmWav(fixtureRoot / "long-ir.wav", 1.000, true);

  std::vector<ScenarioReport> reports;
  reports.push_back(runPipelineScenario(
      "pcm-steady-180s",
      pcmLong,
      kLongScenarioAudioSeconds,
      "{\"dspEnabled\":true,\"fftEnabled\":false}"));
  reports.push_back(runPipelineScenario(
      "gapless-promote",
      gaplessA,
      12.0,
      "{\"dspEnabled\":true,\"gapless\":true,\"crossfadeSeconds\":0}",
      gaplessB));
  reports.push_back(runPipelineScenario(
      "crossfade-promote",
      crossfadeA,
      12.0,
      "{\"dspEnabled\":true,\"gapless\":true,\"crossfadeSeconds\":0.25}",
      crossfadeB));
  reports.push_back(runPipelineScenario(
      "convolution-short-ir",
      pcmLong,
      30.0,
      "{\"dspEnabled\":true,\"convolverEnabled\":true}",
      std::nullopt,
      shortIr));
  reports.push_back(runPipelineScenario(
      "convolution-long-ir",
      pcmLong,
      30.0,
      "{\"dspEnabled\":true,\"convolverEnabled\":true}",
      std::nullopt,
      longIr));
#ifdef _WIN32
  reports.push_back(runControlledVst3Scenario());
#endif

  const ProcessMemorySnapshot memory = processMemorySnapshot();
  std::cout << "{\n"
            << "  \"schemaVersion\": 1,\n"
            << "  \"gate\": \"audio-performance\",\n"
            << "  \"execution\": \"controlled-pump\",\n"
            << "  \"hardwareClaim\": false,\n"
            << "  \"callbackMetric\": \"elapsed callback time divided by audio buffer deadline; not system CPU\",\n"
            << "  \"thresholds\": {\"meanCallbackDeadlineLoadPercentMax\": "
            << kPipelineMeanDeadlineLoadLimitPercent
            << ", \"deadlineMissCountMax\": " << kPipelineDeadlineMissLimit << "},\n"
            << "  \"processMemory\": {\"workingSetBytes\": " << memory.workingSetBytes
            << ", \"peakWorkingSetBytes\": " << memory.peakWorkingSetBytes << "},\n"
            << "  \"scenarios\": [\n";
  for (size_t index = 0; index < reports.size(); ++index) {
    writeScenarioJson(std::cout, reports[index], index + 1 < reports.size());
  }
  std::cout << "  ]\n}" << std::endl;

  std::filesystem::remove_all(fixtureRoot, ignored);
  return 0;
#endif
}
