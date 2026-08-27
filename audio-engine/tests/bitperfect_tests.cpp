#include "../core/AudioTypes.h"
#include "../core/AudioPipelineRenderUtils.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace twilight::audio;

namespace {

void require(bool condition) {
  if (!condition) std::abort();
}

AudioFormat pcm(
    int sampleRate = 48000,
    int bitDepth = 24,
    int channels = 2,
    AudioSampleFormat sampleFormat = AudioSampleFormat::Int24Interleaved) {
  AudioFormat format;
  format.sampleRate = sampleRate;
  format.channelCount = channels;
  format.bitDepth = bitDepth;
  format.sampleFormat = sampleFormat;
  return format;
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

void testTypedPcmToFloatAvoidsUnalignedWideReads() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "core" / "AudioPipelineRenderUtils.h";
  const std::string source = readTextFile(sourcePath);

  require(!source.empty());
  require(source.find("reinterpret_cast<const int16_t*>(block.data)") == std::string::npos);
  require(source.find("reinterpret_cast<const int32_t*>(block.data)") == std::string::npos);
}

PerfectEvaluation baseEvaluation() {
  PerfectEvaluation evaluation;
  evaluation.sourceFormat = pcm();
  evaluation.decodedFormat = pcm();
  evaluation.outputFormat = pcm();
  evaluation.sourceLossless = true;
  evaluation.supportsOutputPerfect = true;
  evaluation.volume = 1.0;
  evaluation.routingMode = ChannelRoutingMode::Auto;
  evaluation.pcmPassthrough = true;
  return evaluation;
}

void assertOutputPerfect(PerfectEvaluation evaluation) {
  const PerfectResult result = evaluatePerfect(evaluation);
  assert(result.outputPerfect);
  assert(result.pcmPassthrough);
  assert(!result.resampled);
}

void assertNotOutputPerfect(PerfectEvaluation evaluation) {
  const PerfectResult result = evaluatePerfect(evaluation);
  assert(!result.outputPerfect);
}

void testVolumeAppliesOnlyToRenderedFrames() {
  std::vector<float> samples = {
      2.0f, -2.0f,
      0.5f, -0.5f,
      9.0f, -9.0f,
  };

  render::applyVolumeToRenderedFrames(samples.data(), 2, 3, 2, 0.5);

  assert(samples[0] == 1.0f);
  assert(samples[1] == -1.0f);
  assert(std::abs(samples[2] - 0.25f) < 0.0001f);
  assert(std::abs(samples[3] + 0.25f) < 0.0001f);
  assert(samples[4] == 9.0f);
  assert(samples[5] == -9.0f);
}

void testUnityVolumeSkipsRenderedFrameProcessing() {
  require(!render::volumeNeedsProcessing(2, 3, 2, 1.0));
  require(!render::volumeNeedsProcessing(0, 3, 2, 0.5));
  require(!render::volumeNeedsProcessing(2, 0, 2, 0.5));
  require(!render::volumeNeedsProcessing(2, 3, 0, 0.5));
  require(render::volumeNeedsProcessing(2, 3, 2, 0.5));
}

void testZeroVolumeSilencesRenderedFramesWithoutTouchingTail() {
  std::vector<float> samples = {
      0.25f, -0.25f,
      2.0f, -2.0f,
      9.0f, -9.0f,
  };

  require(render::volumeSilencesRenderedFrames(2, 3, 2, 0.0));
  require(!render::volumeSilencesRenderedFrames(2, 3, 2, 0.5));

  render::applyVolumeToRenderedFrames(samples.data(), 2, 3, 2, 0.0);

  assert(samples[0] == 0.0f);
  assert(samples[1] == 0.0f);
  assert(samples[2] == 0.0f);
  assert(samples[3] == 0.0f);
  assert(samples[4] == 9.0f);
  assert(samples[5] == -9.0f);
}

void testCrossfadeSegmentMixesWithIncrementalFade() {
  std::vector<float> output = {
      0.8f, -0.8f,
      0.8f, -0.8f,
      0.8f, -0.8f,
  };
  const std::vector<float> preload = {
      -0.8f, 0.8f,
      0.0f, 2.0f,
      2.0f, -2.0f,
  };

  render::mixCrossfadeSegment(output.data(), preload.data(), 3, 2, 0, 2);

  assert(std::abs(output[0] - 0.8f) < 0.0001f);
  assert(std::abs(output[1] + 0.8f) < 0.0001f);
  assert(std::abs(output[2] - 0.4f) < 0.0001f);
  assert(std::abs(output[3] - 0.6f) < 0.0001f);
  assert(output[4] == 1.0f);
  assert(output[5] == -1.0f);
}

void testCrossfadeSegmentDetectsBoundedFadeRange() {
  require(render::crossfadeSegmentFadeIsBounded(3, 2, 8));
  require(render::crossfadeSegmentFadeIsBounded(1, 8, 8));
  require(!render::crossfadeSegmentFadeIsBounded(2, 8, 8));
  require(!render::crossfadeSegmentFadeIsBounded(3, 0, 0));
}

void testTypedPcmToFloatZerosOnlyUnconvertedTail() {
  const int16_t input[] = {
      8192,
      -8192,
  };
  std::vector<float> output = {
      -9.0f, -9.0f,
      -9.0f, -9.0f,
  };

  AudioFormat format = pcm(48000, 16, 2, AudioSampleFormat::Int16Interleaved);
  PcmBlock block;
  block.format = format;
  block.data = reinterpret_cast<uint8_t*>(const_cast<int16_t*>(input));
  block.frames = 1;
  block.byteSize = sizeof(input);

  const size_t converted = render::typedPcmToFloatWithTailSilence(block, output.data(), 2);

  assert(converted == 1);
  assert(std::abs(output[0] - 0.25f) < 0.0001f);
  assert(std::abs(output[1] + 0.25f) < 0.0001f);
  assert(output[2] == 0.0f);
  assert(output[3] == 0.0f);
}

void testTypedPcmToFloatFloat32AllowsInPlaceFullConversion() {
  std::vector<float> samples = {
      0.125f, -0.25f,
      0.5f, -0.75f,
  };

  AudioFormat format = pcm(48000, 32, 2, AudioSampleFormat::Float32Interleaved);
  PcmBlock block;
  block.format = format;
  block.data = reinterpret_cast<uint8_t*>(samples.data());
  block.frames = 2;
  block.byteSize = samples.size() * sizeof(float);

  const size_t converted = render::typedPcmToFloatWithTailSilence(block, samples.data(), 2);

  assert(converted == 2);
  assert(samples[0] == 0.125f);
  assert(samples[1] == -0.25f);
  assert(samples[2] == 0.5f);
  assert(samples[3] == -0.75f);
}

void testFloat32PcmConversionSkipsCopyWhenAlreadyInPlace() {
  std::vector<float> samples = {
      0.125f, -0.25f,
      0.5f, -0.75f,
  };
  PcmBlock block;
  block.data = reinterpret_cast<uint8_t*>(samples.data());

  const bool copyNeeded = render::float32PcmCopyNeeded(block, samples.data(), samples.size());
  require(!copyNeeded);
}

void testLosslessSourceExact() {
  const PerfectResult result = evaluatePerfect(baseEvaluation());
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(result.perfectReason.empty());
}

void testLossyOutputPerfect() {
  auto evaluation = baseEvaluation();
  evaluation.sourceFormat = pcm(48000, 32, 2, AudioSampleFormat::Float32Interleaved);
  evaluation.decodedFormat = evaluation.sourceFormat;
  evaluation.outputFormat = evaluation.sourceFormat;
  evaluation.sourceLossless = false;

  const PerfectResult result = evaluatePerfect(evaluation);
  assert(!result.sourceExact);
  assert(result.outputPerfect);
  assert(result.perfectReason.find("lossy") != std::string::npos);
}

void testLosslessIntegerDecodedConversionBlocksOutputPerfect() {
  auto evaluation = baseEvaluation();
  evaluation.sourceFormat = pcm(48000, 24, 2, AudioSampleFormat::Int24Interleaved);
  evaluation.decodedFormat = pcm(48000, 32, 2, AudioSampleFormat::Float32Interleaved);
  evaluation.outputFormat = evaluation.decodedFormat;

  const PerfectResult result = evaluatePerfect(evaluation);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(!result.pcmPassthrough);
  assert(result.perfectReasonCode == "integer_passthrough_unavailable");
  assert(result.perfectReason.find("Lossless PCM decoded through non-identical PCM format") != std::string::npos);
}

void testInt24SourceStaysExactThroughInt24In32Output() {
  const AudioFormat int24 = pcm(48000, 24, 2, AudioSampleFormat::Int24Interleaved);
  const AudioFormat int24In32 = pcm(48000, 24, 2, AudioSampleFormat::Int24In32Interleaved);
  const AudioFormat int32 = pcm(48000, 32, 2, AudioSampleFormat::Int32Interleaved);
  const AudioFormat int16 = pcm(48000, 16, 2, AudioSampleFormat::Int16Interleaved);
  const AudioFormat float32 = pcm(48000, 32, 2, AudioSampleFormat::Float32Interleaved);

  // Same payload, different container: interchangeable in value, not in bytes.
  assert(sampleFormatsSameIntegerPayload(
      AudioSampleFormat::Int24Interleaved, AudioSampleFormat::Int24In32Interleaved));
  assert(!sampleFormatsSameIntegerPayload(
      AudioSampleFormat::Int24Interleaved, AudioSampleFormat::Int32Interleaved));
  assert(!sampleFormatsSameIntegerPayload(
      AudioSampleFormat::Int24Interleaved, AudioSampleFormat::Float32Interleaved));
  assert(pcmFormatsSemanticallyMatch(int24, int24In32));
  assert(pcmFormatsSemanticallyMatch(int24, int24));
  assert(pcmFormatsSemanticallyMatch(float32, float32));
  assert(!pcmFormatsSemanticallyMatch(int24, int32));
  assert(!pcmFormatsSemanticallyMatch(int24, int16));
  assert(!pcmFormatsSemanticallyMatch(int24, float32));
  assert(!pcmFormatsExactMatch(int24, int24In32));

  // A device that only accepts the 32-bit container still gets every source bit,
  // so the 24-bit track must stay bit perfect instead of falling back to Float32.
  auto evaluation = baseEvaluation();
  evaluation.sourceFormat = int24;
  evaluation.decodedFormat = int24In32;
  evaluation.outputFormat = int24In32;
  const PerfectResult result = evaluatePerfect(evaluation);
  assert(result.sourceFormatMatched);
  assert(result.pcmPassthrough);
  assert(result.outputPerfect);
  assert(result.sourceExact);
  assert(!result.resampled);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());

  // Widening the container is fine; changing the payload is not.
  auto toInt32 = baseEvaluation();
  toInt32.sourceFormat = int24;
  toInt32.decodedFormat = int32;
  toInt32.outputFormat = int32;
  const PerfectResult int32Result = evaluatePerfect(toInt32);
  assert(!int32Result.sourceExact);
  assert(!int32Result.outputPerfect);
  assert(int32Result.perfectReasonCode == "integer_passthrough_unavailable");
}

void testBackendSupport() {
  auto shared = baseEvaluation();
  shared.supportsOutputPerfect = false;
  shared.backendPerfectReasonCode = "shared_mixer";
  shared.backendPerfectReason = "backend shared path";
  const PerfectResult sharedResult = evaluatePerfect(shared);
  assert(!sharedResult.outputPerfect);
  assert(sharedResult.perfectReasonCode == "shared_mixer");
  assert(sharedResult.perfectReason == "backend shared path");

  auto wasapiExclusive = baseEvaluation();
  assertOutputPerfect(wasapiExclusive);

  auto asio = baseEvaluation();
  asio.supportsOutputPerfect = true;
  assertOutputPerfect(asio);
}

void testBackendReasonFallback() {
  auto shared = baseEvaluation();
  shared.supportsOutputPerfect = false;
  const PerfectResult result = evaluatePerfect(shared);
  assert(!result.outputPerfect);
  assert(!result.perfectReason.empty());
}

void testPassthroughRequired() {
  auto evaluation = baseEvaluation();
  evaluation.pcmPassthrough = false;
  const PerfectResult result = evaluatePerfect(evaluation);
  assert(!result.outputPerfect);
  assert(result.perfectReason.find("PCM") != std::string::npos);
}

void testPcmPassthroughRequiresExactFormat() {
  const AudioFormat float32 = pcm(48000, 32, 2, AudioSampleFormat::Float32Interleaved);
  const AudioFormat int24 = pcm(48000, 24, 2, AudioSampleFormat::Int24Interleaved);
  const AudioFormat int24In32 = pcm(48000, 24, 2, AudioSampleFormat::Int24In32Interleaved);
  const AudioFormat pcm192k = pcm(192000, 24, 2, AudioSampleFormat::Int24Interleaved);
  const AudioFormat pcm192kIn32 = pcm(192000, 24, 2, AudioSampleFormat::Int24In32Interleaved);
  const AudioFormat pcm192kFloat = pcm(192000, 32, 2, AudioSampleFormat::Float32Interleaved);
  const AudioFormat pcm192kSixChannels = pcm(192000, 24, 6, AudioSampleFormat::Int24Interleaved);

  assert(pcmFormatsExactMatch(float32, float32));
  assert(!pcmFormatsExactMatch(float32, int24));
  assert(!pcmFormatsExactMatch(int24, int24In32));
  assert(pcmFormatsExactMatch(pcm192k, pcm192k));
  assert(!pcmFormatsExactMatch(pcm192k, pcm192kIn32));
  assert(!pcmFormatsExactMatch(pcm192k, pcm192kFloat));
  assert(!pcmFormatsExactMatch(pcm192k, pcm192kSixChannels));

  auto floatToInt = baseEvaluation();
  floatToInt.decodedFormat = float32;
  floatToInt.outputFormat = int24;
  floatToInt.pcmPassthrough = pcmFormatsExactMatch(floatToInt.decodedFormat, floatToInt.outputFormat);
  const PerfectResult floatToIntResult = evaluatePerfect(floatToInt);
  assert(!floatToIntResult.outputPerfect);
  assert(!floatToIntResult.pcmPassthrough);
  assert(floatToIntResult.perfectReasonCode == "integer_passthrough_unavailable");

  auto outputConversion = baseEvaluation();
  outputConversion.sourceFormat = float32;
  outputConversion.decodedFormat = float32;
  outputConversion.outputFormat = int24;
  outputConversion.pcmPassthrough =
      pcmFormatsExactMatch(outputConversion.decodedFormat, outputConversion.outputFormat);
  const PerfectResult outputConversionResult = evaluatePerfect(outputConversion);
  assert(!outputConversionResult.outputPerfect);
  assert(!outputConversionResult.pcmPassthrough);
  assert(outputConversionResult.perfectReasonCode == "pcm_converted");
  assert(outputConversionResult.perfectReason.find("Decoded PCM converted") != std::string::npos);
}

void testFormatMismatch() {
  auto sampleRateMismatch = baseEvaluation();
  sampleRateMismatch.outputFormat.sampleRate = 96000;
  const PerfectResult sampleRateResult = evaluatePerfect(sampleRateMismatch);
  assert(!sampleRateResult.outputPerfect);
  assert(sampleRateResult.resampled);

  auto bitDepthMismatch = baseEvaluation();
  bitDepthMismatch.outputFormat.bitDepth = 32;
  assertNotOutputPerfect(bitDepthMismatch);

  auto sampleFormatMismatch = baseEvaluation();
  sampleFormatMismatch.outputFormat.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
  const PerfectResult sampleFormatResult = evaluatePerfect(sampleFormatMismatch);
  assert(!sampleFormatResult.outputPerfect);
  assert(sampleFormatResult.perfectReason.find("Decoded PCM converted") != std::string::npos);

  auto backendResampled = baseEvaluation();
  backendResampled.backendResampled = true;
  const PerfectResult backendResult = evaluatePerfect(backendResampled);
  assert(!backendResult.outputPerfect);
  assert(backendResult.resampled);
}

void testSampleFormatEffectiveBitDepth() {
  AudioFormat int16 = pcm(44100, 0, 2, AudioSampleFormat::Int16Interleaved);
  assert(effectivePcmBitDepth(int16) == 16);

  AudioFormat int24Packed = pcm(44100, 0, 2, AudioSampleFormat::Int24Interleaved);
  assert(effectivePcmBitDepth(int24Packed) == 24);

  AudioFormat int24In32 = pcm(44100, 32, 2, AudioSampleFormat::Int24In32Interleaved);
  assert(effectivePcmBitDepth(int24In32) == 24);

  AudioFormat float32 = pcm(44100, 0, 2, AudioSampleFormat::Float32Interleaved);
  assert(effectivePcmBitDepth(float32) == 32);
}

void testDopCarrierHelper() {
  const auto dsd64 = dopCarrierFormatForDsd(64, 2822400, 2);
  assert(dsd64.has_value());
  assert(dsd64->sampleRate == 176400);
  assert(dsd64->bitDepth == 24);
  assert(dsd64->channelCount == 2);
  assert(dsd64->sampleFormat == AudioSampleFormat::Int24Interleaved);

  const auto dsd128 = dopCarrierFormatForDsd(128, 5644800, 6);
  assert(dsd128.has_value());
  assert(dsd128->sampleRate == 352800);
  assert(dsd128->bitDepth == 24);
  assert(dsd128->channelCount == 6);

  const auto dsd256 = dopCarrierFormatForDsd(256, 11289600, 2);
  assert(dsd256.has_value());
  assert(dsd256->sampleRate == 705600);

  const auto dsd512 = dopCarrierFormatForDsd(512, 22579200, 2);
  assert(dsd512.has_value());
  assert(dsd512->sampleRate == 1411200);

  const auto dsd256x48 = dopCarrierFormatForDsd(256, 12288000, 2);
  assert(dsd256x48.has_value());
  assert(dsd256x48->sampleRate == 768000);

  const auto dsd512x48 = dopCarrierFormatForDsd(512, 24576000, 2);
  assert(dsd512x48.has_value());
  assert(dsd512x48->sampleRate == 1536000);

  assert(!dopCarrierFormatForDsd(64, 2822400, 0).has_value());
}

void testProcessingFlags() {
  auto volume = baseEvaluation();
  volume.volume = 0.99;
  assertNotOutputPerfect(volume);
  {
    PerfectResult result = evaluatePerfect(volume);
    assert(result.perfectReasonCode == "volume_not_unity");
  }

  auto playbackRate = baseEvaluation();
  playbackRate.playbackRate = 1.25;
  assertNotOutputPerfect(playbackRate);
  {
    PerfectResult result = evaluatePerfect(playbackRate);
    assert(result.perfectReasonCode == "playback_rate_not_unity");
    assert(result.perfectReason.find("Playback rate") != std::string::npos ||
           result.perfectReason.find("rate") != std::string::npos ||
           !result.perfectReason.empty());
  }

  auto replayGain = baseEvaluation();
  replayGain.replayGainActive = true;
  assertNotOutputPerfect(replayGain);

  auto loudnorm = baseEvaluation();
  loudnorm.loudnormActive = true;
  assertNotOutputPerfect(loudnorm);
  {
    PerfectResult result = evaluatePerfect(loudnorm);
    assert(result.perfectReasonCode == "loudnorm_active");
  }

  auto eq = baseEvaluation();
  eq.eqActive = true;
  assertNotOutputPerfect(eq);

  auto convolver = baseEvaluation();
  convolver.convolverActive = true;
  assertNotOutputPerfect(convolver);

  auto crossfeed = baseEvaluation();
  crossfeed.crossfeedActive = true;
  assertNotOutputPerfect(crossfeed);

  auto crossfade = baseEvaluation();
  crossfade.crossfadeActive = true;
  assertNotOutputPerfect(crossfade);
}

void testRoutingSemantics() {
  auto stereo = baseEvaluation();
  stereo.routingMode = ChannelRoutingMode::Stereo;
  assertOutputPerfect(stereo);

  auto to51 = baseEvaluation();
  to51.outputFormat.channelCount = 6;
  to51.routingMode = ChannelRoutingMode::StereoTo51;
  assertNotOutputPerfect(to51);

  auto to71 = baseEvaluation();
  to71.outputFormat.channelCount = 8;
  to71.routingMode = ChannelRoutingMode::StereoTo71;
  assertNotOutputPerfect(to71);

  auto monoAuto = baseEvaluation();
  monoAuto.sourceFormat.channelCount = 1;
  monoAuto.decodedFormat.channelCount = 1;
  monoAuto.outputFormat.channelCount = 1;
  assertOutputPerfect(monoAuto);

  auto monoToStereo = baseEvaluation();
  monoToStereo.sourceFormat.channelCount = 1;
  monoToStereo.decodedFormat.channelCount = 1;
  monoToStereo.outputFormat.channelCount = 2;
  monoToStereo.routingMode = ChannelRoutingMode::MonoToStereo;
  assertNotOutputPerfect(monoToStereo);

  auto autoChannelMismatch = baseEvaluation();
  autoChannelMismatch.outputFormat.channelCount = 6;
  assertNotOutputPerfect(autoChannelMismatch);
}

void testDsdUnsupported() {
  auto dsd = baseEvaluation();
  dsd.sourceDsd = true;
  dsd.dsdMode = DsdMode::Unsupported;
  const PerfectResult result = evaluatePerfect(dsd);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReason == "DSD source unsupported");
}

void testSacdIsoNativeDsdCanBePerfect() {
  auto sacd = baseEvaluation();
  sacd.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Msb1);
  sacd.decodedFormat = sacd.sourceFormat;
  sacd.outputFormat = sacd.sourceFormat;
  sacd.sourceDsd = true;
  sacd.sourceLossless = true;
  sacd.sacdIsoSource = true;
  sacd.dsdMode = DsdMode::Native;
  sacd.dsdRate = 64;
  sacd.nativeDsdRequested = true;
  sacd.nativeDsdPassthroughProven = true;

  const PerfectResult result = evaluatePerfect(sacd);
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());
}

void testDsdConvertedToPcmReason() {
  auto dsd = baseEvaluation();
  dsd.sourceDsd = true;
  dsd.dsdMode = DsdMode::Pcm;
  const PerfectResult result = evaluatePerfect(dsd);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dsd_converted_to_pcm");
  assert(result.perfectReason == "DSD converted to PCM");
}

void testDopCarrierMismatchReason() {
  auto dop = baseEvaluation();
  dop.sourceDsd = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  dop.dopCarrierFormat = pcm(96000, 24, 2, AudioSampleFormat::Int24Interleaved);
  dop.outputFormat = dop.dopCarrierFormat;
  dop.decodedFormat = dop.dopCarrierFormat;
  dop.pcmPassthrough = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dop_carrier_mismatch");
  assert(result.perfectReason == "DoP carrier mismatch");
}

void testDopCandidateRequiresBackendPassthroughProof() {
  auto dop = baseEvaluation();
  dop.sourceDsd = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  dop.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dop.dopCarrierFormat = dopCarrierFormatForDsd(64, 2822400, 2).value();
  dop.outputFormat = dop.dopCarrierFormat;
  dop.decodedFormat = dop.dopCarrierFormat;
  dop.dopCarrierMatched = true;
  dop.pcmPassthrough = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dop_passthrough_unproven");
  assert(result.perfectReason == "DoP backend could not prove passthrough");
}

void testDopPerfectWhenBackendProvesPassthrough() {
  auto dop = baseEvaluation();
  dop.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::Float32Interleaved);
  dop.sourceDsd = true;
  dop.sourceLossless = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  dop.dopCarrierFormat = dopCarrierFormatForDsd(64, 2822400, 2).value();
  dop.decodedFormat = dop.dopCarrierFormat;
  dop.outputFormat = dop.dopCarrierFormat;
  dop.dopCarrierMatched = true;
  dop.dopPassthroughProven = true;
  dop.pcmPassthrough = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(result.pcmPassthrough);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());
}

void testNativeDsdRequiresBackendProof() {
  auto native = baseEvaluation();
  native.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  native.decodedFormat = native.sourceFormat;
  native.outputFormat = native.sourceFormat;
  native.sourceDsd = true;
  native.sourceLossless = true;
  native.dsdMode = DsdMode::Native;
  native.dsdRate = 64;
  native.nativeDsdRequested = true;
  native.backendPerfectReasonCode = "native_dsd_runtime_unproven";
  native.backendPerfectReason = "ASIO runtime sample type is not Native DSD";

  const PerfectResult result = evaluatePerfect(native);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "native_dsd_runtime_unproven");
  assert(result.perfectReason == "ASIO runtime sample type is not Native DSD");
}

void testNativeDsdPerfectWhenBackendProvesPassthrough() {
  auto native = baseEvaluation();
  native.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  native.decodedFormat = native.sourceFormat;
  native.outputFormat = native.sourceFormat;
  native.sourceDsd = true;
  native.sourceLossless = true;
  native.dsdMode = DsdMode::Native;
  native.dsdRate = 64;
  native.nativeDsdRequested = true;
  native.nativeDsdPassthroughProven = true;
  native.pcmPassthrough = false;

  const PerfectResult result = evaluatePerfect(native);
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(!result.pcmPassthrough);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());
}

void testNativeDsdDriverSelectedWireTypeCanBePerfect() {
  auto native = baseEvaluation();
  native.sourceFormat = pcm(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  native.decodedFormat = native.sourceFormat;
  native.outputFormat = pcm(11289600, 1, 2, AudioSampleFormat::DsdInt8Msb1);
  native.sourceDsd = true;
  native.sourceLossless = true;
  native.dsdMode = DsdMode::Native;
  native.dsdRate = 256;
  native.nativeDsdRequested = true;
  native.nativeDsdPassthroughProven = true;

  assert(!dsdFormatsExactMatch(native.decodedFormat, native.outputFormat));
  const PerfectResult result = evaluatePerfect(native);
  assert(result.formatMatched);
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());
}

void testNativeDsdProcessingBlocksPerfect() {
  auto native = baseEvaluation();
  native.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  native.decodedFormat = native.sourceFormat;
  native.outputFormat = native.sourceFormat;
  native.sourceDsd = true;
  native.sourceLossless = true;
  native.dsdMode = DsdMode::Native;
  native.dsdRate = 64;
  native.nativeDsdRequested = true;
  native.nativeDsdPassthroughProven = true;
  native.eqActive = true;

  const PerfectResult result = evaluatePerfect(native);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dsd_processing_pcm_fallback");
}

void testDsdProcessingFallbackReason() {
  auto dsd = baseEvaluation();
  dsd.sourceDsd = true;
  dsd.dsdMode = DsdMode::Pcm;
  dsd.dsdRate = 64;
  dsd.eqActive = true;
  const PerfectResult result = evaluatePerfect(dsd);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dsd_processing_pcm_fallback");
  assert(result.perfectReason == "DSD processing active; falling back to PCM");
}

void testDsdDopRoutingSemanticChangeUsesRoutingFallbackCode() {
  auto dop = baseEvaluation();
  dop.sourceDsd = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  dop.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dop.dopCarrierFormat = dopCarrierFormatForDsd(64, 2822400, 2).value();
  dop.decodedFormat = dop.dopCarrierFormat;
  dop.outputFormat = dop.dopCarrierFormat;
  dop.outputFormat.channelCount = 6;
  dop.routingMode = ChannelRoutingMode::StereoTo51;
  dop.dopCarrierMatched = true;
  dop.dopPassthroughProven = true;
  dop.pcmPassthrough = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(!result.routingPreservesSemantics);
  assert(result.perfectReasonCode == "routing_changes_semantics");
  assert(result.perfectReason == "Channel routing changes DSD channel semantics");
}

void testDsdHighRateFallbackReason() {
  auto dsd = baseEvaluation();
  dsd.sourceFormat = pcm(11289600, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dsd.sourceDsd = true;
  dsd.dsdMode = DsdMode::Pcm;
  dsd.dsdRate = 256;
  const PerfectResult result = evaluatePerfect(dsd);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dsd_high_rate_pcm_fallback");
  assert(result.perfectReason == "DSD256 currently falls back to PCM");
}

void testDsd512ForcedPcmPreservesExplicitFallbackReason() {
  auto dsd = baseEvaluation();
  dsd.sourceFormat = pcm(22579200, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dsd.sourceDsd = true;
  dsd.dsdMode = DsdMode::Pcm;
  dsd.dsdRate = 512;
  dsd.backendPerfectReason = "DSD output mode forced PCM";

  const PerfectResult result = evaluatePerfect(dsd);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReasonCode == "dsd_output_mode_pcm");
  assert(result.perfectReason == "DSD output mode forced PCM");
}

void testUnsupportedDsdRateRejectsDopPerfect() {
  auto dop = baseEvaluation();
  dop.sourceFormat = pcm(45158400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dop.sourceDsd = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 1024;
  dop.dopCarrierMatched = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(!result.sourceExact);
  assert(!result.outputPerfect);
  assert(result.perfectReason == "DSD source unsupported");
}

void testDopPerfectThroughInt24In32WireContainer() {
  auto dop = baseEvaluation();
  dop.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::Float32Interleaved);
  dop.sourceDsd = true;
  dop.sourceLossless = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  const AudioFormat carrier = dopCarrierFormatForDsd(64, 2822400, 2).value();
  AudioFormat wire = carrier;
  wire.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
  wire.bitDepth = 24;
  dop.dopCarrierFormat = carrier;
  dop.decodedFormat = carrier;
  dop.outputFormat = wire;
  dop.dopCarrierMatched = true;
  dop.dopPassthroughProven = true;
  dop.pcmPassthrough = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(result.formatMatched);
  assert(!result.resampled);
  assert(result.sourceExact);
  assert(result.outputPerfect);
  assert(result.perfectReasonCode.empty());
  assert(result.perfectReason.empty());
}

void testDopCarrierMatchRescuesContainerWidening() {
  auto dop = baseEvaluation();
  dop.sourceFormat = pcm(2822400, 1, 2, AudioSampleFormat::DsdInt8Lsb1);
  dop.sourceDsd = true;
  dop.dsdMode = DsdMode::Dop;
  dop.dsdRate = 64;
  const AudioFormat carrier = dopCarrierFormatForDsd(64, 2822400, 2).value();
  dop.dopCarrierFormat = carrier;
  dop.outputFormat = carrier;
  dop.outputFormat.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
  // The pipeline originally reported Int24 vs Int24In32 as an exact-match
  // failure; semantically both carry the same 24-bit DoP payload, so the
  // carrier check must rescue the claim instead of reporting a mismatch.
  dop.dopCarrierMatched = false;
  dop.dopPassthroughProven = true;

  const PerfectResult result = evaluatePerfect(dop);
  assert(result.outputPerfect);
  assert(result.sourceExact);
  assert(result.perfectReasonCode.empty());
}

}  // namespace

int main() {
  testTypedPcmToFloatAvoidsUnalignedWideReads();
  testVolumeAppliesOnlyToRenderedFrames();
  testUnityVolumeSkipsRenderedFrameProcessing();
  testZeroVolumeSilencesRenderedFramesWithoutTouchingTail();
  testCrossfadeSegmentMixesWithIncrementalFade();
  testCrossfadeSegmentDetectsBoundedFadeRange();
  testTypedPcmToFloatZerosOnlyUnconvertedTail();
  testTypedPcmToFloatFloat32AllowsInPlaceFullConversion();
  testFloat32PcmConversionSkipsCopyWhenAlreadyInPlace();
  testLosslessSourceExact();
  testLossyOutputPerfect();
  testLosslessIntegerDecodedConversionBlocksOutputPerfect();
  testInt24SourceStaysExactThroughInt24In32Output();
  testBackendSupport();
  testBackendReasonFallback();
  testPassthroughRequired();
  testPcmPassthroughRequiresExactFormat();
  testFormatMismatch();
  testSampleFormatEffectiveBitDepth();
  testDopCarrierHelper();
  testProcessingFlags();
  testRoutingSemantics();
  testDsdUnsupported();
  testSacdIsoNativeDsdCanBePerfect();
  testDsdConvertedToPcmReason();
  testDopCarrierMismatchReason();
  testDopCandidateRequiresBackendPassthroughProof();
  testDopPerfectWhenBackendProvesPassthrough();
  testNativeDsdRequiresBackendProof();
  testNativeDsdPerfectWhenBackendProvesPassthrough();
  testNativeDsdDriverSelectedWireTypeCanBePerfect();
  testNativeDsdProcessingBlocksPerfect();
  testDsdProcessingFallbackReason();
  testDsdDopRoutingSemanticChangeUsesRoutingFallbackCode();
  testDsdHighRateFallbackReason();
  testDsd512ForcedPcmPreservesExplicitFallbackReason();
  testUnsupportedDsdRateRejectsDopPerfect();
  testDopPerfectThroughInt24In32WireContainer();
  testDopCarrierMatchRescuesContainerWidening();
  return 0;
}
