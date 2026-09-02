#pragma once

#include "../core/AudioTypes.h"

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace twilight::audio {

enum class ReplayGainMode {
  Off,
  Track,
  Album,
  Loudnorm
};

enum class EqMode {
  Graphic,
  Parametric
};

enum class DsdOutputMode {
  Auto,
  Pcm,
  Dop,
  Native
};

enum class DsdRatePolicy {
  Exact,
  Downrate,
  PcmFallback
};

/**
 * Optional compatibility route for DSD streams. Some DAC ASIO drivers never
 * accept DSD sample types (and some users only have WASAPI), which forces the
 * DSD path down to DoP or PCM no matter what the source is. An externally
 * registered ASIO proxy driver can accept raw DSD and re-encode it for the
 * hardware, so the fix is to let the host carry DSD over a different
 * backend/device than the regular PCM output.
 *
 * The engine deliberately knows nothing about which proxy this is: it only
 * receives a backend id and a device id. Proxy branding stays in the UI layer
 * so any vendor's proxy works and renames cannot break routing.
 */
struct DsdRouteOverride {
  bool enabled = false;
  // Empty means "reuse the main playback backend / device".
  std::string backendId;
  std::string deviceId;
  // Route PCM->DSD sigma-delta upconversion over the same override.
  bool applyToPcmToDsd = true;
  // true = a failed passthrough reports an error instead of silently degrading.
  bool strictPassthrough = false;
};

inline bool dsdRouteOverrideTargetsDistinctRoute(const DsdRouteOverride& route) {
  return route.enabled && (!route.backendId.empty() || !route.deviceId.empty());
}

inline bool dsdRouteOverrideEquals(const DsdRouteOverride& left, const DsdRouteOverride& right) {
  return left.enabled == right.enabled && left.backendId == right.backendId &&
         left.deviceId == right.deviceId && left.applyToPcmToDsd == right.applyToPcmToDsd &&
         left.strictPassthrough == right.strictPassthrough;
}

enum class SacdProgramMode {
  Auto,
  Stereo,
  Multichannel
};

enum class DspFilterType {
  Peak,
  LowShelf,
  HighShelf,
  LowPass,
  HighPass,
  BandPass,
  AllPass,
  Notch
};

enum class CrossfeedAlgorithm {
  Custom,
  Bauer,
  Bs2b,
  Meier
};

enum class DspResamplerQuality {
  Native,
  High,
  Ultra,
  // SoX-quality tiers use the libswresample soxr engine when the linked FFmpeg
  // provides it; otherwise they gracefully fall back to the Ultra swr settings.
  SoxrHq,
  SoxrVhq
};

enum class DspDitherMode {
  Off,
  Tpdf,
  HighpassTpdf,
  NoiseShaped
};

/**
 * Process-wide runtime probe result for the libswresample soxr engine.
 * The decode-side resampler reports the outcome of its first soxr swr_init
 * attempt; status surfaces (DspChain graph status) read it to report an honest
 * "soxr requested but unavailable" fallback. Header-inline so every test
 * binary links it without pulling in the FFmpeg decoder translation unit.
 */
enum class SoxrRuntimeState {
  Unknown = 0,
  Available = 1,
  Unavailable = 2
};

inline std::atomic<int>& soxrRuntimeStateStorage() {
  static std::atomic<int> state{0};
  return state;
}

inline void reportSoxrRuntimeAvailability(bool available) {
  soxrRuntimeStateStorage().store(available ? 1 : 2, std::memory_order_relaxed);
}

inline SoxrRuntimeState soxrRuntimeAvailability() {
  return static_cast<SoxrRuntimeState>(soxrRuntimeStateStorage().load(std::memory_order_relaxed));
}

struct DspEqBand {
  double frequency = 1000.0;
  double gainDb = 0.0;
  double q = 1.0;
  DspFilterType type = DspFilterType::Peak;
  bool enabled = true;
  uint32_t channelMask = 0xffffffffu;
};

struct DspDynamicEqBand {
  double frequency = 1000.0;
  double gainDb = 0.0;
  double q = 1.0;
  double thresholdDb = -24.0;
  double ratio = 2.0;
  double rangeDb = -6.0;
  double attackMs = 15.0;
  double releaseMs = 180.0;
  DspFilterType type = DspFilterType::Peak;
  bool enabled = true;
  uint32_t channelMask = 0xffffffffu;
};

struct DspMultibandCompressorBand {
  double thresholdDb = -18.0;
  double ratio = 2.0;
  double attackMs = 15.0;
  double releaseMs = 180.0;
  double makeupDb = 0.0;
  bool enabled = true;
};

struct DspConfig {
  bool enabled = false;
  bool clipGuard = true;
  bool fftEnabled = true;
  size_t fftResolution = 8192;
  bool gapless = true;
  DsdOutputMode dsdOutputMode = DsdOutputMode::Auto;
  DsdRatePolicy dsdRatePolicy = DsdRatePolicy::PcmFallback;
  DsdRouteOverride dsdRoute;
  SacdProgramMode sacdProgramMode = SacdProgramMode::Auto;

  ReplayGainMode replayGainMode = ReplayGainMode::Off;
  double replayGainPreampDb = 0.0;
  double replayGainFallbackDb = 0.0;
  bool replayGainClip = true;
  // Loudnorm targets (EBU R128). Used only when replayGainMode == Loudnorm.
  double loudnormTargetLufs = -23.0;
  double loudnormTruePeakCeilingDb = -1.0;

  bool eqEnabled = false;
  EqMode eqMode = EqMode::Graphic;
  double eqPreampDb = 0.0;
  std::vector<DspEqBand> eqBands;

  bool convolverEnabled = false;
  std::string impulseResponsePath;
  double convolverWet = 1.0;
  double convolverDry = 0.0;
  double convolverGainDb = 0.0;
  bool convolverPolarityInverted = false;
  double convolverDelayMs = 0.0;
  uint32_t convolverPartitionSize = 0;
  std::vector<double> convolverMatrix;

  bool crossfeedEnabled = false;
  CrossfeedAlgorithm crossfeedAlgorithm = CrossfeedAlgorithm::Custom;
  double crossfeedStrength = 0.0;
  double crossfeedDelayMs = 0.35;
  double crossfeedCutoffHz = 700.0;

  double crossfadeSeconds = 0.0;

  bool channelMatrixEnabled = false;
  std::vector<double> channelMatrix;

  struct ChannelStripChannel {
    double gainDb = 0.0;
    double delayMs = 0.0;
    bool polarityInverted = false;
    bool muted = false;
  };
  bool channelStripEnabled = false;
  std::vector<ChannelStripChannel> channelStripChannels;

  bool bassManagementEnabled = false;
  double bassCrossoverHz = 80.0;
  double bassLfeGainDb = 0.0;
  bool bassRedirectLfe = true;

  bool gateEnabled = false;
  double gateThresholdDb = -60.0;
  double gateAttackMs = 2.0;
  double gateReleaseMs = 120.0;

  bool compressorEnabled = false;
  double compressorThresholdDb = -18.0;
  double compressorRatio = 2.0;
  double compressorAttackMs = 15.0;
  double compressorReleaseMs = 180.0;
  double compressorMakeupDb = 0.0;

  bool dynamicEqEnabled = false;
  std::vector<DspDynamicEqBand> dynamicEqBands;

  bool multibandCompressorEnabled = false;
  std::vector<double> multibandCrossoversHz;
  std::vector<DspMultibandCompressorBand> multibandCompressorBands;

  bool stereoFieldEnabled = false;
  double stereoWidth = 1.0;
  double stereoBalance = 0.0;
  double stereoMidGainDb = 0.0;
  double stereoSideGainDb = 0.0;
  bool stereoSwap = false;
  bool stereoMono = false;
  bool stereoInvertLeft = false;
  bool stereoInvertRight = false;

  bool loudnessContourEnabled = false;
  double loudnessContourAmount = 0.0;
  double loudnessReferenceVolume = 0.75;

  bool truePeakLimiterEnabled = false;
  double truePeakCeilingDb = -0.1;
  double truePeakAttackMs = 0.2;
  double truePeakReleaseMs = 80.0;
  double truePeakLookaheadMs = 1.0;

  bool meterEnabled = false;

  int outputTargetSampleRate = 0;
  DspResamplerQuality resamplerQuality = DspResamplerQuality::Native;
  DspDitherMode ditherMode = DspDitherMode::Off;
  bool outputSafetyClamp = true;
};

struct DspTrackContext {
  AudioStreamInfo stream;
  QueueItem item;
};

struct DspStatus {
  bool dspActive = false;
  bool replayGainActive = false;
  bool loudnormActive = false;
  bool eqActive = false;
  bool convolverActive = false;
  bool crossfeedActive = false;
  bool channelMatrixActive = false;
  bool channelStripActive = false;
  bool bassManagementActive = false;
  bool gateActive = false;
  bool compressorActive = false;
  bool dynamicEqActive = false;
  bool multibandCompressorActive = false;
  bool stereoFieldActive = false;
  bool loudnessContourActive = false;
  bool truePeakLimiterActive = false;
  bool meterActive = false;
  bool nativeDspActive = false;
  bool vst3DspActive = false;
  bool crossfadeActive = false;
  bool irResampled = false;
  double replayGainDb = 0.0;
  double crossfeedStrength = 0.0;
  double crossfadeSeconds = 0.0;
  uint32_t convolverLatencyFrames = 0;
  uint32_t partitionSize = 0;
  std::string channelMappingMode;
  std::string nativeDspJson = "{\"plugins\":[]}";
  double integratedLufs = 0.0;
  double momentaryLufs = 0.0;
  double shortTermLufs = 0.0;
  double loudnessRangeLu = 0.0;
  double truePeakDb = 0.0;
  double correlation = 0.0;
  uint64_t clipCount = 0;
};

// Realtime-visible convolver state, shared between the control-side ConvolverProcessor and
// the render clones published into AudioPipeline::renderDspGraphs_.
//
// The render thread processes a *different* ConvolverProcessor instance than the one
// DspChain::convolverInfo() reads (AudioPipeline builds render graphs from scratch rather
// than copying), so a realtime bypass used to be invisible to the UI and had no way back:
// one scheduler hiccup muted convolution for the rest of that graph generation. Routing the
// realtime signals through shared atomics makes the bypass observable and re-armable.
struct ConvolverRealtimeState {
  // Set by the render thread when the process budget is missed repeatedly.
  std::atomic<bool> bypassed{false};
  std::atomic<uint64_t> overrunCount{0};
  std::atomic<uint64_t> bypassCount{0};
  // steady_clock ticks; 0 means "never bypassed".
  std::atomic<int64_t> lastBypassTicks{0};
  std::atomic<double> lastProcessMs{0.0};
  std::atomic<double> maxProcessMs{0.0};
};

struct ConvolverInfo {
  bool loaded = false;
  bool active = false;
  bool bypassed = false;
  bool irResampled = false;
  std::string path;
  int sampleRate = 0;
  int channels = 0;
  uint64_t lengthFrames = 0;
  double lengthMs = 0.0;
  uint32_t partitionSize = 0;
  uint32_t latencyFrames = 0;
  uint64_t tailFrames = 0;
  uint64_t memoryBytes = 0;
  bool loading = false;
  uint64_t overrunCount = 0;
  uint64_t bypassCount = 0;
  double lastProcessMs = 0.0;
  double maxProcessMs = 0.0;
  std::string channelMappingMode;
  std::string warning;
  std::string lastError;
};

}  // namespace twilight::audio
