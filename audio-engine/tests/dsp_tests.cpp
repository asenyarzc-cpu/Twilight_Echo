#include "../dsp/DspChain.h"
#include "../dsp/DspChainActiveUtils.h"
#include "../dsp/ConvolverProcessorUtils.h"
#include "../dsp/CrossfeedProcessorUtils.h"
#include "../dsp/FftSpectrumAnalyzer.h"
#include "../dsp/FftSpectrumAnalyzerUtils.h"
#include "../dsp/KissFftAdapterUtils.h"
#include "../dsp/ParametricEqProcessorUtils.h"
#include "../dsp/ReplayGainProcessorUtils.h"

#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <thread>
#include <vector>

using namespace twilight::audio;

namespace {

class CountingProcessor final : public IAudioProcessor {
 public:
  explicit CountingProcessor(bool active) : active_(active) {}

  void configure(const DspConfig&) override {}
  void prepare(const AudioFormat&) override {}
  void setTrackContext(const DspTrackContext&) override {}
  void process(float*, size_t) override { ++processCalls; }
  void reset() override {}
  bool isActive() const override { return active_; }

  int processCalls = 0;

 private:
  bool active_ = false;
};

bool closeTo(double actual, double expected, double tolerance = 0.02) {
  return std::abs(actual - expected) <= tolerance;
}

void require(bool condition) {
  if (!condition) std::abort();
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

std::string extractFunctionBody(const std::string& source, const std::string& signature) {
  const size_t signaturePos = source.find(signature);
  require(signaturePos != std::string::npos);
  const size_t bodyStart = source.find('{', signaturePos);
  require(bodyStart != std::string::npos);
  int depth = 0;
  for (size_t i = bodyStart; i < source.size(); ++i) {
    if (source[i] == '{') {
      ++depth;
    } else if (source[i] == '}') {
      --depth;
      if (depth == 0) return source.substr(bodyStart, i - bodyStart + 1);
    }
  }
  require(false);
  return {};
}

void requireAnalyzerReadRefreshesBeforeLock(const std::string& body) {
  const size_t refresh = body.find("updateSpectrumForRead");
  const size_t lock = body.find("std::lock_guard lock(mutex_)");
  require(refresh != std::string::npos);
  require(lock != std::string::npos);
  require(refresh < lock);

  const std::string lockTail = body.substr(lock);
  require(lockTail.find("updateSpectrumLocked") == std::string::npos);
  require(lockTail.find("KissFftAdapter::forward") == std::string::npos);
}

void testFftAnalyzerReadSideRefreshesSpectrumOutsideCaptureMutex() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "dsp" / "FftSpectrumAnalyzer.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string readBody =
      extractFunctionBody(source, "size_t FftSpectrumAnalyzer::read(float* output, size_t points, double idlePhase) const");
  const std::string jsonBody = extractFunctionBody(
      source,
      "std::string FftSpectrumAnalyzer::readVisualizationJson(");

  requireAnalyzerReadRefreshesBeforeLock(readBody);
  requireAnalyzerReadRefreshesBeforeLock(jsonBody);
}

void testFftAnalyzerCaptureDoesNotSlideFullWindows() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "dsp" / "FftSpectrumAnalyzer.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string captureBody =
      extractFunctionBody(source, "void FftSpectrumAnalyzer::capture(const float* interleaved, size_t frames, int channels)");

  require(captureBody.find("std::move") == std::string::npos);
  require(captureBody.find("timeDomainWriteIndex_") != std::string::npos);
  require(captureBody.find("oscilloscopeWriteIndex_") != std::string::npos);
}

void testFftAnalyzerReadRefreshReusesScratchBuffers() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "dsp" / "FftSpectrumAnalyzer.cpp";
  const std::filesystem::path headerPath =
      testFilePath.parent_path().parent_path() / "dsp" / "FftSpectrumAnalyzer.h";
  const std::string source = readTextFile(sourcePath);
  const std::string header = readTextFile(headerPath);
  const std::string updateBody =
      extractFunctionBody(source, "void FftSpectrumAnalyzer::updateSpectrumForRead(bool retainSpectrogram) const");

  require(updateBody.find("std::vector<float> fftInputScratch") == std::string::npos);
  require(updateBody.find("std::vector<std::complex<float>> spectrumScratch") == std::string::npos);
  require(updateBody.find("fftInputScratch_") != std::string::npos);
  require(updateBody.find("spectrumScratch_") != std::string::npos);
  require(header.find("fftInputScratch_") != std::string::npos);
  require(header.find("spectrumScratch_") != std::string::npos);
  require(header.find("spectrumUpdateMutex_") != std::string::npos);
}

void testParametricEqPreampOnlyProcessesContiguousSamples() {
  std::vector<float> samples = {-0.5f, 0.25f, 3.0f, -3.0f};

  eq::applyPreampOnly(samples.data(), samples.size(), 2.0);

  require(closeTo(samples[0], -1.0f, 0.0001));
  require(closeTo(samples[1], 0.5f, 0.0001));
  require(closeTo(samples[2], 4.0f, 0.0001));
  require(closeTo(samples[3], -4.0f, 0.0001));
}

void testWindowedFftInputOverwritesScratchWithoutPreclear() {
  std::vector<float> scratch = {99.0f, 99.0f, 99.0f};
  const std::vector<float> input = {1.0f, -2.0f, 0.5f};
  const std::vector<float> window = {0.25f, 0.5f, 2.0f};

  fft::writeWindowedFftInput(input, window, 3, scratch);

  assert(closeTo(scratch[0], 0.25f, 0.0001));
  assert(closeTo(scratch[1], -1.0f, 0.0001));
  assert(closeTo(scratch[2], 1.0f, 0.0001));
}

void testWindowResizeKeepsSameSizedBufferForOverwrite() {
  std::vector<float> window = {0.1f, 0.2f, 0.3f};
  const float* before = window.data();

  fft::resizeWindowForOverwrite(window, 3);

  assert(window.data() == before);
  assert(closeTo(window[0], 0.1f, 0.0001));
  assert(closeTo(window[1], 0.2f, 0.0001));
  assert(closeTo(window[2], 0.3f, 0.0001));
}

void testMagnitudeResizeKeepsSameSizedBufferForOverwrite() {
  std::vector<float> magnitudes = {0.25f, 0.5f, 0.75f};
  const float* before = magnitudes.data();

  fft::resizeMagnitudesForOverwrite(magnitudes, 3);

  assert(magnitudes.data() == before);
  assert(closeTo(magnitudes[0], 0.25f, 0.0001));
  assert(closeTo(magnitudes[1], 0.5f, 0.0001));
  assert(closeTo(magnitudes[2], 0.75f, 0.0001));
}

void testReducedArrayJsonWritesDirectlyWithOptionalClamp() {
  std::ostringstream json;
  const std::vector<float> values = {-2.0f, 0.5f, 2.0f};

  fft::writeReducedArrayJson(json, values, 3, true, true);

  assert(json.str() == "[-1,0.5,1]");
}

void testFftOutputResizeKeepsSameSizedBufferForOverwrite() {
  std::vector<KissFftAdapter::Complex> output = {
      {1.0f, 1.0f},
      {2.0f, 2.0f},
      {3.0f, 3.0f},
  };
  const KissFftAdapter::Complex* before = output.data();

  fft::resizeComplexOutputForOverwrite(output, 3);

  assert(output.data() == before);
  assert(output[0] == KissFftAdapter::Complex(1.0f, 1.0f));
  assert(output[1] == KissFftAdapter::Complex(2.0f, 2.0f));
  assert(output[2] == KissFftAdapter::Complex(3.0f, 3.0f));
}

void testResetCaptureSkipsBufferClearOnlyWhenAlreadySilent() {
  const bool alreadySilent = fft::resetCaptureCanSkipBufferClear(false, false, true, true, -120.0, -120.0, -70.0);
  const bool hasCapture = fft::resetCaptureCanSkipBufferClear(true, false, true, true, -120.0, -120.0, -70.0);
  const bool buffersDirty = fft::resetCaptureCanSkipBufferClear(false, false, true, false, -120.0, -120.0, -70.0);
  const bool spectrumDirty = fft::resetCaptureCanSkipBufferClear(false, true, true, true, -120.0, -120.0, -70.0);

  assert(alreadySilent);
  assert(!hasCapture);
  assert(!buffersDirty);
  assert(!spectrumDirty);
}

void testConvolverScratchWritePreservesInputAndClearsOnlyTail() {
  const std::vector<float> inputBlock = {1.0f, -2.0f, 0.5f};
  const std::vector<float> originalInput = inputBlock;
  std::vector<float> scratch = {9.0f, 9.0f, 9.0f, 9.0f, 9.0f, 9.0f};

  convolver::writeInputBlockToPaddedScratch(inputBlock, scratch, 3, 6);

  assert(inputBlock == originalInput);
  assert(closeTo(scratch[0], 1.0f, 0.0001));
  assert(closeTo(scratch[1], -2.0f, 0.0001));
  assert(closeTo(scratch[2], 0.5f, 0.0001));
  assert(closeTo(scratch[3], 0.0f, 0.0001));
  assert(closeTo(scratch[4], 0.0f, 0.0001));
  assert(closeTo(scratch[5], 0.0f, 0.0001));
}

void testConvolverImpulsePartitionWriteClearsOnlyUncoveredTail() {
  const std::vector<float> impulse = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
  std::vector<float> scratch = {9.0f, 9.0f, 9.0f, 9.0f, 9.0f, 9.0f};

  convolver::writeImpulsePartitionToPaddedScratch(impulse, 3, scratch, 3, 6);

  assert(closeTo(scratch[0], 0.4f, 0.0001));
  assert(closeTo(scratch[1], 0.5f, 0.0001));
  assert(closeTo(scratch[2], 0.0f, 0.0001));
  assert(closeTo(scratch[3], 0.0f, 0.0001));
  assert(closeTo(scratch[4], 0.0f, 0.0001));
  assert(closeTo(scratch[5], 0.0f, 0.0001));
}

void testConvolverSpectrumAccumulationOverwritesScratchWithoutPreclear() {
  using Complex = KissFftAdapter::Complex;
  const std::vector<std::vector<Complex>> inputHistory = {
      {Complex(10.0f, 0.0f), Complex(20.0f, 0.0f)},
      {Complex(1.0f, 0.0f), Complex(2.0f, 0.0f)},
  };
  const std::vector<std::vector<Complex>> impulsePartitions = {
      {Complex(3.0f, 0.0f), Complex(4.0f, 0.0f)},
      {Complex(5.0f, 0.0f), Complex(6.0f, 0.0f)},
  };
  std::vector<Complex> scratch = {Complex(99.0f, 0.0f), Complex(99.0f, 0.0f)};

  convolver::writePartitionedSpectrumProduct(
      inputHistory,
      impulsePartitions,
      1,
      2,
      scratch);

  assert(scratch[0] == Complex(53.0f, 0.0f));
  assert(scratch[1] == Complex(128.0f, 0.0f));
}

void testCrossfeedDelayIndexAdvancesAndWraps() {
  size_t index = 0;

  crossfeed::advanceDelayIndex(index, 3);
  assert(index == 1);
  crossfeed::advanceDelayIndex(index, 3);
  assert(index == 2);
  crossfeed::advanceDelayIndex(index, 3);
  assert(index == 0);
  crossfeed::advanceDelayIndex(index, 0);
  assert(index == 0);
}

void testReplayGainApplySplitsClippedAndUnclippedPaths() {
  std::vector<float> unclipped = {-0.75f, 0.5f, 0.75f};
  replaygain::applyReplayGain(unclipped.data(), unclipped.size(), 2.0, false);

  assert(closeTo(unclipped[0], -1.5f, 0.0001));
  assert(closeTo(unclipped[1], 1.0f, 0.0001));
  assert(closeTo(unclipped[2], 1.5f, 0.0001));

  std::vector<float> clipped = {-0.75f, 0.5f, 0.75f};
  replaygain::applyReplayGain(clipped.data(), clipped.size(), 2.0, true);

  assert(closeTo(clipped[0], -1.0f, 0.0001));
  assert(closeTo(clipped[1], 1.0f, 0.0001));
  assert(closeTo(clipped[2], 1.0f, 0.0001));
}

AudioFormat testFormat(int channelCount = 2) {
  AudioFormat format;
  format.sampleRate = 48000;
  format.channelCount = channelCount;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  return format;
}

void testDspProcessDoesNotTakeConfigurationLock() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "dsp" / "DspChain.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string processBody = extractFunctionBody(source, "void DspChain::process(float* samples, size_t frameCount)");

  require(processBody.find("mutex_") == std::string::npos);
  require(processBody.find("std::try_to_lock") == std::string::npos);
}

void testDsdPcmSafetyRecognizesSecondPhaseProcessors() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "core" / "AudioPipeline.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(
      source,
      "bool dspConfigProcessingRequiresPcm(");

  require(body.find("channelMatrixEnabled") != std::string::npos);
  require(body.find("dynamicEqEnabled") != std::string::npos);
  require(body.find("multibandCompressorEnabled") != std::string::npos);
  require(body.find("truePeakLimiterEnabled") != std::string::npos);
  require(body.find("ditherMode") != std::string::npos);
}

void testNativeDspPluginChainSetupDoesNotPreparePluginsTwice() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath = testFilePath.parent_path().parent_path() / "dsp" / "DspChain.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "void DspChain::setNativeDspPluginChain(const std::string& json)");
  const size_t setChain = body.find("nativePlugins_->setPluginChain");
  require(setChain != std::string::npos);

  const std::string afterSetChain = body.substr(setChain);
  require(afterSetChain.find("nativePlugins_->configure") == std::string::npos);
  require(afterSetChain.find("nativePlugins_->prepare") == std::string::npos);
  require(afterSetChain.find("nativePlugins_->setTrackContext") != std::string::npos);
}

void testDspConfigJsonParserReadsOnlyCurrentObjectFields() {
  const char* json = R"({
    "metadata": {
      "dspEnabled": true,
      "dsdOutputMode": "pcm",
      "crossfeedStrength": 1,
      "eqBands": [{"frequency": 20, "gain": 12}]
    },
    "dspEnabled": false,
    "dsdOutputMode": "dop",
    "crossfeedStrength": 0.25,
    "eqBands": [
      {"metadata": {"gain": 99, "q": 99}, "frequency": 1000, "gain": 1.5, "q": 0.7}
    ]
  })";

  const DspConfig config = DspChain::parseConfigJson(json);
  assert(!config.enabled);
  assert(config.dsdOutputMode == DsdOutputMode::Dop);
  assert(closeTo(config.crossfeedStrength, 0.25, 0.0001));
  assert(config.eqBands.size() == 1);
  assert(closeTo(config.eqBands[0].frequency, 1000.0, 0.0001));
  assert(closeTo(config.eqBands[0].gainDb, 1.5, 0.0001));
  assert(closeTo(config.eqBands[0].q, 0.7, 0.0001));

}

void testConvolverWaveExtensibleParsingUsesSubFormatGuid() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "dsp" / "ConvolverProcessor.cpp";
  const std::string source = readTextFile(sourcePath);
  require(source.find("formatTag = bitsPerSample == 32 ? kWaveFloat : kWavePcm") == std::string::npos);
  require(source.find("kWaveSubFormatPcm") != std::string::npos);
  require(source.find("kWaveSubFormatFloat") != std::string::npos);
}

void testConvolverBypassesAfterRepeatedBudgetMisses() {
  const std::filesystem::path testFilePath(__FILE__);
  const std::filesystem::path sourcePath =
      testFilePath.parent_path().parent_path() / "dsp" / "ConvolverProcessor.cpp";
  const std::string source = readTextFile(sourcePath);
  const std::string body = extractFunctionBody(source, "void ConvolverProcessor::process(float* samples, size_t frameCount)");
  const std::string bypassBody = extractFunctionBody(source, "void ConvolverProcessor::bypassRealtime(");

  require(body.find("std::chrono::steady_clock::now()") != std::string::npos);
  require(body.find("elapsedMs > budgetMs") != std::string::npos);
  require(body.find("consecutiveOverruns_ +=") != std::string::npos);
  require(body.find("kConvolverRealtimeBypassOverrunThreshold") != std::string::npos);
  require(body.find("bypassRealtime(") != std::string::npos);
  require(bypassBody.find("channels_.clear()") == std::string::npos);

  // bypassRealtime() runs on the audio thread. Assigning to info_.lastError there allocates
  // (the reason string is well past the SSO limit), so the reason has to come from info().
  require(bypassBody.find("info_.lastError =") == std::string::npos);

  // The bypass must be recoverable: process() re-arms once the backoff elapses instead of
  // muting convolution for the rest of the graph generation.
  require(body.find("shouldRearmAfterBypass()") != std::string::npos);
  const std::string rearmBody = extractFunctionBody(source, "bool ConvolverProcessor::shouldRearmAfterBypass(");
  require(rearmBody.find("kConvolverRearmBaseCooldown") != std::string::npos);
  require(rearmBody.find("kConvolverMaxBypassGenerations") != std::string::npos);
  // Re-arm happens on the audio thread, so it may only touch allocation-free resets.
  require(rearmBody.find("channels_.clear()") == std::string::npos);
  require(rearmBody.find(".assign(") == std::string::npos);
  require(rearmBody.find("prepareRuntimeIr") == std::string::npos);
}

// The render thread runs a *clone* of the convolver, not the instance convolverInfo() reads,
// so the realtime bypass only reaches the UI through the shared state. Verify the handshake
// directly rather than trusting a timing-dependent overrun.
void testConvolverRealtimeStateIsSharedWithRenderClone() {
  ConvolverProcessor control;
  ConvolverProcessor renderClone;

  auto shared = control.realtimeState();
  require(shared != nullptr);
  renderClone.setRealtimeState(shared);
  require(renderClone.realtimeState() == shared);

  require(!control.info().bypassed);

  // Stand in for what bypassRealtime() publishes from the audio thread.
  shared->bypassed.store(true, std::memory_order_release);
  shared->bypassCount.fetch_add(1, std::memory_order_relaxed);
  shared->overrunCount.store(7, std::memory_order_relaxed);
  shared->maxProcessMs.store(12.5, std::memory_order_relaxed);

  const ConvolverInfo info = control.info();
  require(info.bypassed);
  require(!info.active);
  require(info.overrunCount == 7);
  require(info.bypassCount == 1);
  require(info.maxProcessMs >= 12.5);
  require(!info.lastError.empty());

  shared->bypassed.store(false, std::memory_order_release);
  require(!control.info().bypassed);
}

void writeImpulseWav(const std::filesystem::path& path, int sampleRate, int channels) {
  const int bitsPerSample = 16;
  const int frames = 8;
  const int blockAlign = channels * bitsPerSample / 8;
  const int byteRate = sampleRate * blockAlign;
  const int dataSize = frames * blockAlign;
  std::ofstream out(path, std::ios::binary);
  out.write("RIFF", 4);
  const uint32_t riffSize = static_cast<uint32_t>(36 + dataSize);
  out.write(reinterpret_cast<const char*>(&riffSize), 4);
  out.write("WAVE", 4);
  out.write("fmt ", 4);
  const uint32_t fmtSize = 16;
  const uint16_t audioFormat = 1;
  const uint16_t channelCount = static_cast<uint16_t>(channels);
  const uint32_t rate = static_cast<uint32_t>(sampleRate);
  const uint32_t bytesPerSecond = static_cast<uint32_t>(byteRate);
  const uint16_t align = static_cast<uint16_t>(blockAlign);
  const uint16_t bits = static_cast<uint16_t>(bitsPerSample);
  out.write(reinterpret_cast<const char*>(&fmtSize), 4);
  out.write(reinterpret_cast<const char*>(&audioFormat), 2);
  out.write(reinterpret_cast<const char*>(&channelCount), 2);
  out.write(reinterpret_cast<const char*>(&rate), 4);
  out.write(reinterpret_cast<const char*>(&bytesPerSecond), 4);
  out.write(reinterpret_cast<const char*>(&align), 2);
  out.write(reinterpret_cast<const char*>(&bits), 2);
  out.write("data", 4);
  const uint32_t dataBytes = static_cast<uint32_t>(dataSize);
  out.write(reinterpret_cast<const char*>(&dataBytes), 4);
  for (int frame = 0; frame < frames; ++frame) {
    for (int channel = 0; channel < channels; ++channel) {
      const int16_t sample = frame == 0 ? 32767 : 0;
      out.write(reinterpret_cast<const char*>(&sample), 2);
    }
  }
}

void writeExtensiblePcm32ImpulseWav(const std::filesystem::path& path) {
  constexpr int sampleRate = 48000;
  constexpr int channels = 1;
  constexpr int bitsPerSample = 32;
  constexpr int frames = 8;
  constexpr int blockAlign = channels * bitsPerSample / 8;
  constexpr int byteRate = sampleRate * blockAlign;
  constexpr int dataSize = frames * blockAlign;
  std::ofstream out(path, std::ios::binary);
  out.write("RIFF", 4);
  const uint32_t riffSize = static_cast<uint32_t>(4 + (8 + 40) + (8 + dataSize));
  out.write(reinterpret_cast<const char*>(&riffSize), 4);
  out.write("WAVE", 4);
  out.write("fmt ", 4);
  const uint32_t fmtSize = 40;
  const uint16_t audioFormat = 0xfffe;
  const uint16_t channelCount = static_cast<uint16_t>(channels);
  const uint32_t rate = static_cast<uint32_t>(sampleRate);
  const uint32_t bytesPerSecond = static_cast<uint32_t>(byteRate);
  const uint16_t align = static_cast<uint16_t>(blockAlign);
  const uint16_t bits = static_cast<uint16_t>(bitsPerSample);
  const uint16_t cbSize = 22;
  const uint16_t validBits = bits;
  const uint32_t channelMask = 0x4;
  const std::array<unsigned char, 16> pcmSubFormat = {
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
      0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
  out.write(reinterpret_cast<const char*>(&fmtSize), 4);
  out.write(reinterpret_cast<const char*>(&audioFormat), 2);
  out.write(reinterpret_cast<const char*>(&channelCount), 2);
  out.write(reinterpret_cast<const char*>(&rate), 4);
  out.write(reinterpret_cast<const char*>(&bytesPerSecond), 4);
  out.write(reinterpret_cast<const char*>(&align), 2);
  out.write(reinterpret_cast<const char*>(&bits), 2);
  out.write(reinterpret_cast<const char*>(&cbSize), 2);
  out.write(reinterpret_cast<const char*>(&validBits), 2);
  out.write(reinterpret_cast<const char*>(&channelMask), 4);
  out.write(reinterpret_cast<const char*>(pcmSubFormat.data()), static_cast<std::streamsize>(pcmSubFormat.size()));
  out.write("data", 4);
  const uint32_t dataBytes = static_cast<uint32_t>(dataSize);
  out.write(reinterpret_cast<const char*>(&dataBytes), 4);
  for (int frame = 0; frame < frames; ++frame) {
    const int32_t sample = frame == 0 ? std::numeric_limits<int32_t>::max() : 0;
    out.write(reinterpret_cast<const char*>(&sample), 4);
  }
}

// Extracts a flat JSON numeric array field (e.g. "oscilloscope":[0.1,-0.2,...])
// into a vector<float>. Returns empty vector if the key is absent or the array
// cannot be parsed. Non-numeric tokens (e.g. null) are skipped.
std::vector<float> extractJsonArray(const std::string& json, const std::string& key) {
  std::vector<float> result;
  const std::string needle = "\"" + key + "\":[";
  const size_t start = json.find(needle);
  if (start == std::string::npos) return result;
  const size_t arrStart = start + needle.size();
  const size_t arrEnd = json.find(']', arrStart);
  if (arrEnd == std::string::npos) return result;
  std::stringstream ss(json.substr(arrStart, arrEnd - arrStart));
  std::string token;
  while (std::getline(ss, token, ',')) {
    try {
      result.push_back(std::stof(token));
    } catch (...) {
      // skip null / invalid tokens
    }
  }
  return result;
}

}  // namespace

int main() {
  testFftAnalyzerReadSideRefreshesSpectrumOutsideCaptureMutex();
  testFftAnalyzerCaptureDoesNotSlideFullWindows();
  testFftAnalyzerReadRefreshReusesScratchBuffers();
  testParametricEqPreampOnlyProcessesContiguousSamples();
  testWindowedFftInputOverwritesScratchWithoutPreclear();
  testWindowResizeKeepsSameSizedBufferForOverwrite();
  testMagnitudeResizeKeepsSameSizedBufferForOverwrite();
  testReducedArrayJsonWritesDirectlyWithOptionalClamp();
  testFftOutputResizeKeepsSameSizedBufferForOverwrite();
  testResetCaptureSkipsBufferClearOnlyWhenAlreadySilent();
  testConvolverScratchWritePreservesInputAndClearsOnlyTail();
  testConvolverImpulsePartitionWriteClearsOnlyUncoveredTail();
  testConvolverSpectrumAccumulationOverwritesScratchWithoutPreclear();
  testCrossfeedDelayIndexAdvancesAndWraps();
  testReplayGainApplySplitsClippedAndUnclippedPaths();
  testDspProcessDoesNotTakeConfigurationLock();
  testDsdPcmSafetyRecognizesSecondPhaseProcessors();
  testNativeDspPluginChainSetupDoesNotPreparePluginsTwice();
  testDspConfigJsonParserReadsOnlyCurrentObjectFields();
  testConvolverWaveExtensibleParsingUsesSubFormatGuid();
  testConvolverBypassesAfterRepeatedBudgetMisses();
  testConvolverRealtimeStateIsSharedWithRenderClone();
  {
    CountingProcessor inactive(false);
    CountingProcessor active(true);
    std::vector<IAudioProcessor*> processors{&inactive, &active};
    const std::vector<IAudioProcessor*> activeProcessors = dsp::collectActiveProcessors(processors);

    assert(activeProcessors.size() == 1);
    assert(activeProcessors[0] == &active);
  }

  {
    DspChain chain;
    DspConfig config;
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setTrackContext({});

    std::vector<float> samples = {1.0f, -1.0f, 0.25f, -0.25f};
    const std::vector<float> original = samples;
    chain.process(samples.data(), 2);

    assert(!chain.status().dspActive);
    assert(samples == original);
  }

  {
    DspChain chain;
    const DspConfig config = DspChain::parseConfigJson("{\"dspEnabled\":false,\"crossfadeSeconds\":0.5}");
    assert(config.gapless);
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setTrackContext({});

    const DspStatus status = chain.status();
    assert(status.crossfadeActive);
    assert(closeTo(status.crossfadeSeconds, 0.5));

    std::vector<float> samples = {1.0f, -1.0f, 0.25f, -0.25f};
    const std::vector<float> original = samples;
    chain.process(samples.data(), 2);
    assert(samples == original);
  }

  {
    const DspConfig config = DspChain::parseConfigJson("{\"gapless\":false,\"crossfadeSeconds\":0}");
    assert(!config.gapless);
    assert(config.crossfadeSeconds == 0.0);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.replayGainMode = ReplayGainMode::Track;
    config.replayGainClip = true;
    chain.configure(config);
    chain.prepare(testFormat());

    DspTrackContext context;
    context.stream.replayGain.trackGainDb = -6.0;
    chain.setTrackContext(context);

    std::vector<float> samples = {1.0f, -1.0f, 0.5f, -0.5f};
    chain.process(samples.data(), 2);

    const DspStatus status = chain.status();
    assert(status.dspActive);
    assert(status.replayGainActive);
    assert(closeTo(samples[0], 0.501));
    assert(closeTo(samples[2], 0.251));
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.replayGainMode = ReplayGainMode::Album;
    config.replayGainFallbackDb = -3.0;
    config.replayGainPreampDb = 1.0;
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setTrackContext({});

    std::vector<float> samples = {1.0f, 1.0f};
    chain.process(samples.data(), 1);

    assert(chain.status().replayGainActive);
    assert(closeTo(samples[0], std::pow(10.0, -2.0 / 20.0)));
  }

  {
    // loudnorm must not alias to Track tags; without measured LUFS use fallback only.
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.replayGainMode = ReplayGainMode::Loudnorm;
    config.replayGainFallbackDb = -4.0;
    config.replayGainPreampDb = 0.0;
    chain.configure(config);
    chain.prepare(testFormat());

    DspTrackContext context;
    context.stream.replayGain.trackGainDb = -12.0;
    context.stream.replayGain.albumGainDb = -9.0;
    chain.setTrackContext(context);

    std::vector<float> samples = {1.0f, 1.0f};
    chain.process(samples.data(), 1);

    const DspStatus status = chain.status();
    assert(status.replayGainActive);
    assert(status.loudnormActive);
    assert(closeTo(samples[0], std::pow(10.0, -4.0 / 20.0)));

    const DspConfig parsed = DspChain::parseConfigJson(
        "{\"enabled\":true,\"volumeNormalization\":\"loudnorm\",\"replayGainFallback\":-1.5}");
    assert(parsed.replayGainMode == ReplayGainMode::Loudnorm);
  }

  {
    const DspConfig defaults = DspChain::parseConfigJson("{}");
    const DspConfig exact = DspChain::parseConfigJson("{\"dsdRatePolicy\":\"exact\"}");
    const DspConfig downrate = DspChain::parseConfigJson("{\"dsdRatePolicy\":\"downrate\"}");
    const DspConfig invalid = DspChain::parseConfigJson("{\"dsdRatePolicy\":\"invalid\"}");
    assert(defaults.dsdRatePolicy == DsdRatePolicy::PcmFallback);
    assert(exact.dsdRatePolicy == DsdRatePolicy::Exact);
    assert(downrate.dsdRatePolicy == DsdRatePolicy::Downrate);
    assert(invalid.dsdRatePolicy == DsdRatePolicy::PcmFallback);
  }

  {
    // loudnorm measured path: gain = target - measured + preamp, with true-peak ceiling.
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.replayGainMode = ReplayGainMode::Loudnorm;
    config.loudnormTargetLufs = -23.0;
    config.loudnormTruePeakCeilingDb = -1.0;
    config.replayGainPreampDb = 0.0;
    config.replayGainFallbackDb = -99.0;
    config.replayGainClip = false;
    chain.configure(config);
    chain.prepare(testFormat());

    DspTrackContext context;
    context.stream.replayGain.trackGainDb = -12.0;
    context.stream.replayGain.measuredIntegratedLufs = -18.0;
    context.stream.replayGain.measuredTruePeakDb = -6.0;
    chain.setTrackContext(context);

    // gainDb = (-23 - (-18)) + 0 = -5 dB; projected TP = -6 + (-5) = -11 <= -1 → no extra cut.
    std::vector<float> samples = {1.0f, 1.0f};
    chain.process(samples.data(), 1);
    assert(chain.status().loudnormActive);
    assert(closeTo(samples[0], std::pow(10.0, -5.0 / 20.0)));

    // True-peak ceiling: measured TP -2 dB + gain would exceed -1 → extra attenuation.
    context.stream.replayGain.measuredIntegratedLufs = -30.0;
    context.stream.replayGain.measuredTruePeakDb = -0.5;
    chain.setTrackContext(context);
    // rawGain = (-23 - (-30)) = +7; projected TP = -0.5 + 7 = 6.5 → cut by 7.5 → gain = -0.5
    samples = {1.0f, 1.0f};
    chain.process(samples.data(), 1);
    assert(closeTo(samples[0], std::pow(10.0, -0.5 / 20.0)));
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.eqEnabled = true;
    config.eqMode = EqMode::Graphic;
    config.eqBands.push_back({1000.0, 3.0, 1.0, DspFilterType::AllPass});
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setTrackContext({});

    std::vector<float> samples(256, 0.1f);
    chain.process(samples.data(), 128);

    assert(chain.status().eqActive);
    for (float sample : samples) {
      assert(std::isfinite(sample));
    }
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.eqEnabled = true;
    config.eqMode = EqMode::Parametric;
    config.eqBands.push_back({1000.0, 3.0, 1.0, DspFilterType::BandPass});
    config.eqBands.push_back({2000.0, 3.0, 1.0, DspFilterType::AllPass});
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setTrackContext({});

    assert(chain.status().eqActive);
    std::vector<float> samples(256, 0.1f);
    chain.process(samples.data(), 128);
    for (float sample : samples) assert(std::isfinite(sample));
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;
    const std::string graph = R"({"revision":7,"sceneId":"mastering","graph":{"nodes":[
      {"id":"strip","type":"channelStrip","enabled":true,"params":{"channels":[{"gainDb":-6,"delayMs":0,"polarityInverted":false,"mute":false},{"gainDb":-6,"delayMs":0,"polarityInverted":true,"mute":false}]}},
      {"id":"limiter","type":"truePeakLimiter","enabled":true,"params":{"ceilingDb":-1,"releaseMs":50}},
      {"id":"meter","type":"meter","enabled":true,"params":{}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples = {2.0f, 2.0f, 2.0f, 2.0f};
    chain.process(samples.data(), 2);
    const DspStatus status = chain.status();
    assert(status.channelStripActive);
    assert(status.truePeakLimiterActive);
    assert(status.meterActive);
    assert(chain.graphStatusJson().find("\"revision\":7") != std::string::npos);
    for (float sample : samples) assert(std::isfinite(sample));
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;
    const std::string graph = R"({"revision":8,"sceneId":"matrix","graph":{"nodes":[
      {"id":"matrix","type":"channelMatrix","enabled":true,"params":{"matrix":[0,1,1,0]}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples = {0.25f, -0.5f, 0.75f, -0.125f};
    chain.process(samples.data(), 2);
    assert(chain.status().channelMatrixActive);
    assert(closeTo(samples[0], -0.5f, 0.0001));
    assert(closeTo(samples[1], 0.25f, 0.0001));
    assert(closeTo(samples[2], -0.125f, 0.0001));
    assert(closeTo(samples[3], 0.75f, 0.0001));
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;
    const std::string graph = R"({"revision":81,"sceneId":"singleton","graph":{"nodes":[
      {"id":"eq-first","type":"equalizer","enabled":true,"params":{"mode":"parametric","bands":[]}},
      {"id":"eq-second","type":"equalizer","enabled":true,"params":{"mode":"parametric","bands":[]}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    const std::string status = chain.graphStatusJson();
    assert(status.find("\"id\":\"eq-second\"") != std::string::npos);
    assert(status.find("Only one equalizer node is supported") != std::string::npos);
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat(8));
    std::string error;
    const std::string graph = R"({"revision":9,"sceneId":"calibration","graph":{"nodes":[
      {"id":"strip","type":"channelStrip","enabled":true,"params":{"channels":[
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":-6,"delayMs":0,"polarityInverted":true,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":false},
        {"gainDb":0,"delayMs":0,"polarityInverted":false,"mute":true}
      ]}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples(8, 0.5f);
    chain.process(samples.data(), 1);
    assert(chain.status().channelStripActive);
    assert(closeTo(samples[0], 0.5f, 0.0001));
    assert(closeTo(samples[1], -0.5f * std::pow(10.0, -6.0 / 20.0), 0.0001));
    assert(closeTo(samples[7], 0.0f, 0.0001));
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat(6));
    std::string error;
    const std::string graph = R"({"revision":10,"sceneId":"bass","graph":{"nodes":[
      {"id":"bass","type":"bassManagement","enabled":true,"params":{"crossoverHz":80,"lfeGainDb":0,"redirectLfe":true}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples(512 * 6, 0.0f);
    for (size_t frame = 0; frame < 512; ++frame) {
      samples[frame * 6] = 0.5f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * frame / 240.0));
    }
    chain.process(samples.data(), 512);
    double lfeEnergy = 0.0;
    for (size_t frame = 0; frame < 512; ++frame) {
      lfeEnergy += std::abs(samples[frame * 6 + 3]);
      for (int channel = 0; channel < 6; ++channel) assert(std::isfinite(samples[frame * 6 + channel]));
    }
    assert(chain.status().bassManagementActive);
    assert(lfeEnergy > 0.01);
  }

  {
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;
    const std::string graph = R"({"revision":11,"sceneId":"limiter","graph":{"nodes":[
      {"id":"limiter","type":"truePeakLimiter","enabled":true,"params":{"ceilingDb":-1,"attackMs":0.1,"releaseMs":40,"lookaheadMs":0.1}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples(512 * 2, 1.5f);
    chain.process(samples.data(), 512);
    double peak = 0.0;
    for (size_t frame = 12; frame < 512; ++frame) {
      peak = std::max(peak, std::abs(static_cast<double>(samples[frame * 2])));
    }
    assert(chain.status().truePeakLimiterActive);
    assert(peak <= std::pow(10.0, -1.0 / 20.0) + 0.02);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    chain.configure(config);
    chain.prepare(testFormat());

    const auto wavPath = std::filesystem::temp_directory_path() / "twilight-ir-48000.wav";
    writeImpulseWav(wavPath, 48000, 1);
    std::string error;
    assert(chain.loadImpulseResponse(wavPath.string(), &error));
    const DspStatus status = chain.status();
    assert(status.convolverActive);
    assert(status.partitionSize == 1024);
    assert(status.channelMappingMode == "mono-to-all");
    std::filesystem::remove(wavPath);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    chain.configure(config);
    chain.prepare(testFormat());

    const auto wavPath = std::filesystem::temp_directory_path() / "twilight-ir-extensible-pcm32.wav";
    writeExtensiblePcm32ImpulseWav(wavPath);
    std::string error;
    assert(chain.loadImpulseResponse(wavPath.string(), &error));
    std::vector<float> samples(2048 * 2, 0.0f);
    samples[0] = 1.0f;
    chain.process(samples.data(), 2048);
    assert(samples[1024 * 2] > 0.2f);
    std::filesystem::remove(wavPath);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.convolverGainDb = -6.0;
    config.convolverPolarityInverted = true;
    config.convolverDelayMs = 1.0;
    chain.configure(config);
    chain.prepare(testFormat());

    const auto wavPath = std::filesystem::temp_directory_path() / "twilight-ir-wet-delay.wav";
    writeImpulseWav(wavPath, 48000, 1);
    std::string error;
    assert(chain.loadImpulseResponse(wavPath.string(), &error));
    std::vector<float> samples(2048 * 2, 0.0f);
    samples[0] = 1.0f;
    chain.process(samples.data(), 2048);
    const DspStatus status = chain.status();
    assert(status.convolverLatencyFrames == 1024 + 48);
    assert(closeTo(samples[(1024 + 48) * 2], -std::pow(10.0, -6.0 / 20.0), 0.03));
    std::filesystem::remove(wavPath);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    config.convolverMatrix = {0.0, 1.0};
    chain.configure(config);
    chain.prepare(testFormat());

    const auto wavPath = std::filesystem::temp_directory_path() / "twilight-ir-mono-to-stereo.wav";
    writeImpulseWav(wavPath, 48000, 1);
    std::string error;
    assert(chain.loadImpulseResponse(wavPath.string(), &error));
    std::vector<float> samples(2048 * 2, 0.0f);
    samples[0] = 1.0f;
    chain.process(samples.data(), 2048);
    assert(chain.status().channelMappingMode == "matrix-1xn");
    assert(std::abs(samples[1024 * 2]) < 0.01f);
    assert(samples[1024 * 2 + 1] > 0.2f);
    std::filesystem::remove(wavPath);
  }

  {
    DspChain chain;
    DspConfig config;
    config.enabled = true;
    chain.configure(config);
    chain.prepare(testFormat());
    chain.setCrossfeedStrength(0.75);
    assert(chain.status().crossfeedActive);
    std::vector<float> samples(512, 0.0f);
    samples[0] = 1.0f;
    chain.process(samples.data(), 256);
    for (float sample : samples) assert(std::isfinite(sample));
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 256);
    std::vector<float> samples(512, 0.0f);
    for (size_t i = 0; i < 256; ++i) {
      samples[i * 2] = static_cast<float>(std::sin(2.0 * 3.141592653589793 * i / 32.0));
      samples[i * 2 + 1] = samples[i * 2];
    }
    analyzer.capture(samples.data(), 256, 2);
    std::vector<float> spectrum(64, 0.0f);
    assert(analyzer.read(spectrum.data(), spectrum.size()) == spectrum.size());
    assert(analyzer.isActive());
    for (float value : spectrum) assert(std::isfinite(value));

    const std::string json = analyzer.readVisualizationJson(24, 32, 8);
    assert(json.find("\"active\":true") != std::string::npos);
    assert(json.find("\"spectrum\"") != std::string::npos);
    assert(json.find("\"waveform\"") != std::string::npos);
    assert(json.find("\"peakDb\"") != std::string::npos);
    assert(json.find("\"rmsDb\"") != std::string::npos);
    assert(json.find("\"lufsMomentary\"") != std::string::npos);
    assert(json.find("\"spectrogram\"") != std::string::npos);
    assert(json.find("\"sampleRate\":48000") != std::string::npos);
    assert(json.find("nan") == std::string::npos);
    assert(json.find("inf") == std::string::npos);

    const std::string lightJson = analyzer.readVisualizationJson(24, 32, 0, 0);
    assert(lightJson.find("\"spectrogram\":[]") != std::string::npos);
    const std::vector<float> omittedOscilloscope = extractJsonArray(lightJson, "oscilloscope");
    assert(omittedOscilloscope.empty());

    for (int read = 0; read < 120; ++read) {
      analyzer.capture(samples.data(), 256, 2);
      const std::string repeatedLightJson = analyzer.readVisualizationJson(24, 32, 0, 0);
      assert(repeatedLightJson.find("\"spectrogram\":[]") != std::string::npos);
    }
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 8192);
    std::vector<float> samples(8192 * 2, 0.0f);
    for (size_t i = 0; i < 8192; ++i) {
      samples[i * 2] = static_cast<float>(std::sin(2.0 * 3.141592653589793 * i / 256.0));
      samples[i * 2 + 1] = samples[i * 2];
    }
    analyzer.capture(samples.data(), 8192, 2);
    const std::string json = analyzer.readVisualizationJson(4096, 32, 8);
    const std::vector<float> spectrum = extractJsonArray(json, "spectrum");
    assert(spectrum.size() == 4096);
    bool anyNonZero = false;
    for (float value : spectrum) {
      assert(std::isfinite(value));
      if (value > 0.0f) anyNonZero = true;
    }
    assert(anyNonZero);
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 1024);

    auto captureSine = [&](float amplitude) {
      std::vector<float> samples(1024 * 2, 0.0f);
      for (size_t i = 0; i < 1024; ++i) {
        const float value =
            amplitude * static_cast<float>(std::sin(2.0 * 3.141592653589793 * static_cast<double>(i) / 64.0));
        samples[i * 2] = value;
        samples[i * 2 + 1] = value;
      }
      analyzer.resetCapture();
      analyzer.capture(samples.data(), 1024, 2);
      const std::string json = analyzer.readVisualizationJson(128, 32, 0, 0);
      return extractJsonArray(json, "spectrum");
    };

    const std::vector<float> loudSpectrum = captureSine(1.0f);
    const std::vector<float> halfSpectrum = captureSine(0.5f);
    const std::vector<float> quietSpectrum = captureSine(0.001f);
    const float loudPeak = *std::max_element(loudSpectrum.begin(), loudSpectrum.end());
    const float halfPeak = *std::max_element(halfSpectrum.begin(), halfSpectrum.end());
    const float quietPeak = *std::max_element(quietSpectrum.begin(), quietSpectrum.end());

    assert(loudPeak > 0.82f);
    assert(loudPeak < 0.96f);
    assert(halfPeak > 0.0f);
    assert(halfPeak < loudPeak - 0.02f);
    assert(quietPeak > 0.0f);
    assert(quietPeak < loudPeak - 0.4f);
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 1024);
    std::vector<float> samples(1024 * 2, 0.0f);
    for (size_t i = 0; i < 1024; ++i) {
      const float value =
          static_cast<float>(std::sin(2.0 * 3.141592653589793 * static_cast<double>(i) / 64.0));
      samples[i * 2] = value;
      samples[i * 2 + 1] = value;
    }

    analyzer.capture(samples.data(), 1024, 2);
    float legacySpectrum[64] = {};
    require(analyzer.read(legacySpectrum, 64, 0.0) == 64);

    const std::string json = analyzer.readVisualizationJson(64, 32, 1, 0);
    require(json.find("\"spectrogram\":[[") != std::string::npos);
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 256);
    analyzer.setEnabled(false);
    const std::string json = analyzer.readVisualizationJson(24, 32, 8, 1024);
    assert(json.find("\"active\":false") != std::string::npos);
    assert(json.find("\"lufsMomentary\":null") != std::string::npos);
    assert(json.find("\"spectrogram\":[]") != std::string::npos);
    assert(json.find("\"sampleRate\":48000") != std::string::npos);
    // Oscilloscope key must be present even when inactive: a zero-filled
    // array of the requested point count (decoupled from fftResolution).
    assert(json.find("\"oscilloscope\"") != std::string::npos);
    const std::vector<float> inactiveOscilloscope = extractJsonArray(json, "oscilloscope");
    assert(inactiveOscilloscope.size() == 1024);
    for (float value : inactiveOscilloscope) {
      assert(value == 0.0f);
    }
  }

  {
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 256);
    std::vector<float> silence(512, 0.0f);
    analyzer.capture(silence.data(), 256, 2);
    std::vector<float> spectrum(64, 1.0f);
    assert(analyzer.read(spectrum.data(), spectrum.size()) == spectrum.size());
    assert(analyzer.isActive());
    for (float value : spectrum) {
      assert(std::isfinite(value));
      assert(value == 0.0f);
    }
  }

  {
    // testOscilloscopeBufferDecoupled: the oscilloscope tap must provide a
    // high-resolution time-domain ring buffer INDEPENDENT of fftResolution.
    // With fftResolution=64 the legacy waveform tap can never yield more than
    // 64 distinct samples, but the decoupled oscilloscope buffer (1024) must.
    FftSpectrumAnalyzer analyzer;
    analyzer.prepare(testFormat(), 64);          // small FFT resolution
    analyzer.prepareOscilloscope(1024);          // decoupled, larger tap
    // Feed 2048 frames of a sine (period 2048). The last 1024 frames (second
    // half-cycle) populate the oscilloscope buffer; they are nearly all
    // distinct. The legacy timeDomain_ only retains the last 64 frames.
    const size_t frames = 2048;
    std::vector<float> samples(frames * 2, 0.0f);
    for (size_t i = 0; i < frames; ++i) {
      const float v = static_cast<float>(std::sin(2.0 * 3.141592653589793 * static_cast<double>(i) / 2048.0));
      samples[i * 2] = v;
      samples[i * 2 + 1] = v;
    }
    analyzer.capture(samples.data(), frames, 2);
    const std::string json = analyzer.readVisualizationJson(24, 32, 8, 1024);
    assert(json.find("\"active\":true") != std::string::npos);
    assert(json.find("\"oscilloscope\"") != std::string::npos);

    const std::vector<float> oscilloscope = extractJsonArray(json, "oscilloscope");
    assert(oscilloscope.size() == 1024);  // decoupled from fftResolution=64

    // Non-zero signal captured.
    bool anyNonZero = false;
    for (float v : oscilloscope) {
      assert(v >= -1.0f && v <= 1.0f);  // signed mono PCM range
      if (v != 0.0f) anyNonZero = true;
    }
    assert(anyNonZero);

    // The oscilloscope must expose strictly more distinct values than the
    // 64-sample timeDomain_ could ever provide (proves decoupling).
    const std::set<float> distinct(oscilloscope.begin(), oscilloscope.end());
    assert(distinct.size() > 64);

    // Legacy waveform stays coupled to fftResolution: only 32 points requested,
    // sourced from a 64-sample timeDomain_.
    const std::vector<float> waveform = extractJsonArray(json, "waveform");
    assert(waveform.size() == 32);
  }

  {
    // The second-phase nodes must compile into the serial graph and operate on
    // the preallocated render buffers without changing the block shape.
    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;
    const std::string graph = R"({"revision":21,"sceneId":"hifi-workstation","graph":{"outputStage":{"targetSampleRate":96000,"resamplerQuality":"ultra","dither":"noiseShaped","safetyClamp":true},"nodes":[
      {"id":"dynamic","type":"dynamicEqualizer","enabled":true,"params":{"bands":[{"frequency":1000,"gainDb":0,"q":1,"thresholdDb":-30,"ratio":3,"rangeDb":-8,"attackMs":5,"releaseMs":90,"filterType":"peak","enabled":true}]}},
      {"id":"multiband","type":"multibandCompressor","enabled":true,"params":{"crossoversHz":[240],"bands":[{"thresholdDb":-24,"ratio":2,"attackMs":5,"releaseMs":80,"makeupDb":0,"enabled":true},{"thresholdDb":-24,"ratio":2,"attackMs":5,"releaseMs":80,"makeupDb":0,"enabled":true}]}},
      {"id":"field","type":"stereoField","enabled":true,"params":{"width":1.2,"balance":0,"midGainDb":0,"sideGainDb":0}},
      {"id":"contour","type":"loudnessContour","enabled":true,"params":{"amount":1,"referenceVolume":0.5}},
      {"id":"limiter","type":"truePeakLimiter","enabled":true,"params":{"ceilingDb":-1,"attackMs":0.2,"releaseMs":60,"lookaheadMs":1}},
      {"id":"meter","type":"meter","enabled":true,"params":{}}
    ]}})";
    assert(chain.configureGraphJson(graph, &error));
    std::vector<float> samples(2048 * 2, 0.0f);
    for (size_t frame = 0; frame < 2048; ++frame) {
      const float value = 1.4f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * frame / 37.0));
      samples[frame * 2] = value;
      samples[frame * 2 + 1] = value * 0.8f;
    }
    chain.process(samples.data(), 2048);
    const DspStatus status = chain.status();
    assert(status.dynamicEqActive);
    assert(status.multibandCompressorActive);
    assert(status.stereoFieldActive);
    assert(status.loudnessContourActive);
    assert(status.truePeakLimiterActive);
    assert(status.meterActive);
    assert(std::isfinite(status.truePeakDb));
    assert(chain.graphStatusJson().find("\"resamplerQuality\":\"ultra\"") != std::string::npos);
    assert(chain.graphStatusJson().find("\"momentaryLufs\"") != std::string::npos);
    for (float sample : samples) assert(std::isfinite(sample));
  }

  {
    // SoX-quality resampler tiers: parsing, status naming, and honest runtime
    // fallback reporting when the linked FFmpeg lacks the soxr engine.
    const auto graphWithQuality = [](const std::string& quality) {
      return std::string(R"({"revision":30,"sceneId":"soxr","graph":{"outputStage":{"targetSampleRate":96000,"resamplerQuality":")") +
             quality + R"(","dither":"off","safetyClamp":true},"nodes":[{"id":"meter","type":"meter","enabled":true,"params":{}}]}})";
    };

    DspChain chain;
    chain.configure(DspConfig{});
    chain.prepare(testFormat());
    std::string error;

    assert(chain.configureGraphJson(graphWithQuality("soxrHq"), &error));
    std::string statusJson = chain.graphStatusJson();
    assert(statusJson.find("\"resamplerQuality\":\"soxrHq\"") != std::string::npos);
    assert(statusJson.find("\"resamplerEngine\":\"") != std::string::npos);
    assert(statusJson.find("\"resamplerFallback\":") != std::string::npos);

    assert(chain.configureGraphJson(graphWithQuality("soxrVhq"), &error));
    assert(chain.graphStatusJson().find("\"resamplerQuality\":\"soxrVhq\"") != std::string::npos);

    // Unknown soxr-family values keep the quality intent as Ultra.
    assert(chain.configureGraphJson(graphWithQuality("soxrUltraMax"), &error));
    assert(chain.graphStatusJson().find("\"resamplerQuality\":\"ultra\"") != std::string::npos);

    // Unknown non-soxr values still fall back to native.
    assert(chain.configureGraphJson(graphWithQuality("bogus"), &error));
    assert(chain.graphStatusJson().find("\"resamplerQuality\":\"native\"") != std::string::npos);

    // Simulate the decode-side probe outcome: unavailable → engine reports the
    // honest swr fallback and the reason string carries the fallback fact.
    reportSoxrRuntimeAvailability(false);
    assert(chain.configureGraphJson(graphWithQuality("soxrVhq"), &error));
    statusJson = chain.graphStatusJson();
    assert(statusJson.find("\"resamplerEngine\":\"swr\"") != std::string::npos);
    assert(statusJson.find("\"resamplerFallback\":true") != std::string::npos);
    assert(statusJson.find("SoX resampler unavailable") != std::string::npos);

    // Available → soxr engine is reported and no fallback is claimed.
    reportSoxrRuntimeAvailability(true);
    statusJson = chain.graphStatusJson();
    assert(statusJson.find("\"resamplerEngine\":\"soxr\"") != std::string::npos);
    assert(statusJson.find("\"resamplerFallback\":false") != std::string::npos);
    assert(statusJson.find("SoX resampler unavailable") == std::string::npos);

    // Non-soxr tiers always report the swr engine regardless of probe state.
    assert(chain.configureGraphJson(graphWithQuality("ultra"), &error));
    statusJson = chain.graphStatusJson();
    assert(statusJson.find("\"resamplerEngine\":\"swr\"") != std::string::npos);
    assert(statusJson.find("\"resamplerFallback\":false") != std::string::npos);

    // Reset the process-wide probe state for any later assertions.
    soxrRuntimeStateStorage().store(0);
  }

  return 0;
}
