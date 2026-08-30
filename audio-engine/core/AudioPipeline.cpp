#include "AudioPipeline.h"
#include "AudioPipelineDsdUtils.h"
#include "AudioPipelineRenderUtils.h"
#include "DiagnosticLog.h"
#include "../dsp/ChannelRouter.h"
#include "../decoder/DopPackerUtils.h"
#include "../decoder/SacdIsoProbe.h"
#include "../utils/JsonUtils.h"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <thread>
#include <utility>
#include <vector>

#if defined(__x86_64__) || defined(_M_X64)
#include <pmmintrin.h>
#include <xmmintrin.h>
#endif

namespace twilight::audio {

#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
// Declared rather than included: the pipeline decides routing policy and must
// not take a dependency on the ASIO host headers. Defined in the ASIO backend.
std::vector<std::string> asioNativeDsdCapableDeviceIds();
#endif

namespace {

constexpr size_t kDecodeChunkFrames = 2048;
constexpr size_t kVisualizationFftResolution = 8192;
constexpr double kUnityVolumeEpsilon = 0.0001;
// Below this a gain stage is bit-transparent, so it is not "processing".
constexpr double kTransparentGainEpsilonDb = 0.0001;

uint64_t doubleBits(double value) noexcept {
  return std::bit_cast<uint64_t>(value);
}

double doubleFromBits(uint64_t bits) noexcept {
  return std::bit_cast<double>(bits);
}

uint32_t floatBits(float value) noexcept {
  return std::bit_cast<uint32_t>(value);
}

float floatFromBits(uint32_t bits) noexcept {
  return std::bit_cast<float>(bits);
}

uint64_t pointerBits(const void* value) noexcept {
  return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(value));
}

template <typename T>
T* pointerFromBits(uint64_t bits) noexcept {
  return reinterpret_cast<T*>(static_cast<uintptr_t>(bits));
}

double loadAtomicDouble(
    const std::atomic<uint64_t>& bits,
    std::memory_order order = std::memory_order_seq_cst) noexcept {
  return doubleFromBits(bits.load(order));
}

void storeAtomicDouble(
    std::atomic<uint64_t>& bits,
    double value,
    std::memory_order order = std::memory_order_seq_cst) noexcept {
  bits.store(doubleBits(value), order);
}

UpmixConfig upmixConfigFromOutputConfig(const OutputConfig& config) noexcept {
  UpmixConfig upmix;
  upmix.centerGain = config.upmixCenterGain;
  upmix.lfeGain = config.upmixLfeGain;
  upmix.lfeLowpassHz = config.upmixLfeLowpassHz;
  upmix.surroundGain = config.upmixSurroundGain;
  upmix.sideGain = config.upmixSideGain;
  upmix.surroundDelayMs = config.upmixSurroundDelayMs;
  return upmix;
}

bool wasapiExclusiveTopologyChanged(
    const std::string& backendId,
    const OutputConfig& previous,
    const OutputConfig& next) noexcept {
  return backendId == "wasapi-exclusive" &&
         (previous.preferredBufferSize != next.preferredBufferSize ||
          previous.wasapiExclusivePushMode != next.wasapiExclusivePushMode);
}

AudioPipeline::BackendFactory& backendFactoryOverride() {
  static AudioPipeline::BackendFactory factory;
  return factory;
}

AudioPipeline::NativeDsdDeviceDiscovery& nativeDsdDeviceDiscoveryOverride() {
  static AudioPipeline::NativeDsdDeviceDiscovery discovery;
  return discovery;
}

/** Probe-verified DSD-capable device ids, honoring a test override. */
std::vector<std::string> discoverNativeDsdCapableDevices() {
  if (nativeDsdDeviceDiscoveryOverride()) return nativeDsdDeviceDiscoveryOverride()();
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  return asioNativeDsdCapableDeviceIds();
#else
  return {};
#endif
}

QueueItem makeManualItem(const std::string& source) {
  QueueItem item;
  item.id = source;
  item.source = source;
  item.title = source;
  return item;
}

AudioSampleFormat sampleFormatFromOutputLabel(const std::string& label, AudioSampleFormat fallback) {
  if (label == "int16" || label == "s16" || label == "S16_LE") return AudioSampleFormat::Int16Interleaved;
  if (label == "int24" || label == "s24_3le" || label == "S24_3LE") return AudioSampleFormat::Int24Interleaved;
  if (label == "int24-in32" || label == "s24_le" || label == "S24_LE") {
    return AudioSampleFormat::Int24In32Interleaved;
  }
  if (label == "int32" || label == "s32" || label == "S32_LE") return AudioSampleFormat::Int32Interleaved;
  if (label == "float32" || label == "FLOAT_LE") return AudioSampleFormat::Float32Interleaved;
  return fallback;
}

AudioFormat actualOutputPcmFormat(const AudioFormat& fallback, const OutputInfo& info) {
  AudioFormat format = fallback;
  if (info.actualSampleRate > 0) format.sampleRate = info.actualSampleRate;
  if (info.actualChannels > 0) format.channelCount = info.actualChannels;
  if (info.actualBitDepth > 0) {
    format.bitDepth = info.actualBitDepth;
  } else if (info.outputBitDepth > 0) {
    format.bitDepth = info.outputBitDepth;
  }
  format.sampleFormat = sampleFormatFromOutputLabel(info.actualOutputFormat, fallback.sampleFormat);
  return format;
}

AudioFormat actualOutputFormat(const AudioFormat& fallback, const OutputInfo& info) {
  AudioFormat format = actualOutputPcmFormat(fallback, info);
  if (isDsdSampleFormat(fallback.sampleFormat)) {
    format.bitDepth = 1;
    if (info.actualOutputFormat == "dsd-int8-msb1") {
      format.sampleFormat = AudioSampleFormat::DsdInt8Msb1;
    } else if (info.actualOutputFormat == "dsd-int8-ner8") {
      format.sampleFormat = AudioSampleFormat::DsdInt8Ner8;
    } else {
      format.sampleFormat = AudioSampleFormat::DsdInt8Lsb1;
    }
  }
  return format;
}

bool backendCanAttemptDop(const std::string& backendId) {
  return backendId == "asio" || backendId == "wasapi-exclusive" || backendId == "coreaudio-exclusive";
}

bool backendCanAttemptNativeDsd(const std::string& backendId) {
  return backendId == "asio" || backendId == "alsa";
}

bool backendCanTypedPassthrough(const std::string& backendId) {
  return backendId == "asio" || backendId == "wasapi-exclusive" || backendId == "coreaudio-exclusive";
}

/**
 * Auto-discovered DSD compatibility route.
 *
 * When the main output cannot carry DSD (a DAC whose own ASIO driver refuses
 * DSD sample types, or a WASAPI-only setup) and the user has not pinned a route
 * explicitly, look for an ASIO driver that a capability probe proved can accept
 * a raw DSD I/O format. This is how a registered DSD proxy driver gets used
 * without the user having to know it exists.
 *
 * Nothing here matches on vendor or product names: the choice comes from the
 * driver's own answer to CanDoIoFormat, so any vendor's proxy qualifies and a
 * rename cannot break it. An explicit user route always wins over this.
 */
std::string autoDiscoveredNativeDsdDeviceId(const std::string& mainBackendId) {
  // The main route already reaches a DSD-capable backend; its own device is
  // tried first by the normal path, so auto-discovery would add nothing.
  if (backendCanAttemptNativeDsd(mainBackendId)) return {};
  const auto capable = discoverNativeDsdCapableDevices();
  return capable.empty() ? std::string{} : capable.front();
}

bool formatCanTypedPassthrough(const AudioFormat& format) {
  return format.sampleRate > 0 && format.channelCount > 0 && audioFormatBytesPerFrame(format) > 0;
}

struct DspOutputStageRequest {
  int targetSampleRate = 0;
  DspResamplerQuality resamplerQuality = DspResamplerQuality::Native;
  bool dsdPcmFallbackApplied = false;
};

DspOutputStageRequest outputStageRequestFromGraphJson(const std::string& json) {
  const std::string graph = json_utils::fieldObject(json, "graph");
  const std::string root = graph.empty() ? json : graph;
  const std::string outputStage = json_utils::fieldObject(root, "outputStage");
  DspOutputStageRequest request;
  if (!outputStage.empty()) {
    request.targetSampleRate = static_cast<int>(std::clamp(
        json_utils::fieldNumber(outputStage, "targetSampleRate").value_or(0.0), 0.0, 384000.0));
    const std::string quality = json_utils::fieldString(outputStage, "resamplerQuality").value_or("native");
    if (quality == "high") {
      request.resamplerQuality = DspResamplerQuality::High;
    } else if (quality == "ultra") {
      request.resamplerQuality = DspResamplerQuality::Ultra;
    } else if (quality == "soxrHq") {
      request.resamplerQuality = DspResamplerQuality::SoxrHq;
    } else if (quality == "soxrVhq") {
      request.resamplerQuality = DspResamplerQuality::SoxrVhq;
    } else if (quality.rfind("soxr", 0) == 0) {
      // Unknown soxr-family value: honor the quality intent with Ultra swr.
      request.resamplerQuality = DspResamplerQuality::Ultra;
    }
  }
  request.dsdPcmFallbackApplied = json_utils::fieldBool(json, "dsdPcmFallbackApplied").value_or(false);
  return request;
}

bool outputUsesIntegerPcm(const AudioFormat& format) {
  return format.sampleFormat == AudioSampleFormat::Int16Interleaved ||
         format.sampleFormat == AudioSampleFormat::Int24Interleaved ||
         format.sampleFormat == AudioSampleFormat::Int24In32Interleaved ||
         format.sampleFormat == AudioSampleFormat::Int32Interleaved;
}

uint32_t nextDitherRandom(uint32_t& state) {
  state ^= state << 13U;
  state ^= state >> 17U;
  state ^= state << 5U;
  return state;
}

double ditherUniform(uint32_t& state) {
  return static_cast<double>(nextDitherRandom(state)) / static_cast<double>(UINT32_MAX);
}

void resetDitherState(
    std::array<uint32_t, 8>& random,
    std::array<float, 8>& previousNoise,
    std::array<float, 8>& error) {
  random = {{0x12345678U, 0x23456789U, 0x3456789aU, 0x456789abU,
             0x56789abcU, 0x6789abcdU, 0x789abcdeU, 0x89abcdefU}};
  previousNoise.fill(0.0f);
  error.fill(0.0f);
}

void applyOutputDither(
    float* samples,
    size_t frameCount,
    int channels,
    const AudioFormat& outputFormat,
    DspDitherMode mode,
    std::array<uint32_t, 8>& random,
    std::array<float, 8>& previousNoise,
    std::array<float, 8>& error) {
  if (!samples || frameCount == 0 || mode == DspDitherMode::Off || !outputUsesIntegerPcm(outputFormat)) return;
  const int bitDepth = std::clamp(effectivePcmBitDepth(outputFormat), 2, 32);
  const double scale = std::ldexp(1.0, bitDepth - 1);
  const double lsb = 1.0 / scale;
  const int sampleStride = std::max(1, outputFormat.channelCount);
  const int activeChannels = std::clamp(channels, 1, 8);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    for (int channel = 0; channel < activeChannels; ++channel) {
      const size_t channelIndex = static_cast<size_t>(channel);
      const size_t index = frame * static_cast<size_t>(sampleStride) + channelIndex;
      const double tpdf = (ditherUniform(random[channelIndex]) - ditherUniform(random[channelIndex])) * lsb;
      double noise = tpdf;
      if (mode == DspDitherMode::HighpassTpdf) {
        noise -= previousNoise[channelIndex];
        previousNoise[channelIndex] = static_cast<float>(tpdf);
      }
      double value = std::isfinite(samples[index]) ? static_cast<double>(samples[index]) : 0.0;
      if (mode == DspDitherMode::NoiseShaped) value += static_cast<double>(error[channelIndex]) * 0.85;
      value += noise;
      value = std::clamp(value, -1.0, 1.0 - lsb);
      if (mode == DspDitherMode::NoiseShaped) {
        const double quantized = std::round(value * scale) / scale;
        error[channelIndex] = static_cast<float>(std::clamp(value - quantized, -2.0 * lsb, 2.0 * lsb));
      }
      samples[index] = static_cast<float>(value);
    }
  }
}

bool sampleFormatCanCarryDop(AudioSampleFormat format) {
  return format == AudioSampleFormat::Int24Interleaved || format == AudioSampleFormat::Int24In32Interleaved;
}

AudioSampleFormat nativeDsdSampleFormatForBitOrder(DsdBitOrder bitOrder) {
  return bitOrder == DsdBitOrder::MsbFirst ? AudioSampleFormat::DsdInt8Msb1 : AudioSampleFormat::DsdInt8Lsb1;
}

AudioFormat nativeDsdFormatForStream(const DsdStreamInfo& dsd) {
  AudioFormat format;
  format.sampleRate = dsd.dsdSampleRate;
  format.channelCount = dsd.channelCount;
  format.bitDepth = 1;
  format.sampleFormat = nativeDsdSampleFormatForBitOrder(dsd.bitOrder);
  return format;
}

bool formatCanCarryDop(const AudioFormat& format, int dsdRate, int sourceSampleRate, int channels) {
  const auto expected = dopCarrierFormatForDsd(dsdRate, sourceSampleRate, channels);
  return expected.has_value() && format.sampleRate == expected->sampleRate &&
         format.channelCount == expected->channelCount && effectivePcmBitDepth(format) == 24 &&
         sampleFormatCanCarryDop(format.sampleFormat);
}

bool nativeDsdRuntimeFactsMatchRequested(const NativeDsdRuntimeFacts& facts, const AudioFormat& requested) {
  return facts.explicitlyCapable &&
         (facts.state == NativeDsdRuntimeFactState::Candidate || facts.state == NativeDsdRuntimeFactState::Proven) &&
         facts.requestedDsdRate == requested.sampleRate && facts.actualDsdRate == requested.sampleRate &&
         facts.channelCount == requested.channelCount;
}

bool nativeDsdOutputMatchesRequested(
    const AudioFormat& outputFormat,
    const AudioFormat& requested,
    const NativeDsdRuntimeFacts& facts) {
  if (!isDsdSampleFormat(outputFormat.sampleFormat) || outputFormat.channelCount != requested.channelCount) {
    return false;
  }
  if (outputFormat.sampleRate == requested.sampleRate) return true;
  return nativeDsdRuntimeFactsMatchRequested(facts, requested);
}

/**
 * Whether an equalizer band changes the signal.
 *
 * A gain-shaped band at 0 dB is bit-transparent, so an enabled but flat
 * equalizer is not processing. Filter bands reshape the signal at any gain, so
 * for those the enable flag alone counts.
 */
bool eqBandAltersSignal(const DspEqBand& band) {
  if (!band.enabled) return false;
  switch (band.type) {
    case DspFilterType::Peak:
    case DspFilterType::LowShelf:
    case DspFilterType::HighShelf:
      return std::abs(band.gainDb) > kTransparentGainEpsilonDb;
    default:
      return true;
  }
}

/**
 * Whether one enabled graph node would actually change the samples.
 *
 * The identity settings mirror the legacy-flag rules below: a flat equalizer, a
 * ReplayGain stage switched off, a crossfeed at zero strength and a convolver
 * with no impulse response are all bit-transparent. A scene generated from the
 * renderer's module toggles enables the node as soon as the toggle is on, so
 * without this an untouched 10-band EQ still cost a DSD source its passthrough.
 * Unknown node types count as processing: silence is not the safe default when
 * the alternative is claiming bit-perfect output that isn't.
 */
bool graphNodeAltersSignal(const std::string& type, const std::string& params) {
  if (type == "meter") return false;
  if (type == "replayGain" || type == "replaygain") {
    return json_utils::fieldString(params, "mode").value_or("off") != "off";
  }
  if (type == "crossfeed") {
    return json_utils::fieldNumber(params, "strength").value_or(0.0) > 0.0;
  }
  if (type == "convolver") {
    return !json_utils::fieldString(params, "impulseResponsePath").value_or("").empty();
  }
  if (type == "equalizer") {
    if (std::abs(json_utils::fieldNumber(params, "preampDb").value_or(0.0)) > kTransparentGainEpsilonDb) {
      return true;
    }
    for (const std::string& band : json_utils::splitTopLevelObjects(json_utils::fieldArray(params, "bands"))) {
      if (!json_utils::fieldBool(band, "enabled").value_or(true)) continue;
      const std::string filter = json_utils::fieldString(band, "filterType").value_or("peak");
      if (filter == "peak" || filter == "lowShelf" || filter == "highShelf") {
        if (std::abs(json_utils::fieldNumber(band, "gain").value_or(0.0)) > kTransparentGainEpsilonDb) return true;
        continue;
      }
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Whether an applied DSP graph state actually processes audio.
 *
 * An ApplyDspState payload carries two descriptions of the DSP: the graph that
 * runs, and the renderer's legacy module toggles. Only the graph runs. A scene
 * whose equalizer node is disabled still ships `eqEnabled: true`, so reading the
 * toggle sent every DSD source through a PCM conversion on behalf of a graph
 * that processes nothing - which is why DSD passthrough looked permanently
 * broken to anyone who had ever switched the EQ on. `meter` is a read-only
 * observation tap, and an enabled node left at its identity settings does not
 * count either - see graphNodeAltersSignal.
 *
 * Returns nullopt when the payload carries no graph at all, so config-only
 * callers keep deciding from the legacy flags.
 */
std::optional<bool> graphStateProcessingActive(const std::string& stateJson) {
  if (stateJson.empty()) return std::nullopt;
  const std::string graph = json_utils::fieldObject(stateJson, "graph");
  const std::string root = graph.empty() ? stateJson : graph;
  const std::string nodes = json_utils::fieldArray(root, "nodes");
  if (nodes.empty()) return std::nullopt;

  const std::string processing = json_utils::fieldObject(stateJson, "processing");
  if (!processing.empty() && !json_utils::fieldBool(processing, "dspEnabled").value_or(true)) {
    return false;
  }

  for (const std::string& node : json_utils::splitTopLevelObjects(nodes)) {
    if (!json_utils::fieldBool(node, "enabled").value_or(true)) continue;
    const std::string type = json_utils::fieldString(node, "type").value_or("");
    if (graphNodeAltersSignal(type, json_utils::fieldObject(node, "params"))) return true;
  }

  const std::string outputStage = json_utils::fieldObject(root, "outputStage");
  if (outputStage.empty()) return false;
  return json_utils::fieldNumber(outputStage, "targetSampleRate").value_or(0.0) > 0.0 ||
         json_utils::fieldString(outputStage, "resamplerQuality").value_or("native") != "native" ||
         json_utils::fieldString(outputStage, "dither").value_or("off") != "off";
}

bool dspConfigProcessingRequiresPcm(
    const DspConfig& dspConfig,
    const OutputConfig& outputConfig,
    double volume,
    double playbackRate = 1.0,
    std::optional<bool> graphProcessingActive = std::nullopt) {
  const bool eqAltersSignal =
      dspConfig.eqEnabled &&
      (std::abs(dspConfig.eqPreampDb) > kTransparentGainEpsilonDb ||
       std::any_of(dspConfig.eqBands.begin(), dspConfig.eqBands.end(), eqBandAltersSignal));
  // Each module is judged by what it would do, not by its enable flag: a flat
  // equalizer, a convolver with no impulse response and a crossfeed at zero
  // strength all leave the samples untouched, and treating them as processing
  // costs a DSD source its passthrough for nothing.
  const bool graphOrLegacyProcessing =
      dspConfig.replayGainMode != ReplayGainMode::Off || eqAltersSignal ||
      (dspConfig.convolverEnabled && !dspConfig.impulseResponsePath.empty()) ||
      (dspConfig.crossfeedEnabled && dspConfig.crossfeedStrength > 0.0) ||
      dspConfig.channelMatrixEnabled || dspConfig.channelStripEnabled ||
      dspConfig.bassManagementEnabled || dspConfig.gateEnabled || dspConfig.compressorEnabled ||
      dspConfig.dynamicEqEnabled || dspConfig.multibandCompressorEnabled || dspConfig.stereoFieldEnabled ||
      dspConfig.loudnessContourEnabled || dspConfig.truePeakLimiterEnabled ||
      dspConfig.outputTargetSampleRate > 0 || dspConfig.resamplerQuality != DspResamplerQuality::Native ||
      dspConfig.ditherMode != DspDitherMode::Off;
  // An applied graph outranks the legacy flags; see graphStateProcessingActive.
  const bool moduleProcessing = graphProcessingActive.value_or(dspConfig.enabled && graphOrLegacyProcessing);
  return moduleProcessing ||
         dspConfig.crossfadeSeconds > 0.0001 || outputConfig.routingMode != ChannelRoutingMode::Auto ||
         std::abs(volume - 1.0) > kUnityVolumeEpsilon ||
         std::abs(playbackRate - 1.0) > kUnityVolumeEpsilon;
}

bool dopRuntimeFactsRequirePcmFallback(const DopRuntimeFacts& facts) {
  return facts.state == DopRuntimeFactState::Candidate || facts.state == DopRuntimeFactState::Mismatch ||
         facts.state == DopRuntimeFactState::Unproven || facts.state == DopRuntimeFactState::Unsupported;
}

bool dopRuntimeFactsRejectBeforeStart(const DopRuntimeFacts& facts) {
  return facts.state == DopRuntimeFactState::Mismatch || facts.state == DopRuntimeFactState::Unproven ||
         facts.state == DopRuntimeFactState::Unsupported;
}

std::string dopPcmFallbackReason(const DopRuntimeFacts& facts) {
  const std::string base =
      facts.state == DopRuntimeFactState::Mismatch ? "DoP carrier mismatch" : "DoP backend could not prove passthrough";
  // The base prefix must stay first: dsdPcmFallbackReasonCode matches on it.
  // Appending the backend's own reason keeps shared-mixer or format-negotiation
  // detail visible instead of a generic unproven message.
  return facts.reason.empty() || facts.reason == base ? base : base + " (" + facts.reason + ")";
}

bool nativeDsdRuntimeFactsRequirePcmFallback(const NativeDsdRuntimeFacts& facts) {
  return facts.state == NativeDsdRuntimeFactState::Mismatch || facts.state == NativeDsdRuntimeFactState::Unproven ||
         facts.state == NativeDsdRuntimeFactState::Unsupported;
}

std::string nativeDsdPcmFallbackReason(const NativeDsdRuntimeFacts& facts) {
  return facts.reason.empty() ? "ASIO Native DSD could not prove raw DSD output" : facts.reason;
}

NativeDsdRuntimeFacts buildNativeDsdAttemptFacts(
    const AudioFormat& requestedFormat,
    NativeDsdRuntimeFacts facts,
    const std::string& error) {
  if (facts.requestedDsdRate <= 0) facts.requestedDsdRate = requestedFormat.sampleRate;
  if (facts.channelCount <= 0) facts.channelCount = requestedFormat.channelCount;
  if (!error.empty() &&
      (facts.reason.empty() || facts.reason == "No Native DSD stream was requested")) {
    facts.reason = error;
  }
  return facts;
}

int positionSampleRateForStream(const AudioStreamInfo& stream, const AudioFormat& outputFormat) {
  if (stream.isDsd && stream.dsdMode == DsdMode::Native && stream.decodedFormat.sampleRate > 0) {
    return stream.decodedFormat.sampleRate;
  }
  return outputFormat.sampleRate;
}

std::string nativeDsdRuntimeStateToString(NativeDsdRuntimeFactState state) {
  switch (state) {
    case NativeDsdRuntimeFactState::Candidate:
      return "candidate";
    case NativeDsdRuntimeFactState::Unproven:
      return "unproven";
    case NativeDsdRuntimeFactState::Mismatch:
      return "mismatch";
    case NativeDsdRuntimeFactState::Proven:
      return "proven";
    case NativeDsdRuntimeFactState::Unsupported:
    default:
      return "unsupported";
  }
}

void applyNativeDsdRuntimeFacts(OutputInfo* info, const NativeDsdRuntimeFacts& facts) {
  if (!info) return;
  info->nativeDsdRuntimeState = nativeDsdRuntimeStateToString(facts.state);
  info->nativeDsdRequestedRate = facts.requestedDsdRate;
  info->nativeDsdActualRate = facts.actualDsdRate;
  info->nativeDsdChannels = facts.channelCount;
  info->nativeDsdExplicitlyCapable = facts.explicitlyCapable;
  info->nativeDsdAdvertisedSampleRates = facts.advertisedSampleRates;
  info->nativeDsdRuntimeReason = facts.reason;
}

void typedPcmToFloat(const PcmBlock& block, float* output, size_t frames) {
  render::typedPcmToFloatWithTailSilence(block, output, frames);
}

uint8_t nativeDsdIdleByte(AudioSampleFormat format) {
  return render::convertDsdByte(0x69, DsdBitOrder::LsbFirst, format);
}

void fillNativeDsdIdle(PcmBlock& block, size_t startFrame) {
  if (!block.data || startFrame >= block.frames || !isDsdSampleFormat(block.format.sampleFormat)) return;
  const size_t bytesPerFrame = audioFormatBytesPerFrame(block.format);
  if (bytesPerFrame == 0) return;
  const size_t offset = startFrame * bytesPerFrame;
  if (offset >= block.byteSize) return;
  std::memset(block.data + offset, nativeDsdIdleByte(block.format.sampleFormat), block.byteSize - offset);
}

void finalizeDopCarrier(PcmBlock& block, size_t renderedFrames, uint64_t* markerIndex) {
  if (!block.data || !markerIndex || !isDopCarrierFormat(block.format)) return;
  const size_t channels = static_cast<size_t>(std::max(1, block.format.channelCount));
  const size_t bytesPerSample = audioSampleFormatBytes(block.format.sampleFormat);
  const size_t bytesPerFrame = audioFormatBytesPerFrame(block.format);
  if (bytesPerSample == 0 || bytesPerFrame == 0) return;

  // DSD idle is the 0x69 alternating pattern; a DoP payload carries it MSB-first,
  // which is 0x96. Both payload bytes are identical so byte order is moot here,
  // but the value has to match the packer's MSB-first convention or a strict DAC
  // sees a payload it did not expect where it expects silence.
  constexpr uint8_t kDopIdlePayloadByte = 0x96;
  const size_t boundedRendered = std::min(renderedFrames, block.frames);
  for (size_t frame = 0; frame < block.frames; ++frame) {
    const uint8_t marker = dop::dopMarkerForFrame(static_cast<size_t>(*markerIndex + frame));
    for (size_t channel = 0; channel < channels; ++channel) {
      uint8_t* sample = block.data + frame * bytesPerFrame + channel * bytesPerSample;
      if (frame >= boundedRendered) {
        if (block.format.sampleFormat == AudioSampleFormat::Int24In32Interleaved) {
          sample[0] = 0x00;
          sample[1] = kDopIdlePayloadByte;
          sample[2] = kDopIdlePayloadByte;
        } else {
          sample[0] = kDopIdlePayloadByte;
          sample[1] = kDopIdlePayloadByte;
        }
      }
      sample[bytesPerSample - 1] = marker;
    }
  }
  *markerIndex += block.frames;
}

void fillDsdTransportIdle(PcmBlock& block, uint64_t* dopMarkerIndex) {
  if (isDopCarrierFormat(block.format)) {
    finalizeDopCarrier(block, 0, dopMarkerIndex);
  } else if (isDsdSampleFormat(block.format.sampleFormat)) {
    fillNativeDsdIdle(block, 0);
  } else if (block.data && block.byteSize > 0) {
    std::memset(block.data, 0, block.byteSize);
  }
}

size_t dsdBytesToInterleaved(
    const uint8_t* dsdBytes,
    size_t byteCount,
    const DsdStreamInfo& info,
    AudioSampleFormat targetFormat,
    std::vector<uint8_t>* output) {
  return render::dsdBytesToInterleavedResizeOnly(dsdBytes, byteCount, info, targetFormat, output);
}

uint64_t dsdRenderedFrameUnits(size_t byteFrames, const AudioFormat& format) {
  return static_cast<uint64_t>(byteFrames) * (isDsdSampleFormat(format.sampleFormat) ? 8U : 1U);
}

#if defined(__x86_64__) || defined(_M_X64)
void enableDenormalFlushToZero() noexcept {
  // IIR tails (EQ/crossfeed/bass management) and convolution tails decay into
  // denormals after silence; on many x86 CPUs those ops run 1-2 orders of
  // magnitude slower and blow the render budget exactly when playback resumes
  // from quiet. MXCSR is per-thread and both setters are register writes.
  _MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
  _MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON);
}
#else
void enableDenormalFlushToZero() noexcept {}
#endif

DsdBitOrder dsdBitOrderFromInfo(const DsdStreamInfo& info) {
  return info.bitOrder;
}

DsdPacking dsdPackingFromInfo(const DsdStreamInfo& info) {
  return info.packing;
}

void applyQueueReplayGainTags(const QueueItem& item, ReplayGainInfo& replayGain) {
  // Host-injected tags overlay decode-time metadata (library cold start).
  // Loudnorm still only uses measuredIntegratedLufs / measuredTruePeakDb.
  if (item.replayGainTrackGainDb) replayGain.trackGainDb = item.replayGainTrackGainDb;
  if (item.replayGainAlbumGainDb) replayGain.albumGainDb = item.replayGainAlbumGainDb;
  if (item.r128TrackGainDb) replayGain.r128TrackGainDb = item.r128TrackGainDb;
  if (item.r128AlbumGainDb) replayGain.r128AlbumGainDb = item.r128AlbumGainDb;
  if (item.measuredIntegratedLufs) {
    replayGain.measuredIntegratedLufs = item.measuredIntegratedLufs;
  }
  if (item.measuredTruePeakDb) {
    replayGain.measuredTruePeakDb = item.measuredTruePeakDb;
  }
}

AudioStreamInfo streamInfoFromDsd(const QueueItem& item, const DsdStreamInfo& dsd, DsdMode mode) {
  AudioStreamInfo stream;
  stream.source = item.source;
  stream.codec = "dsd";
  stream.durationSeconds = item.durationSeconds > 0.0 ? item.durationSeconds : dsd.durationSeconds;
  stream.sourceFormat.sampleRate = dsd.dsdSampleRate;
  stream.sourceFormat.channelCount = dsd.channelCount;
  stream.sourceFormat.bitDepth = 1;
  stream.sourceFormat.sampleFormat = AudioSampleFormat::Float32Interleaved;
  stream.decodedFormat = stream.sourceFormat;
  stream.sourceLossless = true;
  stream.isDsd = true;
  stream.dsdMode = mode;
  stream.dsdRate = dsd.dsdRate;
  applyQueueReplayGainTags(item, stream.replayGain);
  return stream;
}

bool dsdOutputModePrefersPcm(DsdOutputMode mode) {
  return mode == DsdOutputMode::Pcm;
}

bool dsdOutputModeRequestsNative(DsdOutputMode mode) {
  return mode == DsdOutputMode::Auto || mode == DsdOutputMode::Native;
}

bool dsdOutputModeRequestsDop(DsdOutputMode mode) {
  return mode == DsdOutputMode::Auto || mode == DsdOutputMode::Dop || mode == DsdOutputMode::Native;
}

AudioFormat pcmFallbackRequestFormat(
    const AudioStreamInfo& stream,
    const std::optional<DsdStreamInfo>& dsdProbe) {
  AudioFormat requested = stream.decodedFormat;
  requested.channelCount =
      stream.sourceFormat.channelCount > 0 ? stream.sourceFormat.channelCount : std::max(1, requested.channelCount);
  requested.bitDepth = 32;
  requested.sampleFormat = AudioSampleFormat::Float32Interleaved;

  const auto assignRate = [&](int sampleRate) {
    if (sampleRate > 0) requested.sampleRate = sampleRate;
  };

  if (dsdProbe.has_value()) {
    assignRate(dsdProbe->dsdSampleRate / 16);
  } else if (stream.dsdRate > 0 && stream.sourceFormat.sampleRate > 0) {
    assignRate(stream.sourceFormat.sampleRate / 16);
  }

  if (requested.sampleRate <= 0) requested.sampleRate = stream.sourceFormat.sampleRate;
  if (requested.sampleRate <= 0) requested.sampleRate = 176400;
  return requested;
}

}  // namespace

size_t visualizationFftResolutionForConfig(size_t configuredFftResolution) {
  if (configuredFftResolution == 0) return kVisualizationFftResolution;
  return std::max(configuredFftResolution, kVisualizationFftResolution);
}

struct AudioPipeline::DecodeStream {
  enum class Mode {
    Pcm,
    Dop,
    NativeDsd
  };

  QueueItem item;
  AudioStreamInfo stream;
  AudioFormat decodeFormat;
  std::unique_ptr<FFmpegDecoder> decoder;
  std::unique_ptr<DsdReader> dsdReader;
  // DSD-preserving DST decoder provider, injected into dsdReader so SACD ISO
  // DST-compressed tracks are playable through the DoP / native-DSD pipeline.
  std::unique_ptr<SacdDstDecoderProvider> dstProvider = createDefaultSacdDstDecoderProvider();
  DopPacker dopPacker;
  AudioBuffer buffer;
  std::vector<uint8_t> floatReadScratch;
  std::atomic<bool> running{false};
  std::atomic<bool> eof{false};
  std::thread decodeThread;
  Mode mode = Mode::Pcm;
  bool typedPassthrough = false;
  // Only touched by the control thread before start and by the decode thread while running.
  std::optional<uint64_t> remainingSegmentFrames;
  uint64_t remainingVirtualPregapFrames = 0;

  ~DecodeStream() {
    stop();
  }

  bool openSource(const QueueItem& queueItem, std::string* error) {
    stop();
    dsdReader.reset();
    item = queueItem;
    mode = Mode::Pcm;
    decoder = std::make_unique<FFmpegDecoder>();
    if (!decoder->open(item.source, error)) {
      decoder.reset();
      return false;
    }
    stream = decoder->streamInfo();
    stream.source = item.source;
    if (hasCueRange()) {
      stream.durationSeconds = cueLogicalDurationSeconds();
    } else if (item.durationSeconds > 0.0) {
      stream.durationSeconds = item.durationSeconds;
    }
    // Host-injected library RG/R128 and loudnorm measurement overlay decode-time tags.
    applyQueueReplayGainTags(item, stream.replayGain);
    return true;
  }

  void setResamplerQuality(DspResamplerQuality quality) {
    if (!decoder) return;
    switch (quality) {
      case DspResamplerQuality::SoxrVhq:
        decoder->setResamplerQuality(FFmpegDecoder::ResamplerQuality::SoxrVhq);
        break;
      case DspResamplerQuality::SoxrHq:
        decoder->setResamplerQuality(FFmpegDecoder::ResamplerQuality::SoxrHq);
        break;
      case DspResamplerQuality::Ultra:
        decoder->setResamplerQuality(FFmpegDecoder::ResamplerQuality::Ultra);
        break;
      case DspResamplerQuality::High:
        decoder->setResamplerQuality(FFmpegDecoder::ResamplerQuality::High);
        break;
      case DspResamplerQuality::Native:
      default:
        decoder->setResamplerQuality(FFmpegDecoder::ResamplerQuality::Native);
        break;
    }
  }

  bool openDsdSource(const QueueItem& queueItem, std::string* error) {
    stop();
    decoder.reset();
    item = queueItem;
    mode = Mode::Dop;
    dsdReader = std::make_unique<DsdReader>();
    dsdReader->setDstDecoderProvider(dstProvider.get());
    if (!dsdReader->open(item.source, error)) {
      dsdReader.reset();
      return false;
    }
    stream = streamInfoFromDsd(item, dsdReader->streamInfo(), DsdMode::Dop);
    if (hasCueRange()) stream.durationSeconds = cueLogicalDurationSeconds();
    return true;
  }

  bool openNativeDsdSource(const QueueItem& queueItem, std::string* error) {
    stop();
    decoder.reset();
    item = queueItem;
    mode = Mode::NativeDsd;
    dsdReader = std::make_unique<DsdReader>();
    dsdReader->setDstDecoderProvider(dstProvider.get());
    if (!dsdReader->open(item.source, error)) {
      dsdReader.reset();
      return false;
    }
    stream = streamInfoFromDsd(item, dsdReader->streamInfo(), DsdMode::Native);
    if (hasCueRange()) stream.durationSeconds = cueLogicalDurationSeconds();
    return true;
  }

  bool configure(
      const AudioFormat& outputFormat,
      double startTimeSeconds,
      std::string* error,
      bool useTypedPassthrough = false) {
    if (mode == Mode::Dop) return configureDop(outputFormat, startTimeSeconds, error);
    if (mode == Mode::NativeDsd) return configureNativeDsd(outputFormat, startTimeSeconds, error);
    return configurePcm(outputFormat, startTimeSeconds, error, useTypedPassthrough);
  }

  bool configurePcm(
      const AudioFormat& outputFormat,
      double startTimeSeconds,
      std::string* error,
      bool useTypedPassthrough) {
    if (!decoder) {
      if (error) *error = "解码器尚未打开";
      return false;
    }

    decodeFormat = outputFormat;
    typedPassthrough = useTypedPassthrough;
    if (!typedPassthrough) {
      decodeFormat.bitDepth = 32;
      decodeFormat.sampleFormat = AudioSampleFormat::Float32Interleaved;
    }
    if (!decoder->setOutputFormat(decodeFormat, error)) return false;
    decodeFormat = decoder->outputFormat();
    stream.decodedFormat = decodeFormat;
    const double logicalStart = clampLogicalSegmentPosition(startTimeSeconds);
    const double sourceStart = sourcePositionForLogicalPosition(logicalStart);
    if (sourceStart > 0.0 && !decoder->seek(sourceStart, error)) return false;

    if (hasCueRange()) {
      remainingSegmentFrames = remainingFramesForSourcePosition(sourceStart);
      remainingVirtualPregapFrames = virtualPregapFramesForLogicalPosition(logicalStart);
    } else {
      remainingSegmentFrames.reset();
      remainingVirtualPregapFrames = 0;
    }

    eof = remainingVirtualPregapFrames == 0 && remainingSegmentFrames && *remainingSegmentFrames == 0;
    buffer.reset(decodeFormat, static_cast<size_t>(std::max(decodeFormat.sampleRate * 2, 8192)));
    return true;
  }

  bool configureDop(const AudioFormat& outputFormat, double startTimeSeconds, std::string* error) {
    if (!dsdReader) {
      if (error) *error = "DSD reader is not open";
      return false;
    }
    const DsdStreamInfo& dsd = dsdReader->streamInfo();
    if (!formatCanCarryDop(outputFormat, dsd.dsdRate, dsd.dsdSampleRate, dsd.channelCount)) {
      if (error) *error = "DoP carrier format mismatch";
      return false;
    }

    DopPackerConfig config;
    config.channelCount = dsd.channelCount;
    config.dsdRate = dsd.dsdRate;
    config.sourceSampleRate = dsd.dsdSampleRate;
    config.bitOrder = dsdBitOrderFromInfo(dsd);
    config.packing = dsdPackingFromInfo(dsd);
    config.outputFormat = outputFormat.sampleFormat;
    if (!dopPacker.configure(config, error)) return false;
    const double logicalStart = clampLogicalSegmentPosition(startTimeSeconds);
    const double sourceStart = sourcePositionForLogicalPosition(logicalStart);
    if (sourceStart > 0.0 && !dsdReader->seek(sourceStart, error)) return false;

    decodeFormat = dopPacker.carrierFormat();
    stream.decodedFormat = decodeFormat;
    stream.dsdMode = DsdMode::Dop;
    typedPassthrough = true;
    if (hasCueRange()) {
      remainingSegmentFrames = remainingFramesForSourcePosition(sourceStart);
      remainingVirtualPregapFrames = virtualPregapFramesForLogicalPosition(logicalStart);
    } else {
      remainingSegmentFrames.reset();
      remainingVirtualPregapFrames = 0;
    }
    eof = remainingVirtualPregapFrames == 0 && remainingSegmentFrames && *remainingSegmentFrames == 0;
    // DoP is a raw 24-bit carrier. Preserve marker and payload bytes end-to-end;
    // any Float32 conversion, volume, DSP, dither, or requantization can make the DAC lose lock.
    buffer.reset(decodeFormat, static_cast<size_t>(std::max(decodeFormat.sampleRate * 2, 8192)));
    return true;
  }

  bool configureNativeDsd(const AudioFormat& outputFormat, double startTimeSeconds, std::string* error) {
    if (!dsdReader) {
      if (error) *error = "DSD reader is not open";
      return false;
    }
    const DsdStreamInfo& dsd = dsdReader->streamInfo();
    if (!isDsdSampleFormat(outputFormat.sampleFormat) || outputFormat.channelCount != dsd.channelCount) {
      if (error) *error = "Native DSD output format mismatch";
      return false;
    }
    const double logicalStart = clampLogicalSegmentPosition(startTimeSeconds);
    const double sourceStart = sourcePositionForLogicalPosition(logicalStart);
    if (sourceStart > 0.0 && !dsdReader->seek(sourceStart, error)) return false;
    decodeFormat = outputFormat;
    stream.decodedFormat = nativeDsdFormatForStream(dsd);
    stream.dsdMode = DsdMode::Native;
    typedPassthrough = true;
    if (hasCueRange()) {
      remainingSegmentFrames = remainingFramesForSourcePosition(sourceStart);
      remainingVirtualPregapFrames = virtualPregapFramesForLogicalPosition(logicalStart);
    } else {
      remainingSegmentFrames.reset();
      remainingVirtualPregapFrames = 0;
    }
    eof = remainingVirtualPregapFrames == 0 && remainingSegmentFrames && *remainingSegmentFrames == 0;
    buffer.reset(decodeFormat, static_cast<size_t>(std::max(dsd.dsdSampleRate / 8, 8192)));
    return true;
  }

  void start() {
    if ((!decoder && !dsdReader) || running.load() || eof.load()) return;
    running = true;
    decodeThread = std::thread([this] { decodeLoop(); });
  }

  void requestStop() {
    running = false;
    buffer.notifyAll();
  }

  void stop() {
    requestStop();
    if (decodeThread.joinable()) decodeThread.join();
  }

  bool seek(double seconds, std::string* error) {
    if (!decoder && !dsdReader) return false;
    stop();
    const double logicalSeconds = clampLogicalSegmentPosition(seconds);
    const double sourceSeconds = sourcePositionForLogicalPosition(logicalSeconds);
    const bool ok = (mode == Mode::Dop || mode == Mode::NativeDsd)
                        ? dsdReader->seek(sourceSeconds, error)
                        : decoder->seek(sourceSeconds, error);
    if (!ok) {
      start();
      return false;
    }
    // A DoP stream has an alternating 0x05/0xfa marker phase.  The decoder may
    // have filled far ahead of the render cursor before a seek, so retaining
    // that internal phase would make the first carrier frame after the seek
    // depend on how much happened to be prefetched.  Restart every seek at the
    // canonical marker boundary, just as a freshly configured stream does.
    if (mode == Mode::Dop) dopPacker.reset();
    buffer.clear();
    if (hasCueRange()) {
      remainingSegmentFrames = remainingFramesForSourcePosition(sourceSeconds);
      remainingVirtualPregapFrames = virtualPregapFramesForLogicalPosition(logicalSeconds);
    }
    eof = remainingVirtualPregapFrames == 0 && remainingSegmentFrames && *remainingSegmentFrames == 0;
    start();
    return true;
  }

  double clampRelativePosition(double seconds) const {
    return clampLogicalSegmentPosition(seconds);
  }

  size_t read(float* output, size_t frameCount) {
    return buffer.read(output, frameCount);
  }

  void prepareFloatReadScratch(size_t maxFrames) {
    const AudioFormat bufferFormat = buffer.format();
    if (bufferFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
      floatReadScratch.clear();
      return;
    }
    const size_t bytesPerFrame = audioFormatBytesPerFrame(bufferFormat);
    if (bytesPerFrame == 0) {
      floatReadScratch.clear();
      return;
    }
    floatReadScratch.resize(std::max<size_t>(1, maxFrames) * bytesPerFrame);
  }

  size_t readFloat(float* output, size_t frameCount) {
    if (!output || frameCount == 0) return 0;
    const AudioFormat bufferFormat = buffer.format();
    if (bufferFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
      return buffer.read(output, frameCount);
    }

    const size_t bytesPerFrame = audioFormatBytesPerFrame(bufferFormat);
    if (bytesPerFrame == 0) return 0;
    size_t readableFrames = frameCount;
    const size_t scratchFrames = floatReadScratch.size() / bytesPerFrame;
    if (scratchFrames == 0) {
      const size_t samples = frameCount * static_cast<size_t>(std::max(1, bufferFormat.channelCount));
      std::fill(output, output + samples, 0.0f);
      return 0;
    }
    readableFrames = std::min(readableFrames, scratchFrames);
    const size_t requiredBytes = readableFrames * bytesPerFrame;
    PcmBlock block;
    block.format = bufferFormat;
    block.data = floatReadScratch.data();
    block.frames = readableFrames;
    block.byteSize = requiredBytes;
    const size_t read = buffer.read(block);
    block.frames = read;
    typedPcmToFloat(block, output, frameCount);
    return read;
  }

  size_t read(PcmBlock& output) {
    return buffer.read(output);
  }

  AudioFormat bufferFormat() const {
    return buffer.format();
  }

  bool drained() const {
    return eof.load() && buffer.availableFrames() == 0;
  }

  bool readyForRender() const {
    return buffer.availableFrames() > 0 || eof.load();
  }

  bool waitForPreroll(size_t targetFrames, std::chrono::milliseconds timeout) const {
    return buffer.waitForAvailableFrames(targetFrames, timeout, running, eof) > 0 || eof.load();
  }

  bool hasVirtualPregap() const {
    return cueVirtualPregapSeconds() > 0.0;
  }

  size_t virtualPregapFramesFromLogicalFrame(
      uint64_t logicalFrame,
      int frameRate,
      size_t maximumFrames) const {
    if (!hasVirtualPregap() || frameRate <= 0 || maximumFrames == 0) return 0;
    const uint64_t total = static_cast<uint64_t>(
        std::ceil(cueVirtualPregapSeconds() * static_cast<double>(frameRate)));
    if (logicalFrame >= total) return 0;
    return static_cast<size_t>(
        std::min<uint64_t>(total - logicalFrame, static_cast<uint64_t>(maximumFrames)));
  }

 private:
  bool hasCueRange() const {
    return item.cueStartSeconds && item.cueEndSeconds &&
           *item.cueStartSeconds >= 0.0 && *item.cueEndSeconds > *item.cueStartSeconds;
  }

  double cueSourceStartSeconds() const {
    return hasCueRange() ? *item.cueStartSeconds : 0.0;
  }

  double cueVirtualPregapSeconds() const {
    return hasCueRange() ? std::max(0.0, item.cueVirtualPregapSeconds) : 0.0;
  }

  double cueLogicalDurationSeconds() const {
    if (!hasCueRange()) return std::max(0.0, item.durationSeconds);
    return cueVirtualPregapSeconds() + *item.cueEndSeconds - *item.cueStartSeconds;
  }

  double clampLogicalSegmentPosition(double seconds) const {
    const double requested = std::max(0.0, seconds);
    if (!hasCueRange()) return requested;
    return std::min(requested, cueLogicalDurationSeconds());
  }

  double sourcePositionForLogicalPosition(double logicalSeconds) const {
    if (!hasCueRange()) return logicalSeconds;
    const double sourceRelative = std::max(0.0, logicalSeconds - cueVirtualPregapSeconds());
    return cueSourceStartSeconds() + sourceRelative;
  }

  double segmentFrameRate() const {
    if (mode == Mode::NativeDsd && isDsdSampleFormat(decodeFormat.sampleFormat)) {
      return static_cast<double>(decodeFormat.sampleRate) / 8.0;
    }
    return static_cast<double>(decodeFormat.sampleRate);
  }

  uint64_t remainingFramesForSourcePosition(double sourceSeconds) const {
    if (!hasCueRange()) return 0;
    const double remainingSeconds = std::max(0.0, *item.cueEndSeconds - sourceSeconds);
    return static_cast<uint64_t>(std::ceil(remainingSeconds * segmentFrameRate()));
  }

  uint64_t virtualPregapFramesForLogicalPosition(double logicalSeconds) const {
    const double remainingSeconds =
        std::max(0.0, cueVirtualPregapSeconds() - std::max(0.0, logicalSeconds));
    return static_cast<uint64_t>(std::ceil(remainingSeconds * segmentFrameRate()));
  }

  void markEof() {
    eof = true;
    buffer.notifyAll();
  }

  void decodeLoop() {
    if (mode == Mode::Dop) {
      decodeDopLoop();
      return;
    }
    if (mode == Mode::NativeDsd) {
      decodeNativeDsdLoop();
      return;
    }

    const int channels = std::max(1, decodeFormat.channelCount);
    const size_t bytesPerFrame = audioFormatBytesPerFrame(decodeFormat);
    std::vector<float> frames;
    std::vector<uint8_t> typedFrames;
    if (decodeFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
      frames.assign(kDecodeChunkFrames * static_cast<size_t>(channels), 0.0f);
    } else {
      typedFrames.assign(kDecodeChunkFrames * bytesPerFrame, 0);
    }

    while (running.load()) {
      if (remainingVirtualPregapFrames > 0) {
        if (decodeFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
          remainingVirtualPregapFrames = 0;
        } else {
          const size_t silenceFrames = static_cast<size_t>(std::min<uint64_t>(
              remainingVirtualPregapFrames, static_cast<uint64_t>(kDecodeChunkFrames)));
          std::fill(typedFrames.begin(), typedFrames.end(), 0);
          PcmBlock silence;
          silence.format = decodeFormat;
          silence.data = typedFrames.data();
          silence.frames = silenceFrames;
          silence.byteSize = silenceFrames * bytesPerFrame;
          buffer.writeBlocking(silence, running);
          remainingVirtualPregapFrames -= silenceFrames;
          continue;
        }
      }
      if (!decoder) break;
      std::string error;
      size_t decoded = 0;
      if (decodeFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
        decoded = decoder->readFrames(frames.data(), kDecodeChunkFrames, &error);
      } else {
        PcmBlock block;
        block.format = decodeFormat;
        block.data = typedFrames.data();
        block.frames = kDecodeChunkFrames;
        block.byteSize = typedFrames.size();
        decoded = decoder->readFrames(block, &error);
      }
      // Keep decoder StreamTitle snapshot fresh for status() readers.
      decoder->pollStreamMetadata();
      if (remainingSegmentFrames) {
        decoded = std::min(decoded, static_cast<size_t>(*remainingSegmentFrames));
      }
      if (decoded == 0) {
        markEof();
        break;
      }
      if (decodeFormat.sampleFormat == AudioSampleFormat::Float32Interleaved) {
        buffer.writeBlocking(frames.data(), decoded, running);
      } else {
        PcmBlock block;
        block.format = decodeFormat;
        block.data = typedFrames.data();
        block.frames = decoded;
        block.byteSize = decoded * bytesPerFrame;
        buffer.writeBlocking(block, running);
      }
      if (remainingSegmentFrames) {
        *remainingSegmentFrames -= decoded;
        if (*remainingSegmentFrames == 0) {
          markEof();
          break;
        }
      }
    }
  }

  void decodeDopLoop() {
    const int channels = std::max(1, decodeFormat.channelCount);
    const size_t dsdBytesPerChunk = kDecodeChunkFrames * static_cast<size_t>(channels) * 2;
    std::vector<uint8_t> dsdBytes(dsdBytesPerChunk);
    std::vector<uint8_t> pcmBytes;

    while (running.load()) {
      if (remainingVirtualPregapFrames > 0) {
        const size_t silenceFrames = static_cast<size_t>(std::min<uint64_t>(
            remainingVirtualPregapFrames, static_cast<uint64_t>(kDecodeChunkFrames)));
        const size_t silenceBytes = silenceFrames * static_cast<size_t>(channels) * 2;
        // These are *source* DSD bytes: the packer normalizes them to the DoP
        // payload's MSB-first order using the stream's own bit order, so the
        // idle pattern has to be written the way this source would encode it.
        // 0x69 is the LSB-first spelling; MSB-first sources need it reversed so
        // both land on the same 0x96 payload byte after normalization.
        const uint8_t silenceSourceByte = dsdReader && dsdReader->streamInfo().bitOrder == DsdBitOrder::MsbFirst
                                              ? dop::kBitReverseTable[0x69]
                                              : 0x69;
        std::fill(dsdBytes.begin(), dsdBytes.begin() + silenceBytes, silenceSourceByte);
        const size_t packedFrames = dopPacker.pack(dsdBytes.data(), silenceBytes, &pcmBytes);
        if (packedFrames == 0) {
          markEof();
          break;
        }
        PcmBlock block;
        block.format = decodeFormat;
        block.data = pcmBytes.data();
        block.frames = packedFrames;
        block.byteSize = packedFrames * audioFormatBytesPerFrame(decodeFormat);
        buffer.writeBlocking(block, running);
        remainingVirtualPregapFrames -= packedFrames;
        continue;
      }
      if (!dsdReader) break;
      const size_t read = dsdReader->readBytes(dsdBytes.data(), dsdBytes.size());
      if (read == 0) {
        markEof();
        break;
      }
      const size_t packedFrames = dopPacker.pack(dsdBytes.data(), read, &pcmBytes);
      if (packedFrames == 0) continue;
      const size_t boundedFrames = remainingSegmentFrames
                                       ? std::min(packedFrames, static_cast<size_t>(*remainingSegmentFrames))
                                       : packedFrames;
      if (boundedFrames == 0) {
        markEof();
        break;
      }
      PcmBlock block;
      block.format = decodeFormat;
      block.data = pcmBytes.data();
      block.frames = boundedFrames;
      block.byteSize = boundedFrames * audioFormatBytesPerFrame(decodeFormat);
      buffer.writeBlocking(block, running);
      if (remainingSegmentFrames) {
        *remainingSegmentFrames -= boundedFrames;
        if (*remainingSegmentFrames == 0) {
          markEof();
          break;
        }
      }
    }
  }

  void decodeNativeDsdLoop() {
    const DsdStreamInfo info = dsdReader ? dsdReader->streamInfo() : DsdStreamInfo{};
    const int channels = std::max(1, decodeFormat.channelCount);
    const size_t dsdBytesPerChunk =
        info.packing == DsdPacking::DsfPlanarBlocks && info.blockSizePerChannel > 0
            ? static_cast<size_t>(info.blockSizePerChannel) * static_cast<size_t>(channels)
            : kDecodeChunkFrames * static_cast<size_t>(channels);
    std::vector<uint8_t> dsdBytes(dsdBytesPerChunk);
    std::vector<uint8_t> interleaved;

    while (running.load()) {
      if (remainingVirtualPregapFrames > 0) {
        const size_t silenceFrames = static_cast<size_t>(std::min<uint64_t>(
            remainingVirtualPregapFrames, static_cast<uint64_t>(kDecodeChunkFrames)));
        const uint8_t silenceByte =
            render::convertDsdByte(0x69, DsdBitOrder::LsbFirst, decodeFormat.sampleFormat);
        interleaved.assign(silenceFrames * audioFormatBytesPerFrame(decodeFormat), silenceByte);
        PcmBlock silence;
        silence.format = decodeFormat;
        silence.data = interleaved.data();
        silence.frames = silenceFrames;
        silence.byteSize = silenceFrames * audioFormatBytesPerFrame(decodeFormat);
        buffer.writeBlocking(silence, running);
        remainingVirtualPregapFrames -= silenceFrames;
        continue;
      }
      if (!dsdReader) break;
      const size_t read = dsdReader->readBytes(dsdBytes.data(), dsdBytes.size());
      if (read == 0) {
        markEof();
        break;
      }
      const size_t decodedFrames = dsdBytesToInterleaved(dsdBytes.data(), read, info, decodeFormat.sampleFormat, &interleaved);
      const size_t frames = remainingSegmentFrames
                                ? std::min(decodedFrames, static_cast<size_t>(*remainingSegmentFrames))
                                : decodedFrames;
      if (frames == 0) {
        if (remainingSegmentFrames && *remainingSegmentFrames == 0) markEof();
        if (eof.load()) break;
        continue;
      }
      PcmBlock block;
      block.format = decodeFormat;
      block.data = interleaved.data();
      block.frames = frames;
      block.byteSize = frames * audioFormatBytesPerFrame(decodeFormat);
      buffer.writeBlocking(block, running);
      if (remainingSegmentFrames) {
        *remainingSegmentFrames -= frames;
        if (*remainingSegmentFrames == 0) {
          markEof();
          break;
        }
      }
    }
  }
};

namespace {
bool sameQueueSegment(const QueueItem& left, const QueueItem& right) {
  if (left.source != right.source) return false;
  return left.cueStartSeconds == right.cueStartSeconds &&
         left.cueEndSeconds == right.cueEndSeconds &&
         left.cueVirtualPregapSeconds == right.cueVirtualPregapSeconds;
}
}  // namespace

struct AudioPipeline::DecodeStreamReaper {
  DecodeStreamReaper() : worker([this] { run(); }) {}

  // Only safe while every thread in the process is still alive. decodeStreamReaper()
  // intentionally leaks its instance so this never runs during DLL unload, where
  // joining an already-killed worker deadlocks in pthread_cond_destroy. Do not turn
  // that singleton back into a plain static.
  ~DecodeStreamReaper() {
    {
      std::lock_guard lock(mutex);
      stopping = true;
    }
    cv.notify_one();
    if (worker.joinable()) worker.join();
    drain();
  }

  void retire(std::unique_ptr<DecodeStream> stream) {
    if (!stream) return;
    stream->requestStop();
    {
      std::lock_guard lock(mutex);
      queue.push_back(std::move(stream));
    }
    cv.notify_one();
  }

 private:
  void run() {
    while (true) {
      std::unique_ptr<DecodeStream> stream;
      {
        std::unique_lock lock(mutex);
        cv.wait(lock, [this] { return stopping || !queue.empty(); });
        if (queue.empty()) {
          if (stopping) break;
          continue;
        }
        stream = std::move(queue.front());
        queue.pop_front();
      }
      stream->stop();
      stream.reset();
    }
  }

  void drain() {
    std::deque<std::unique_ptr<DecodeStream>> remaining;
    {
      std::lock_guard lock(mutex);
      remaining.swap(queue);
    }
    for (auto& stream : remaining) {
      if (stream) stream->stop();
    }
  }

  std::mutex mutex;
  std::condition_variable cv;
  std::deque<std::unique_ptr<DecodeStream>> queue;
  std::thread worker;
  bool stopping = false;
};

AudioPipeline::AudioPipeline()
    : dspChain_(std::make_unique<DspChain>()),
      preloadDspChain_(std::make_unique<DspChain>()) {
  // The transaction commit below must not allocate after graph preparation
  // succeeds. Keeping this fixed-capacity retirement window reserved makes
  // the ownership hand-off deterministic.
  renderDspGraphs_.reserve(kMaxRenderDspGraphGenerations);
  // activeDspChainLocked() can return either chain, so both have to observe the same
  // realtime convolver telemetry.
  if (dspChain_ && preloadDspChain_) {
    preloadDspChain_->setConvolverRealtimeState(dspChain_->convolverRealtimeState());
  }
}

void AudioPipeline::LatestControlCommandSlot::publish(const ControlCommand& command) noexcept {
  // Volume and PlaybackRate share this coalescing slot. Callers must snapshot both
  // fields on the command so a later Volume publish cannot reset rate to 1.0.
  sequence.fetch_add(1, std::memory_order_acq_rel);
  volumeBits.store(doubleBits(command.volume), std::memory_order_relaxed);
  playbackRateBits.store(doubleBits(command.playbackRate), std::memory_order_relaxed);
  type.store(static_cast<uint8_t>(command.type), std::memory_order_relaxed);
  revision.store(command.revision, std::memory_order_relaxed);
  sequence.fetch_add(1, std::memory_order_release);
}

bool AudioPipeline::LatestControlCommandSlot::read(ControlCommand* command) const noexcept {
  if (!command) return false;
  const uint64_t before = sequence.load(std::memory_order_acquire);
  if ((before & 1U) != 0U) return false;
  ControlCommand snapshot;
  snapshot.type = static_cast<ControlCommandType>(type.load(std::memory_order_relaxed));
  snapshot.volume = doubleFromBits(volumeBits.load(std::memory_order_relaxed));
  snapshot.playbackRate = doubleFromBits(playbackRateBits.load(std::memory_order_relaxed));
  snapshot.revision = revision.load(std::memory_order_relaxed);
  const uint64_t after = sequence.load(std::memory_order_acquire);
  if (before != after || (after & 1U) != 0U) return false;
  *command = snapshot;
  return snapshot.revision != 0;
}

void AudioPipeline::LatestRoutingCommandSlot::publish(const ControlCommand& command) noexcept {
  sequence.fetch_add(1, std::memory_order_acq_rel);
  routingMode.store(static_cast<uint32_t>(command.routingMode), std::memory_order_relaxed);
  centerGainBits.store(floatBits(command.upmix.centerGain), std::memory_order_relaxed);
  lfeGainBits.store(floatBits(command.upmix.lfeGain), std::memory_order_relaxed);
  lfeLowpassHzBits.store(floatBits(command.upmix.lfeLowpassHz), std::memory_order_relaxed);
  surroundGainBits.store(floatBits(command.upmix.surroundGain), std::memory_order_relaxed);
  sideGainBits.store(floatBits(command.upmix.sideGain), std::memory_order_relaxed);
  surroundDelayMsBits.store(floatBits(command.upmix.surroundDelayMs), std::memory_order_relaxed);
  sequence.fetch_add(1, std::memory_order_release);
}

bool AudioPipeline::LatestRoutingCommandSlot::read(ControlCommand* command) const noexcept {
  if (!command) return false;
  const uint64_t before = sequence.load(std::memory_order_acquire);
  if ((before & 1U) != 0U) return false;

  ControlCommand snapshot;
  snapshot.type = ControlCommandType::Routing;
  snapshot.routingMode = static_cast<ChannelRoutingMode>(routingMode.load(std::memory_order_relaxed));
  snapshot.upmix.centerGain = floatFromBits(centerGainBits.load(std::memory_order_relaxed));
  snapshot.upmix.lfeGain = floatFromBits(lfeGainBits.load(std::memory_order_relaxed));
  snapshot.upmix.lfeLowpassHz = floatFromBits(lfeLowpassHzBits.load(std::memory_order_relaxed));
  snapshot.upmix.surroundGain = floatFromBits(surroundGainBits.load(std::memory_order_relaxed));
  snapshot.upmix.sideGain = floatFromBits(sideGainBits.load(std::memory_order_relaxed));
  snapshot.upmix.surroundDelayMs = floatFromBits(surroundDelayMsBits.load(std::memory_order_relaxed));

  const uint64_t after = sequence.load(std::memory_order_acquire);
  if (before != after || (after & 1U) != 0U) return false;
  snapshot.revision = after;
  *command = snapshot;
  return after != 0;
}

void AudioPipeline::LatestDspGraphCommandSlot::publish(const ControlCommand& command) noexcept {
  sequence.fetch_add(1, std::memory_order_acq_rel);
  revision.store(command.revision, std::memory_order_relaxed);
  dspEpoch.store(command.dspEpoch, std::memory_order_relaxed);
  activeGraphBits.store(pointerBits(command.activeDspGraph), std::memory_order_relaxed);
  preloadGraphBits.store(pointerBits(command.preloadDspGraph), std::memory_order_relaxed);
  gaplessEnabled.store(command.gaplessEnabled, std::memory_order_relaxed);
  crossfadeSecondsBits.store(doubleBits(command.crossfadeSeconds), std::memory_order_relaxed);
  sequence.fetch_add(1, std::memory_order_release);
}

bool AudioPipeline::LatestDspGraphCommandSlot::read(ControlCommand* command) const noexcept {
  if (!command) return false;
  const uint64_t before = sequence.load(std::memory_order_acquire);
  if ((before & 1U) != 0U) return false;

  ControlCommand snapshot;
  snapshot.type = ControlCommandType::DspGraph;
  snapshot.revision = revision.load(std::memory_order_relaxed);
  snapshot.dspEpoch = dspEpoch.load(std::memory_order_relaxed);
  snapshot.activeDspGraph = pointerFromBits<DspChain>(activeGraphBits.load(std::memory_order_relaxed));
  snapshot.preloadDspGraph = pointerFromBits<DspChain>(preloadGraphBits.load(std::memory_order_relaxed));
  snapshot.gaplessEnabled = gaplessEnabled.load(std::memory_order_relaxed);
  snapshot.crossfadeSeconds = doubleFromBits(crossfadeSecondsBits.load(std::memory_order_relaxed));

  const uint64_t after = sequence.load(std::memory_order_acquire);
  if (before != after || (after & 1U) != 0U || snapshot.dspEpoch == 0) return false;
  *command = snapshot;
  return true;
}

AudioPipeline::~AudioPipeline() {
  stop();
}

std::shared_ptr<AudioPipeline::DecodeStream> AudioPipeline::makeDecodeStream() {
  return std::shared_ptr<DecodeStream>(
      new DecodeStream(),
      [](DecodeStream* stream) {
        decodeStreamReaper().retire(std::unique_ptr<DecodeStream>(stream));
      });
}

AudioPipeline::DecodeStreamReaper& AudioPipeline::decodeStreamReaper() {
  // Deliberately never destroyed. On Windows the loader kills every thread except
  // the one calling ExitProcess before it runs DLL_PROCESS_DETACH, so a static
  // destructor here would try to reap a thread that is already gone: worker.join()
  // returns immediately, but the worker died inside cv.wait() without releasing its
  // waiter slot, and pthread_cond_destroy then blocks on that semaphore forever.
  // Reaping decode streams at process exit buys nothing -- the OS reclaims the file
  // handles and decoder contexts either way -- so leaking the reaper is the fix.
  static DecodeStreamReaper* const reaper = new DecodeStreamReaper();
  return *reaper;
}

bool AudioPipeline::retireDecodeStreamLocked(std::shared_ptr<DecodeStream> stream) {
  if (!stream) return true;
  stream->requestStop();
  if (retiredStreamCount_ >= retiredStreams_.size()) {
    deferredRetiredStreams_.push_back(std::move(stream));
    return true;
  }
  retiredStreams_[retiredStreamCount_++] = std::move(stream);
  return true;
}

void AudioPipeline::cleanupRetiredDecodeStreams() const {
  if (renderState_.load(std::memory_order_acquire) != PipelineState::Stopped) return;
  std::array<std::shared_ptr<DecodeStream>, kRetiredStreamSlots> retired;
  std::vector<std::shared_ptr<DecodeStream>> deferred;
  size_t retiredCount = 0;
  {
    std::lock_guard lock(mutex_);
    retiredCount = retiredStreamCount_;
    for (size_t i = 0; i < retiredCount; ++i) {
      retired[i] = std::move(retiredStreams_[i]);
    }
    retiredStreamCount_ = 0;
    deferred.swap(deferredRetiredStreams_);
  }
  for (size_t i = 0; i < retiredCount; ++i) {
    if (retired[i]) retired[i]->stop();
  }
  for (const auto& stream : deferred) {
    if (stream) stream->stop();
  }
}

void AudioPipeline::tryCleanupRetiredDecodeStreams() const {
  if (renderState_.load(std::memory_order_acquire) != PipelineState::Stopped) return;
  std::array<std::shared_ptr<DecodeStream>, kRetiredStreamSlots> retired;
  std::vector<std::shared_ptr<DecodeStream>> deferred;
  size_t retiredCount = 0;
  {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return;
    retiredCount = retiredStreamCount_;
    for (size_t i = 0; i < retiredCount; ++i) {
      retired[i] = std::move(retiredStreams_[i]);
    }
    retiredStreamCount_ = 0;
    deferred.swap(deferredRetiredStreams_);
  }
  for (size_t i = 0; i < retiredCount; ++i) {
    if (retired[i]) retired[i]->stop();
  }
  for (const auto& stream : deferred) {
    if (stream) stream->stop();
  }
}

void AudioPipeline::setBackendFactoryForTests(BackendFactory factory) {
  backendFactoryOverride() = std::move(factory);
}

void AudioPipeline::setNativeDsdDeviceDiscoveryForTests(NativeDsdDeviceDiscovery discovery) {
  nativeDsdDeviceDiscoveryOverride() = std::move(discovery);
}

TAE_Result AudioPipeline::play(
    const std::string& source,
    double startTimeSeconds,
    const std::string& backendId,
    const std::string& deviceId,
    double volume,
    const std::string& dspConfigJson,
    std::string* error) {
  return playInternal(
      makeManualItem(source),
      std::nullopt,
      startTimeSeconds,
      backendId,
      deviceId,
      volume,
      dspConfigJson,
      false,
      true,
      true,
      {},
      {},
      error);
}

TAE_Result AudioPipeline::play(
    const QueueItem& item,
    const std::optional<QueueItem>& upcomingItem,
    double startTimeSeconds,
    const std::string& backendId,
    const std::string& deviceId,
    double volume,
    const std::string& dspConfigJson,
    bool gaplessEnabled,
    std::string* error) {
  return playInternal(
      item,
      upcomingItem,
      startTimeSeconds,
      backendId,
      deviceId,
      volume,
      dspConfigJson,
      gaplessEnabled,
      true,
      true,
      {},
      {},
      error);
}

TAE_Result AudioPipeline::playInternal(
    const QueueItem& item,
    const std::optional<QueueItem>& upcomingItem,
    double startTimeSeconds,
    const std::string& backendId,
    const std::string& deviceId,
    double volume,
    const std::string& dspConfigJson,
    bool gaplessEnabled,
    bool allowNativeDsd,
    bool allowDop,
    const std::string& forcedDsdFallbackReason,
    const std::optional<NativeDsdRuntimeFacts>& forcedNativeDsdFallbackFacts,
    std::string* error) {
  std::lock_guard<std::recursive_mutex> transportLock(transportMutex_);
  stop();
  if (item.source.empty()) return TAE_RESULT_INVALID_ARGUMENT;
  const double requestedPlaybackVolume = std::clamp(volume, 0.0, 1.0);
  if (std::abs(loadAtomicDouble(requestedVolumeBits_, std::memory_order_acquire) - requestedPlaybackVolume) >
      kUnityVolumeEpsilon) {
    setVolume(requestedPlaybackVolume);
  }
  const double requestedPlaybackRate =
      loadAtomicDouble(requestedPlaybackRateBits_, std::memory_order_acquire);

  OutputConfig outputConfig;
  std::string dspGraphJson;
  {
    std::lock_guard lock(mutex_);
    outputConfig = outputConfig_;
    dspGraphJson = dspGraphJson_;
  }

  const DspConfig requestedDspConfig = DspChain::parseConfigJson(dspConfigJson);
  const DspOutputStageRequest outputStageRequest = outputStageRequestFromGraphJson(dspGraphJson);
  // The DSD routes are decided against the graph that will run, not the legacy
  // module toggles that ride along with it.
  const std::optional<bool> graphProcessingActive = graphStateProcessingActive(dspGraphJson);
  const bool processingRequiresPcm =
      dspConfigProcessingRequiresPcm(
          requestedDspConfig, outputConfig, requestedPlaybackVolume, requestedPlaybackRate,
          graphProcessingActive);

  crossfadeMixActive_ = false;
  crossfadeFramesProcessed_ = 0;
  crossfadeTotalFrames_ = 0;

  std::optional<DsdStreamInfo> dsdProbe;
  std::string dsdProbeError;
  if (sourceLooksDsfOrDff(item.source) || sourceLooksSacdIso(item.source)) {
    // DST-compressed sources (SACD ISO areas, DSDIFF 'DST ' form) only open
    // through the DSD-preserving provider; the probe needs the same decoder
    // the playback paths get, or those tracks never reach the DSD routes.
    auto probeDstProvider = createDefaultSacdDstDecoderProvider();
    DsdReader probe;
    probe.setDstDecoderProvider(probeDstProvider.get());
    if (probe.open(item.source, &dsdProbeError)) {
      dsdProbe = probe.streamInfo();
    }
  }
  if (!dsdProbe.has_value() && !dsdProbeError.empty()) {
    // Without the probe neither DSD route is attempted; this event is the only
    // durable record of why (e.g. an unreadable source path).
    DiagnosticLog::instance().append(DiagLevel::Error, "dsd_probe_failed", dsdProbeError,
                                     "{\"source\":\"" + json_utils::escape(item.source) + "\"}");
  }

  // DSD compatibility route. When enabled, DSD (and optionally PCM->DSD
  // upconversion) leaves over a different backend/device than the regular PCM
  // output, so a DAC whose own ASIO driver refuses DSD sample types can still
  // reach a registered DSD-capable proxy driver. Empty fields inherit the main
  // route; the engine never inspects which proxy this is.
  const DsdRouteOverride& dsdRoute = requestedDspConfig.dsdRoute;
  bool dsdRouteActive = dsdRouteOverrideTargetsDistinctRoute(dsdRoute);
  std::string dsdBackendId =
      dsdRouteActive && !dsdRoute.backendId.empty() ? dsdRoute.backendId : backendId;
  std::string dsdDeviceId =
      dsdRouteActive && !dsdRoute.deviceId.empty() ? dsdRoute.deviceId : deviceId;

  // No explicit route and the main backend cannot carry DSD: look for a
  // DSD-capable ASIO driver rather than silently degrading to DoP/PCM. Only
  // engaged for real DSD sources, and never when the user pinned a route.
  bool dsdRouteAutoDiscovered = false;
  if (!dsdRouteActive && dsdProbe.has_value() && !backendCanAttemptNativeDsd(backendId) &&
      !dsdOutputModePrefersPcm(requestedDspConfig.dsdOutputMode)) {
    const std::string discovered = autoDiscoveredNativeDsdDeviceId(backendId);
    if (!discovered.empty()) {
      dsdRouteActive = true;
      dsdRouteAutoDiscovered = true;
      dsdBackendId = "asio";
      dsdDeviceId = discovered;
    }
  }

  // An auto-discovered route is a best-effort guess, so it must always be able
  // to fall back to the main route; only an explicit strict-passthrough opt-in
  // suppresses that.
  const bool dsdRouteRetriesMainRoute =
      dsdRouteActive && (dsdRouteAutoDiscovered || !dsdRoute.strictPassthrough) &&
      (dsdBackendId != backendId || dsdDeviceId != deviceId);

  const bool canTryDop = allowDop &&
                         shouldAttemptDopForCurrentConfig(
                             requestedDspConfig,
                             outputConfig,
                             dsdProbe,
                             requestedPlaybackVolume,
                             dsdBackendId,
                             graphProcessingActive);
  const bool canTryNativeDsd =
      allowNativeDsd && shouldAttemptNativeDsdForCurrentConfig(
                            requestedDspConfig,
                            outputConfig,
                            dsdProbe,
                            requestedPlaybackVolume,
                            dsdBackendId,
                            graphProcessingActive);
  if (const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
      tracePath != nullptr && tracePath[0] != '\0') {
    if (std::ofstream trace(tracePath, std::ios::app); trace) {
      const double tracePlaybackRate = loadAtomicDouble(requestedPlaybackRateBits_);
      trace << "DSD route decision"
            << " backend=" << backendId << " dsdBackend=" << dsdBackendId
            << " mode=" << static_cast<int>(requestedDspConfig.dsdOutputMode)
            << " volume=" << requestedPlaybackVolume << " rate=" << tracePlaybackRate
            << " routingMode=" << static_cast<int>(outputConfig.routingMode)
            << " processingRequiresPcm="
            << dspConfigProcessingRequiresPcm(
                   requestedDspConfig, outputConfig, requestedPlaybackVolume, tracePlaybackRate,
                   graphProcessingActive)
            << " graphProcessingActive="
            << (graphProcessingActive.has_value() ? (*graphProcessingActive ? "1" : "0") : "unset")
            << " allowNativeDsd=" << allowNativeDsd << " canTryNativeDsd=" << canTryNativeDsd
            << " allowDop=" << allowDop << " canTryDop=" << canTryDop
            << " dsdRate=" << (dsdProbe.has_value() ? dsdProbe->dsdRate : 0)
            << " probeError=" << dsdProbeError << '\n';
    }
  }
  if (sourceLooksDsfOrDff(item.source) || sourceLooksSacdIso(item.source)) {
    const bool routeAllowed = canTryNativeDsd || canTryDop;
    const int dsdRate = dsdProbe.has_value() ? dsdProbe->dsdRate : 0;
    const double decisionRate = loadAtomicDouble(requestedPlaybackRateBits_);
    const std::string summary =
        "backend=" + backendId + " dsdBackend=" + dsdBackendId +
        " mode=" + std::to_string(static_cast<int>(requestedDspConfig.dsdOutputMode)) +
        " rate=" + std::to_string(decisionRate) + " canTryNativeDsd=" +
        (canTryNativeDsd ? "1" : "0") + " canTryDop=" + (canTryDop ? "1" : "0") +
        " dsdRate=" + std::to_string(dsdRate) + " graphProcessingActive=" +
        (graphProcessingActive.has_value() ? (*graphProcessingActive ? "1" : "0") : "unset");
    DiagnosticLog::instance().append(
        routeAllowed ? DiagLevel::Info : DiagLevel::Warning, "dsd_route_decision",
        dsdProbeError.empty() ? summary : summary + " probeError=" + dsdProbeError,
        "{\"backend\":\"" + json_utils::escape(backendId) + "\",\"dsdBackend\":\"" +
            json_utils::escape(dsdBackendId) + "\",\"mode\":" +
            std::to_string(static_cast<int>(requestedDspConfig.dsdOutputMode)) +
            ",\"volume\":" + std::to_string(requestedPlaybackVolume) +
            ",\"playbackRate\":" + std::to_string(decisionRate) +
            ",\"allowNativeDsd\":" + (allowNativeDsd ? "true" : "false") +
            ",\"canTryNativeDsd\":" + (canTryNativeDsd ? "true" : "false") +
            ",\"allowDop\":" + (allowDop ? "true" : "false") +
            ",\"canTryDop\":" + (canTryDop ? "true" : "false") +
            ",\"dsdRate\":" + std::to_string(dsdRate) + ",\"graphProcessingActive\":" +
            (graphProcessingActive.has_value() ? (*graphProcessingActive ? "true" : "false") : "null") +
            ",\"probeError\":\"" + json_utils::escape(dsdProbeError) + "\"}");
  }

  std::shared_ptr<DecodeStream> active;
  std::unique_ptr<IOutputBackend> output;
  AudioFormat outputFormat;
  bool dopPath = false;
  bool nativeDsdPath = false;
  std::string nativeAttemptError;
  std::string dopAttemptError;
  std::optional<NativeDsdRuntimeFacts> attemptedNativeDsdFacts = forcedNativeDsdFallbackFacts;

  const auto tryNativeDsdRoute = [&](const std::string& routeBackendId, const std::string& routeDeviceId) {
    auto nativeActive = makeDecodeStream();
    if (nativeActive->openNativeDsdSource(item, &nativeAttemptError)) {
      output = backendFactoryOverride() ? backendFactoryOverride()(routeBackendId)
                                        : createOutputBackend(routeBackendId);
      if (!output) {
        nativeAttemptError = "请求的音频输出后端不可用：" + routeBackendId;
      } else if (!output->setOutputConfig(outputConfig, &nativeAttemptError)) {
        output.reset();
      } else {
        AudioFormat requested = nativeDsdFormatForStream(dsdProbe.value());
        if (output->open(routeDeviceId, requested, &nativeAttemptError)) {
          outputFormat = output->outputFormat();
          const NativeDsdRuntimeFacts nativeFacts = output->nativeDsdRuntimeFacts();
          if (nativeDsdOutputMatchesRequested(outputFormat, requested, nativeFacts) &&
              nativeActive->configure(outputFormat, startTimeSeconds, &nativeAttemptError)) {
            active = nativeActive;
            nativeDsdPath = true;
          } else {
            if (nativeAttemptError.empty()) {
              nativeAttemptError = nativeFacts.reason.empty()
                                       ? "ASIO runtime format did not match the requested Native DSD stream"
                                       : nativeFacts.reason;
            }
            attemptedNativeDsdFacts = buildNativeDsdAttemptFacts(requested, nativeFacts, nativeAttemptError);
            output->close();
            output.reset();
          }
        } else {
          attemptedNativeDsdFacts =
              buildNativeDsdAttemptFacts(requested, output->nativeDsdRuntimeFacts(), nativeAttemptError);
          output.reset();
        }
      }
    }
  };

  // True once the compatibility route actually carried the stream, so status can
  // report the real wire path instead of the configured intent.
  bool dsdRouteOverrideUsed = false;
  std::string dsdRouteOverrideError;

  if (canTryNativeDsd) {
    tryNativeDsdRoute(dsdBackendId, dsdDeviceId);
    if (active && dsdRouteActive) dsdRouteOverrideUsed = true;
    // The override device can be busy or unplugged. Unless the user asked for
    // strict passthrough, fall back to the main route before degrading to DoP.
    if (!active && dsdRouteRetriesMainRoute) {
      dsdRouteOverrideError = nativeAttemptError;
      nativeAttemptError.clear();
      if (shouldAttemptNativeDsdForCurrentConfig(
              requestedDspConfig, outputConfig, dsdProbe, requestedPlaybackVolume, backendId,
              graphProcessingActive)) {
        tryNativeDsdRoute(backendId, deviceId);
      }
      if (!active && nativeAttemptError.empty()) nativeAttemptError = dsdRouteOverrideError;
    }
  }

  const auto tryDopRoute = [&](const std::string& routeBackendId, const std::string& routeDeviceId) {
    auto dopActive = makeDecodeStream();
    if (dopActive->openDsdSource(item, &dopAttemptError)) {
      output = backendFactoryOverride() ? backendFactoryOverride()(routeBackendId)
                                        : createOutputBackend(routeBackendId);
      if (!output) {
        dopAttemptError = "请求的音频输出后端不可用：" + routeBackendId;
      } else if (!output->setOutputConfig(outputConfig, &dopAttemptError)) {
        output.reset();
      } else {
        AudioFormat requested =
            dopCarrierFormatForDsd(dsdProbe->dsdRate, dsdProbe->dsdSampleRate, dsdProbe->channelCount).value();
        requested.sampleFormat = AudioSampleFormat::Int24Interleaved;
        if (output->open(routeDeviceId, requested, &dopAttemptError)) {
          outputFormat = output->outputFormat();
          if (formatCanCarryDop(outputFormat, dsdProbe->dsdRate, dsdProbe->dsdSampleRate, dsdProbe->channelCount) &&
              dopActive->configure(outputFormat, startTimeSeconds, &dopAttemptError)) {
            active = dopActive;
            dopPath = true;
          } else {
            if (!formatCanCarryDop(outputFormat, dsdProbe->dsdRate, dsdProbe->dsdSampleRate, dsdProbe->channelCount)) {
              // The driver answered, but not with a DoP carrier. Record the
              // negotiated format so the fallback report names the concrete
              // blocker instead of a bare "could not prove passthrough".
              // Keep the "DoP carrier mismatch" prefix for the reason-code map.
              dopAttemptError = "DoP carrier mismatch: backend negotiated " +
                                sampleFormatToString(outputFormat.sampleFormat) + " " +
                                std::to_string(outputFormat.sampleRate) + " Hz x" +
                                std::to_string(outputFormat.channelCount) + " instead of int24 " +
                                std::to_string(requested.sampleRate) + " Hz x" +
                                std::to_string(requested.channelCount);
            } else if (dopAttemptError.empty()) {
              dopAttemptError = "DoP carrier negotiated but decoder configure failed";
            }
            output->close();
            output.reset();
          }
        } else {
          output.reset();
        }
      }
    }
  };

  if (canTryDop && !active) {
    tryDopRoute(dsdBackendId, dsdDeviceId);
    if (active && dsdRouteActive) dsdRouteOverrideUsed = true;
    if (!active && dsdRouteRetriesMainRoute) {
      const std::string overrideDopError = dopAttemptError;
      dopAttemptError.clear();
      if (shouldAttemptDopForCurrentConfig(
              requestedDspConfig, outputConfig, dsdProbe, requestedPlaybackVolume, backendId,
              graphProcessingActive)) {
        tryDopRoute(backendId, deviceId);
      }
      if (!active && dopAttemptError.empty()) dopAttemptError = overrideDopError;
    }
  }

  // Strict passthrough: the user explicitly asked never to degrade silently.
  // Report the real reason instead of opening a PCM stream behind their back.
  if (!active && dsdProbe.has_value() && dsdRoute.enabled && dsdRoute.strictPassthrough &&
      !dsdOutputModePrefersPcm(requestedDspConfig.dsdOutputMode)) {
    if (error) {
      const std::string detail = !nativeAttemptError.empty()
                                     ? nativeAttemptError
                                     : (!dopAttemptError.empty() ? dopAttemptError : "设备未确认 DSD 直通能力");
      *error = "DSD 严格直通模式：无法建立 DSD 直通输出（" + detail + "）";
    }
    return TAE_RESULT_BACKEND_UNAVAILABLE;
  }

  bool pcmToDsdPath = false;
  if (!active) {
    active = makeDecodeStream();
    if (!active->openSource(item, error)) {
      return TAE_RESULT_BACKEND_UNAVAILABLE;
    }

    AudioFormat requestedPcmFormat =
        active->stream.isDsd ? pcmFallbackRequestFormat(active->stream, dsdProbe) : active->stream.sourceFormat;

    // The graph's output stage is materialized by FFmpeg/libswresample before the
    // output backend opens. Native DSD and DoP stay untouched unless the manager
    // has already performed the explicit PCM-fallback transition.
    if (outputStageRequest.targetSampleRate > 0 &&
        (!active->stream.isDsd || outputStageRequest.dsdPcmFallbackApplied)) {
      requestedPcmFormat.sampleRate = outputStageRequest.targetSampleRate;
    }

    switch (outputConfig.routingMode) {
      case ChannelRoutingMode::MonoToStereo:
      case ChannelRoutingMode::Stereo:
        requestedPcmFormat.channelCount = 2;
        break;
      case ChannelRoutingMode::StereoTo51:
        requestedPcmFormat.channelCount = 6;
        break;
      case ChannelRoutingMode::StereoTo71:
        requestedPcmFormat.channelCount = 8;
        break;
      default:
        break;
    }

    const int pcmToDsdMultiplier =
        !active->stream.isDsd ? pcmToDsdModeRateMultiplier(outputConfig.pcmToDsdMode) : 0;
    const bool wantPcmToDsd = pcmToDsdMultiplier > 0 && requestedPcmFormat.sampleRate > 0 &&
                             requestedPcmFormat.channelCount > 0;

    // PCM->DSD upconversion is a DSD wire path, so it honors the compatibility
    // route when the user opted in. Plain PCM always stays on the main route.
    // Auto-discovery is triggered by a DSD source, so it never claims the
    // PCM->DSD upconversion path; that stays an explicit user opt-in.
    const bool pcmToDsdUsesOverride =
        wantPcmToDsd && dsdRouteActive && !dsdRouteAutoDiscovered && dsdRoute.applyToPcmToDsd;
    const std::string pcmStageBackendId = pcmToDsdUsesOverride ? dsdBackendId : backendId;
    const std::string pcmStageDeviceId = pcmToDsdUsesOverride ? dsdDeviceId : deviceId;

    const auto createPcmStageBackend = [&](const std::string& routeBackendId) -> bool {
      output = backendFactoryOverride() ? backendFactoryOverride()(routeBackendId)
                                        : createOutputBackend(routeBackendId);
      if (!output) {
        if (error) *error = "请求的音频输出后端不可用：" + routeBackendId;
        return false;
      }
      return output->setOutputConfig(outputConfig, error);
    };

    if (!createPcmStageBackend(pcmStageBackendId)) {
      return output ? TAE_RESULT_INVALID_ARGUMENT : TAE_RESULT_BACKEND_UNAVAILABLE;
    }

    if (wantPcmToDsd) {
      const int baseRate = (requestedPcmFormat.sampleRate % 48000 == 0) ? 48000 : 44100;
      const int dsdSampleRate = baseRate * pcmToDsdMultiplier;
      AudioFormat requestedNativeDsd;
      requestedNativeDsd.sampleRate = dsdSampleRate;
      requestedNativeDsd.channelCount = requestedPcmFormat.channelCount;
      requestedNativeDsd.bitDepth = 1;
      requestedNativeDsd.sampleFormat = AudioSampleFormat::DsdInt8Msb1;

      std::string pcmToDsdError;
      bool opened = false;
      if (backendCanAttemptNativeDsd(pcmStageBackendId) &&
          output->open(pcmStageDeviceId, requestedNativeDsd, &pcmToDsdError)) {
        outputFormat = output->outputFormat();
        const NativeDsdRuntimeFacts nativeFacts = output->nativeDsdRuntimeFacts();
        if (nativeDsdOutputMatchesRequested(outputFormat, requestedNativeDsd, nativeFacts) &&
            !nativeDsdRuntimeFactsRequirePcmFallback(nativeFacts)) {
          opened = true;
          nativeDsdPath = true;
          pcmToDsdPath = true;
        } else {
          output->close();
        }
      }
      if (!opened) {
        const auto dopCarrier =
            dopCarrierFormatForDsd(pcmToDsdMultiplier, dsdSampleRate, requestedPcmFormat.channelCount);
        if (dopCarrier.has_value() && backendCanAttemptDop(pcmStageBackendId)) {
          AudioFormat requestedDop = *dopCarrier;
          requestedDop.sampleFormat = AudioSampleFormat::Int24Interleaved;
          if (output->open(pcmStageDeviceId, requestedDop, &pcmToDsdError)) {
            outputFormat = output->outputFormat();
            if (formatCanCarryDop(
                    outputFormat, pcmToDsdMultiplier, dsdSampleRate, requestedPcmFormat.channelCount)) {
              opened = true;
              dopPath = true;
              pcmToDsdPath = true;
            } else {
              output->close();
            }
          }
        }
      }
      if (!opened) {
        // Fall through to ordinary PCM open when the device cannot take DSD/DoP.
        pcmToDsdPath = false;
        nativeDsdPath = false;
        dopPath = false;
        // Plain PCM must never be pushed through the compatibility route; the
        // proxy device exists only to carry DSD. Rebuild on the main backend.
        if (pcmToDsdUsesOverride && pcmStageBackendId != backendId) {
          output.reset();
          if (!createPcmStageBackend(backendId)) {
            return output ? TAE_RESULT_INVALID_ARGUMENT : TAE_RESULT_BACKEND_UNAVAILABLE;
          }
        }
      } else if (pcmToDsdUsesOverride) {
        dsdRouteOverrideUsed = true;
      }
    }

    if (!pcmToDsdPath) {
      if (!output->open(deviceId, requestedPcmFormat, error)) {
        return TAE_RESULT_BACKEND_UNAVAILABLE;
      }
      outputFormat = output->outputFormat();
    }

    // A 24-bit source and a 24-in-32 wire format hold the same significant bits,
    // so the decoder can fill the device buffer directly. Requiring an identical
    // sample-format enum here sent every 24-bit track through Float32 on devices
    // that only accept the 32-bit container.
    const bool canUseTypedPassthrough =
        !pcmToDsdPath && !active->stream.isDsd && !processingRequiresPcm &&
        backendCanTypedPassthrough(backendId) && formatCanTypedPassthrough(active->stream.sourceFormat) &&
        pcmFormatsSemanticallyMatch(active->stream.sourceFormat, outputFormat);
    AudioFormat decodeFormat = pcmToDsdPath ? requestedPcmFormat : outputFormat;
    if (pcmToDsdPath) {
      decodeFormat.sampleFormat = AudioSampleFormat::Float32Interleaved;
      decodeFormat.bitDepth = 32;
    }
    if (outputConfig.routingMode != ChannelRoutingMode::Auto) {
      decodeFormat.channelCount = std::max(1, active->stream.sourceFormat.channelCount);
    }

    active->setResamplerQuality(
        outputStageRequest.targetSampleRate > 0 ? outputStageRequest.resamplerQuality : requestedDspConfig.resamplerQuality);
    if (!active->configure(decodeFormat, startTimeSeconds, error, canUseTypedPassthrough)) {
      output->close();
      return TAE_RESULT_INTERNAL_ERROR;
    }

    if (pcmToDsdPath) {
      PcmToDsdModulatorConfig modulatorConfig;
      modulatorConfig.inputSampleRate = decodeFormat.sampleRate;
      modulatorConfig.channelCount = decodeFormat.channelCount;
      modulatorConfig.targetDsdRate = pcmToDsdMultiplier;
      modulatorConfig.bitOrder = DsdBitOrder::MsbFirst;
      std::string modulatorError;
      if (!pcmToDsdModulator_.configure(modulatorConfig, &modulatorError)) {
        if (error) *error = modulatorError.empty() ? "PCM to DSD modulator configure failed" : modulatorError;
        output->close();
        return TAE_RESULT_INTERNAL_ERROR;
      }
      if (dopPath) {
        DopPackerConfig dopConfig;
        dopConfig.channelCount = decodeFormat.channelCount;
        dopConfig.dsdRate = pcmToDsdMultiplier;
        dopConfig.sourceSampleRate = pcmToDsdModulator_.dsdSampleRate();
        dopConfig.bitOrder = DsdBitOrder::MsbFirst;
        // process() writes per-channel planar bytes matching DSF planar blocks.
        dopConfig.packing = DsdPacking::DsfPlanarBlocks;
        dopConfig.outputFormat = outputFormat.sampleFormat;
        if (!pcmToDsdDopPacker_.configure(dopConfig, error)) {
          output->close();
          return TAE_RESULT_INTERNAL_ERROR;
        }
      }
      active->stream.dsdMode = nativeDsdPath ? DsdMode::Native : DsdMode::Dop;
      active->stream.isDsd = true;
      active->stream.dsdRate = pcmToDsdMultiplier;
      active->stream.decodedFormat = decodeFormat;
    }

    if (active->stream.isDsd && !pcmToDsdPath) {
      active->stream.dsdMode = DsdMode::Pcm;
      dopAttemptError = determineDsdPcmFallbackReason(
          requestedDspConfig,
          outputConfig,
          active->stream,
          requestedPlaybackVolume,
          backendId,
          forcedDsdFallbackReason.empty()
              // DoP is the last route tried; its error names the actionable
              // blocker, while a stale native-DSD error would mislead the
              // report when DoP failed too.
              ? (!dopAttemptError.empty() ? dopAttemptError : nativeAttemptError)
              : forcedDsdFallbackReason,
          dsdOutputModeRequestsDop(requestedDspConfig.dsdOutputMode),
          graphProcessingActive);
      if (!dsdProbe.has_value() && !dsdProbeError.empty()) {
        // Without the probe both DSD routes were skipped before any backend was
        // asked, so this is the only record of why passthrough never happened.
        dopAttemptError += " (DSD probe failed: " + dsdProbeError + ")";
      }
      DiagnosticLog::instance().append(DiagLevel::Warning, "dsd_pcm_fallback", dopAttemptError,
                                       "{\"backend\":\"" + json_utils::escape(backendId) +
                                           "\",\"dsdRate\":" +
                                           std::to_string(active->stream.dsdRate) + "}");
    }
  }

  if (dopPath) {
    const DopRuntimeFacts dopFacts = output->dopRuntimeFacts();
    if (dopRuntimeFactsRejectBeforeStart(dopFacts)) {
      const std::string fallbackReason = dopPcmFallbackReason(dopFacts);
      output->close();
      return playInternal(
          item,
          upcomingItem,
          startTimeSeconds,
          backendId,
          deviceId,
          requestedPlaybackVolume,
          dspConfigJson,
          gaplessEnabled,
          false,
          false,
          fallbackReason,
          attemptedNativeDsdFacts,
          error);
    }
  }

  if (nativeDsdPath) {
    const NativeDsdRuntimeFacts nativeFacts = output->nativeDsdRuntimeFacts();
    if (nativeDsdRuntimeFactsRequirePcmFallback(nativeFacts)) {
      const std::string fallbackReason = nativeDsdPcmFallbackReason(nativeFacts);
      attemptedNativeDsdFacts = nativeFacts;
      output->close();
      return playInternal(
          item,
          upcomingItem,
          startTimeSeconds,
          backendId,
          deviceId,
          volume,
          dspConfigJson,
          gaplessEnabled,
          false,
          true,
          fallbackReason,
          attemptedNativeDsdFacts,
          error);
    }
  }

  {
    std::lock_guard lock(mutex_);
    output_ = std::move(output);
    activeStream_ = active;
    preloadStream_.reset();
    stream_ = activeStream_->stream;
    outputFormat_ = outputFormat;
    decodeFormat_ = activeStream_->bufferFormat().sampleRate > 0 ? activeStream_->bufferFormat() : outputFormat;
    if (pcmToDsdPath) {
      // Modulator consumes float decode frames; keep DSP/decode on PCM rate/layout.
      decodeFormat_ = activeStream_->stream.decodedFormat.sampleRate > 0
                          ? activeStream_->stream.decodedFormat
                          : activeStream_->bufferFormat();
    }
    if (outputConfig.routingMode != ChannelRoutingMode::Auto && !pcmToDsdPath) {
      decodeFormat_.channelCount = std::max(1, stream_.sourceFormat.channelCount);
    }
    // Allocate routing state before the callback starts. Runtime route changes
    // are delivered through the SPSC queue and do not resize these buffers.
    channelRouter_.setUpmixConfig(upmixConfigFromOutputConfig(outputConfig));
    channelRouter_.prepareForRealtime(std::max(1, decodeFormat_.sampleRate), 1000.0f);
    channelRouter_.reset();
    currentItem_ = item;
    backendId_ = backendId == "wasapi-shared" ? "wasapi" : backendId;
    deviceId_ = deviceId;
    deviceName_ = output_->deviceName();
    outputInfo_ = output_->outputInfo();
    outputInfo_.backend = backendId_;
    outputInfo_.deviceName = deviceName_;
    if (activeStream_->stream.isDsd) {
      const DsdStreamInfo sourceDsd = activeStream_->dsdReader
                                          ? activeStream_->dsdReader->streamInfo()
                                          : DsdStreamInfo{};
      outputInfo_.diagnostics.dsdTransport = dopPath ? "dop" : (nativeDsdPath ? "native" : "pcm");
      outputInfo_.diagnostics.dsdRouteOverrideActive = dsdRouteOverrideUsed;
      if (dsdRouteOverrideUsed) {
        outputInfo_.diagnostics.dsdRouteBackend = dsdBackendId;
        outputInfo_.diagnostics.dsdRouteDevice = dsdDeviceId;
      }
      if (dsdRouteActive && !dsdRouteOverrideUsed && !dsdRouteOverrideError.empty()) {
        outputInfo_.diagnostics.dsdRouteFallbackReason = dsdRouteOverrideError;
      }
      outputInfo_.diagnostics.dsdSourceBitOrder =
          sourceDsd.bitOrder == DsdBitOrder::MsbFirst ? "msb-first" : "lsb-first";
      outputInfo_.diagnostics.dsdSourcePacking =
          sourceDsd.packing == DsdPacking::DsfPlanarBlocks ? "dsf-planar-blocks" : "dff-interleaved";
      outputInfo_.diagnostics.requestedWireFormat = sampleFormatToString(outputFormat_.sampleFormat);
      outputInfo_.diagnostics.actualWireFormat = outputInfo_.actualOutputFormat;
      outputInfo_.diagnostics.containerBits = static_cast<int>(audioSampleFormatBytes(outputFormat_.sampleFormat) * 8);
      outputInfo_.diagnostics.validBits = effectivePcmBitDepth(outputFormat_);
      outputInfo_.diagnostics.blockAlign = static_cast<int>(audioFormatBytesPerFrame(outputFormat_));
      outputInfo_.diagnostics.semanticSampleRate = sourceDsd.dsdSampleRate;
      // Preserve the backend's transport rate. Native DSD uses one ASIO
      // element per 8 DSD bits, so its callback rate is DSD bit-clock / 8;
      // the backend has already recorded that distinction. Only derive a
      // value when an older/non-ASIO backend did not provide one.
      if (outputInfo_.diagnostics.transportSampleRate <= 0) {
        outputInfo_.diagnostics.transportSampleRate =
            nativeDsdPath && outputFormat_.sampleRate % 8 == 0 ? outputFormat_.sampleRate / 8
                                                               : outputFormat_.sampleRate;
      }
      outputInfo_.diagnostics.typedRawPath = dopPath || nativeDsdPath;
      outputInfo_.diagnostics.processingBypassed = dopPath || nativeDsdPath;
    } else if (pcmToDsdPath) {
      // PCM->DSD upconversion: the source is PCM, so the DSD branch above is
      // skipped, but the wire path is still DSD and may use the override route.
      outputInfo_.diagnostics.dsdRouteOverrideActive = dsdRouteOverrideUsed;
      if (dsdRouteOverrideUsed) {
        outputInfo_.diagnostics.dsdRouteBackend = dsdBackendId;
        outputInfo_.diagnostics.dsdRouteDevice = dsdDeviceId;
      }
    } else {
      // Plain PCM: only the pipeline knows whether the decoder's integer samples
      // reach the device untouched, so the backend cannot report this on its own.
      outputInfo_.diagnostics.typedRawPath = activeStream_->typedPassthrough;
      outputInfo_.diagnostics.processingBypassed = activeStream_->typedPassthrough;
      // A hi-rate 24-bit request is wire-identical to a DoP carrier, so a
      // backend that sniffs the carrier shape labels plain PCM as a DSD
      // transport. The pipeline owns the truth: this stream has no DSD source.
      outputInfo_.diagnostics.dsdTransport = "pcm";
      outputInfo_.diagnostics.semanticSampleRate = outputFormat_.sampleRate;
      outputInfo_.diagnostics.transportSampleRate = outputFormat_.sampleRate;
      if (pcmFormatsSemanticallyMatch(activeStream_->stream.sourceFormat, outputFormat_)) {
        outputInfo_.resampled = false;
        if (outputInfo_.perfectReasonCode == "dsd_dop") {
          outputInfo_.perfectReasonCode.clear();
          outputInfo_.perfectReason.clear();
        }
      }
    }
    nativeDsdFallbackFacts_ =
        activeStream_->stream.isDsd && activeStream_->stream.dsdMode != DsdMode::Native &&
                attemptedNativeDsdFacts.has_value()
            ? attemptedNativeDsdFacts
            : std::nullopt;
    dsdFallbackReason_ =
        (!dopAttemptError.empty() && activeStream_->stream.isDsd && activeStream_->stream.dsdMode == DsdMode::Pcm &&
         !pcmToDsdPath)
            ? dopAttemptError
            : "";
    if (!dsdFallbackReason_.empty()) {
      outputInfo_.perfectReason = dopAttemptError;
    }
    dspConfig_ = requestedDspConfig;
    dspChain_->configure(dspConfig_);
    dspConfig_ = dspChain_->config();
    dspChain_->prepare(decodeFormat_);
    dspChain_->setTrackContext(DspTrackContext{stream_, currentItem_});
    preloadDspChain_->configure(dspConfig_);
    preloadDspChain_->prepare(decodeFormat_);
    preloadDspChain_->setTrackContext(DspTrackContext{stream_, currentItem_});
    if (!dspGraphJson_.empty()) {
      std::string graphError;
      if (!dspChain_->configureGraphJson(dspGraphJson_, &graphError) && error && error->empty()) {
        *error = graphError.empty() ? "Failed to compile DSP graph" : graphError;
      }
      std::string preloadGraphError;
      if (!preloadDspChain_->configureGraphJson(dspGraphJson_, &preloadGraphError) && error && error->empty()) {
        *error = preloadGraphError.empty() ? "Failed to compile preload DSP graph" : preloadGraphError;
      }
      dspConfig_ = dspChain_->config();
    }
    dspStatus_ = dspChain_->status();
    dspActive_ = dspStatus_.dspActive || std::abs(requestedPlaybackVolume - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
    spectrum_.prepare(decodeFormat_, visualizationFftResolutionForConfig(dspConfig_.fftResolution));
    spectrum_.setEnabled(dspConfig_.fftEnabled);
    gaplessEnabled_ =
        gaplessEnabled && !dopPath && !nativeDsdPath && !pcmToDsdPath && !activeStream_->typedPassthrough;
    dopPathActive_ = dopPath;
    nativeDsdPathActive_ = nativeDsdPath;
    pcmToDsdPathActive_ = pcmToDsdPath;
    typedPassthroughActive_ = pcmToDsdPath || activeStream_->typedPassthrough;
    activeUsesPreloadDspChain_ = false;
    const size_t maxRenderFrames = outputInfo_.bufferSizeFrames > 0
                                       ? static_cast<size_t>(outputInfo_.bufferSizeFrames)
                                       : static_cast<size_t>(std::max(1, std::max(1, decodeFormat_.sampleRate) / 100));
    if (pcmToDsdPathActive_) {
      const size_t channels = static_cast<size_t>(std::max(1, decodeFormat_.channelCount));
      pcmToDsdFloatScratch_.assign(maxRenderFrames * channels, 0.0f);
      const size_t bytesPerChannel = pcmToDsdModulator_.outputBytesPerChannel(maxRenderFrames);
      pcmToDsdPlanarBytes_.assign(bytesPerChannel * channels, 0);
      pcmToDsdChannelPtrs_.resize(channels);
      for (size_t channel = 0; channel < channels; ++channel) {
        pcmToDsdChannelPtrs_[channel] = pcmToDsdPlanarBytes_.data() + channel * bytesPerChannel;
      }
      pcmToDsdInterleavedBytes_.clear();
      pcmToDsdModulator_.reset();
      if (dopPathActive_) pcmToDsdDopPacker_.reset();
    }
    prepareRenderScratchLocked(maxRenderFrames);
    if (activeStream_) activeStream_->prepareFloatReadScratch(maxRenderFrames);
    if (preloadStream_) preloadStream_->prepareFloatReadScratch(maxRenderFrames);
    publishedActiveDspGraph_ = nullptr;
    publishedPreloadDspGraph_ = nullptr;
    renderDspGraphs_.clear();
    std::string renderDspError;
    if (!publishPreparedRenderDspGraphsLocked(0, &renderDspError) && error && error->empty()) {
      *error = renderDspError.empty() ? "Failed to prepare realtime DSP graph" : renderDspError;
    }
    updatePerfectLocked();
    state_ = PipelineState::Playing;
    const double boundedStartTime = activeStream_->clampRelativePosition(startTimeSeconds);
    renderedFrames_ = static_cast<uint64_t>(
        boundedStartTime * static_cast<double>(positionSampleRateForStream(stream_, outputFormat_)));
    renderDopMarkerIndex_ = 0;
    renderVolumeCurrentBits_.store(doubleBits(-1.0), std::memory_order_relaxed);
    resetRateResampler();
    ended_ = false;
    deviceInvalidated_ = false;
    trackStarted_ = false;
    outputEventMessage_.clear();
    preloadDspStatus_ = preloadDspChain_->status();
    renderChannelCount_ = std::max(1, outputFormat_.channelCount);
    renderOutputFormat_ = outputFormat_;
    renderDecodeFormat_ = decodeFormat_;
    renderActiveStream_.store(activeStream_.get(), std::memory_order_release);
    renderPreloadStream_.store(nullptr, std::memory_order_release);
    renderGaplessEnabled_.store(gaplessEnabled_, std::memory_order_release);
    renderDopPathActive_.store(dopPathActive_, std::memory_order_release);
    renderNativeDsdPathActive_.store(nativeDsdPathActive_, std::memory_order_release);
    renderPcmToDsdPathActive_.store(pcmToDsdPathActive_, std::memory_order_release);
    renderTypedPassthroughActive_.store(typedPassthroughActive_, std::memory_order_release);
    renderActiveUsesPreloadDspChain_.store(false, std::memory_order_release);
    renderPromotionPending_.store(false, std::memory_order_release);
    renderCrossfadeResetRequested_.store(false, std::memory_order_release);
    renderDitherMode_.store(static_cast<uint32_t>(dspConfig_.ditherMode), std::memory_order_release);
    renderDitherResetRequested_.store(true, std::memory_order_release);
    renderRoutingMode_.store(static_cast<uint32_t>(outputConfig_.routingMode), std::memory_order_release);
    storeAtomicDouble(renderCrossfadeSecondsBits_, dspConfig_.crossfadeSeconds, std::memory_order_release);
    renderCrossfadeMixActive_ = false;
    renderCrossfadeFramesProcessed_ = 0;
    renderCrossfadeTotalFrames_ = 0;
    renderState_.store(PipelineState::Playing, std::memory_order_release);
    publishStatusLocked();
  }

  const size_t prerollFrames = outputInfo_.bufferSizeFrames > 0
                                   ? static_cast<size_t>(outputInfo_.bufferSizeFrames)
                                   : static_cast<size_t>(std::max(1, outputFormat_.sampleRate / 100));
  active->start();
  active->waitForPreroll(prerollFrames, std::chrono::milliseconds(500));
  if (gaplessEnabled && !dopPath && !nativeDsdPath && !pcmToDsdPath && !active->typedPassthrough) {
    std::string preloadError;
    preloadNext(upcomingItem, &preloadError);
  }

  auto eventCallback = [this](OutputBackendEvent event, const std::string& message) {
    std::lock_guard lock(mutex_);
    outputEventMessage_ = message;
    if (event == OutputBackendEvent::DeviceInvalidated) {
      deviceInvalidated_ = true;
    } else if (event == OutputBackendEvent::RenderError) {
      renderError_ = true;
    }
    state_ = PipelineState::Stopped;
    renderState_.store(PipelineState::Stopped, std::memory_order_release);
  };

  if (!output_->startTyped(
          [this](PcmBlock& block) { return renderTyped(block); },
          [this](float* data, size_t frames) { return render(data, frames); },
          eventCallback,
          error)) {
    stop();
    return TAE_RESULT_BACKEND_UNAVAILABLE;
  }

  if (dopPath) {
    DopRuntimeFacts dopFacts = output_->dopRuntimeFacts();
    if (dopFacts.state == DopRuntimeFactState::Candidate) {
      // Drivers that do not expose their negotiated runtime format (so the
      // backend could only report a Candidate) prove the carrier through the
      // DoP marker check, which happens in the first typed buffers on the
      // render thread. Give that check a short window before condemning the
      // path to PCM, otherwise every such driver falls back instantly.
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
      while (dopFacts.state == DopRuntimeFactState::Candidate && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        dopFacts = output_->dopRuntimeFacts();
      }
    }
    if (dopRuntimeFactsRequirePcmFallback(dopFacts)) {
      const std::string fallbackReason = dopPcmFallbackReason(dopFacts);
      stop();
      return playInternal(
          item,
          upcomingItem,
          startTimeSeconds,
          backendId,
          deviceId,
          requestedPlaybackVolume,
          dspConfigJson,
          gaplessEnabled,
          false,
          false,
          fallbackReason,
          attemptedNativeDsdFacts,
          error);
    }
  }

  if (nativeDsdPath) {
    const NativeDsdRuntimeFacts nativeFacts = output_->nativeDsdRuntimeFacts();
    if (nativeDsdRuntimeFactsRequirePcmFallback(nativeFacts)) {
      const std::string fallbackReason = nativeDsdPcmFallbackReason(nativeFacts);
      attemptedNativeDsdFacts = nativeFacts;
      stop();
      return playInternal(
          item,
          upcomingItem,
          startTimeSeconds,
          backendId,
          deviceId,
          requestedPlaybackVolume,
          dspConfigJson,
          gaplessEnabled,
          false,
          true,
          fallbackReason,
          attemptedNativeDsdFacts,
          error);
    }
  }

  {
    std::lock_guard lock(mutex_);
    // Re-reading the backend picks up post-start runtime facts, but it also
    // resets diagnostics the backend cannot know. The compatibility route is
    // decided here in the pipeline, so carry those four fields across.
    const bool routeOverrideActive = outputInfo_.diagnostics.dsdRouteOverrideActive;
    const std::string routeBackend = outputInfo_.diagnostics.dsdRouteBackend;
    const std::string routeDevice = outputInfo_.diagnostics.dsdRouteDevice;
    const std::string routeFallbackReason = outputInfo_.diagnostics.dsdRouteFallbackReason;
    outputFormat_ = output_->outputFormat();
    outputInfo_ = output_->outputInfo();
    outputInfo_.backend = backendId_;
    outputInfo_.deviceName = deviceName_;
    outputInfo_.diagnostics.dsdRouteOverrideActive = routeOverrideActive;
    outputInfo_.diagnostics.dsdRouteBackend = routeBackend;
    outputInfo_.diagnostics.dsdRouteDevice = routeDevice;
    outputInfo_.diagnostics.dsdRouteFallbackReason = routeFallbackReason;
    updatePerfectLocked();
  }

  if (nativeDsdPath || dopPath || pcmToDsdPath) {
    const char* mode = nativeDsdPath ? "native" : (dopPath ? "dop" : "pcm-to-dsd");
    DiagnosticLog::instance().append(
        DiagLevel::Info, "dsd_route_engaged",
        "mode=" + std::string(mode) + " backend=" + backendId_ + " device=" + deviceName_ +
            " rate=" + std::to_string(outputFormat_.sampleRate),
        "{\"mode\":\"" + std::string(mode) + "\",\"backend\":\"" + json_utils::escape(backendId_) +
            "\",\"sampleRate\":" + std::to_string(outputFormat_.sampleRate) +
            ",\"channels\":" + std::to_string(outputFormat_.channelCount) + "}");
  }

  return TAE_RESULT_OK;
}

bool AudioPipeline::shouldAttemptDopForCurrentConfig(
    const DspConfig& dspConfig,
    const OutputConfig& outputConfig,
    const std::optional<DsdStreamInfo>& dsdProbe,
    double volume,
    const std::string& backendId,
    std::optional<bool> graphProcessingActive) const {
  if (!dsdProbe.has_value()) return false;
  if (!dsdOutputModeRequestsDop(dspConfig.dsdOutputMode)) return false;
  const double playbackRate = loadAtomicDouble(requestedPlaybackRateBits_);
  if (dspConfigProcessingRequiresPcm(dspConfig, outputConfig, volume, playbackRate, graphProcessingActive)) {
    return false;
  }
  if (!backendCanAttemptDop(backendId)) return false;
  return dopCarrierFormatForDsd(dsdProbe->dsdRate, dsdProbe->dsdSampleRate, dsdProbe->channelCount).has_value();
}

bool AudioPipeline::shouldAttemptNativeDsdForCurrentConfig(
    const DspConfig& dspConfig,
    const OutputConfig& outputConfig,
    const std::optional<DsdStreamInfo>& dsdProbe,
    double volume,
    const std::string& backendId,
    std::optional<bool> graphProcessingActive) const {
  if (!dsdProbe.has_value()) return false;
  if (!dsdOutputModeRequestsNative(dspConfig.dsdOutputMode)) return false;
  const double playbackRate = loadAtomicDouble(requestedPlaybackRateBits_);
  if (dspConfigProcessingRequiresPcm(dspConfig, outputConfig, volume, playbackRate, graphProcessingActive)) {
    return false;
  }
  if (!backendCanAttemptNativeDsd(backendId)) return false;
  return dsdProbe->dsdRate == 64 || dsdProbe->dsdRate == 128 || dsdProbe->dsdRate == 256 ||
         dsdProbe->dsdRate == 512;
}

std::string AudioPipeline::determineDsdPcmFallbackReason(
    const DspConfig& dspConfig,
    const OutputConfig& outputConfig,
    const AudioStreamInfo& stream,
    double volume,
    const std::string& backendId,
    const std::string& attemptedDopReason,
    bool dopModeRequested,
    std::optional<bool> graphProcessingActive) const {
  const double playbackRate = loadAtomicDouble(requestedPlaybackRateBits_);
  if (dspConfigProcessingRequiresPcm(dspConfig, outputConfig, volume, playbackRate, graphProcessingActive)) {
    return "DSD processing active; falling back to PCM";
  }
  if (dspConfig.dsdOutputMode == DsdOutputMode::Pcm) return "DSD output mode forced PCM";
  if (!attemptedDopReason.empty()) return attemptedDopReason;
  if (dsdRouteOverrideTargetsDistinctRoute(dspConfig.dsdRoute)) {
    return "DSD 兼容层路由未能建立直通输出，已回退 PCM";
  }
  // Neither route was attempted because the backend itself cannot carry DSD
  // (e.g. WASAPI shared mode); an "unproven DoP" message would point at the
  // transport instead of the output mode.
  if (dopModeRequested && !backendCanAttemptDop(backendId) && !backendCanAttemptNativeDsd(backendId)) {
    return "Current output backend cannot carry DSD or DoP";
  }
  if (dspConfig.dsdOutputMode == DsdOutputMode::Native) return "ASIO Native DSD could not prove raw DSD output";
  if (stream.dsdRate >= 256) {
    return "DSD" + std::to_string(stream.dsdRate) + " currently falls back to PCM";
  }
  if (dopModeRequested) return "DoP backend could not prove passthrough";
  return "DSD converted to PCM";
}

TAE_Result AudioPipeline::togglePause() {
  std::lock_guard lock(mutex_);
  if (state_ == PipelineState::Playing) {
    state_ = PipelineState::Paused;
    renderState_.store(PipelineState::Paused, std::memory_order_release);
    spectrum_.resetCapture();
  } else if (state_ == PipelineState::Paused) {
    state_ = PipelineState::Playing;
    renderState_.store(PipelineState::Playing, std::memory_order_release);
  }
  publishStatusLocked();
  return TAE_RESULT_OK;
}

TAE_Result AudioPipeline::stop() {
  std::lock_guard<std::recursive_mutex> transportLock(transportMutex_);
  return stopUnlocked();
}

TAE_Result AudioPipeline::stopUnlocked() {
  std::unique_ptr<IOutputBackend> output;
  std::shared_ptr<DecodeStream> active;
  std::shared_ptr<DecodeStream> preload;
  std::array<std::shared_ptr<DecodeStream>, kRetiredStreamSlots> retired;
  std::vector<std::shared_ptr<DecodeStream>> deferred;
  size_t retiredCount = 0;
  {
    std::lock_guard lock(mutex_);
    state_ = PipelineState::Stopped;
    renderState_.store(PipelineState::Stopped, std::memory_order_release);
    output = std::move(output_);
    active = std::move(activeStream_);
    preload = std::move(preloadStream_);
    retiredCount = retiredStreamCount_;
    for (size_t i = 0; i < retiredCount; ++i) {
      retired[i] = std::move(retiredStreams_[i]);
    }
    retiredStreamCount_ = 0;
    deferred.swap(deferredRetiredStreams_);
  }

  if (output) {
    output->stop();
    output->close();
  }
  if (active) active->stop();
  if (preload) preload->stop();
  for (size_t i = 0; i < retiredCount; ++i) {
    if (retired[i]) retired[i]->stop();
  }
  for (const auto& stream : deferred) {
    if (stream) stream->stop();
  }

  {
    std::lock_guard lock(mutex_);
    stream_ = {};
    outputFormat_ = {};
    currentItem_ = {};
    backendId_.clear();
    deviceId_.clear();
    deviceName_.clear();
    perfectReason_.clear();
    dsdFallbackReason_.clear();
    nativeDsdFallbackFacts_.reset();
    outputInfo_ = {};
    renderChannelCount_ = 2;
    renderOutputFormat_ = {};
    renderDecodeFormat_ = {};
    renderActiveStream_.store(nullptr, std::memory_order_release);
    renderPreloadStream_.store(nullptr, std::memory_order_release);
    renderGaplessEnabled_.store(true, std::memory_order_release);
    renderDopPathActive_.store(false, std::memory_order_release);
    renderNativeDsdPathActive_.store(false, std::memory_order_release);
    renderPcmToDsdPathActive_.store(false, std::memory_order_release);
    renderTypedPassthroughActive_.store(false, std::memory_order_release);
    renderActiveUsesPreloadDspChain_.store(false, std::memory_order_release);
    renderPromotionPending_.store(false, std::memory_order_release);
    renderCrossfadeResetRequested_.store(false, std::memory_order_release);
    renderDitherMode_.store(static_cast<uint32_t>(DspDitherMode::Off), std::memory_order_release);
    renderDitherResetRequested_.store(true, std::memory_order_release);
    renderRoutingMode_.store(static_cast<uint32_t>(ChannelRoutingMode::Auto), std::memory_order_release);
    storeAtomicDouble(renderCrossfadeSecondsBits_, 0.0, std::memory_order_release);
    renderCrossfadeMixActive_ = false;
    renderCrossfadeFramesProcessed_ = 0;
    renderCrossfadeTotalFrames_ = 0;
    renderedFrames_ = 0;
    renderVolumeCurrentBits_.store(doubleBits(-1.0), std::memory_order_relaxed);
    resetRateResampler();
    ended_ = false;
    deviceInvalidated_ = false;
    trackStarted_ = false;
    outputEventMessage_.clear();
    dspStatus_ = {};
    dspConfig_ = {};
    dspActive_ = false;
    outputPerfect_ = false;
    gaplessEnabled_ = true;
    dopPathActive_ = false;
    nativeDsdPathActive_ = false;
    pcmToDsdPathActive_ = false;
    typedPassthroughActive_ = false;
    pcmToDsdFloatScratch_.clear();
    pcmToDsdPlanarBytes_.clear();
    pcmToDsdInterleavedBytes_.clear();
    pcmToDsdChannelPtrs_.clear();
    activeUsesPreloadDspChain_ = false;
    crossfadeMixActive_ = false;
    crossfadeFramesProcessed_ = 0;
    crossfadeTotalFrames_ = 0;
    preloadDspStatus_ = {};
    renderActiveDspGraph_.store(nullptr, std::memory_order_release);
    renderPreloadDspGraph_.store(nullptr, std::memory_order_release);
    publishedActiveDspGraph_ = nullptr;
    publishedPreloadDspGraph_ = nullptr;
    renderDspGraphs_.clear();
    spectrum_.resetCapture();
    publishStatusLocked();
  }
  return TAE_RESULT_OK;
}

TAE_Result AudioPipeline::seek(double seconds, std::string* error) {
  std::shared_ptr<DecodeStream> active;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    if (!activeStream_ || outputFormat_.sampleRate <= 0) return TAE_RESULT_NOT_INITIALIZED;
    active = activeStream_;
  }

  const double boundedSeconds = active->clampRelativePosition(seconds);
  if (!active->seek(boundedSeconds, error)) return TAE_RESULT_INTERNAL_ERROR;

  {
    std::lock_guard lock(mutex_);
    renderedFrames_ = static_cast<uint64_t>(
        boundedSeconds * static_cast<double>(positionSampleRateForStream(stream_, outputFormat_)));
    // DecodeStream::seek() resets the decoder-side packer. Publish the matching
    // render-side reset only after the seek succeeds so the next carrier frame
    // starts at canonical marker 0x05 without a control/render data race.
    renderDopMarkerResetRequested_.store(true, std::memory_order_release);
    resetRateResampler();
    ended_ = false;
    DspChain& activeDspChain = activeDspChainLocked();
    activeDspChain.setTrackContext(DspTrackContext{stream_, currentItem_});
    dspStatus_ = activeDspChain.status();
    dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
    updatePerfectLocked();
    publishStatusLocked();
  }
  return TAE_RESULT_OK;
}

void AudioPipeline::setVolume(double volume) {
  const double requested = std::clamp(volume, 0.0, 1.0);
  storeAtomicDouble(requestedVolumeBits_, requested, std::memory_order_release);
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  ControlCommand command;
  command.type = ControlCommandType::Volume;
  command.volume = requested;
  // Snapshot companion field so shared overflow slot never reverts the other control.
  command.playbackRate = loadAtomicDouble(requestedPlaybackRateBits_, std::memory_order_acquire);
  command.revision = revision;
  enqueueControlCommand(command);
}

void AudioPipeline::setPlaybackRate(double rate) {
  const double requested = std::clamp(rate, 0.5, 2.0);
  storeAtomicDouble(requestedPlaybackRateBits_, requested, std::memory_order_release);
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  ControlCommand command;
  command.type = ControlCommandType::PlaybackRate;
  command.playbackRate = requested;
  // Snapshot companion field so shared overflow slot never reverts the other control.
  command.volume = loadAtomicDouble(requestedVolumeBits_, std::memory_order_acquire);
  command.revision = revision;
  enqueueControlCommand(command);
}

void AudioPipeline::setLoopRange(double startSeconds, double endSeconds) {
  if (!std::isfinite(startSeconds) || !std::isfinite(endSeconds) || endSeconds <= startSeconds ||
      startSeconds < 0.0) {
    clearLoopRange();
    return;
  }
  storeAtomicDouble(loopStartBits_, startSeconds, std::memory_order_release);
  storeAtomicDouble(loopEndBits_, endSeconds, std::memory_order_release);
  loopEnabled_.store(true, std::memory_order_release);
}

void AudioPipeline::clearLoopRange() {
  loopEnabled_.store(false, std::memory_order_release);
  storeAtomicDouble(loopStartBits_, 0.0, std::memory_order_release);
  storeAtomicDouble(loopEndBits_, 0.0, std::memory_order_release);
}

bool AudioPipeline::enforceLoopRange(std::string* error) {
  if (!loopEnabled_.load(std::memory_order_acquire)) return false;
  // Re-entrancy guard: seek itself must not re-enter enforcement.
  bool expected = false;
  if (!loopEnforceBusy_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
    return false;
  }
  struct BusyGuard {
    std::atomic<bool>& flag;
    ~BusyGuard() { flag.store(false, std::memory_order_release); }
  } guard{loopEnforceBusy_};

  const double start = loadAtomicDouble(loopStartBits_, std::memory_order_acquire);
  const double end = loadAtomicDouble(loopEndBits_, std::memory_order_acquire);
  if (!(end > start) || start < 0.0) {
    clearLoopRange();
    return false;
  }

  // Read position without holding mutex across seek() (seek also takes mutex_).
  const auto state = renderState_.load(std::memory_order_acquire);
  if (state != PipelineState::Playing && state != PipelineState::Paused) return false;
  const int positionSampleRate = positionSampleRateForStream(stream_, outputFormat_);
  if (positionSampleRate <= 0) return false;
  const double position =
      static_cast<double>(renderedFrames_.load(std::memory_order_relaxed)) /
      static_cast<double>(positionSampleRate);

  // Small epsilon so we jump just as the playhead reaches end.
  if (position + 0.005 < end) return false;
  return seek(start, error) == TAE_RESULT_OK;
}

void AudioPipeline::resetRateResampler() noexcept {
  rateWsola_.reset();
  rateWsolaDirty_ = false;
}

void AudioPipeline::enqueueControlCommand(const ControlCommand& command) noexcept {
  if (controlCommands_.push(command)) return;
  if (command.type == ControlCommandType::Volume || command.type == ControlCommandType::PlaybackRate) {
    latestOverflowCommand_.publish(command);
  } else if (command.type == ControlCommandType::Routing) {
    latestRoutingCommand_.publish(command);
  } else if (command.type == ControlCommandType::DspGraph) {
    latestDspGraphCommand_.publish(command);
  }
}

void AudioPipeline::applyControlCommand(const ControlCommand& command) noexcept {
  if (command.type == ControlCommandType::Volume) {
    if (command.revision <= appliedConfigRevision_.load(std::memory_order_relaxed)) return;
    storeAtomicDouble(appliedVolumeBits_, command.volume, std::memory_order_relaxed);
    // Companion snapshot keeps overflow/coalesced rate coherent with volume updates.
    storeAtomicDouble(appliedPlaybackRateBits_, command.playbackRate, std::memory_order_relaxed);
    appliedConfigRevision_.store(command.revision, std::memory_order_release);
    return;
  }
  if (command.type == ControlCommandType::PlaybackRate) {
    if (command.revision <= appliedConfigRevision_.load(std::memory_order_relaxed)) return;
    storeAtomicDouble(appliedPlaybackRateBits_, command.playbackRate, std::memory_order_relaxed);
    storeAtomicDouble(appliedVolumeBits_, command.volume, std::memory_order_relaxed);
    appliedConfigRevision_.store(command.revision, std::memory_order_release);
    return;
  }
  if (command.type == ControlCommandType::Routing) {
    renderRoutingMode_.store(static_cast<uint32_t>(command.routingMode), std::memory_order_release);
    channelRouter_.setUpmixConfig(command.upmix);
    return;
  }
  if (command.type == ControlCommandType::DspGraph) {
    if (command.dspEpoch <= appliedRenderDspEpoch_.load(std::memory_order_relaxed)) return;
    renderActiveDspGraph_.store(command.activeDspGraph, std::memory_order_release);
    renderPreloadDspGraph_.store(command.preloadDspGraph, std::memory_order_release);
    renderGaplessEnabled_.store(command.gaplessEnabled, std::memory_order_release);
    storeAtomicDouble(renderCrossfadeSecondsBits_, command.crossfadeSeconds, std::memory_order_release);
    renderCrossfadeResetRequested_.store(true, std::memory_order_release);
    appliedRenderDspEpoch_.store(command.dspEpoch, std::memory_order_release);
    uint64_t appliedRevision = appliedConfigRevision_.load(std::memory_order_relaxed);
    while (command.revision > appliedRevision &&
           !appliedConfigRevision_.compare_exchange_weak(
               appliedRevision,
               command.revision,
               std::memory_order_release,
               std::memory_order_relaxed)) {
    }
  }
}

void AudioPipeline::applyPendingControlCommands() noexcept {
  ControlCommand command;
  for (size_t processed = 0; processed < kControlCommandCapacity; ++processed) {
    if (!controlCommands_.pop(command)) break;
    applyControlCommand(command);
  }
  // Overflow slot coalesces Volume + PlaybackRate field-wise. Apply both so a
  // later Volume publish does not drop a previously coalesced rate (and vice versa).
  if (latestOverflowCommand_.read(&command)) {
    const uint64_t applied = appliedConfigRevision_.load(std::memory_order_relaxed);
    if (command.revision > applied) {
      storeAtomicDouble(appliedVolumeBits_, command.volume, std::memory_order_relaxed);
      storeAtomicDouble(appliedPlaybackRateBits_, command.playbackRate, std::memory_order_relaxed);
      appliedConfigRevision_.store(command.revision, std::memory_order_release);
    }
  }
  if (latestRoutingCommand_.read(&command) && command.revision != appliedLatestRoutingSequence_) {
    applyControlCommand(command);
    appliedLatestRoutingSequence_ = command.revision;
  }
  if (latestDspGraphCommand_.read(&command)) applyControlCommand(command);
}

void AudioPipeline::setDspConfig(const std::string& dspConfigJson) {
  std::shared_ptr<DecodeStream> disabledPreload;
  const DspConfig nextConfig = DspChain::parseConfigJson(dspConfigJson);
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    dspConfig_ = nextConfig;
    renderDitherMode_.store(static_cast<uint32_t>(dspConfig_.ditherMode), std::memory_order_release);
    renderDitherResetRequested_.store(true, std::memory_order_release);
    gaplessEnabled_ = !dopPathActive_ && !nativeDsdPathActive_ && !typedPassthroughActive_ && dspConfig_.gapless;
    if (!gaplessEnabled_) {
      disabledPreload = std::move(preloadStream_);
      renderPreloadStream_.store(nullptr, std::memory_order_release);
      crossfadeMixActive_ = false;
      crossfadeFramesProcessed_ = 0;
      crossfadeTotalFrames_ = 0;
      renderCrossfadeResetRequested_.store(true, std::memory_order_release);
    }
    DspChain& activeDspChain = activeDspChainLocked();
    DspChain& spareDspChain = spareDspChainLocked();
    activeDspChain.configure(dspConfig_);
    dspConfig_ = activeDspChain.config();
    spareDspChain.configure(dspConfig_);
    if (decodeFormat_.sampleRate > 0 && decodeFormat_.channelCount > 0) {
      activeDspChain.prepare(decodeFormat_);
      activeDspChain.setTrackContext(DspTrackContext{stream_, currentItem_});
      spareDspChain.prepare(decodeFormat_);
      const DspTrackContext preloadContext =
          preloadStream_ ? DspTrackContext{preloadStream_->stream, preloadStream_->item}
                         : DspTrackContext{stream_, currentItem_};
      spareDspChain.setTrackContext(preloadContext);
    }
    if (outputFormat_.sampleRate > 0 && outputFormat_.channelCount > 0) {
      spectrum_.prepare(outputFormat_, visualizationFftResolutionForConfig(dspConfig_.fftResolution));
    }
    spectrum_.setEnabled(dspConfig_.fftEnabled);
    dspStatus_ = activeDspChain.status();
    preloadDspStatus_ = spareDspChain.status();
    dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
    std::string renderDspError;
    publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
    updatePerfectLocked();
    publishStatusLocked();
  }
  if (disabledPreload) {
    std::lock_guard lock(mutex_);
    retireDecodeStreamLocked(std::move(disabledPreload));
  }
}

bool AudioPipeline::setDspGraph(const std::string& graphJson, std::string* error) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  dspGraphJson_ = graphJson.empty() ? "{\"graph\":{\"nodes\":[]}}" : graphJson;
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  std::string activeError;
  const bool activeOk = activeDspChain.configureGraphJson(dspGraphJson_, &activeError);
  std::string spareError;
  const bool spareOk = spareDspChain.configureGraphJson(dspGraphJson_, &spareError);
  if (!activeOk || !spareOk) {
    if (error) *error = !activeError.empty() ? activeError : spareError;
    return false;
  }
  dspConfig_ = activeDspChain.config();
  renderDitherMode_.store(static_cast<uint32_t>(dspConfig_.ditherMode), std::memory_order_release);
  renderDitherResetRequested_.store(true, std::memory_order_release);
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  if (!publishPreparedRenderDspGraphsLocked(revision, &renderDspError)) {
    if (error) *error = renderDspError;
    return false;
  }
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
  return true;
}

bool AudioPipeline::applyDspState(
    uint64_t revision,
    const std::string& stateJson,
    std::string* error) {
  if (error) error->clear();
  if (revision == 0) {
    if (error) *error = "DSP state revision must be positive";
    return false;
  }
  const auto payloadRevision = json_utils::fieldNumber(stateJson, "revision");
  if (!payloadRevision.has_value() || !std::isfinite(*payloadRevision) ||
      *payloadRevision != std::floor(*payloadRevision) ||
      *payloadRevision != static_cast<double>(revision)) {
    if (error) *error = "DSP state payload revision does not match the requested revision";
    return false;
  }
  const std::string processingJson = json_utils::fieldObject(stateJson, "processing");
  if (processingJson.empty() || json_utils::fieldObject(stateJson, "graph").empty()) {
    if (error) *error = "DSP state payload requires processing and graph objects";
    return false;
  }

  std::shared_ptr<DecodeStream> disabledPreload;
  const DspConfig nextConfig = DspChain::parseConfigJson(processingJson);
  std::string committedGraphJson = stateJson;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    reclaimRetiredRenderDspGraphsLocked();
    if (activeStream_ && renderDspGraphs_.size() >= kMaxRenderDspGraphGenerations) {
      if (error) *error = "Realtime DSP graph generations are waiting for render-thread ACK";
      return false;
    }

    const bool nextGaplessEnabled =
        !dopPathActive_ && !nativeDsdPathActive_ && !typedPassthroughActive_ && nextConfig.gapless;
    const DspTrackContext activeContext{stream_, currentItem_};
    const DspTrackContext preloadContext =
        nextGaplessEnabled && preloadStream_
            ? DspTrackContext{preloadStream_->stream, preloadStream_->item}
            : activeContext;

    // Compile isolated control and render candidates first. DspChain graph
    // compilation mutates its receiver even when IR preparation fails, so no
    // live chain may be reused as a validation scratch object.
    auto activeControlCandidate =
        makeDspGraphCandidateLocked(nextConfig, stateJson, activeContext, error);
    if (!activeControlCandidate) return false;
    auto spareControlCandidate =
        makeDspGraphCandidateLocked(nextConfig, stateJson, preloadContext, error);
    if (!spareControlCandidate) return false;

    std::unique_ptr<DspChain> activeRenderCandidate;
    std::unique_ptr<DspChain> preloadRenderCandidate;
    std::string graphStatusJson = activeControlCandidate->graphStatusJson();
    if (activeStream_ && decodeFormat_.sampleRate > 0 && decodeFormat_.channelCount > 0) {
      activeRenderCandidate =
          makeDspGraphCandidateLocked(nextConfig, stateJson, activeContext, error);
      if (!activeRenderCandidate) return false;
      preloadRenderCandidate =
          makeDspGraphCandidateLocked(nextConfig, stateJson, preloadContext, error);
      if (!preloadRenderCandidate) return false;
      graphStatusJson = activeRenderCandidate->graphStatusJson();
    }

    // Materialize every allocating snapshot before replacing live state. From
    // here through the render ownership hand-off, all operations are moves,
    // atomic stores, or writes into the vector capacity reserved at startup.
    DspConfig committedConfig = activeControlCandidate->config();
    DspStatus committedActiveStatus = activeControlCandidate->status();
    DspStatus committedPreloadStatus = spareControlCandidate->status();

    if (!nextGaplessEnabled) {
      disabledPreload = std::move(preloadStream_);
      renderPreloadStream_.store(nullptr, std::memory_order_release);
      crossfadeMixActive_ = false;
      crossfadeFramesProcessed_ = 0;
      crossfadeTotalFrames_ = 0;
      renderCrossfadeResetRequested_.store(true, std::memory_order_release);
    }
    if (activeUsesPreloadDspChain_) {
      preloadDspChain_ = std::move(activeControlCandidate);
      dspChain_ = std::move(spareControlCandidate);
    } else {
      dspChain_ = std::move(activeControlCandidate);
      preloadDspChain_ = std::move(spareControlCandidate);
    }
    dspConfig_ = std::move(committedConfig);
    dspGraphJson_ = std::move(committedGraphJson);
    gaplessEnabled_ = nextGaplessEnabled;
    dspStatus_ = std::move(committedActiveStatus);
    preloadDspStatus_ = std::move(committedPreloadStatus);
    dspActive_ = dspStatus_.dspActive ||
                 std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
    renderDitherMode_.store(
        static_cast<uint32_t>(dspConfig_.ditherMode),
        std::memory_order_release);
    renderDitherResetRequested_.store(true, std::memory_order_release);
    if (outputFormat_.sampleRate > 0 && outputFormat_.channelCount > 0) {
      spectrum_.prepare(
          outputFormat_,
          visualizationFftResolutionForConfig(dspConfig_.fftResolution));
    }
    spectrum_.setEnabled(dspConfig_.fftEnabled);

    // GetDspGraphStatus is the authoritative external DSP ACK channel. Its
    // revision comes directly from this request; the generic playback config
    // counter remains monotonic when other controls have advanced it first.
    uint64_t requestedRevision = requestedConfigRevision_.load(std::memory_order_relaxed);
    while (revision > requestedRevision &&
           !requestedConfigRevision_.compare_exchange_weak(
               requestedRevision,
               revision,
               std::memory_order_release,
               std::memory_order_relaxed)) {
    }
    commitPreparedRenderDspGraphsLocked(
        revision,
        std::move(activeRenderCandidate),
        std::move(preloadRenderCandidate),
        std::move(graphStatusJson));
    updatePerfectLocked();
    publishStatusLocked();
  }
  if (disabledPreload) {
    std::lock_guard lock(mutex_);
    retireDecodeStreamLocked(std::move(disabledPreload));
  }
  return true;
}

std::string AudioPipeline::dspGraphStatusJson() const {
  std::lock_guard lock(mutex_);
  return appliedDspGraphStatusJsonLocked();
}

size_t AudioPipeline::renderDspGraphGenerationCountForTests() const {
  std::lock_guard lock(mutex_);
  reclaimRetiredRenderDspGraphsLocked();
  return renderDspGraphs_.size();
}

size_t AudioPipeline::maxRenderDspGraphGenerationCountForTests() const {
  return kMaxRenderDspGraphGenerations;
}

uint64_t AudioPipeline::appliedRenderDspEpochForTests() const noexcept {
  return appliedRenderDspEpoch_.load(std::memory_order_acquire);
}

OutputInfo::RenderPerformanceSnapshot AudioPipeline::renderPerformanceSnapshot() const noexcept {
  OutputInfo::RenderPerformanceSnapshot snapshot;
  snapshot.callbackCount = renderCallbackCount_.load(std::memory_order_relaxed);
  snapshot.totalCallbackNanoseconds = renderTotalCallbackNanoseconds_.load(std::memory_order_relaxed);
  snapshot.peakCallbackNanoseconds = renderPeakCallbackNanoseconds_.load(std::memory_order_relaxed);
  snapshot.totalDeadlineNanoseconds = renderTotalDeadlineNanoseconds_.load(std::memory_order_relaxed);
  snapshot.deadlineMissCount = renderDeadlineMissCount_.load(std::memory_order_relaxed);
  return snapshot;
}

void AudioPipeline::recordRenderPerformance(
    size_t frameCount,
    int sampleRate,
    uint64_t elapsedNanoseconds) noexcept {
  renderCallbackCount_.fetch_add(1, std::memory_order_relaxed);
  renderTotalCallbackNanoseconds_.fetch_add(elapsedNanoseconds, std::memory_order_relaxed);

  uint64_t observedPeak = renderPeakCallbackNanoseconds_.load(std::memory_order_relaxed);
  while (observedPeak < elapsedNanoseconds &&
         !renderPeakCallbackNanoseconds_.compare_exchange_weak(
             observedPeak,
             elapsedNanoseconds,
             std::memory_order_relaxed,
             std::memory_order_relaxed)) {
  }

  if (frameCount == 0 || sampleRate <= 0) return;
  const uint64_t deadlineNanoseconds =
      (static_cast<uint64_t>(frameCount) * 1000000000ULL) / static_cast<uint64_t>(sampleRate);
  if (deadlineNanoseconds == 0) return;
  renderTotalDeadlineNanoseconds_.fetch_add(deadlineNanoseconds, std::memory_order_relaxed);
  if (elapsedNanoseconds > deadlineNanoseconds) {
    renderDeadlineMissCount_.fetch_add(1, std::memory_order_relaxed);
  }
}

bool AudioPipeline::setOutputConfig(const OutputConfig& config, std::string* error) {
  std::unique_lock lock(mutex_);
  synchronizeRenderPromotionLocked();
  const OutputConfig previousConfig = outputConfig_;
  const auto applyRoutingLocked = [this](const OutputConfig& nextConfig) {
    ControlCommand routingCommand;
    routingCommand.type = ControlCommandType::Routing;
    routingCommand.routingMode = nextConfig.routingMode;
    routingCommand.upmix = upmixConfigFromOutputConfig(nextConfig);
    if (renderState_.load(std::memory_order_acquire) == PipelineState::Stopped) {
      renderRoutingMode_.store(static_cast<uint32_t>(routingCommand.routingMode), std::memory_order_release);
      channelRouter_.setUpmixConfig(routingCommand.upmix);
    } else {
      enqueueControlCommand(routingCommand);
    }
  };
  const auto refreshOpenedOutputLocked = [this](IOutputBackend* output) {
    outputFormat_ = output->outputFormat();
    outputInfo_ = output->outputInfo();
    deviceName_ = output->deviceName();
    outputInfo_.backend = backendId_;
    outputInfo_.deviceName = deviceName_;
    const size_t maxRenderFrames = outputInfo_.bufferSizeFrames > 0
                                       ? static_cast<size_t>(outputInfo_.bufferSizeFrames)
                                       : static_cast<size_t>(std::max(1, outputFormat_.sampleRate / 100));
    prepareRenderScratchLocked(maxRenderFrames);
    if (activeStream_) activeStream_->prepareFloatReadScratch(maxRenderFrames);
    renderChannelCount_.store(std::max(1, outputFormat_.channelCount), std::memory_order_release);
    renderOutputFormat_ = outputFormat_;
  };

  if (!output_ || !wasapiExclusiveTopologyChanged(backendId_, previousConfig, config)) {
    outputConfig_ = config;
    applyRoutingLocked(config);
    if (output_ && !output_->setOutputConfig(config, error)) {
      outputConfig_ = previousConfig;
      applyRoutingLocked(previousConfig);
      return false;
    }
    if (output_) refreshOpenedOutputLocked(output_.get());
    updatePerfectLocked();
    publishStatusLocked();
    return true;
  }

  // WASAPI Exclusive fixes its event/push mode and buffer duration during
  // IAudioClient::Initialize. A live assignment cannot change that topology.
  // Keep render callbacks silent while the current backend is fully stopped,
  // then only publish the requested config after the candidate has reopened
  // and started. The previous topology is reopened on every candidate failure.
  renderState_.store(PipelineState::Paused, std::memory_order_release);
  lock.unlock();
  // The reopen below runs with mutex_ released; serialize it against
  // play/stop/skipToPreloaded (transportMutex_) and re-validate the backend
  // under the lock — a concurrent transport operation may have replaced or
  // closed output_ while we waited.
  std::lock_guard<std::recursive_mutex> transportLock(transportMutex_);
  IOutputBackend* output = nullptr;
  AudioFormat requestedFormat;
  std::string deviceId;
  PipelineState previousState = PipelineState::Stopped;
  {
    std::lock_guard revalidate(mutex_);
    output = output_.get();
    requestedFormat = outputFormat_;
    deviceId = deviceId_;
    previousState = state_;
  }
  if (!output) {
    // The backend went away while we waited for the transport lock; nothing
    // to reopen, so fall through to the stopped-path bookkeeping.
    std::lock_guard revalidate(mutex_);
    outputConfig_ = config;
    applyRoutingLocked(config);
    updatePerfectLocked();
    publishStatusLocked();
    return true;
  }

  const auto startOutput = [this, output](std::string* startError) {
    return output->startTyped(
        [this](PcmBlock& block) { return renderTyped(block); },
        [this](float* data, size_t frames) { return render(data, frames); },
        [this](OutputBackendEvent event, const std::string& message) {
          std::lock_guard eventLock(mutex_);
          outputEventMessage_ = message;
          if (event == OutputBackendEvent::DeviceInvalidated) {
            deviceInvalidated_ = true;
          } else if (event == OutputBackendEvent::RenderError) {
            renderError_ = true;
          }
          state_ = PipelineState::Stopped;
          renderState_.store(PipelineState::Stopped, std::memory_order_release);
        },
        startError);
  };
  const auto reopen = [&](const OutputConfig& nextConfig, std::string* reopenError) {
    output->stop();
    output->close();
    if (!output->setOutputConfig(nextConfig, reopenError)) return false;
    if (!output->open(deviceId, requestedFormat, reopenError)) return false;
    lock.lock();
    refreshOpenedOutputLocked(output);
    lock.unlock();
    return startOutput(reopenError);
  };

  std::string candidateError;
  bool candidateStarted = reopen(config, &candidateError);
  if (candidateStarted) {
    lock.lock();
    const bool candidateRaisedOutputFailure =
        deviceInvalidated_.load(std::memory_order_acquire) || renderError_.load(std::memory_order_acquire);
    if (candidateRaisedOutputFailure) {
      candidateError = outputEventMessage_.empty() ? "WASAPI Exclusive candidate reported an output failure" :
                                                     outputEventMessage_;
      candidateStarted = false;
    }
    lock.unlock();
  }
  if (!candidateStarted) {
    std::string rollbackError;
    const bool rollbackStarted = reopen(previousConfig, &rollbackError);
    lock.lock();
    outputConfig_ = previousConfig;
    if (rollbackStarted) {
      deviceInvalidated_ = false;
      renderError_ = false;
      state_ = previousState;
      renderState_.store(previousState, std::memory_order_release);
      updatePerfectLocked();
      publishStatusLocked();
      if (error) {
        *error = "WASAPI Exclusive topology update failed and the previous topology was restored: " +
                 candidateError;
      }
    } else {
      state_ = PipelineState::Stopped;
      renderState_.store(PipelineState::Stopped, std::memory_order_release);
      outputInfo_.perfectReasonCode = "topology_rollback_failed";
      outputInfo_.perfectReason = rollbackError.empty() ? "WASAPI Exclusive rollback failed" : rollbackError;
      publishStatusLocked();
      if (error) {
        *error = "WASAPI Exclusive topology update failed: " + candidateError +
                 "; rollback failed: " + rollbackError;
      }
    }
    return false;
  }

  lock.lock();
  outputConfig_ = config;
  applyRoutingLocked(config);
  state_ = previousState;
  renderState_.store(previousState, std::memory_order_release);
  updatePerfectLocked();
  publishStatusLocked();
  return true;
}

bool AudioPipeline::loadImpulseResponse(const std::string& path, std::string* error) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  const bool ok = activeDspChain.loadImpulseResponse(path, error);
  if (ok) {
    std::string spareError;
    spareDspChain.loadImpulseResponse(path, &spareError);
    dspConfig_ = activeDspChain.config();
    const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::string renderDspError;
    if (!publishPreparedRenderDspGraphsLocked(revision, &renderDspError) && error && error->empty()) {
      *error = renderDspError;
    }
  }
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
  return ok;
}

void AudioPipeline::unloadImpulseResponse() {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  activeDspChain.unloadImpulseResponse();
  spareDspChain.unloadImpulseResponse();
  dspConfig_ = activeDspChain.config();
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
}

ConvolverInfo AudioPipeline::convolverInfo() const {
  std::lock_guard lock(mutex_);
  return activeDspChainLocked().convolverInfo();
}

bool AudioPipeline::setEqBands(const std::string& json, std::string* error) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  const bool ok = activeDspChain.setEqBandsFromJson(json, error);
  if (ok) spareDspChain.setEqBandsFromJson(json, error);
  if (ok) {
    dspConfig_ = activeDspChain.config();
    const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::string renderDspError;
    if (!publishPreparedRenderDspGraphsLocked(revision, &renderDspError) && error && error->empty()) {
      *error = renderDspError;
    }
  }
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
  return ok;
}

bool AudioPipeline::setEqPreset(const std::string& json, std::string* error) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  const bool ok = activeDspChain.setEqPresetFromJson(json, error);
  if (ok) spareDspChain.setEqPresetFromJson(json, error);
  if (ok) {
    dspConfig_ = activeDspChain.config();
    const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::string renderDspError;
    if (!publishPreparedRenderDspGraphsLocked(revision, &renderDspError) && error && error->empty()) {
      *error = renderDspError;
    }
  }
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
  return ok;
}

void AudioPipeline::setCrossfeedStrength(double strength) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  activeDspChain.setCrossfeedStrength(strength);
  spareDspChain.setCrossfeedStrength(strength);
  dspConfig_ = activeDspChain.config();
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
}

void AudioPipeline::setReplayGainMode(ReplayGainMode mode, double preampDb, double fallbackDb, bool clip) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  activeDspChain.setReplayGainMode(mode, preampDb, fallbackDb, clip);
  spareDspChain.setReplayGainMode(mode, preampDb, fallbackDb, clip);
  dspConfig_ = activeDspChain.config();
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
}

void AudioPipeline::refreshQueueReplayGainTags(const QueueItem& item) {
  if (item.source.empty()) return;
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  bool changed = false;

  auto overlayItemFields = [](QueueItem& target, const QueueItem& source) {
    if (source.replayGainTrackGainDb) target.replayGainTrackGainDb = source.replayGainTrackGainDb;
    if (source.replayGainAlbumGainDb) target.replayGainAlbumGainDb = source.replayGainAlbumGainDb;
    if (source.replayGainTrackPeak) target.replayGainTrackPeak = source.replayGainTrackPeak;
    if (source.replayGainAlbumPeak) target.replayGainAlbumPeak = source.replayGainAlbumPeak;
    if (source.r128TrackGainDb) target.r128TrackGainDb = source.r128TrackGainDb;
    if (source.r128AlbumGainDb) target.r128AlbumGainDb = source.r128AlbumGainDb;
    if (source.measuredIntegratedLufs) target.measuredIntegratedLufs = source.measuredIntegratedLufs;
    if (source.measuredTruePeakDb) target.measuredTruePeakDb = source.measuredTruePeakDb;
  };

  if (sameQueueSegment(currentItem_, item)) {
    overlayItemFields(currentItem_, item);
    applyQueueReplayGainTags(currentItem_, stream_.replayGain);
    if (activeStream_) {
      activeStream_->item = currentItem_;
      activeStream_->stream.replayGain = stream_.replayGain;
    }
    changed = true;
  }

  if (preloadStream_ && sameQueueSegment(preloadStream_->item, item)) {
    overlayItemFields(preloadStream_->item, item);
    applyQueueReplayGainTags(preloadStream_->item, preloadStream_->stream.replayGain);
    changed = true;
  }

  if (!changed) return;

  DspChain& activeDspChain = activeDspChainLocked();
  DspChain& spareDspChain = spareDspChainLocked();
  activeDspChain.setTrackContext(DspTrackContext{stream_, currentItem_});
  if (preloadStream_) {
    spareDspChain.setTrackContext(DspTrackContext{preloadStream_->stream, preloadStream_->item});
  } else {
    spareDspChain.setTrackContext(DspTrackContext{stream_, currentItem_});
  }
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
  dspStatus_ = activeDspChain.status();
  preloadDspStatus_ = spareDspChain.status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
}

void AudioPipeline::setNativeDspPluginChain(const std::string& json) {
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  nativeDspPluginChainJson_ = json.empty() ? "{\"plugins\":[]}" : json;
  dspChain_->setNativeDspPluginChain(nativeDspPluginChainJson_);
  preloadDspChain_->setNativeDspPluginChain(nativeDspPluginChainJson_);
  const uint64_t revision = requestedConfigRevision_.fetch_add(1, std::memory_order_acq_rel) + 1;
  std::string renderDspError;
  publishPreparedRenderDspGraphsLocked(revision, &renderDspError);
  dspStatus_ = activeDspChainLocked().status();
  preloadDspStatus_ = spareDspChainLocked().status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  publishStatusLocked();
}

std::string AudioPipeline::nativeDspPluginStatusJson() const {
  std::lock_guard lock(mutex_);
  return activeDspChainLocked().nativeDspPluginStatusJson();
}

bool AudioPipeline::preloadNext(const std::optional<QueueItem>& item, std::string* error) {
  cleanupRetiredDecodeStreams();

  if (!item || item->source.empty()) {
    std::shared_ptr<DecodeStream> previous;
    {
      std::lock_guard lock(mutex_);
      synchronizeRenderPromotionLocked();
      previous = std::move(preloadStream_);
      renderPreloadStream_.store(nullptr, std::memory_order_release);
      publishRenderDspPointerTransitionLocked(
          publishedActiveDspGraph_,
          nullptr);
      preloadDspStatus_ = {};
      lastPreloadFormatMismatch_ = false;
      publishStatusLocked();
    }
    if (previous) {
      std::lock_guard lock(mutex_);
      retireDecodeStreamLocked(std::move(previous));
    }
    return true;
  }

  AudioFormat outputFormat;
  bool gapless = false;
  uint32_t bufferSizeFrames = 0;
  DspResamplerQuality resamplerQuality = DspResamplerQuality::Native;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    if (preloadStream_ && sameQueueSegment(preloadStream_->item, *item)) return true;
    outputFormat = outputFormat_;
    gapless = gaplessEnabled_;
    bufferSizeFrames = outputInfo_.bufferSizeFrames;
    resamplerQuality = dspConfig_.resamplerQuality;
  }
  if (!gapless || outputFormat.sampleRate <= 0 || outputFormat.channelCount <= 0) return false;

  auto stream = makeDecodeStream();
  if (!stream->openSource(*item, error)) {
    std::lock_guard lock(mutex_);
    lastPreloadFormatMismatch_ = true;
    publishStatusLocked();
    return false;
  }
  stream->setResamplerQuality(resamplerQuality);
  if (!stream->configure(outputFormat, 0.0, error)) {
    std::lock_guard lock(mutex_);
    lastPreloadFormatMismatch_ = true;
    publishStatusLocked();
    return false;
  }
  const size_t maxRenderFrames = bufferSizeFrames > 0
                                     ? static_cast<size_t>(bufferSizeFrames)
                                     : static_cast<size_t>(std::max(1, outputFormat.sampleRate / 100));
  stream->prepareFloatReadScratch(maxRenderFrames);
  stream->start();

  std::shared_ptr<DecodeStream> previous;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    previous = std::move(preloadStream_);
    preloadStream_ = std::move(stream);
    lastPreloadFormatMismatch_ = false;
    DspChain& spareDspChain = spareDspChainLocked();
    spareDspChain.configure(dspConfig_);
    spareDspChain.prepare(outputFormat_);
    spareDspChain.setTrackContext(DspTrackContext{preloadStream_->stream, preloadStream_->item});
    preloadDspStatus_ = spareDspChain.status();
    std::string renderDspError;
    if (!publishPreparedRenderPreloadDspGraphLocked(&renderDspError)) {
      if (error && error->empty()) {
        *error = renderDspError.empty() ? "Failed to prepare preloaded DSP graph" : renderDspError;
      }
      renderPreloadStream_.store(nullptr, std::memory_order_release);
      preloadStream_.reset();
      lastPreloadFormatMismatch_ = true;
    } else {
      renderPreloadStream_.store(preloadStream_.get(), std::memory_order_release);
    }
    publishStatusLocked();
  }
  if (previous) {
    std::lock_guard lock(mutex_);
    retireDecodeStreamLocked(std::move(previous));
  }
  return true;
}

bool AudioPipeline::skipToPreloaded(const QueueItem& item, std::string* error) {
  std::lock_guard<std::recursive_mutex> transportLock(transportMutex_);
  std::shared_ptr<DecodeStream> oldActive;
  {
    std::lock_guard lock(mutex_);
    synchronizeRenderPromotionLocked();
    // The live overlap state lives on the render thread. crossfadeMixActive_ is
    // the control-side mirror and is never set, so reading it here let a
    // mid-overlap promotion skip already-consumed preload frames.
    if (renderCrossfadeMixActive_.load(std::memory_order_acquire)) {
      if (error) *error = "crossfade overlap 已经消耗了预加载流起始数据";
      return false;
    }
    if (!preloadStream_ || !sameQueueSegment(preloadStream_->item, item)) {
      if (error) *error = "下一首尚未完成预加载";
      return false;
    }
    oldActive = std::move(activeStream_);
    activeStream_ = std::move(preloadStream_);
    preloadStream_.reset();
    renderActiveStream_.store(activeStream_.get(), std::memory_order_release);
    renderPreloadStream_.store(nullptr, std::memory_order_release);
    stream_ = activeStream_->stream;
    currentItem_ = activeStream_->item;
    renderedFrames_ = 0;
    renderVolumeCurrentBits_.store(doubleBits(-1.0), std::memory_order_relaxed);
    resetRateResampler();
    ended_ = false;
    trackStarted_ = true;
    activeUsesPreloadDspChain_ = !activeUsesPreloadDspChain_;
    renderActiveUsesPreloadDspChain_.store(activeUsesPreloadDspChain_, std::memory_order_release);
    DspChain* const nextRenderDspGraph = publishedPreloadDspGraph_;
    publishRenderDspPointerTransitionLocked(nextRenderDspGraph, nullptr);
    dspStatus_ = preloadDspStatus_;
    preloadDspStatus_ = {};
    dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
    crossfadeMixActive_ = false;
    crossfadeFramesProcessed_ = 0;
    crossfadeTotalFrames_ = 0;
    renderCrossfadeResetRequested_.store(true, std::memory_order_release);
    updatePerfectLocked();
    publishStatusLocked();
  }
  if (oldActive) {
    std::lock_guard lock(mutex_);
    retireDecodeStreamLocked(std::move(oldActive));
  }
  return true;
}

PipelineStatus AudioPipeline::buildStatusLocked() {
  PipelineStatus status;
  status.state = state_;
  const int positionSampleRate = positionSampleRateForStream(stream_, outputFormat_);
  status.positionSeconds =
      positionSampleRate > 0
          ? static_cast<double>(renderedFrames_.load()) / static_cast<double>(positionSampleRate)
          : 0.0;
  status.stream = stream_;
  // Live ICY title: read from decoder under its internal mutex (decode-thread safe).
  if (activeStream_ && activeStream_->decoder) {
    const std::string title = activeStream_->decoder->streamTitle();
    if (!title.empty()) status.stream.streamTitle = title;
  }
  status.outputFormat = outputFormat_;
  OutputInfo backendInfo = output_ ? output_->outputInfo() : outputInfo_;
  backendInfo.sourceExact = outputInfo_.sourceExact;
  backendInfo.outputPerfect = outputInfo_.outputPerfect;
  backendInfo.pcmPassthrough = outputInfo_.pcmPassthrough;
  backendInfo.resampled = outputInfo_.resampled;
  backendInfo.isDsd = outputInfo_.isDsd;
  backendInfo.dsdMode = outputInfo_.dsdMode;
  backendInfo.dsdRate = outputInfo_.dsdRate;
  if (stream_.isDsd) {
    backendInfo.diagnostics.dsdSourceBitOrder = outputInfo_.diagnostics.dsdSourceBitOrder;
    backendInfo.diagnostics.dsdSourcePacking = outputInfo_.diagnostics.dsdSourcePacking;
    if (backendInfo.diagnostics.dsdTransport.empty()) {
      backendInfo.diagnostics.dsdTransport = outputInfo_.diagnostics.dsdTransport;
    }
    backendInfo.diagnostics.typedRawPath = outputInfo_.diagnostics.typedRawPath;
    backendInfo.diagnostics.processingBypassed = outputInfo_.diagnostics.processingBypassed;
  }
  // The compatibility route is decided by the pipeline; the backend cannot know
  // it. Copy unconditionally: PCM->DSD upconversion uses the route while its
  // source stream is PCM (stream_.isDsd == false).
  backendInfo.diagnostics.dsdRouteOverrideActive = outputInfo_.diagnostics.dsdRouteOverrideActive;
  backendInfo.diagnostics.dsdRouteBackend = outputInfo_.diagnostics.dsdRouteBackend;
  backendInfo.diagnostics.dsdRouteDevice = outputInfo_.diagnostics.dsdRouteDevice;
  backendInfo.diagnostics.dsdRouteFallbackReason = outputInfo_.diagnostics.dsdRouteFallbackReason;
  if (stream_.isDsd && stream_.dsdMode != DsdMode::Native && nativeDsdFallbackFacts_.has_value()) {
    applyNativeDsdRuntimeFacts(&backendInfo, *nativeDsdFallbackFacts_);
  } else if (output_) {
    applyNativeDsdRuntimeFacts(&backendInfo, output_->nativeDsdRuntimeFacts());
  }
  backendInfo.channelRoutingMode = outputInfo_.channelRoutingMode;
  backendInfo.perfectReasonCode = outputInfo_.perfectReasonCode;
  backendInfo.perfectReason = outputInfo_.perfectReason;
  backendInfo.renderPerformance = renderPerformanceSnapshot();
  status.outputInfo = backendInfo;
  status.backendId = backendId_;
  status.deviceName = deviceName_;
  status.currentItem = currentItem_;
  status.dspActive = dspActive_;
  status.replayGainActive = dspStatus_.replayGainActive;
  status.loudnormActive = dspStatus_.loudnormActive;
  status.eqActive = dspStatus_.eqActive;
  status.convolverActive = dspStatus_.convolverActive;
  status.crossfeedActive = dspStatus_.crossfeedActive;
  status.nativeDspActive = dspStatus_.nativeDspActive;
  status.crossfadeActive = dspStatus_.crossfadeActive || dspConfig_.crossfadeSeconds > 0.0001;
  status.fftActive = spectrum_.isActive();
  status.irResampled = dspStatus_.irResampled;
  status.replayGainDb = dspStatus_.replayGainDb;
  status.crossfeedStrength = dspStatus_.crossfeedStrength;
  status.crossfadeSeconds = status.crossfadeActive ? dspConfig_.crossfadeSeconds : 0.0;
  status.convolverLatencyFrames = dspStatus_.convolverLatencyFrames;
  status.partitionSize = dspStatus_.partitionSize;
  status.channelMappingMode = dspStatus_.channelMappingMode;
  status.nativeDspJson = dspStatus_.nativeDspJson;
  status.dspGraphJson = appliedDspGraphStatusJsonLocked();
  status.sourceExact = outputInfo_.sourceExact;
  status.outputPerfect = outputPerfect_;
  status.gaplessActive =
      gaplessEnabled_ && dspConfig_.crossfadeSeconds <= 0.0001 && preloadStream_ != nullptr && !crossfadeMixActive_;
  status.preloadReady = preloadStream_ && preloadStream_->readyForRender();
  // Canonical blocked-reason priority: user intent first, then path gates, then format.
  if (!dspConfig_.gapless) {
    status.gaplessBlockedReason = "disabled";
  } else if (dspConfig_.crossfadeSeconds > 0.0001 || crossfadeMixActive_) {
    status.gaplessBlockedReason = "crossfade";
  } else if (dopPathActive_ || nativeDsdPathActive_) {
    status.gaplessBlockedReason = "dsd_path";
  } else if (typedPassthroughActive_) {
    status.gaplessBlockedReason = "typed_passthrough";
  } else if (lastPreloadFormatMismatch_ && !preloadStream_) {
    status.gaplessBlockedReason = "format_mismatch";
  } else if (!gaplessEnabled_) {
    // Intent on but internal path still cannot preload.
    status.gaplessBlockedReason = "disabled";
  } else {
    status.gaplessBlockedReason.clear();
  }
  status.perfectReason = perfectReason_;
  status.requestedConfigRevision = requestedConfigRevision_.load(std::memory_order_acquire);
  status.appliedConfigRevision = appliedConfigRevision_.load(std::memory_order_acquire);
  return status;
}

PipelineStatus AudioPipeline::fallbackStatus() const {
  std::lock_guard lock(statusMutex_);
  // `state` is the user-visible transport state. `renderState_` is a
  // callback-side implementation detail and may be temporarily Paused while
  // WASAPI Exclusive reopens its topology. Do not expose that transient state
  // when the pipeline mutex is contended; status() will take the mutex for
  // end-of-file, device-invalidated, and render-error snapshots.
  PipelineStatus status = lastStatus_;
  const int positionSampleRate = positionSampleRateForStream(status.stream, status.outputFormat);
  status.positionSeconds =
      positionSampleRate > 0
          ? static_cast<double>(renderedFrames_.load()) / static_cast<double>(positionSampleRate)
          : 0.0;
  status.outputInfo.renderPerformance = renderPerformanceSnapshot();
  status.requestedConfigRevision = requestedConfigRevision_.load(std::memory_order_acquire);
  status.appliedConfigRevision = appliedConfigRevision_.load(std::memory_order_acquire);
  return status;
}

void AudioPipeline::publishStatusLocked() {
  PipelineStatus status = buildStatusLocked();
  std::lock_guard lock(statusMutex_);
  lastStatus_ = std::move(status);
}

PipelineStatus AudioPipeline::status() {
  const bool requiresFreshStatus =
      ended_.load() || deviceInvalidated_.load() || renderError_.load() || trackStarted_.load();
  if (requiresFreshStatus) {
    cleanupRetiredDecodeStreams();
  } else {
    tryCleanupRetiredDecodeStreams();
  }

  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) {
    if (!requiresFreshStatus) return fallbackStatus();
    lock.lock();
  }
  synchronizeRenderPromotionLocked();
  if (ended_.load(std::memory_order_acquire) && state_ == PipelineState::Playing &&
      renderState_.load(std::memory_order_acquire) == PipelineState::Stopped) {
    state_ = PipelineState::Stopped;
  }
  dspStatus_ = activeDspChainLocked().status();
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  updatePerfectLocked();
  PipelineStatus status = buildStatusLocked();
  {
    std::lock_guard statusLock(statusMutex_);
    lastStatus_ = status;
  }
  return status;
}

bool AudioPipeline::isDopPathActive() const {
  std::lock_guard lock(mutex_);
  return dopPathActive_;
}

bool AudioPipeline::isNativeDsdPathActive() const {
  std::lock_guard lock(mutex_);
  return nativeDsdPathActive_;
}

/**
 * Whether the current processing state would force a DSD source onto PCM.
 *
 * This is the same predicate the open path uses to decide whether Native DSD or
 * DoP may even be attempted, exposed so the reroute decision can tell a
 * re-negotiation that might succeed from one that provably cannot. Without it,
 * a DSD track sitting in PCM fallback because software volume is below unity was
 * restarted on every single volume change: the reroute reopened the device, the
 * open path re-applied this very check, and playback landed back in PCM.
 */
bool AudioPipeline::processingForcesDsdPcmFallback() const {
  std::lock_guard lock(mutex_);
  return dspConfigProcessingRequiresPcm(
      dspConfig_,
      outputConfig_,
      loadAtomicDouble(requestedVolumeBits_),
      loadAtomicDouble(requestedPlaybackRateBits_),
      graphStateProcessingActive(dspGraphJson_));
}

bool AudioPipeline::needsPcmFallback(std::string* reason) const {
  std::lock_guard lock(mutex_);
  const bool processingActive =
      dspStatus_.replayGainActive || dspStatus_.eqActive || dspStatus_.convolverActive || dspStatus_.crossfeedActive ||
      dspStatus_.nativeDspActive || dspStatus_.crossfadeActive || dspConfig_.crossfadeSeconds > 0.0001 ||
      std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > kUnityVolumeEpsilon ||
      std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > kUnityVolumeEpsilon ||
      outputConfig_.routingMode != ChannelRoutingMode::Auto;

  if (nativeDsdPathActive_ && stream_.isDsd && stream_.dsdMode == DsdMode::Native) {
    if (output_) {
      const NativeDsdRuntimeFacts facts = output_->nativeDsdRuntimeFacts();
      if (facts.state != NativeDsdRuntimeFactState::Proven) {
        if (reason) {
          *reason = facts.reason.empty() ? "ASIO Native DSD could not prove raw DSD output" : facts.reason;
        }
        return true;
      }
    }
    if (!processingActive) return false;
    if (reason) *reason = "DSD processing active; falling back to PCM";
    return true;
  }

  if (typedPassthroughActive_) {
    if (!processingActive) return false;
    if (reason) *reason = "PCM processing active; falling back to Float32";
    return true;
  }

  if (!dopPathActive_ || !stream_.isDsd || stream_.dsdMode != DsdMode::Dop) return false;
  if (output_) {
    const DopRuntimeFacts dopFacts = output_->dopRuntimeFacts();
    if (dopFacts.state == DopRuntimeFactState::Mismatch) {
      if (reason) *reason = "DoP carrier mismatch";
      return true;
    }
    if (dopFacts.state == DopRuntimeFactState::Candidate || dopFacts.state == DopRuntimeFactState::Unproven ||
        dopFacts.state == DopRuntimeFactState::Unsupported) {
      if (reason) *reason = dopPcmFallbackReason(dopFacts);
      return true;
    }
  }
  if (!processingActive) return false;
  if (reason) *reason = "DSD processing active; falling back to PCM";
  return true;
}

void AudioPipeline::setRerouteInProgress(bool active, const std::string& reason) {
  std::lock_guard lock(mutex_);
  rerouteInProgress_ = active;
  if (active && !reason.empty()) {
    dsdFallbackReason_ = reason;
    outputInfo_.perfectReason = reason;
    perfectReason_ = reason;
  }
}

bool AudioPipeline::consumeEnded() {
  return ended_.exchange(false);
}

bool AudioPipeline::consumeDeviceInvalidated(std::string* message) {
  if (!deviceInvalidated_.exchange(false)) return false;
  std::lock_guard lock(mutex_);
  if (message) *message = outputEventMessage_.empty() ? "输出设备已失效" : outputEventMessage_;
  outputEventMessage_.clear();
  return true;
}

bool AudioPipeline::consumeRenderError(std::string* message) {
  if (!renderError_.exchange(false)) return false;
  std::lock_guard lock(mutex_);
  if (message) *message = outputEventMessage_.empty() ? "音频渲染失败" : outputEventMessage_;
  outputEventMessage_.clear();
  return true;
}

bool AudioPipeline::consumeTrackStarted(QueueItem* item) {
  if (!trackStarted_.exchange(false)) return false;
  std::lock_guard lock(mutex_);
  synchronizeRenderPromotionLocked();
  if (item) *item = currentItem_;
  return true;
}

size_t AudioPipeline::getSpectrumData(float* buffer, size_t pointCount) const {
  double sampleRate = 0.0;
  {
    std::lock_guard lock(mutex_);
    sampleRate = positionSampleRateForStream(stream_, outputFormat_);
  }
  const double phase =
      sampleRate > 0.0 ? static_cast<double>(renderedFrames_.load()) / sampleRate : 0.0;
  return spectrum_.read(buffer, pointCount, phase);
}

std::string AudioPipeline::getVisualizationDataJson(
    size_t spectrumPoints,
    size_t waveformPoints,
    size_t spectrogramFrames,
    size_t oscilloscopePoints) const {
  return spectrum_.readVisualizationJson(spectrumPoints, waveformPoints, spectrogramFrames, oscilloscopePoints);
}

bool AudioPipeline::configureActiveStreamLocked(
    const std::shared_ptr<DecodeStream>& stream,
    const QueueItem& item,
    double startTimeSeconds,
    std::string* error) {
  if (!stream) return false;
  if (!stream->openSource(item, error)) return false;
  if (!stream->configure(decodeFormat_, startTimeSeconds, error)) return false;
  return true;
}

bool AudioPipeline::updatePerfectLocked() {
  const OutputInfo backendInfo = output_ ? output_->outputInfo() : outputInfo_;
  const DopRuntimeFacts dopFacts = output_ ? output_->dopRuntimeFacts() : DopRuntimeFacts{};
  const NativeDsdRuntimeFacts backendNativeDsdFacts =
      output_ ? output_->nativeDsdRuntimeFacts() : unsupportedNativeDsdRuntimeFacts("No output backend is active");
  const NativeDsdRuntimeFacts nativeDsdFacts =
      stream_.isDsd && stream_.dsdMode != DsdMode::Native && nativeDsdFallbackFacts_.has_value()
          ? *nativeDsdFallbackFacts_
          : backendNativeDsdFacts;
  AudioFormat semanticOutputFormat = actualOutputFormat(outputFormat_, backendInfo);
  const bool backendResampled = backendInfo.resampled;
  const std::string backendPerfectReason =
      stream_.isDsd && stream_.dsdMode == DsdMode::Pcm && !dsdFallbackReason_.empty()
          ? dsdFallbackReason_
          : backendInfo.perfectReason;
  PerfectEvaluation evaluation;
  evaluation.sourceFormat = stream_.sourceFormat;
  evaluation.decodedFormat = stream_.decodedFormat;
  evaluation.outputFormat = semanticOutputFormat;
  evaluation.sourceLossless = stream_.sourceLossless;
  evaluation.sourceDsd = stream_.isDsd;
  if (stream_.isDsd) {
    evaluation.dsdMode = stream_.dsdMode;
    evaluation.dsdRate = stream_.dsdRate;
    if (stream_.dsdMode == DsdMode::Dop) {
      evaluation.dopCarrierFormat = stream_.decodedFormat;
      evaluation.dopCarrierMatched = pcmFormatsSemanticallyMatch(stream_.decodedFormat, semanticOutputFormat);
      if (dopFacts.state == DopRuntimeFactState::Mismatch && hasConcreteAudioFormat(dopFacts.actualFormat)) {
        evaluation.dopCarrierFormat = dopFacts.actualFormat;
        evaluation.dopCarrierMatched = pcmFormatsSemanticallyMatch(dopFacts.actualFormat, semanticOutputFormat);
      }
      evaluation.dopPassthroughProven =
          dopFacts.state == DopRuntimeFactState::Proven && evaluation.dopCarrierMatched && !backendResampled;
    } else if (stream_.dsdMode == DsdMode::Native) {
      evaluation.nativeDsdRequested = true;
      evaluation.nativeDsdPassthroughProven = nativeDsdFacts.state == NativeDsdRuntimeFactState::Proven;
      if (nativeDsdFacts.state == NativeDsdRuntimeFactState::Proven && nativeDsdFacts.actualDsdRate > 0) {
        semanticOutputFormat.sampleRate = nativeDsdFacts.actualDsdRate;
        evaluation.outputFormat = semanticOutputFormat;
      }
    }
  }
  evaluation.supportsOutputPerfect = backendInfo.supportsOutputPerfect;
  evaluation.backendResampled = backendResampled;
  evaluation.backendPerfectReasonCode = backendInfo.perfectReasonCode;
  evaluation.backendPerfectReason = backendPerfectReason;
  evaluation.volume = loadAtomicDouble(requestedVolumeBits_);
  evaluation.playbackRate = loadAtomicDouble(requestedPlaybackRateBits_);
  evaluation.replayGainActive = dspStatus_.replayGainActive;
  evaluation.loudnormActive = dspStatus_.loudnormActive;
  evaluation.eqActive = dspStatus_.eqActive;
  evaluation.convolverActive = dspStatus_.convolverActive;
  evaluation.crossfeedActive = dspStatus_.crossfeedActive;
  evaluation.nativeDspActive = dspStatus_.nativeDspActive;
  evaluation.crossfadeActive = dspStatus_.crossfadeActive || dspConfig_.crossfadeSeconds > 0.0001;
  evaluation.routingMode = outputConfig_.routingMode;
  evaluation.pcmPassthrough =
      !stream_.isDsd && typedPassthroughActive_ &&
      pcmFormatsExactMatch(evaluation.decodedFormat, evaluation.outputFormat) && !backendResampled;
  const PerfectResult result = evaluatePerfect(evaluation);
  dspActive_ = result.processingActive;
  outputPerfect_ = result.outputPerfect;
  outputInfo_.sourceExact = result.sourceExact;
  outputInfo_.resampled = result.resampled;
  outputInfo_.outputPerfect = outputPerfect_;
  outputInfo_.pcmPassthrough = result.pcmPassthrough;
  outputInfo_.isDsd = stream_.isDsd;
  outputInfo_.dsdMode = stream_.isDsd ? dsdModeToString(stream_.dsdMode) : dsdModeToString(DsdMode::Pcm);
  outputInfo_.dsdRate = stream_.isDsd ? stream_.dsdRate : 0;
  applyNativeDsdRuntimeFacts(&outputInfo_, nativeDsdFacts);
  outputInfo_.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  outputInfo_.perfectReasonCode = result.perfectReasonCode;
  outputInfo_.perfectReason = result.perfectReason;
  perfectReason_ = result.perfectReason;
  return outputPerfect_;
}

DspChain& AudioPipeline::activeDspChainLocked() {
  return activeUsesPreloadDspChain_ ? *preloadDspChain_ : *dspChain_;
}

const DspChain& AudioPipeline::activeDspChainLocked() const {
  return activeUsesPreloadDspChain_ ? *preloadDspChain_ : *dspChain_;
}

DspChain& AudioPipeline::spareDspChainLocked() {
  return activeUsesPreloadDspChain_ ? *dspChain_ : *preloadDspChain_;
}

void AudioPipeline::reclaimRetiredRenderDspGraphsLocked() const {
  const uint64_t appliedEpoch = appliedRenderDspEpoch_.load(std::memory_order_acquire);
  DspChain* const active = renderActiveDspGraph_.load(std::memory_order_acquire);
  DspChain* const preload = renderPreloadDspGraph_.load(std::memory_order_acquire);

  for (const RenderDspGraphGeneration& generation : renderDspGraphs_) {
    if (generation.epoch > appliedEpoch || !generation.updatesGraphStatus ||
        generation.epoch < appliedDspGraphStatusEpoch_) {
      continue;
    }
    appliedDspGraphStatusEpoch_ = generation.epoch;
    appliedDspGraphStatusJson_ = generation.graphStatusJson;
  }

  renderDspGraphs_.erase(
      std::remove_if(
          renderDspGraphs_.begin(),
          renderDspGraphs_.end(),
          [appliedEpoch, active, preload](const RenderDspGraphGeneration& generation) {
            if (generation.epoch > appliedEpoch) return false;
            return generation.active.get() != active && generation.active.get() != preload &&
                   generation.preload.get() != active && generation.preload.get() != preload;
          }),
      renderDspGraphs_.end());
}

std::string AudioPipeline::appliedDspGraphStatusJsonLocked() const {
  reclaimRetiredRenderDspGraphsLocked();
  return appliedDspGraphStatusJson_;
}

std::unique_ptr<DspChain> AudioPipeline::makeDspGraphCandidateLocked(
    const DspConfig& config,
    const std::string& graphJson,
    const DspTrackContext& context,
    std::string* error) {
  auto graph = std::make_unique<DspChain>();
  // Render graphs are built from the config rather than copied, so the convolver they get
  // is a different object from the one convolverInfo() reads. Hand it the control chain's
  // realtime telemetry, otherwise a bypass raised on the audio thread is invisible.
  if (dspChain_) graph->setConvolverRealtimeState(dspChain_->convolverRealtimeState());
  graph->configure(config);
  if (decodeFormat_.sampleRate > 0 && decodeFormat_.channelCount > 0) {
    graph->prepare(decodeFormat_);
  }
  graph->setTrackContext(context);
  if (!graphJson.empty() && !graph->configureGraphJson(graphJson, error)) return nullptr;
  graph->setNativeDspPluginChain(nativeDspPluginChainJson_);
  const DspConfig preparedConfig = graph->config();
  // Graph compilation already loads its convolver node. The explicit load is
  // needed only for legacy config-only callers.
  if (graphJson.empty() && !preparedConfig.impulseResponsePath.empty()) {
    if (!graph->loadImpulseResponse(preparedConfig.impulseResponsePath, error)) return nullptr;
  }
  return graph;
}

std::unique_ptr<DspChain> AudioPipeline::makeRenderDspGraphLocked(
    const DspTrackContext& context,
    std::string* error) {
  return makeDspGraphCandidateLocked(dspConfig_, dspGraphJson_, context, error);
}

void AudioPipeline::commitPreparedRenderDspGraphsLocked(
    uint64_t revision,
    std::unique_ptr<DspChain> activeGraph,
    std::unique_ptr<DspChain> preloadGraph,
    std::string graphStatusJson) noexcept {
  if (!activeGraph || !preloadGraph) {
    appliedDspGraphStatusJson_ = std::move(graphStatusJson);
    appliedDspGraphStatusEpoch_ = appliedRenderDspEpoch_.load(std::memory_order_acquire);
    if (revision > 0) {
      uint64_t appliedRevision = appliedConfigRevision_.load(std::memory_order_relaxed);
      while (revision > appliedRevision &&
             !appliedConfigRevision_.compare_exchange_weak(
                 appliedRevision,
                 revision,
                 std::memory_order_release,
                 std::memory_order_relaxed)) {
      }
    }
    return;
  }

  DspChain* const activeGraphPtr = activeGraph.get();
  DspChain* const preloadGraphPtr = preloadGraph.get();
  const uint64_t dspEpoch = requestedRenderDspEpoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
  renderDspGraphs_.push_back(RenderDspGraphGeneration{
      dspEpoch,
      revision,
      true,
      std::move(activeGraph),
      std::move(preloadGraph),
      std::move(graphStatusJson)});

  ControlCommand command;
  command.type = ControlCommandType::DspGraph;
  command.revision = revision;
  command.dspEpoch = dspEpoch;
  command.activeDspGraph = activeGraphPtr;
  command.preloadDspGraph = preloadGraphPtr;
  command.gaplessEnabled = gaplessEnabled_;
  command.crossfadeSeconds = dspConfig_.crossfadeSeconds;
  publishedActiveDspGraph_ = activeGraphPtr;
  publishedPreloadDspGraph_ = preloadGraphPtr;
  if (renderState_.load(std::memory_order_acquire) == PipelineState::Stopped) {
    renderActiveDspGraph_.store(activeGraphPtr, std::memory_order_release);
    renderPreloadDspGraph_.store(preloadGraphPtr, std::memory_order_release);
    renderGaplessEnabled_.store(gaplessEnabled_, std::memory_order_release);
    storeAtomicDouble(renderCrossfadeSecondsBits_, dspConfig_.crossfadeSeconds, std::memory_order_release);
    appliedRenderDspEpoch_.store(dspEpoch, std::memory_order_release);
    if (revision > 0) {
      uint64_t appliedRevision = appliedConfigRevision_.load(std::memory_order_relaxed);
      while (revision > appliedRevision &&
             !appliedConfigRevision_.compare_exchange_weak(
                 appliedRevision,
                 revision,
                 std::memory_order_release,
                 std::memory_order_relaxed)) {
      }
    }
    reclaimRetiredRenderDspGraphsLocked();
  } else {
    enqueueControlCommand(command);
  }
}

bool AudioPipeline::publishPreparedRenderDspGraphsLocked(uint64_t revision, std::string* error) {
  if (!activeStream_ || decodeFormat_.sampleRate <= 0 || decodeFormat_.channelCount <= 0) {
    commitPreparedRenderDspGraphsLocked(
        revision,
        nullptr,
        nullptr,
        activeDspChainLocked().graphStatusJson());
    return true;
  }

  reclaimRetiredRenderDspGraphsLocked();
  if (renderDspGraphs_.size() >= kMaxRenderDspGraphGenerations) {
    if (error) *error = "Realtime DSP graph generations are waiting for render-thread ACK";
    return false;
  }

  auto activeGraph = makeRenderDspGraphLocked(DspTrackContext{stream_, currentItem_}, error);
  if (!activeGraph) return false;
  const DspTrackContext preloadContext =
      preloadStream_ ? DspTrackContext{preloadStream_->stream, preloadStream_->item}
                     : DspTrackContext{stream_, currentItem_};
  auto preloadGraph = makeRenderDspGraphLocked(preloadContext, error);
  if (!preloadGraph) return false;
  std::string graphStatusJson = activeGraph->graphStatusJson();
  commitPreparedRenderDspGraphsLocked(
      revision,
      std::move(activeGraph),
      std::move(preloadGraph),
      std::move(graphStatusJson));
  return true;
}

bool AudioPipeline::publishPreparedRenderPreloadDspGraphLocked(std::string* error) {
  if (!activeStream_ || !preloadStream_ || decodeFormat_.sampleRate <= 0 ||
      decodeFormat_.channelCount <= 0) {
    return true;
  }
  reclaimRetiredRenderDspGraphsLocked();
  if (renderDspGraphs_.size() >= kMaxRenderDspGraphGenerations) {
    if (error) *error = "Realtime DSP graph generations are waiting for render-thread ACK";
    return false;
  }

  auto preloadGraph = makeRenderDspGraphLocked(
      DspTrackContext{preloadStream_->stream, preloadStream_->item},
      error);
  if (!preloadGraph) return false;

  DspChain* const activeGraphPtr = publishedActiveDspGraph_;
  DspChain* const preloadGraphPtr = preloadGraph.get();
  const uint64_t dspEpoch = requestedRenderDspEpoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
  renderDspGraphs_.push_back(RenderDspGraphGeneration{
      dspEpoch,
      0,
      false,
      nullptr,
      std::move(preloadGraph),
      appliedDspGraphStatusJson_});
  publishedPreloadDspGraph_ = preloadGraphPtr;

  ControlCommand command;
  command.type = ControlCommandType::DspGraph;
  command.dspEpoch = dspEpoch;
  command.activeDspGraph = activeGraphPtr;
  command.preloadDspGraph = preloadGraphPtr;
  command.gaplessEnabled = gaplessEnabled_;
  command.crossfadeSeconds = dspConfig_.crossfadeSeconds;
  if (renderState_.load(std::memory_order_acquire) == PipelineState::Stopped) {
    renderPreloadDspGraph_.store(preloadGraphPtr, std::memory_order_release);
    appliedRenderDspEpoch_.store(dspEpoch, std::memory_order_release);
    reclaimRetiredRenderDspGraphsLocked();
  } else {
    enqueueControlCommand(command);
  }
  return true;
}

void AudioPipeline::publishRenderDspPointerTransitionLocked(
    DspChain* active,
    DspChain* preload) {
  const uint64_t dspEpoch = requestedRenderDspEpoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
  ControlCommand command;
  command.type = ControlCommandType::DspGraph;
  command.dspEpoch = dspEpoch;
  command.activeDspGraph = active;
  command.preloadDspGraph = preload;
  command.gaplessEnabled = gaplessEnabled_;
  command.crossfadeSeconds = dspConfig_.crossfadeSeconds;
  publishedActiveDspGraph_ = active;
  publishedPreloadDspGraph_ = preload;
  if (renderState_.load(std::memory_order_acquire) == PipelineState::Stopped) {
    renderActiveDspGraph_.store(active, std::memory_order_release);
    renderPreloadDspGraph_.store(preload, std::memory_order_release);
    appliedRenderDspEpoch_.store(dspEpoch, std::memory_order_release);
    reclaimRetiredRenderDspGraphsLocked();
  } else {
    enqueueControlCommand(command);
  }
}

void AudioPipeline::synchronizeRenderPromotionLocked() {
  if (!renderPromotionPending_.exchange(false, std::memory_order_acq_rel)) return;

  DecodeStream* const promoted = renderActiveStream_.load(std::memory_order_acquire);
  if (!promoted || !preloadStream_ || preloadStream_.get() != promoted) return;

  std::shared_ptr<DecodeStream> previous = std::move(activeStream_);
  activeStream_ = std::move(preloadStream_);
  stream_ = activeStream_->stream;
  currentItem_ = activeStream_->item;
  activeUsesPreloadDspChain_ = renderActiveUsesPreloadDspChain_.load(std::memory_order_acquire);
  publishedActiveDspGraph_ = renderActiveDspGraph_.load(std::memory_order_acquire);
  publishedPreloadDspGraph_ = renderPreloadDspGraph_.load(std::memory_order_acquire);
  dspStatus_ = activeDspChainLocked().status();
  preloadDspStatus_ = {};
  dspActive_ = dspStatus_.dspActive || std::abs(loadAtomicDouble(requestedVolumeBits_) - 1.0) > 0.0001 ||
                 std::abs(loadAtomicDouble(requestedPlaybackRateBits_) - 1.0) > 0.0001;
  crossfadeMixActive_ = false;
  crossfadeFramesProcessed_ = 0;
  crossfadeTotalFrames_ = 0;
  updatePerfectLocked();
  // The callback has already published the new raw pointer before raising the
  // promotion flag, so releasing the former owner on this control path cannot
  // destroy a stream that is still being rendered.
  previous.reset();
}

void AudioPipeline::prepareRenderScratchLocked(size_t maxFrames) {
  const size_t frames = std::max<size_t>(1, maxFrames);
  const size_t outputChannels = static_cast<size_t>(std::max(1, outputFormat_.channelCount));
  const size_t decodeChannels = static_cast<size_t>(std::max(1, decodeFormat_.channelCount));
  const size_t outputSamples = frames * outputChannels;
  const size_t decodeSamples = frames * decodeChannels;

  routingScratch_.resize(decodeSamples);
  preloadRoutingScratch_.resize(decodeSamples);
  preloadMixScratch_.resize(outputSamples);
  typedVisualizationScratch_.resize(outputSamples);

  // WSOLA grain buffers (prepared for current output format on the control path).
  const int sampleRate = std::max(1, outputFormat_.sampleRate);
  rateWsola_.prepare(static_cast<int>(outputChannels), sampleRate, frames);
  rateWsolaReady_ = true;
  resetRateResampler();
}

size_t AudioPipeline::renderTyped(PcmBlock& output) {
  if (!output.data || output.frames == 0) return 0;
  enableDenormalFlushToZero();
  const auto renderStarted = std::chrono::steady_clock::now();
  const auto recordPerformance = [this, &output, renderStarted]() noexcept {
    const auto elapsed = std::chrono::steady_clock::now() - renderStarted;
    recordRenderPerformance(
        output.frames,
        output.format.sampleRate,
        static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count()));
  };
  applyPendingControlCommands();
  if (renderDopMarkerResetRequested_.exchange(false, std::memory_order_acq_rel)) {
    renderDopMarkerIndex_ = 0;
  }

  const PipelineState state = renderState_.load(std::memory_order_acquire);
  DecodeStream* const active = renderActiveStream_.load(std::memory_order_acquire);
  const AudioFormat outputFormat = renderOutputFormat_;
  const bool typedPassthroughActive = renderTypedPassthroughActive_.load(std::memory_order_acquire);
  const bool nativeDsdPathActive = renderNativeDsdPathActive_.load(std::memory_order_acquire);
  const bool pcmToDsdPathActive = renderPcmToDsdPathActive_.load(std::memory_order_acquire);
  const bool dopPathActive = renderDopPathActive_.load(std::memory_order_acquire);
  // The only authoritative signal that this stream is a DSD transport. Plain
  // hi-rate 24-bit PCM is wire-identical to a DoP carrier, so the format alone
  // cannot decide: marker/idle writes into plain PCM destroy its top byte.
  const bool dsdTransportActive = dopPathActive || nativeDsdPathActive || pcmToDsdPathActive;

  if (state != PipelineState::Playing || !active) {
    if (typedPassthroughActive && output.byteSize > 0) {
      if (isDopCarrierFormat(output.format)) {
        if (dsdTransportActive) {
          finalizeDopCarrier(output, 0, &renderDopMarkerIndex_);
        } else {
          std::memset(output.data, 0, output.byteSize);
        }
      } else if (isDsdSampleFormat(output.format.sampleFormat)) {
        fillNativeDsdIdle(output, 0);
      } else {
        std::memset(output.data, 0, output.byteSize);
      }
    }
    spectrum_.tryResetCapture();
    recordPerformance();
    return typedPassthroughActive ? output.frames : 0;
  }

  if (pcmToDsdPathActive && pcmToDsdModulator_.configured()) {
    const AudioFormat decodeFormat = renderDecodeFormat_;
    const int channels = std::max(1, decodeFormat.channelCount);
    const int upsampleRatio = std::max(1, pcmToDsdModulator_.upsampleRatio());
    size_t pcmFramesWanted = 0;
    if (isDsdSampleFormat(output.format.sampleFormat)) {
      // Backend frame unit is one DSD byte (8 bits) per channel.
      pcmFramesWanted = (output.frames * 8) / static_cast<size_t>(upsampleRatio);
    } else {
      // DoP carrier: each sample packs 16 DSD bits → 2 DSD bytes.
      pcmFramesWanted = (output.frames * 16) / static_cast<size_t>(upsampleRatio);
    }
    if (pcmFramesWanted == 0) {
      fillDsdTransportIdle(output, &renderDopMarkerIndex_);
      recordPerformance();
      return output.frames;
    }
    const size_t scratchCapacity =
        pcmToDsdFloatScratch_.size() / static_cast<size_t>(std::max(1, channels));
    pcmFramesWanted = std::min(pcmFramesWanted, scratchCapacity);
    if (pcmFramesWanted == 0 || pcmToDsdChannelPtrs_.size() < static_cast<size_t>(channels)) {
      fillDsdTransportIdle(output, &renderDopMarkerIndex_);
      recordPerformance();
      return output.frames;
    }

    float* floatScratch = pcmToDsdFloatScratch_.data();
    size_t filled = 0;
    while (filled < pcmFramesWanted) {
      const size_t want = pcmFramesWanted - filled;
      float* segment = floatScratch + filled * static_cast<size_t>(channels);
      size_t read = active->readFloat(segment, want);
      if (read > 0) {
        DspChain* activeDsp = renderActiveDspGraph_.load(std::memory_order_acquire);
        if (activeDsp) activeDsp->process(segment, read);
        const double volume = loadAtomicDouble(appliedVolumeBits_, std::memory_order_acquire);
        if (std::abs(volume - 1.0) > kUnityVolumeEpsilon) {
          for (size_t i = 0; i < read * static_cast<size_t>(channels); ++i) {
            segment[i] = static_cast<float>(static_cast<double>(segment[i]) * volume);
          }
        }
        filled += read;
      }
      if (read < want) break;
    }

    if (filled == 0) {
      fillDsdTransportIdle(output, &renderDopMarkerIndex_);
      if (active->drained()) {
        ended_ = true;
        renderState_.store(PipelineState::Stopped, std::memory_order_release);
      }
      spectrum_.tryResetCapture();
      recordPerformance();
      return output.frames;
    }

    spectrum_.capture(floatScratch, filled, channels);
    const size_t bytesPerChannel = pcmToDsdModulator_.outputBytesPerChannel(filled);
    const size_t written = pcmToDsdModulator_.process(
        floatScratch, filled, pcmToDsdChannelPtrs_.data(), bytesPerChannel);
    if (written == 0) {
      fillDsdTransportIdle(output, &renderDopMarkerIndex_);
      recordPerformance();
      return output.frames;
    }

    renderedFrames_ += filled;
    if (isDsdSampleFormat(output.format.sampleFormat)) {
      DsdStreamInfo info;
      info.channelCount = channels;
      info.bitOrder = DsdBitOrder::MsbFirst;
      info.packing = DsdPacking::DsfPlanarBlocks;
      info.dsdSampleRate = pcmToDsdModulator_.dsdSampleRate();
      info.dsdRate = pcmToDsdModulator_.config().targetDsdRate;
      const size_t planarBytes = written * static_cast<size_t>(channels);
      const size_t framesOut = dsdBytesToInterleaved(
          pcmToDsdPlanarBytes_.data(),
          planarBytes,
          info,
          output.format.sampleFormat,
          &pcmToDsdInterleavedBytes_);
      const size_t copyFrames = std::min(framesOut, output.frames);
      const size_t copyBytes = copyFrames * static_cast<size_t>(channels);
      if (copyBytes > 0) {
        std::memcpy(output.data, pcmToDsdInterleavedBytes_.data(), std::min(copyBytes, output.byteSize));
      }
      if (copyFrames < output.frames) {
        fillNativeDsdIdle(output, copyFrames);
      }
      recordPerformance();
      return output.frames;
    }

    // DoP carrier packing from planar MSB-first DSD bytes.
    const size_t planarBytes = written * static_cast<size_t>(channels);
    const size_t carrierFrames =
        pcmToDsdDopPacker_.pack(pcmToDsdPlanarBytes_.data(), planarBytes, &pcmToDsdInterleavedBytes_);
    const size_t copyFrames = std::min(carrierFrames, output.frames);
    const size_t bytesPerFrame = audioFormatBytesPerFrame(output.format);
    const size_t copyBytes = copyFrames * bytesPerFrame;
    if (copyBytes > 0) {
      std::memcpy(output.data, pcmToDsdInterleavedBytes_.data(), std::min(copyBytes, output.byteSize));
    }
    finalizeDopCarrier(output, copyFrames, &renderDopMarkerIndex_);
    recordPerformance();
    return output.frames;
  }

  const bool outputMatches =
      isDsdSampleFormat(output.format.sampleFormat) || isDsdSampleFormat(outputFormat.sampleFormat)
          ? dsdFormatsExactMatch(output.format, outputFormat)
          : pcmFormatsExactMatch(output.format, outputFormat);
  const bool bufferMatches =
      isDsdSampleFormat(active->bufferFormat().sampleFormat) || isDsdSampleFormat(output.format.sampleFormat)
          ? dsdFormatsExactMatch(active->bufferFormat(), output.format)
          : pcmFormatsExactMatch(active->bufferFormat(), output.format);
  if (!typedPassthroughActive || !outputMatches || !bufferMatches) {
    if (typedPassthroughActive && dsdTransportActive &&
        (isDopCarrierFormat(output.format) || isDsdSampleFormat(output.format.sampleFormat))) {
      // Never expose all-zero or PCM fallback bytes at a DSD transport boundary.
      // Even on an unexpected typed-format mismatch, keep the DAC locked to a
      // canonical DoP carrier or the actual Native DSD wire-format idle byte.
      fillDsdTransportIdle(output, &renderDopMarkerIndex_);
      recordPerformance();
      return output.frames;
    }
    if (output.byteSize > 0) std::memset(output.data, 0, output.byteSize);
    recordPerformance();
    return 0;
  }

  const size_t read = active->read(output);
  if (isDopCarrierFormat(output.format)) {
    if (dsdTransportActive) {
      finalizeDopCarrier(output, read, &renderDopMarkerIndex_);
    }
  } else if (isDsdSampleFormat(output.format.sampleFormat) && read < output.frames) {
    fillNativeDsdIdle(output, read);
  }
  if (read > 0) {
    renderedFrames_ += dsdRenderedFrameUnits(read, output.format);
    if (nativeDsdPathActive || isDsdSampleFormat(output.format.sampleFormat)) {
      spectrum_.tryResetCapture();
    } else {
      const int channels = std::max(1, output.format.channelCount);
      const size_t visualizationSamples = read * static_cast<size_t>(channels);
      if (typedVisualizationScratch_.size() >= visualizationSamples) {
        PcmBlock captured = output;
        captured.frames = read;
        captured.byteSize = read * audioFormatBytesPerFrame(output.format);
        typedPcmToFloat(captured, typedVisualizationScratch_.data(), read);
        spectrum_.capture(typedVisualizationScratch_.data(), read, channels);
      } else {
        spectrum_.tryResetCapture();
      }
    }
  } else if (active->drained()) {
    ended_ = true;
    renderState_.store(PipelineState::Stopped, std::memory_order_release);
    spectrum_.tryResetCapture();
  } else {
    spectrum_.tryResetCapture();
  }

  const size_t result = (read > 0 || active->drained() || isDopCarrierFormat(output.format))
                            ? output.frames
                            : (nativeDsdPathActive || isDsdSampleFormat(output.format.sampleFormat) ? 0 : output.frames);
  recordPerformance();
  return result;
}

size_t AudioPipeline::render(float* output, size_t frameCount) {
  if (!output || frameCount == 0) return 0;
  enableDenormalFlushToZero();
  const auto renderStarted = std::chrono::steady_clock::now();
  const auto recordPerformance = [this, frameCount, renderStarted]() noexcept {
    const auto elapsed = std::chrono::steady_clock::now() - renderStarted;
    recordRenderPerformance(
        frameCount,
        renderOutputFormat_.sampleRate,
        static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count()));
  };
  applyPendingControlCommands();
  if (renderCrossfadeResetRequested_.exchange(false, std::memory_order_acq_rel)) {
    renderCrossfadeMixActive_ = false;
    renderCrossfadeFramesProcessed_ = 0;
    renderCrossfadeTotalFrames_ = 0;
  }
  if (renderDitherResetRequested_.exchange(false, std::memory_order_acq_rel)) {
    resetDitherState(renderDitherRandom_, renderDitherPreviousNoise_, renderDitherError_);
  }

  const PipelineState state = renderState_.load(std::memory_order_acquire);
  const AudioFormat outputFormat = renderOutputFormat_;
  const AudioFormat decodeFormat = renderDecodeFormat_;
  const int channels = std::max(1, outputFormat.channelCount);
  DecodeStream* active = renderActiveStream_.load(std::memory_order_acquire);
  DecodeStream* preload = renderPreloadStream_.load(std::memory_order_acquire);
  const double crossfadeSeconds = loadAtomicDouble(renderCrossfadeSecondsBits_, std::memory_order_acquire);
  const bool dopPathActive = renderDopPathActive_.load(std::memory_order_acquire);
  const bool nativeDsdPathActive = renderNativeDsdPathActive_.load(std::memory_order_acquire);
  bool activeUsesPreloadDspChain = renderActiveUsesPreloadDspChain_.load(std::memory_order_acquire);
  const ChannelRoutingMode routingMode =
      static_cast<ChannelRoutingMode>(renderRoutingMode_.load(std::memory_order_acquire));
  const double volume = loadAtomicDouble(appliedVolumeBits_, std::memory_order_acquire);
  const double playbackRate = loadAtomicDouble(appliedPlaybackRateBits_, std::memory_order_acquire);
  const bool rateActive =
      !dopPathActive && !nativeDsdPathActive && std::abs(playbackRate - 1.0) > kUnityVolumeEpsilon;
  bool crossfadeMixActive = renderCrossfadeMixActive_;
  uint64_t crossfadeFramesProcessed = renderCrossfadeFramesProcessed_;
  uint64_t crossfadeTotalFrames = renderCrossfadeTotalFrames_;

  if (state != PipelineState::Playing || !active) {
    std::fill(output, output + frameCount * static_cast<size_t>(channels), 0.0f);
    spectrum_.tryResetCapture();
    recordPerformance();
    return frameCount;
  }

  // Reset residual WSOLA state once when returning to unity rate.
  if (!rateActive && rateWsolaDirty_) {
    resetRateResampler();
  }

  // A declared CUE PREGAP is an exact-duration silence prefix. Consuming it as a crossfade
  // preload would hide part of that prefix underneath the previous track.
  const bool wantsCrossfade =
      crossfadeSeconds > 0.0001 && (!preload || !preload->hasVirtualPregap());
  DspChain* activeDspChain = renderActiveDspGraph_.load(std::memory_order_acquire);
  DspChain* preloadDspChain = renderPreloadDspGraph_.load(std::memory_order_acquire);
  size_t totalRead = 0;
  size_t positionRead = 0;
  std::array<size_t, 2> virtualSilenceSpanOffsets{};
  std::array<size_t, 2> virtualSilenceSpanFrames{};
  size_t virtualSilenceSpanCount = 0;

  // Shared pull of decoded/DSP/routed PCM frames into dest (output-channel interleaved).
  // Advances positionRead by source frames consumed. Handles gapless preload promote.
  const auto pullProcessedFrames = [&](float* dest, size_t requestedFrames) -> size_t {
    if (!active || !dest || requestedFrames == 0) return 0;
    size_t filled = 0;
    while (filled < requestedFrames) {
      const int decodeChannels = std::max(1, decodeFormat.channelCount);
      const bool routingRequired = !dopPathActive && !nativeDsdPathActive &&
                                   (decodeChannels != channels || routingMode != ChannelRoutingMode::Auto);

      size_t want = requestedFrames - filled;
      if (routingRequired) {
        want = std::min(want, routingScratch_.size() / static_cast<size_t>(decodeChannels));
      }
      if (want == 0) break;

      float* segment = dest + filled * static_cast<size_t>(channels);
      float* readBuffer = routingRequired ? routingScratch_.data() : segment;
      const size_t logicalFramePosition = renderedFrames_.load() + positionRead;
      const size_t virtualSilenceFrames = active->virtualPregapFramesFromLogicalFrame(
          logicalFramePosition,
          outputFormat.sampleRate,
          want);

      if (virtualSilenceFrames > 0 && !dopPathActive && !nativeDsdPathActive) {
        std::fill(
            segment,
            segment + virtualSilenceFrames * static_cast<size_t>(channels),
            0.0f);
        // Virtual silence spans only map 1:1 onto output when rate is unity.
        if (!rateActive && virtualSilenceSpanCount < virtualSilenceSpanOffsets.size()) {
          virtualSilenceSpanOffsets[virtualSilenceSpanCount] = totalRead + filled;
          virtualSilenceSpanFrames[virtualSilenceSpanCount] = virtualSilenceFrames;
          ++virtualSilenceSpanCount;
        }
        filled += virtualSilenceFrames;
        positionRead += virtualSilenceFrames;
        continue;
      }

      const size_t read = active->readFloat(readBuffer, want);
      if (read > 0 && !dopPathActive && !nativeDsdPathActive) {
        if (activeDspChain) activeDspChain->process(readBuffer, read);
        if (routingRequired) {
          channelRouter_.route(
              readBuffer,
              segment,
              read,
              decodeChannels,
              channels,
              routingMode);
        } else if (readBuffer != segment) {
          std::memcpy(segment, readBuffer, read * static_cast<size_t>(channels) * sizeof(float));
        }
      } else if (read > 0 && readBuffer != segment) {
        std::memcpy(segment, readBuffer, read * static_cast<size_t>(channels) * sizeof(float));
      }

      // Crossfade only for the unity-rate path; rate-path timeline math would be incorrect.
      if (!rateActive && wantsCrossfade && preload && preload->readyForRender() && outputFormat.sampleRate > 0) {
        const uint64_t crossfadeRequestedFrames =
            static_cast<uint64_t>(std::max(1.0, crossfadeSeconds * static_cast<double>(outputFormat.sampleRate)));
        if (!crossfadeMixActive) {
          // Unknown duration (radio / live streams report 0): never engage the
          // overlap, or the preload being ready alone would fade the current
          // (endless) stream out mid-track.
          const bool hasKnownDuration = active->stream.durationSeconds > 0.0;
          const double secondsRemaining =
              hasKnownDuration
                  ? std::max(0.0, active->stream.durationSeconds -
                                       (static_cast<double>(renderedFrames_.load() + positionRead + read) /
                                        static_cast<double>(outputFormat.sampleRate)))
                  : 0.0;
          if (hasKnownDuration && secondsRemaining <= crossfadeSeconds + 0.02) {
            crossfadeMixActive = true;
            crossfadeFramesProcessed = 0;
            crossfadeTotalFrames = crossfadeRequestedFrames;
            renderCrossfadeMixActive_ = true;
            renderCrossfadeFramesProcessed_ = 0;
            renderCrossfadeTotalFrames_ = crossfadeRequestedFrames;
          }
        }

        if (crossfadeMixActive) {
          const size_t preloadSampleCount = read * static_cast<size_t>(channels);
          const bool crossfadeScratchReady =
              preloadMixScratch_.size() >= preloadSampleCount &&
              (!routingRequired || preloadRoutingScratch_.size() >= read * static_cast<size_t>(decodeChannels));
          if (crossfadeScratchReady) {
            float* preloadReadBuffer = routingRequired ? preloadRoutingScratch_.data() : preloadMixScratch_.data();
            const size_t mixedFrames = preload->readFloat(preloadReadBuffer, read);
            if (mixedFrames > 0 && !dopPathActive) {
              if (preloadDspChain) preloadDspChain->process(preloadReadBuffer, mixedFrames);
              if (routingRequired) {
                channelRouter_.route(
                    preloadReadBuffer,
                    preloadMixScratch_.data(),
                    mixedFrames,
                    decodeChannels,
                    channels,
                    routingMode);
              }
              render::mixCrossfadeSegment(
                  segment,
                  preloadMixScratch_.data(),
                  mixedFrames,
                  channels,
                  crossfadeFramesProcessed,
                  crossfadeTotalFrames);
              crossfadeFramesProcessed += mixedFrames;
              renderCrossfadeFramesProcessed_ = crossfadeFramesProcessed;
            }
          }
        }
      }

      filled += read;
      positionRead += read;

      if (filled >= requestedFrames || !active->drained()) break;

      const bool canPromotePreload = preload && preload->readyForRender();
      if ((!renderGaplessEnabled_.load(std::memory_order_acquire) && !renderCrossfadeMixActive_) ||
          !canPromotePreload) {
        break;
      }
      active = preload;
      preload = nullptr;
      renderActiveStream_.store(active, std::memory_order_release);
      renderPreloadStream_.store(nullptr, std::memory_order_release);
      renderedFrames_ = 0;
      renderVolumeCurrentBits_.store(doubleBits(-1.0), std::memory_order_relaxed);
      positionRead = 0;
      resetRateResampler();
      ended_ = false;
      trackStarted_ = true;
      activeUsesPreloadDspChain = !activeUsesPreloadDspChain;
      renderActiveUsesPreloadDspChain_.store(activeUsesPreloadDspChain, std::memory_order_release);
      renderPromotionPending_.store(true, std::memory_order_release);
      activeDspChain = preloadDspChain;
      preloadDspChain = nullptr;
      renderActiveDspGraph_.store(activeDspChain, std::memory_order_release);
      renderPreloadDspGraph_.store(nullptr, std::memory_order_release);
      crossfadeMixActive = false;
      crossfadeFramesProcessed = 0;
      crossfadeTotalFrames = 0;
      renderCrossfadeMixActive_ = false;
      renderCrossfadeFramesProcessed_ = 0;
      renderCrossfadeTotalFrames_ = 0;
    }
    return filled;
  };

  if (rateActive && rateWsolaReady_) {
    // Rate path: WSOLA pitch-preserving time stretch. Pull post-DSP frames on demand.
    // prepare()/resize must only run on the control path (prepareRenderScratchLocked).
    const size_t ch = static_cast<size_t>(channels);
    rateWsola_.setRate(playbackRate);
    rateWsolaDirty_ = true;
    totalRead = rateWsola_.process(output, frameCount, [&](float* dst, size_t maxFrames) -> size_t {
      return pullProcessedFrames(dst, maxFrames);
    });
    if (totalRead < frameCount) {
      std::fill(
          output + totalRead * ch,
          output + frameCount * ch,
          0.0f);
    }
  } else {
    // Unity-rate path: pull exact frameCount frames straight into the output buffer.
    totalRead = pullProcessedFrames(output, frameCount);
    if (totalRead < frameCount) {
      std::fill(
          output + totalRead * static_cast<size_t>(channels),
          output + frameCount * static_cast<size_t>(channels),
          0.0f);
    }
  }

  if (!dopPathActive) {
    const double previousGain = doubleFromBits(renderVolumeCurrentBits_.load(std::memory_order_relaxed));
    const double from = previousGain >= 0.0 ? previousGain : volume;
    renderVolumeCurrentBits_.store(doubleBits(volume), std::memory_order_relaxed);
    if (std::abs(volume - 1.0) > 0.0001 || std::abs(from - 1.0) > 0.0001) {
      // On the rate path totalRead is filled output frames (may be < frameCount
      // on underrun); gain only applies to real samples.
      const size_t volumeFrames = std::min(totalRead > 0 ? totalRead : frameCount, frameCount);
      if (std::abs(volume - from) <= 0.0005) {
        render::applyVolumeToRenderedFrames(output, volumeFrames, frameCount, channels, volume);
      } else if (volumeFrames > 0) {
        // Block-step gain changes zipper on every slider move; ramp linearly
        // from the last applied gain to the new target across this block.
        const double step = (volume - from) / static_cast<double>(volumeFrames);
        double gain = from;
        for (size_t frame = 0; frame < volumeFrames; ++frame) {
          for (int channel = 0; channel < channels; ++channel) {
            const size_t index = frame * static_cast<size_t>(channels) + static_cast<size_t>(channel);
            output[index] = static_cast<float>(
                std::clamp(static_cast<double>(output[index]) * gain, -1.0, 1.0));
          }
          gain += step;
        }
      }
    }
  }
  if (!dopPathActive && !nativeDsdPathActive) {
    const auto mode = static_cast<DspDitherMode>(renderDitherMode_.load(std::memory_order_acquire));
    applyOutputDither(
        output,
        totalRead > 0 ? totalRead : frameCount,
        channels,
        outputFormat,
        mode,
        renderDitherRandom_,
        renderDitherPreviousNoise_,
        renderDitherError_);
    // Give back the DSP chain's +12 dB internal headroom. The volume clamp above
    // only runs when volume != 1.0, and dither returns early for float32 output,
    // so without this a unity-volume EQ boost reached the driver unclamped.
    // Mirrors the dither guard: DSD transports are never touched here.
    render::clampRenderedFramesToFullScale(output, totalRead > 0 ? totalRead : frameCount, channels);
  }
  // ReplayGain, routing, and integer-output dither must never turn a virtual pregap into noise.
  for (size_t span = 0; span < virtualSilenceSpanCount; ++span) {
    const size_t offset = virtualSilenceSpanOffsets[span] * static_cast<size_t>(channels);
    const size_t samples = virtualSilenceSpanFrames[span] * static_cast<size_t>(channels);
    std::fill(output + offset, output + offset + samples, 0.0f);
  }

  if (positionRead > 0) {
    // renderedFrames_ counts source frames consumed — correct position when rate != 1.
    renderedFrames_ += positionRead;
  }
  if (totalRead > 0) {
    spectrum_.capture(output, totalRead, channels);
  } else if (active->drained() && (!rateActive || totalRead == 0)) {
    // Rate path ends when the source is drained and WSOLA could not emit more frames
    // (OLA tail already flushed / no full grain left).
    ended_ = true;
    renderState_.store(PipelineState::Stopped, std::memory_order_release);
    spectrum_.tryResetCapture();
  } else {
    spectrum_.tryResetCapture();
  }

  recordPerformance();
  return frameCount;
}

}  // namespace twilight::audio
