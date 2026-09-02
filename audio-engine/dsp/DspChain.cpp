#include "DspChain.h"
#include "DspChainActiveUtils.h"
#include "../utils/JsonUtils.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <optional>
#include <sstream>
#include <unordered_set>

namespace twilight::audio {
namespace {

std::string toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string trim(std::string value) {
  const auto notSpace = [](unsigned char ch) { return std::isspace(ch) == 0; };
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), notSpace));
  value.erase(std::find_if(value.rbegin(), value.rend(), notSpace).base(), value.end());
  return value;
}

std::optional<std::string> extractStringField(const std::string& json, const std::string& key) {
  return json_utils::fieldString(json, key);
}

std::optional<double> extractNumberField(const std::string& json, const std::string& key) {
  return json_utils::fieldNumber(json, key);
}

std::optional<bool> extractBoolField(const std::string& json, const std::string& key) {
  return json_utils::fieldBool(json, key);
}

std::vector<std::string> splitTopLevelObjects(const std::string& json) {
  return json_utils::splitTopLevelObjects(json);
}

std::string extractArrayField(const std::string& json, const std::string& key) {
  return json_utils::fieldArray(json, key);
}

ReplayGainMode parseReplayGainMode(const std::string& mode) {
  const std::string normalized = toLower(mode);
  if (normalized == "track") return ReplayGainMode::Track;
  if (normalized == "album") return ReplayGainMode::Album;
  if (normalized == "loudnorm") return ReplayGainMode::Loudnorm;
  return ReplayGainMode::Off;
}

DsdOutputMode parseDsdOutputMode(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "pcm") return DsdOutputMode::Pcm;
  if (normalized == "dop") return DsdOutputMode::Dop;
  if (normalized == "native") return DsdOutputMode::Native;
  return DsdOutputMode::Auto;
}

DsdRatePolicy parseDsdRatePolicy(const std::string& policy) {
  const std::string normalized = toLower(policy);
  if (normalized == "exact") return DsdRatePolicy::Exact;
  if (normalized == "downrate") return DsdRatePolicy::Downrate;
  return DsdRatePolicy::PcmFallback;
}

DsdRouteOverride parseDsdRouteOverride(const std::string& json) {
  DsdRouteOverride route;
  const std::string object = json_utils::fieldObject(json, "dsdRoute");
  if (object.empty()) return route;
  route.enabled = extractBoolField(object, "enabled").value_or(false);
  route.backendId = trim(extractStringField(object, "backend").value_or(""));
  route.deviceId = trim(extractStringField(object, "device").value_or(""));
  route.applyToPcmToDsd = extractBoolField(object, "applyToPcmToDsd").value_or(true);
  route.strictPassthrough = extractBoolField(object, "strictPassthrough").value_or(false);
  return route;
}

SacdProgramMode parseSacdProgramMode(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "stereo") return SacdProgramMode::Stereo;
  if (normalized == "multichannel") return SacdProgramMode::Multichannel;
  return SacdProgramMode::Auto;
}

CrossfeedAlgorithm parseCrossfeedAlgorithm(const std::string& algorithm) {
  const std::string normalized = toLower(algorithm);
  if (normalized == "bauer") return CrossfeedAlgorithm::Bauer;
  if (normalized == "bs2b") return CrossfeedAlgorithm::Bs2b;
  if (normalized == "meier") return CrossfeedAlgorithm::Meier;
  return CrossfeedAlgorithm::Custom;
}

EqMode parseEqMode(const std::string& mode) {
  return toLower(mode) == "parametric" ? EqMode::Parametric : EqMode::Graphic;
}

DspFilterType parseFilterType(const std::string& type) {
  const std::string normalized = toLower(type);
  if (normalized == "lowshelf") return DspFilterType::LowShelf;
  if (normalized == "highshelf") return DspFilterType::HighShelf;
  if (normalized == "lowpass") return DspFilterType::LowPass;
  if (normalized == "highpass") return DspFilterType::HighPass;
  if (normalized == "bandpass") return DspFilterType::BandPass;
  if (normalized == "allpass") return DspFilterType::AllPass;
  if (normalized == "notch") return DspFilterType::Notch;
  return DspFilterType::Peak;
}

DspResamplerQuality parseResamplerQuality(const std::string& quality) {
  const std::string normalized = toLower(quality);
  if (normalized == "high") return DspResamplerQuality::High;
  if (normalized == "ultra") return DspResamplerQuality::Ultra;
  if (normalized == "soxrhq") return DspResamplerQuality::SoxrHq;
  if (normalized == "soxrvhq") return DspResamplerQuality::SoxrVhq;
  // Unknown soxr-family values still request maximum quality: fall back to
  // the strongest built-in swr tier instead of silently dropping to native.
  if (normalized.rfind("soxr", 0) == 0) return DspResamplerQuality::Ultra;
  return DspResamplerQuality::Native;
}

DspDitherMode parseDitherMode(const std::string& mode) {
  const std::string normalized = toLower(mode);
  if (normalized == "tpdf") return DspDitherMode::Tpdf;
  if (normalized == "highpasstpdf") return DspDitherMode::HighpassTpdf;
  if (normalized == "noiseshaped") return DspDitherMode::NoiseShaped;
  return DspDitherMode::Off;
}

std::vector<DspEqBand> parseEqBands(const std::string& json, EqMode mode) {
  std::vector<DspEqBand> bands;
  const std::string arrayJson = extractArrayField(json, "eqBands");
  for (const std::string& object : splitTopLevelObjects(arrayJson)) {
    DspEqBand band;
    band.frequency = extractNumberField(object, "frequency").value_or(band.frequency);
    band.gainDb = extractNumberField(object, "gain").value_or(0.0);
    band.q = extractNumberField(object, "q").value_or(1.0);
    band.enabled = extractBoolField(object, "enabled").value_or(true);
    band.channelMask = static_cast<uint32_t>(std::clamp(
        extractNumberField(object, "channelMask").value_or(static_cast<double>(band.channelMask)),
        0.0,
        static_cast<double>(UINT32_MAX)));
    band.type = mode == EqMode::Graphic
                    ? DspFilterType::Peak
                    : parseFilterType(extractStringField(object, "filterType").value_or("peak"));
    bands.push_back(band);
  }
  return bands;
}

std::vector<double> parseNumberArray(const std::string& json) {
  std::vector<double> values;
  bool inString = false;
  bool escaped = false;
  for (size_t index = 0; index < json.size();) {
    const char ch = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        inString = false;
      }
      ++index;
      continue;
    }
    if (ch == '"') {
      inString = true;
      ++index;
      continue;
    }
    if (std::isdigit(static_cast<unsigned char>(ch)) || ch == '-' || ch == '+') {
      char* end = nullptr;
      const double value = std::strtod(json.c_str() + index, &end);
      if (end != json.c_str() + index) {
        values.push_back(value);
        index = static_cast<size_t>(end - json.c_str());
        continue;
      }
    }
    ++index;
  }
  return values;
}

std::vector<DspConfig::ChannelStripChannel> parseChannelStripChannels(const std::string& json) {
  std::vector<DspConfig::ChannelStripChannel> channels;
  for (const std::string& item : splitTopLevelObjects(extractArrayField(json, "channels"))) {
    DspConfig::ChannelStripChannel channel;
    channel.gainDb = std::clamp(extractNumberField(item, "gainDb").value_or(0.0), -60.0, 24.0);
    channel.delayMs = std::clamp(extractNumberField(item, "delayMs").value_or(0.0), 0.0, 250.0);
    channel.polarityInverted = extractBoolField(item, "polarityInverted").value_or(
        extractBoolField(item, "polarity").value_or(false));
    channel.muted = extractBoolField(item, "mute").value_or(extractBoolField(item, "muted").value_or(false));
    channels.push_back(channel);
  }
  return channels;
}

std::vector<DspDynamicEqBand> parseDynamicEqBands(const std::string& json) {
  std::vector<DspDynamicEqBand> bands;
  for (const std::string& object : splitTopLevelObjects(extractArrayField(json, "bands"))) {
    if (bands.size() >= 8) break;
    DspDynamicEqBand band;
    band.frequency = std::clamp(extractNumberField(object, "frequency").value_or(band.frequency), 10.0, 96000.0);
    band.gainDb = std::clamp(
        extractNumberField(object, "gainDb").value_or(extractNumberField(object, "gain").value_or(band.gainDb)),
        -24.0,
        24.0);
    band.q = std::clamp(extractNumberField(object, "q").value_or(band.q), 0.1, 20.0);
    band.thresholdDb = std::clamp(extractNumberField(object, "thresholdDb").value_or(band.thresholdDb), -100.0, 0.0);
    band.ratio = std::clamp(extractNumberField(object, "ratio").value_or(band.ratio), 1.0, 20.0);
    band.rangeDb = std::clamp(extractNumberField(object, "rangeDb").value_or(band.rangeDb), -24.0, 24.0);
    band.attackMs = std::clamp(extractNumberField(object, "attackMs").value_or(band.attackMs), 0.1, 1000.0);
    band.releaseMs = std::clamp(extractNumberField(object, "releaseMs").value_or(band.releaseMs), 1.0, 5000.0);
    band.type = parseFilterType(extractStringField(object, "filterType").value_or("peak"));
    band.enabled = extractBoolField(object, "enabled").value_or(true);
    band.channelMask = static_cast<uint32_t>(std::clamp(
        extractNumberField(object, "channelMask").value_or(static_cast<double>(band.channelMask)),
        0.0,
        static_cast<double>(UINT32_MAX)));
    bands.push_back(band);
  }
  return bands;
}

std::vector<DspMultibandCompressorBand> parseMultibandCompressorBands(const std::string& json) {
  std::vector<DspMultibandCompressorBand> bands;
  for (const std::string& object : splitTopLevelObjects(extractArrayField(json, "bands"))) {
    if (bands.size() >= 4) break;
    DspMultibandCompressorBand band;
    band.thresholdDb = std::clamp(extractNumberField(object, "thresholdDb").value_or(band.thresholdDb), -80.0, 0.0);
    band.ratio = std::clamp(extractNumberField(object, "ratio").value_or(band.ratio), 1.0, 20.0);
    band.attackMs = std::clamp(extractNumberField(object, "attackMs").value_or(band.attackMs), 0.1, 1000.0);
    band.releaseMs = std::clamp(extractNumberField(object, "releaseMs").value_or(band.releaseMs), 1.0, 5000.0);
    band.makeupDb = std::clamp(extractNumberField(object, "makeupDb").value_or(band.makeupDb), -24.0, 24.0);
    band.enabled = extractBoolField(object, "enabled").value_or(true);
    bands.push_back(band);
  }
  return bands;
}

std::string graphNodeType(const std::string& object) {
  return toLower(extractStringField(object, "type").value_or(""));
}

bool graphNodeRequiresUniqueProcessor(const std::string& type) {
  return type == "replaygain" || type == "equalizer" || type == "dynamicequalizer" ||
         type == "convolver" || type == "crossfeed" || type == "channelmatrix" ||
         type == "channelstrip" || type == "bassmanagement" || type == "gate" ||
         type == "compressor" || type == "multibandcompressor" || type == "stereofield" ||
         type == "loudnesscontour" || type == "truepeaklimiter" || type == "meter";
}

const char* resamplerQualityName(DspResamplerQuality quality) {
  switch (quality) {
    case DspResamplerQuality::High:
      return "high";
    case DspResamplerQuality::Ultra:
      return "ultra";
    case DspResamplerQuality::SoxrHq:
      return "soxrHq";
    case DspResamplerQuality::SoxrVhq:
      return "soxrVhq";
    case DspResamplerQuality::Native:
    default:
      return "native";
  }
}

bool resamplerQualityUsesSoxr(DspResamplerQuality quality) {
  return quality == DspResamplerQuality::SoxrHq || quality == DspResamplerQuality::SoxrVhq;
}

// Honest status: engine actually in effect for the requested quality tier.
const char* resamplerEngineName(DspResamplerQuality quality) {
  if (!resamplerQualityUsesSoxr(quality)) return "swr";
  return soxrRuntimeAvailability() == SoxrRuntimeState::Unavailable ? "swr" : "soxr";
}

const char* ditherModeName(DspDitherMode mode) {
  switch (mode) {
    case DspDitherMode::Tpdf:
      return "tpdf";
    case DspDitherMode::HighpassTpdf:
      return "highpassTpdf";
    case DspDitherMode::NoiseShaped:
      return "noiseShaped";
    case DspDitherMode::Off:
    default:
      return "off";
  }
}

void writeFiniteJsonNumber(std::ostringstream& json, double value) {
  if (std::isfinite(value)) {
    json << value;
  } else {
    json << "null";
  }
}

}  // namespace

DspChain::DspChain() {
  auto replayGain = std::make_unique<ReplayGainProcessor>();
  replayGain_ = replayGain.get();
  processors_.push_back(std::move(replayGain));

  auto eq = std::make_unique<ParametricEqProcessor>();
  eq_ = eq.get();
  processors_.push_back(std::move(eq));

  auto dynamicEq = std::make_unique<DynamicEqProcessor>();
  dynamicEq_ = dynamicEq.get();
  processors_.push_back(std::move(dynamicEq));

  auto convolver = std::make_unique<ConvolverProcessor>();
  convolver_ = convolver.get();
  processors_.push_back(std::move(convolver));

  auto crossfeed = std::make_unique<CrossfeedProcessor>();
  crossfeed_ = crossfeed.get();
  processors_.push_back(std::move(crossfeed));

  auto channelMatrix = std::make_unique<ChannelMatrixProcessor>();
  channelMatrix_ = channelMatrix.get();
  processors_.push_back(std::move(channelMatrix));

  auto channelStrip = std::make_unique<ChannelStripProcessor>();
  channelStrip_ = channelStrip.get();
  processors_.push_back(std::move(channelStrip));

  auto bassManagement = std::make_unique<BassManagementProcessor>();
  bassManagement_ = bassManagement.get();
  processors_.push_back(std::move(bassManagement));

  auto gate = std::make_unique<DynamicsProcessor>(DynamicsMode::Gate);
  gate_ = gate.get();
  processors_.push_back(std::move(gate));

  auto compressor = std::make_unique<DynamicsProcessor>(DynamicsMode::Compressor);
  compressor_ = compressor.get();
  processors_.push_back(std::move(compressor));

  auto multibandCompressor = std::make_unique<MultibandCompressorProcessor>();
  multibandCompressor_ = multibandCompressor.get();
  processors_.push_back(std::move(multibandCompressor));

  auto stereoField = std::make_unique<StereoFieldProcessor>();
  stereoField_ = stereoField.get();
  processors_.push_back(std::move(stereoField));

  auto loudnessContour = std::make_unique<LoudnessContourProcessor>();
  loudnessContour_ = loudnessContour.get();
  processors_.push_back(std::move(loudnessContour));

  auto truePeakLimiter = std::make_unique<DynamicsProcessor>(DynamicsMode::TruePeakLimiter);
  truePeakLimiter_ = truePeakLimiter.get();
  processors_.push_back(std::move(truePeakLimiter));

  auto meter = std::make_unique<LoudnessMeterProcessor>();
  meter_ = meter.get();
  processors_.push_back(std::move(meter));

  auto nativePlugins = std::make_unique<PluginRegistry>();
  nativePlugins_ = nativePlugins.get();
  processors_.push_back(std::move(nativePlugins));
}

void DspChain::configure(const DspConfig& config) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  graphConfigured_ = false;
  graphNodes_.clear();
  graphPluginNodes_.clear();
  graphVst3Nodes_.clear();
  graphSceneId_.clear();
  DspConfig next = config;
  if (next.impulseResponsePath.empty() && !next.convolverEnabled) {
    next.impulseResponsePath = config_.impulseResponsePath;
    next.convolverEnabled = config_.convolverEnabled;
  }
  config_ = next;
  for (auto& processor : processors_) {
    processor->configure(config_);
    processor->prepare(format_);
    processor->setTrackContext(trackContext_);
  }
  refreshStatusLocked();
}

void DspChain::configureFromJson(const std::string& json) {
  configure(parseConfigJson(json));
}

bool DspChain::configureGraphJson(const std::string& json, std::string* error) {
  const std::string graphJson = json_utils::fieldObject(json, "graph");
  const std::string root = graphJson.empty() ? json : graphJson;
  const std::string nodeArray = extractArrayField(root, "nodes");
  const uint64_t revision = static_cast<uint64_t>(std::max(0.0, extractNumberField(json, "revision").value_or(0.0)));
  const std::string sceneId = extractStringField(json, "sceneId").value_or("");
  const std::string processing = json_utils::fieldObject(json, "processing");
  const bool graphProcessingEnabled = extractBoolField(processing, "dspEnabled").value_or(
      extractBoolField(json, "dspEnabled").value_or(true));
  std::lock_guard lock(mutex_);

  DspConfig next = config_;
  next.enabled = false;
  next.replayGainMode = ReplayGainMode::Off;
  next.eqEnabled = false;
  next.convolverEnabled = false;
  next.crossfeedEnabled = false;
  next.channelMatrixEnabled = false;
  next.channelStripEnabled = false;
  next.bassManagementEnabled = false;
  next.gateEnabled = false;
  next.compressorEnabled = false;
  next.dynamicEqEnabled = false;
  next.multibandCompressorEnabled = false;
  next.stereoFieldEnabled = false;
  next.loudnessContourEnabled = false;
  next.truePeakLimiterEnabled = false;
  next.meterEnabled = false;
  next.eqBands.clear();
  next.dynamicEqBands.clear();
  next.multibandCrossoversHz.clear();
  next.multibandCompressorBands.clear();
  next.impulseResponsePath.clear();
  next.convolverWet = 1.0;
  next.convolverDry = 0.0;
  next.convolverGainDb = 0.0;
  next.convolverPolarityInverted = false;
  next.convolverDelayMs = 0.0;
  next.convolverPartitionSize = 0;
  next.convolverMatrix.clear();
  next.channelMatrix.clear();
  next.channelStripChannels.clear();
  next.outputTargetSampleRate = 0;
  next.resamplerQuality = DspResamplerQuality::Native;
  next.ditherMode = DspDitherMode::Off;
  next.outputSafetyClamp = true;

  const std::string outputStage = json_utils::fieldObject(root, "outputStage");
  if (!outputStage.empty()) {
    next.outputTargetSampleRate = static_cast<int>(std::clamp(
        extractNumberField(outputStage, "targetSampleRate").value_or(0.0), 0.0, 384000.0));
    next.resamplerQuality = parseResamplerQuality(
        extractStringField(outputStage, "resamplerQuality").value_or("native"));
    next.ditherMode = parseDitherMode(extractStringField(outputStage, "dither").value_or("off"));
    next.outputSafetyClamp = extractBoolField(outputStage, "safetyClamp").value_or(true);
  }

  std::vector<GraphNodeRuntime> nodes;
  std::vector<std::unique_ptr<PluginRegistry>> graphPlugins;
  std::vector<std::unique_ptr<Vst3BridgeProcessor>> graphVst3Nodes;
  std::unordered_set<std::string> singletonNodeTypes;
  for (const std::string& object : splitTopLevelObjects(nodeArray)) {
    GraphNodeRuntime runtime;
    runtime.id = extractStringField(object, "id").value_or("");
    runtime.type = graphNodeType(object);
    runtime.enabled = extractBoolField(object, "enabled").value_or(true);
    if (!graphProcessingEnabled && runtime.enabled) {
      runtime.enabled = false;
      runtime.bypassReason = "DSP master bypass is active";
    }
    const std::string params = json_utils::fieldObject(object, "params");
    if (runtime.id.empty()) runtime.id = runtime.type;
    if (graphNodeRequiresUniqueProcessor(runtime.type) &&
        !singletonNodeTypes.insert(runtime.type).second) {
      runtime.bypassReason = "Only one " + runtime.type + " node is supported in a serial graph";
      nodes.push_back(std::move(runtime));
      continue;
    }
    if (runtime.type == "replaygain") {
      runtime.processor = replayGain_;
      next.replayGainMode = parseReplayGainMode(extractStringField(params, "mode").value_or("off"));
      next.replayGainPreampDb = std::clamp(extractNumberField(params, "preampDb").value_or(0.0), -24.0, 24.0);
      next.replayGainFallbackDb = std::clamp(extractNumberField(params, "fallbackDb").value_or(0.0), -24.0, 24.0);
      next.replayGainClip = extractBoolField(params, "clip").value_or(true);
      next.loudnormTargetLufs =
          std::clamp(extractNumberField(params, "targetLufs").value_or(-23.0), -70.0, 0.0);
      next.loudnormTruePeakCeilingDb =
          std::clamp(extractNumberField(params, "truePeakCeilingDb").value_or(-1.0), -12.0, 0.0);
      if (!runtime.enabled) next.replayGainMode = ReplayGainMode::Off;
    } else if (runtime.type == "equalizer") {
      runtime.processor = eq_;
      next.eqEnabled = runtime.enabled;
      next.eqMode = parseEqMode(extractStringField(params, "mode").value_or("parametric"));
      next.eqPreampDb = std::clamp(extractNumberField(params, "preampDb").value_or(0.0), -24.0, 24.0);
      next.eqBands = parseEqBands("{\"eqBands\":" + extractArrayField(params, "bands") + "}", next.eqMode);
    } else if (runtime.type == "dynamicequalizer") {
      runtime.processor = dynamicEq_;
      next.dynamicEqEnabled = runtime.enabled;
      next.dynamicEqBands = parseDynamicEqBands(params);
      if (next.dynamicEqBands.empty()) runtime.bypassReason = "Dynamic EQ requires one to eight bands";
    } else if (runtime.type == "convolver") {
      runtime.processor = convolver_;
      next.convolverEnabled = runtime.enabled;
      next.impulseResponsePath = extractStringField(params, "impulseResponsePath").value_or("");
      next.convolverWet = std::clamp(extractNumberField(params, "wet").value_or(1.0), 0.0, 1.0);
      next.convolverDry = std::clamp(extractNumberField(params, "dry").value_or(0.0), 0.0, 1.0);
      next.convolverGainDb = std::clamp(extractNumberField(params, "gainDb").value_or(0.0), -60.0, 24.0);
      next.convolverPolarityInverted = extractBoolField(params, "polarityInverted").value_or(
          extractBoolField(params, "polarity").value_or(false));
      next.convolverDelayMs = std::clamp(extractNumberField(params, "delayMs").value_or(0.0), 0.0, 250.0);
      next.convolverPartitionSize = static_cast<uint32_t>(std::clamp(
          extractNumberField(params, "partitionSize").value_or(0.0), 0.0, 8192.0));
      next.convolverMatrix = parseNumberArray(extractArrayField(params, "matrix"));
    } else if (runtime.type == "crossfeed") {
      runtime.processor = crossfeed_;
      next.crossfeedEnabled = runtime.enabled;
      next.crossfeedAlgorithm = parseCrossfeedAlgorithm(extractStringField(params, "algorithm").value_or("custom"));
      next.crossfeedStrength = std::clamp(extractNumberField(params, "strength").value_or(0.0), 0.0, 1.0);
      next.crossfeedDelayMs = std::clamp(extractNumberField(params, "delayMs").value_or(0.35), 0.05, 2.0);
      next.crossfeedCutoffHz = std::clamp(extractNumberField(params, "cutoffHz").value_or(700.0), 80.0, 4000.0);
    } else if (runtime.type == "channelmatrix") {
      runtime.processor = channelMatrix_;
      next.channelMatrixEnabled = runtime.enabled;
      next.channelMatrix = parseNumberArray(extractArrayField(params, "matrix"));
    } else if (runtime.type == "channelstrip") {
      runtime.processor = channelStrip_;
      next.channelStripEnabled = runtime.enabled;
      next.channelStripChannels = parseChannelStripChannels(params);
    } else if (runtime.type == "bassmanagement") {
      runtime.processor = bassManagement_;
      next.bassManagementEnabled = runtime.enabled;
      next.bassCrossoverHz = std::clamp(extractNumberField(params, "crossoverHz").value_or(80.0), 20.0, 500.0);
      next.bassLfeGainDb = std::clamp(extractNumberField(params, "lfeGainDb").value_or(0.0), -24.0, 12.0);
      next.bassRedirectLfe = extractBoolField(params, "redirectLfe").value_or(true);
    } else if (runtime.type == "gate") {
      runtime.processor = gate_;
      next.gateEnabled = runtime.enabled;
      next.gateThresholdDb = std::clamp(extractNumberField(params, "thresholdDb").value_or(-60.0), -100.0, 0.0);
      next.gateAttackMs = std::clamp(extractNumberField(params, "attackMs").value_or(2.0), 0.1, 1000.0);
      next.gateReleaseMs = std::clamp(extractNumberField(params, "releaseMs").value_or(120.0), 1.0, 5000.0);
    } else if (runtime.type == "compressor") {
      runtime.processor = compressor_;
      next.compressorEnabled = runtime.enabled;
      next.compressorThresholdDb = std::clamp(extractNumberField(params, "thresholdDb").value_or(-18.0), -80.0, 0.0);
      next.compressorRatio = std::clamp(extractNumberField(params, "ratio").value_or(2.0), 1.0, 20.0);
      next.compressorAttackMs = std::clamp(extractNumberField(params, "attackMs").value_or(15.0), 0.1, 1000.0);
      next.compressorReleaseMs = std::clamp(extractNumberField(params, "releaseMs").value_or(180.0), 1.0, 5000.0);
      next.compressorMakeupDb = std::clamp(extractNumberField(params, "makeupDb").value_or(0.0), -24.0, 24.0);
    } else if (runtime.type == "multibandcompressor") {
      runtime.processor = multibandCompressor_;
      next.multibandCompressorEnabled = runtime.enabled;
      next.multibandCompressorBands = parseMultibandCompressorBands(params);
      next.multibandCrossoversHz = parseNumberArray(extractArrayField(params, "crossoversHz"));
      if (next.multibandCrossoversHz.empty()) {
        next.multibandCrossoversHz = parseNumberArray(extractArrayField(params, "crossovers"));
      }
      if (next.multibandCompressorBands.size() < 2 ||
          next.multibandCrossoversHz.size() + 1 < next.multibandCompressorBands.size()) {
        runtime.bypassReason = "Multiband compressor requires two to four bands and matching crossovers";
      }
    } else if (runtime.type == "stereofield") {
      runtime.processor = stereoField_;
      next.stereoFieldEnabled = runtime.enabled;
      next.stereoWidth = std::clamp(extractNumberField(params, "width").value_or(1.0), 0.0, 2.0);
      next.stereoBalance = std::clamp(extractNumberField(params, "balance").value_or(0.0), -1.0, 1.0);
      next.stereoMidGainDb = std::clamp(extractNumberField(params, "midGainDb").value_or(0.0), -24.0, 24.0);
      next.stereoSideGainDb = std::clamp(extractNumberField(params, "sideGainDb").value_or(0.0), -24.0, 24.0);
      next.stereoSwap = extractBoolField(params, "swap").value_or(false);
      next.stereoMono = extractBoolField(params, "mono").value_or(false);
      next.stereoInvertLeft = extractBoolField(params, "invertLeft").value_or(false);
      next.stereoInvertRight = extractBoolField(params, "invertRight").value_or(false);
    } else if (runtime.type == "loudnesscontour") {
      runtime.processor = loudnessContour_;
      next.loudnessContourEnabled = runtime.enabled;
      next.loudnessContourAmount = std::clamp(extractNumberField(params, "amount").value_or(0.0), 0.0, 1.0);
      next.loudnessReferenceVolume = std::clamp(extractNumberField(params, "referenceVolume").value_or(0.75), 0.0, 1.0);
    } else if (runtime.type == "truepeaklimiter") {
      runtime.processor = truePeakLimiter_;
      next.truePeakLimiterEnabled = runtime.enabled;
      next.truePeakCeilingDb = std::clamp(extractNumberField(params, "ceilingDb").value_or(-0.1), -12.0, 0.0);
      next.truePeakAttackMs = std::clamp(extractNumberField(params, "attackMs").value_or(0.2), 0.1, 1000.0);
      next.truePeakReleaseMs = std::clamp(extractNumberField(params, "releaseMs").value_or(80.0), 1.0, 5000.0);
      next.truePeakLookaheadMs = std::clamp(extractNumberField(params, "lookaheadMs").value_or(1.0), 0.1, 20.0);
    } else if (runtime.type == "meter") {
      runtime.processor = meter_;
      next.meterEnabled = runtime.enabled;
    } else if (runtime.type == "nativeplugin") {
      const std::string pluginId = extractStringField(object, "pluginId").value_or(
          extractStringField(params, "id").value_or(runtime.id));
      const std::string path = extractStringField(params, "path").value_or("");
      if (path.empty()) {
        runtime.bypassReason = "Native DSP graph nodes require a plugin path";
      } else {
        const std::string parameters = json_utils::fieldObject(params, "parameters");
        const std::string chain = "{\"plugins\":[{\"id\":\"" + json_utils::escape(pluginId) +
                                  "\",\"path\":\"" + json_utils::escape(path) + "\",\"enabled\":true,\"parameters\":" +
                                  (parameters.empty() ? "{}" : parameters) + "}]}";
        auto plugin = std::make_unique<PluginRegistry>();
        plugin->setPluginChain(PluginRegistry::parseChainJson(chain));
        const auto pluginStatus = plugin->statuses();
        if (pluginStatus.empty() || !pluginStatus.front().loaded) {
          runtime.bypassReason = pluginStatus.empty() ? "Native DSP plugin could not be loaded" : pluginStatus.front().bypassReason;
        } else if (pluginStatus.front().abiVersion != TAE_DSP_PLUGIN_ABI_VERSION_V2) {
          runtime.bypassReason = "ABI v1 plugins are fixed at the end of the built-in graph";
        } else {
          runtime.processor = plugin.get();
          graphPlugins.push_back(std::move(plugin));
        }
      }
    } else if (runtime.type == "vst3plugin") {
      const std::string configuredBypassReason =
          extractStringField(params, "vst3BypassReason").value_or("");
      const std::string modulePath = extractStringField(params, "vst3ModulePath").value_or("");
      const std::string classId = extractStringField(params, "vst3ClassId").value_or("");
      const std::string statePath = extractStringField(params, "vst3StatePath").value_or("");
      const std::string stateFormat = extractStringField(params, "vst3StateFormat").value_or("");
      if (!configuredBypassReason.empty()) {
        runtime.bypassReason = configuredBypassReason;
      } else if (modulePath.empty() || classId.empty()) {
        runtime.bypassReason = "VST3 graph nodes require a managed module path and class ID";
      } else if (statePath.empty() != stateFormat.empty() ||
                 (!stateFormat.empty() && stateFormat != "preset" && stateFormat != "componentState")) {
        runtime.bypassReason = "VST3 state assets require a supported managed state format";
      } else {
        const std::string parameters = json_utils::fieldObject(params, "parameters");
        auto bridge = std::make_unique<Vst3BridgeProcessor>(Vst3BridgeConfig{
            runtime.id,
            modulePath,
            classId,
            parameters.empty() ? "{}" : parameters,
            statePath,
            stateFormat});
        runtime.processor = bridge.get();
        runtime.vst3Bridge = bridge.get();
        graphVst3Nodes.push_back(std::move(bridge));
      }
    } else {
      runtime.bypassReason = "Unknown DSP graph node type";
    }
    if (runtime.processor && runtime.enabled) next.enabled = true;
    nodes.push_back(std::move(runtime));
  }

  config_ = next;
  for (auto& processor : processors_) {
    processor->configure(config_);
    processor->prepare(format_);
    processor->setTrackContext(trackContext_);
  }
  for (auto& plugin : graphPlugins) {
    plugin->configure(config_);
    plugin->prepare(format_);
    plugin->setTrackContext(trackContext_);
  }
  for (auto& bridge : graphVst3Nodes) {
    bridge->configure(config_);
    bridge->prepare(format_);
    bridge->setTrackContext(trackContext_);
  }
  for (GraphNodeRuntime& runtime : nodes) {
    if (runtime.vst3Bridge && !runtime.vst3Bridge->isActive()) {
      runtime.bypassReason = runtime.vst3Bridge->bypassReason();
    }
  }
  graphNodes_ = std::move(nodes);
  graphPluginNodes_ = std::move(graphPlugins);
  graphVst3Nodes_ = std::move(graphVst3Nodes);
  graphConfigured_ = true;
  graphRevision_ = revision == 0 ? graphRevision_ + 1 : revision;
  graphSceneId_ = sceneId;
  if (convolver_ && config_.convolverEnabled && !config_.impulseResponsePath.empty()) {
    std::string convolverError;
    if (!convolver_->loadImpulseResponse(config_.impulseResponsePath, &convolverError) && error) {
      *error = convolverError;
    }
  }
  refreshStatusLocked();
  return !error || error->empty();
}

void DspChain::prepare(const AudioFormat& format) {
  std::lock_guard lock(mutex_);
  format_ = format;
  for (auto& processor : processors_) {
    processor->prepare(format_);
  }
  for (auto& plugin : graphPluginNodes_) {
    plugin->prepare(format_);
  }
  for (auto& bridge : graphVst3Nodes_) {
    bridge->prepare(format_);
  }
  refreshStatusLocked();
}

void DspChain::setTrackContext(const DspTrackContext& context) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  trackContext_ = context;
  for (auto& processor : processors_) {
    processor->setTrackContext(context);
  }
  for (auto& plugin : graphPluginNodes_) {
    plugin->setTrackContext(context);
  }
  for (auto& bridge : graphVst3Nodes_) {
    bridge->setTrackContext(context);
  }
  refreshStatusLocked();
}

void DspChain::process(float* samples, size_t frameCount) {
  if (!processingRequired_.load(std::memory_order_relaxed)) return;
  if (!samples || frameCount == 0) return;
  // AudioPipeline publishes fully prepared graph instances to the callback;
  // this instance is therefore mutated only by the render thread.
  for (IAudioProcessor* processor : activeProcessors_) {
    processor->process(samples, frameCount);
  }
  if (config_.clipGuard && config_.outputSafetyClamp && status_.dspActive) {
    clampOutput(samples, frameCount);
  }
}

void DspChain::reset() {
  std::lock_guard lock(mutex_);
  for (auto& processor : processors_) {
    processor->reset();
  }
  for (auto& plugin : graphPluginNodes_) {
    plugin->reset();
  }
  for (auto& bridge : graphVst3Nodes_) {
    bridge->reset();
  }
}

DspStatus DspChain::status() {
  std::lock_guard lock(mutex_);
  refreshStatusLocked();
  return status_;
}

DspConfig DspChain::config() const {
  std::lock_guard lock(mutex_);
  return config_;
}

bool DspChain::loadImpulseResponse(const std::string& path, std::string* error) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  if (!convolver_) return false;
  const bool ok = convolver_->loadImpulseResponse(path, error);
  if (ok) {
    config_.convolverEnabled = true;
    config_.impulseResponsePath = path;
    convolver_->configure(config_);
    convolver_->prepare(format_);
  }
  refreshStatusLocked();
  return ok;
}

void DspChain::unloadImpulseResponse() {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  if (convolver_) convolver_->unloadImpulseResponse();
  config_.convolverEnabled = false;
  config_.impulseResponsePath.clear();
  refreshStatusLocked();
}

ConvolverInfo DspChain::convolverInfo() const {
  std::lock_guard lock(mutex_);
  return convolver_ ? convolver_->info() : ConvolverInfo{};
}

void DspChain::setConvolverRealtimeState(std::shared_ptr<ConvolverRealtimeState> state) {
  std::lock_guard lock(mutex_);
  if (convolver_) convolver_->setRealtimeState(std::move(state));
}

std::shared_ptr<ConvolverRealtimeState> DspChain::convolverRealtimeState() const {
  std::lock_guard lock(mutex_);
  return convolver_ ? convolver_->realtimeState() : nullptr;
}

void DspChain::setEqBands(const std::vector<DspEqBand>& bands, EqMode mode, double preampDb, bool enabled) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  config_.eqBands = bands;
  config_.eqMode = mode;
  config_.eqPreampDb = std::clamp(preampDb, -24.0, 24.0);
  config_.eqEnabled = enabled && !bands.empty();
  if (eq_) {
    eq_->configure(config_);
    eq_->prepare(format_);
    eq_->setTrackContext(trackContext_);
  }
  refreshStatusLocked();
}

bool DspChain::setEqBandsFromJson(const std::string& json, std::string*) {
  const EqMode mode = parseEqMode(extractStringField(json, "eqMode").value_or("parametric"));
  const double preamp = std::clamp(extractNumberField(json, "eqPreamp").value_or(0.0), -24.0, 24.0);
  const bool enabled = extractBoolField(json, "eqEnabled").value_or(true);
  setEqBands(parseEqBandsJson(json, mode), mode, preamp, enabled);
  return true;
}

bool DspChain::setEqPresetFromJson(const std::string& json, std::string* error) {
  return setEqBandsFromJson(json, error);
}

void DspChain::setCrossfeedStrength(double strength) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  config_.crossfeedStrength = std::clamp(strength, 0.0, 1.0);
  config_.crossfeedEnabled = config_.crossfeedStrength > 0.0001;
  if (crossfeed_) {
    crossfeed_->configure(config_);
    crossfeed_->prepare(format_);
    crossfeed_->setTrackContext(trackContext_);
  }
  refreshStatusLocked();
}

void DspChain::setReplayGainMode(ReplayGainMode mode, double preampDb, double fallbackDb, bool clip) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  config_.replayGainMode = mode;
  config_.replayGainPreampDb = std::clamp(preampDb, -24.0, 24.0);
  config_.replayGainFallbackDb = std::clamp(fallbackDb, -24.0, 24.0);
  config_.replayGainClip = clip;
  if (replayGain_) {
    replayGain_->configure(config_);
    replayGain_->prepare(format_);
    replayGain_->setTrackContext(trackContext_);
  }
  refreshStatusLocked();
}

void DspChain::setNativeDspPluginChain(const std::string& json) {
  processingRequired_.store(true, std::memory_order_relaxed);
  std::lock_guard lock(mutex_);
  if (!nativePlugins_) return;
  nativePlugins_->setPluginChain(PluginRegistry::parseChainJson(json));
  nativePlugins_->setTrackContext(trackContext_);
  refreshStatusLocked();
}

std::string DspChain::nativeDspPluginStatusJson() const {
  std::lock_guard lock(mutex_);
  return nativePlugins_ ? nativePlugins_->statusJson() : std::string("{\"plugins\":[]}");
}

std::string DspChain::graphStatusJson() const {
  std::lock_guard lock(mutex_);
  std::ostringstream json;
  const ConvolverInfo convolverInfo = convolver_ ? convolver_->info() : ConvolverInfo{};
  const uint32_t limiterLatency = truePeakLimiter_ && truePeakLimiter_->isActive()
                                      ? static_cast<uint32_t>(std::max(1.0, std::round(
                                            config_.truePeakLookaheadMs * static_cast<double>(format_.sampleRate) / 1000.0)))
                                      : 0;
  uint64_t totalLatency = 0;
  uint64_t totalTail = 0;
  for (const GraphNodeRuntime& node : graphNodes_) {
    if (!node.enabled || !node.processor || !node.bypassReason.empty() || !node.processor->isActive()) continue;
    if (node.type == "convolver") {
      totalLatency += convolverInfo.latencyFrames;
      totalTail += convolverInfo.tailFrames;
    } else if (node.type == "truepeaklimiter") {
      totalLatency += limiterLatency;
    } else if (node.vst3Bridge) {
      totalLatency += node.vst3Bridge->latencyFrames();
      totalTail += node.vst3Bridge->tailFrames();
    }
  }
  json << "{\"revision\":" << graphRevision_ << ",\"activeSceneId\":"
       << (graphSceneId_.empty() ? "null" : "\"" + json_utils::escape(graphSceneId_) + "\"")
       << ",\"totalLatencyFrames\":"
       << totalLatency << ",\"totalTailFrames\":" << totalTail << ",\"nodes\":[";
  for (size_t index = 0; index < graphNodes_.size(); ++index) {
    const GraphNodeRuntime& node = graphNodes_[index];
    // A convolver bypassed on the render thread still reports isActive() here -- this chain
    // holds the control instance. convolverInfo() carries the shared realtime flag.
    const bool convolverRealtimeBypassed = node.type == "convolver" && convolverInfo.bypassed;
    const bool active = node.processor && node.enabled && node.bypassReason.empty() &&
                        node.processor->isActive() && !convolverRealtimeBypassed;
    const uint32_t latency = node.type == "convolver" ? convolverInfo.latencyFrames :
                             node.type == "truepeaklimiter" ? limiterLatency :
                             node.vst3Bridge ? node.vst3Bridge->latencyFrames() : 0;
    const uint64_t tail = node.type == "convolver" ? convolverInfo.tailFrames :
                          node.vst3Bridge ? node.vst3Bridge->tailFrames() : 0;
    const uint64_t overrunCount = node.type == "convolver" ? convolverInfo.overrunCount :
                                  node.vst3Bridge ? node.vst3Bridge->overrunCount() : 0;
    const uint64_t clipCount = node.type == "meter" && meter_ ? meter_->clipCount() : 0;
    const std::string bypassReason =
        !node.bypassReason.empty() ? node.bypassReason :
        convolverRealtimeBypassed ? convolverInfo.lastError :
        node.vst3Bridge && node.enabled && !active ? node.vst3Bridge->bypassReason() : "";
    const bool bypassed = !node.enabled || !bypassReason.empty();
    if (index > 0) json << ",";
    json << "{\"id\":\"" << json_utils::escape(node.id) << "\",\"type\":\""
         << json_utils::escape(node.type) << "\",\"enabled\":" << (node.enabled ? "true" : "false")
         << ",\"active\":" << (active ? "true" : "false") << ",\"bypassed\":"
         << (bypassed ? "true" : "false") << ",\"bypassReason\":\""
         << json_utils::escape(bypassReason) << "\",\"latencyFrames\":" << latency
         << ",\"tailFrames\":" << tail << ",\"processCalls\":"
         << (node.vst3Bridge ? node.vst3Bridge->processCalls() : 0) << ",\"lastProcessMs\":"
         << (node.type == "convolver" ? convolverInfo.lastProcessMs :
             node.vst3Bridge ? node.vst3Bridge->lastProcessMs() : 0.0)
         << ",\"maxProcessMs\":" << (node.type == "convolver" ? convolverInfo.maxProcessMs :
             node.vst3Bridge ? node.vst3Bridge->maxProcessMs() : 0.0)
         << ",\"averageProcessMs\":0,\"overrunCount\":" << overrunCount << ",\"clipCount\":"
         << clipCount << "}";
  }
  const bool outputTargetRequested = config_.outputTargetSampleRate > 0;
  const bool outputActive = outputTargetRequested && config_.outputTargetSampleRate == format_.sampleRate;
  const bool soxrRequested = resamplerQualityUsesSoxr(config_.resamplerQuality);
  const bool soxrFallback =
      soxrRequested && soxrRuntimeAvailability() == SoxrRuntimeState::Unavailable;
  std::string outputReason = !outputTargetRequested ? "Using the device native rate" :
                             outputActive ? "Input already matches the requested output rate" :
                             "Output sample-rate conversion is pending the output backend";
  if (soxrFallback) {
    outputReason += "; SoX resampler unavailable in this FFmpeg build, using swr ultra fallback";
  }
  json << "],\"compileState\":\"ready\",\"meter\":{\"momentaryLufs\":";
  writeFiniteJsonNumber(json, meter_ ? meter_->momentaryLufs() : -std::numeric_limits<double>::infinity());
  json << ",\"shortTermLufs\":";
  writeFiniteJsonNumber(json, meter_ ? meter_->shortTermLufs() : -std::numeric_limits<double>::infinity());
  json << ",\"integratedLufs\":";
  writeFiniteJsonNumber(json, meter_ ? meter_->integratedLufs() : -std::numeric_limits<double>::infinity());
  json << ",\"loudnessRangeLu\":";
  writeFiniteJsonNumber(json, meter_ ? meter_->loudnessRangeLu() : -std::numeric_limits<double>::infinity());
  json << ",\"truePeakDb\":";
  writeFiniteJsonNumber(json, meter_ ? meter_->truePeakDb() : -std::numeric_limits<double>::infinity());
  json << ",\"correlation\":" << (meter_ ? meter_->correlation() : 0.0)
       << ",\"clipCount\":" << (meter_ ? meter_->clipCount() : 0)
       << ",\"updatedAt\":0},\"outputStage\":{\"targetSampleRate\":";
  if (outputTargetRequested) {
    json << config_.outputTargetSampleRate;
  } else {
    json << "null";
  }
  json << ",\"actualSampleRate\":" << (format_.sampleRate > 0 ? std::to_string(format_.sampleRate) : "null")
       << ",\"resamplerQuality\":\"" << resamplerQualityName(config_.resamplerQuality)
       << "\",\"resamplerEngine\":\"" << resamplerEngineName(config_.resamplerQuality)
       << "\",\"resamplerFallback\":" << (soxrFallback ? "true" : "false")
       << ",\"dither\":\"" << ditherModeName(config_.ditherMode) << "\",\"active\":"
       << (outputActive ? "true" : "false") << ",\"reason\":\"" << json_utils::escape(outputReason)
       << "\"}}";
  return json.str();
}

DspConfig DspChain::parseConfigJson(const std::string& json) {
  DspConfig config;
  config.enabled = extractBoolField(json, "dspEnabled").value_or(extractBoolField(json, "enabled").value_or(false));
  config.clipGuard = extractBoolField(json, "clipGuard").value_or(true);
  config.fftEnabled = extractBoolField(json, "fftEnabled").value_or(true);
  config.fftResolution =
      static_cast<size_t>(std::clamp(extractNumberField(json, "fftResolution").value_or(8192.0), 64.0, 8192.0));
  config.gapless = extractBoolField(json, "gapless").value_or(true);
  config.dsdOutputMode = parseDsdOutputMode(extractStringField(json, "dsdOutputMode").value_or(
      extractBoolField(json, "dsdToPcm").value_or(false) ? "pcm" : "auto"));
  config.dsdRatePolicy =
      parseDsdRatePolicy(extractStringField(json, "dsdRatePolicy").value_or("pcm-fallback"));
  config.dsdRoute = parseDsdRouteOverride(json);
  config.sacdProgramMode =
      parseSacdProgramMode(extractStringField(json, "sacdProgramMode").value_or("auto"));
  config.replayGainMode = parseReplayGainMode(extractStringField(json, "volumeNormalization").value_or("off"));
  config.replayGainPreampDb = std::clamp(extractNumberField(json, "replayGainPreamp").value_or(0.0), -24.0, 24.0);
  config.replayGainFallbackDb = std::clamp(extractNumberField(json, "replayGainFallback").value_or(0.0), -24.0, 24.0);
  config.replayGainClip = extractBoolField(json, "replayGainClip").value_or(true);
  config.loudnormTargetLufs =
      std::clamp(extractNumberField(json, "loudnormTargetLufs").value_or(-23.0), -70.0, 0.0);
  config.loudnormTruePeakCeilingDb =
      std::clamp(extractNumberField(json, "loudnormTruePeakCeilingDb").value_or(-1.0), -12.0, 0.0);
  config.eqEnabled = extractBoolField(json, "eqEnabled").value_or(false);
  config.eqMode = parseEqMode(extractStringField(json, "eqMode").value_or("graphic"));
  config.eqPreampDb = std::clamp(extractNumberField(json, "eqPreamp").value_or(0.0), -24.0, 24.0);
  config.eqBands = parseEqBands(json, config.eqMode);
  config.convolverEnabled = extractBoolField(json, "convolverEnabled").value_or(false);
  config.impulseResponsePath = extractStringField(json, "convolverIrPath").value_or("");
  config.convolverWet = std::clamp(extractNumberField(json, "convolverWet").value_or(1.0), 0.0, 1.0);
  config.convolverDry = std::clamp(extractNumberField(json, "convolverDry").value_or(0.0), 0.0, 1.0);
  config.convolverGainDb = std::clamp(extractNumberField(json, "convolverGainDb").value_or(0.0), -60.0, 24.0);
  config.convolverPolarityInverted = extractBoolField(json, "convolverPolarityInverted").value_or(false);
  config.convolverDelayMs = std::clamp(extractNumberField(json, "convolverDelayMs").value_or(0.0), 0.0, 250.0);
  config.crossfeedAlgorithm = parseCrossfeedAlgorithm(
      extractStringField(json, "crossfeedAlgorithm").value_or("custom"));
  config.crossfeedStrength = std::clamp(extractNumberField(json, "crossfeedStrength").value_or(0.0), 0.0, 1.0);
  config.crossfeedEnabled = extractBoolField(json, "crossfeedEnabled").value_or(config.crossfeedStrength > 0.0001);
  config.crossfeedDelayMs = std::clamp(extractNumberField(json, "crossfeedDelayMs").value_or(0.35), 0.05, 2.0);
  config.crossfeedCutoffHz = std::clamp(extractNumberField(json, "crossfeedCutoffHz").value_or(700.0), 80.0, 4000.0);
  config.truePeakLimiterEnabled = extractBoolField(json, "truePeakLimiterEnabled").value_or(false);
  config.truePeakCeilingDb = std::clamp(extractNumberField(json, "truePeakCeilingDb").value_or(-0.1), -12.0, 0.0);
  config.truePeakAttackMs = std::clamp(extractNumberField(json, "truePeakAttackMs").value_or(0.2), 0.1, 1000.0);
  config.truePeakReleaseMs = std::clamp(extractNumberField(json, "truePeakReleaseMs").value_or(80.0), 1.0, 5000.0);
  config.truePeakLookaheadMs = std::clamp(extractNumberField(json, "truePeakLookaheadMs").value_or(1.0), 0.1, 20.0);
  config.outputTargetSampleRate = static_cast<int>(std::clamp(
      extractNumberField(json, "outputTargetSampleRate").value_or(0.0), 0.0, 384000.0));
  config.resamplerQuality = parseResamplerQuality(extractStringField(json, "resamplerQuality").value_or("native"));
  config.ditherMode = parseDitherMode(extractStringField(json, "dither").value_or("off"));
  config.outputSafetyClamp = extractBoolField(json, "outputSafetyClamp").value_or(true);
  config.crossfadeSeconds = std::clamp(extractNumberField(json, "crossfadeSeconds").value_or(0.0), 0.0, 12.0);
  return config;
}

std::vector<DspEqBand> DspChain::parseEqBandsJson(const std::string& json, EqMode mode) {
  return parseEqBands(json, mode);
}

void DspChain::refreshStatusLocked() {
  status_.replayGainActive = replayGain_ && replayGain_->isActive();
  status_.loudnormActive = status_.replayGainActive && config_.replayGainMode == ReplayGainMode::Loudnorm;
  status_.eqActive = eq_ && eq_->isActive();
  status_.convolverActive = convolver_ && convolver_->isActive();
  status_.crossfeedActive = crossfeed_ && crossfeed_->isActive();
  status_.channelMatrixActive = channelMatrix_ && channelMatrix_->isActive();
  status_.channelStripActive = channelStrip_ && channelStrip_->isActive();
  status_.bassManagementActive = bassManagement_ && bassManagement_->isActive();
  status_.gateActive = gate_ && gate_->isActive();
  status_.compressorActive = compressor_ && compressor_->isActive();
  status_.dynamicEqActive = dynamicEq_ && dynamicEq_->isActive();
  status_.multibandCompressorActive = multibandCompressor_ && multibandCompressor_->isActive();
  status_.stereoFieldActive = stereoField_ && stereoField_->isActive();
  status_.loudnessContourActive = loudnessContour_ && loudnessContour_->isActive();
  status_.truePeakLimiterActive = truePeakLimiter_ && truePeakLimiter_->isActive();
  status_.meterActive = meter_ && meter_->isActive();
  status_.nativeDspActive = nativePlugins_ && nativePlugins_->isActive();
  status_.vst3DspActive = false;
  for (const GraphNodeRuntime& node : graphNodes_) {
    if (node.vst3Bridge && node.enabled && node.bypassReason.empty() && node.vst3Bridge->isActive()) {
      status_.vst3DspActive = true;
      break;
    }
  }
  status_.crossfadeActive = config_.crossfadeSeconds > 0.0001;
  status_.replayGainDb = replayGain_ ? replayGain_->currentGainDb() : 0.0;
  status_.crossfeedStrength = crossfeed_ ? crossfeed_->strength() : 0.0;
  status_.crossfadeSeconds = status_.crossfadeActive ? config_.crossfadeSeconds : 0.0;
  const ConvolverInfo info = convolver_ ? convolver_->info() : ConvolverInfo{};
  status_.irResampled = info.irResampled;
  status_.convolverLatencyFrames = info.latencyFrames;
  status_.partitionSize = info.partitionSize;
  status_.channelMappingMode = info.channelMappingMode;
  status_.nativeDspJson = nativePlugins_ ? nativePlugins_->statusJson() : std::string("{\"plugins\":[]}");
  status_.integratedLufs = meter_ ? meter_->integratedLufs() : 0.0;
  status_.momentaryLufs = meter_ ? meter_->momentaryLufs() : 0.0;
  status_.shortTermLufs = meter_ ? meter_->shortTermLufs() : 0.0;
  status_.loudnessRangeLu = meter_ ? meter_->loudnessRangeLu() : 0.0;
  status_.truePeakDb = meter_ ? meter_->truePeakDb() : 0.0;
  status_.correlation = meter_ ? meter_->correlation() : 0.0;
  status_.clipCount = meter_ ? meter_->clipCount() : 0;
  status_.dspActive = status_.replayGainActive || status_.eqActive || status_.convolverActive ||
                      status_.crossfeedActive || status_.channelMatrixActive || status_.channelStripActive ||
                      status_.bassManagementActive || status_.gateActive || status_.compressorActive ||
                      status_.dynamicEqActive || status_.multibandCompressorActive || status_.stereoFieldActive ||
                      status_.loudnessContourActive ||
                      status_.truePeakLimiterActive || status_.nativeDspActive || status_.vst3DspActive;
  activeProcessors_.clear();
  if (graphConfigured_) {
    for (const GraphNodeRuntime& node : graphNodes_) {
      if (node.enabled && node.bypassReason.empty() && node.processor && node.processor->isActive()) {
        activeProcessors_.push_back(node.processor);
      }
    }
    // ABI v1 plugins remain fixed after every built-in graph node and before the terminal clamp.
    if (nativePlugins_ && nativePlugins_->isActive()) activeProcessors_.push_back(nativePlugins_);
  } else {
    activeProcessors_ = dsp::collectActiveProcessors(processors_);
  }
  processingRequired_.store(!activeProcessors_.empty(), std::memory_order_relaxed);
}

void DspChain::clampOutput(float* samples, size_t frameCount) {
  const size_t sampleCount = frameCount * static_cast<size_t>(std::max(1, format_.channelCount));
  for (size_t i = 0; i < sampleCount; ++i) {
    samples[i] = static_cast<float>(std::clamp(static_cast<double>(samples[i]), -1.0, 1.0));
  }
}

}  // namespace twilight::audio
