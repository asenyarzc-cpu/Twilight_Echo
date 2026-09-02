#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace twilight::audio {

enum class AudioSampleFormat {
  Float32Interleaved,
  Int16Interleaved,
  Int24Interleaved,
  Int24In32Interleaved,
  Int32Interleaved,
  DsdInt8Lsb1,
  DsdInt8Msb1,
  DsdInt8Ner8
};

enum class DsdMode {
  Pcm,
  Dop,
  Native,
  Unsupported
};

struct AudioFormat {
  int sampleRate = 0;
  int channelCount = 0;
  int bitDepth = 0;
  AudioSampleFormat sampleFormat = AudioSampleFormat::Float32Interleaved;
};

struct PcmBlock {
  AudioFormat format;
  uint8_t* data = nullptr;
  size_t frames = 0;
  size_t byteSize = 0;
};

enum class ChannelRoutingMode {
  Auto,
  Stereo,
  StereoTo51,
  StereoTo71,
  MonoToStereo,
  MonoToMultichannel
};

// PCM -> DSD sigma-delta upconversion (output stage). Off keeps PCM sources on
// the regular float/typed PCM path; DsdN modulates the decoded float stream to
// DSD64/128/256 and delivers it through the existing native-DSD / DoP path.
enum class PcmToDsdMode {
  Off,
  Dsd64,
  Dsd128,
  Dsd256
};

struct OutputConfig {
  uint32_t preferredBufferSize = 0;
  ChannelRoutingMode routingMode = ChannelRoutingMode::Auto;
  bool wasapiExclusivePushMode = false;
  PcmToDsdMode pcmToDsdMode = PcmToDsdMode::Off;
  uint32_t dsdMutePreRollFrames = 256;
  uint32_t dsdMutePostRollFrames = 256;
  uint32_t dsdMuteTimeoutFrames = 4096;
  // 上混参数（5.1/7.1 声道扩展），默认值对应标准 audiophile 配置
  float upmixCenterGain = 0.7071f;     // -3dB
  float upmixLfeGain = 0.5f;           // -6dB
  float upmixLfeLowpassHz = 120.0f;    // LFE 低通截止
  float upmixSurroundGain = 0.5f;      // -6dB
  float upmixSideGain = 0.3f;          // -10dB (仅 7.1)
  float upmixSurroundDelayMs = 0.0f;   // 环绕延迟
};

struct ReplayGainInfo {
  std::optional<double> trackGainDb;
  std::optional<double> albumGainDb;
  std::optional<double> r128TrackGainDb;
  std::optional<double> r128AlbumGainDb;
  // Offline EBU R128 measurement injected for loudnorm (never from Track/Album tags).
  std::optional<double> measuredIntegratedLufs;
  std::optional<double> measuredTruePeakDb;
};

struct AudioStreamInfo {
  std::string source;
  std::string codec = "未知";
  int64_t bitrate = 0;
  double durationSeconds = 0.0;
  AudioFormat sourceFormat;
  AudioFormat decodedFormat;
  ReplayGainInfo replayGain;
  bool sourceLossless = false;
  bool isDsd = false;
  DsdMode dsdMode = DsdMode::Pcm;
  int dsdRate = 0;
  /** Live ICY StreamTitle / container title for radio-style streams. */
  std::string streamTitle;
};

struct QueueItem {
  std::string id;
  std::string source;
  std::string title;
  std::string artist;
  std::string album;
  std::string codec;
  double durationSeconds = 0.0;
  int sampleRate = 0;
  int64_t bitrate = 0;
  int bitDepth = 0;
  // Optional loudnorm measurement injected by the host (cache hit / prior analysis).
  std::optional<double> measuredIntegratedLufs;
  std::optional<double> measuredTruePeakDb;
  // Optional library / host-injected ReplayGain + R128 tags for cold start
  // when decode-time tags are missing. Loudnorm never uses these as measurements.
  std::optional<double> replayGainTrackGainDb;
  std::optional<double> replayGainAlbumGainDb;
  std::optional<double> replayGainTrackPeak;
  std::optional<double> replayGainAlbumPeak;
  std::optional<double> r128TrackGainDb;
  std::optional<double> r128AlbumGainDb;
  // Explicit logical range for a single-file CUE track. Queue positions and seek are relative
  // to this segment; the decoder receives the absolute source offset internally.
  std::optional<double> cueStartSeconds;
  std::optional<double> cueEndSeconds;
  // Legacy/presentation pregap value. Only cueVirtualPregapSeconds creates samples.
  double cuePregapSeconds = 0.0;
  // Explicit CUE PREGAP: synthetic silence at the start of the logical track.
  double cueVirtualPregapSeconds = 0.0;
  // INDEX 00..INDEX 01 duration. These bytes remain in the preceding source segment.
  double cueSourcePregapSeconds = 0.0;
};

struct OutputInfo {
  // Render-thread timing, sampled with lock-free counters. This describes the
  // callback's deadline load, not process or system CPU utilization.
  struct RenderPerformanceSnapshot {
    uint64_t callbackCount = 0;
    uint64_t totalCallbackNanoseconds = 0;
    uint64_t peakCallbackNanoseconds = 0;
    uint64_t totalDeadlineNanoseconds = 0;
    uint64_t deadlineMissCount = 0;
  };

  struct LatencyInfo {
    double bufferLatencyMs = 0.0;
    double outputLatencyMs = 0.0;
    double totalLatencyMs = 0.0;
  };

  struct Diagnostics {
    uint64_t sessionUnderrunCount = 0;
    uint64_t sessionBufferDropCount = 0;
    uint64_t sessionRecoveryCount = 0;
    uint64_t lifetimeUnderrunCount = 0;
    uint64_t lifetimeBufferDropCount = 0;
    uint64_t lifetimeRecoveryCount = 0;
    uint64_t driverRestartCount = 0;
    uint64_t deviceLostCount = 0;
    // Driver-reported transient load events (ASIO kAsioResetRequest's benign
    // cousins: Overload / LatenciesChanged). Recorded but never acted on: they
    // do not invalidate the stream, so rebuilding it would turn a momentary
    // glitch into a guaranteed dropout.
    uint64_t driverXrunCount = 0;
    uint64_t dsdIdleFrameCount = 0;
    uint64_t dsdShortReadCount = 0;
    std::string dsdTransport;
    std::string dsdSourceBitOrder;
    std::string dsdSourcePacking;
    std::string requestedWireFormat;
    std::string actualWireFormat;
    int containerBits = 0;
    int validBits = 0;
    int blockAlign = 0;
    int semanticSampleRate = 0;
    int transportSampleRate = 0;
    bool typedRawPath = false;
    bool processingBypassed = false;
    std::string nativeDsdNegotiation;
    std::string dopRuntimeEvidence;
    std::string quirkRegistryState;
    std::string quirkFingerprint;
    std::string quirkApplied;
    std::string dsdMuteState;
    std::string dsdMuteTransition;
    uint32_t dsdMutePreRollFrames = 0;
    uint32_t dsdMutePostRollFrames = 0;
    uint32_t dsdMuteTimeoutFrames = 0;
    std::string dsdMuteFallback;
    std::string firstBufferSummary;
    std::string processArchitecture;
    bool asioBuildEnabled = false;
    bool asioEnvironmentDisabled = false;
    int asioRegisteredDriverCount32 = 0;
    int asioRegisteredDriverCount64 = 0;
    int asioLoadableDriverCount64 = 0;
    // DSD compatibility route: whether the stream actually left over the
    // override backend/device, and which one. Empty when the main route carried it.
    bool dsdRouteOverrideActive = false;
    std::string dsdRouteBackend;
    std::string dsdRouteDevice;
    std::string dsdRouteFallbackReason;
    std::string lastError;
  };

  bool exclusive = false;
  std::string accessMode = "shared";
  bool supportsOutputPerfect = false;
  bool sourceExact = false;
  bool outputPerfect = false;
  bool pcmPassthrough = false;
  bool resampled = false;
  bool isDsd = false;
  std::string dsdMode = "pcm";
  int dsdRate = 0;
  int actualDsdRate = 0;
  std::string dsdRatePolicy = "pcm-fallback";
  std::string dsdConversion = "exact";
  std::string dsdConversionReason;
  int outputSampleRate = 0;
  int outputBitDepth = 0;
  std::string backend;
  std::string actualBackend;
  std::string devicePathKind = "default";
  std::string deviceName;
  std::string actualDeviceName;
  std::string driverName;
  std::string actualDriverName;
  long driverVersion = 0;
  long actualDriverVersion = 0;
  std::string actualOutputFormat;
  int actualSampleRate = 0;
  int actualBitDepth = 0;
  int actualChannels = 0;
  std::string perfectReasonCode;
  std::string capabilityReason;
  bool driverDopCapable = false;
  bool driverNativeDsdCapable = false;
  std::vector<int> driverDopCarrierSampleRates;
  std::vector<std::string> driverDopCarrierFormats;
  std::vector<int> driverNativeDsdSampleRates;
  std::string nativeDsdRuntimeState = "unsupported";
  int nativeDsdRequestedRate = 0;
  int nativeDsdActualRate = 0;
  int nativeDsdChannels = 0;
  bool nativeDsdExplicitlyCapable = false;
  std::vector<int> nativeDsdAdvertisedSampleRates;
  std::string nativeDsdRuntimeReason;
  int bufferSizeFrames = 0;
  int latencyFrames = 0;
  double latencyMs = 0.0;
  LatencyInfo latencyInfo;
  std::string channelRoutingMode = "auto";
  std::string perfectReason;
  Diagnostics diagnostics;
  RenderPerformanceSnapshot renderPerformance;
  bool deviceRecovered = false;
  int recoveryCount = 0;
  std::string nativeDspJson = "{\"plugins\":[]}";
};

struct PerfectEvaluation {
  AudioFormat sourceFormat;
  AudioFormat decodedFormat;
  AudioFormat outputFormat;
  bool sourceLossless = false;
  bool sourceDsd = false;
  DsdMode dsdMode = DsdMode::Pcm;
  int dsdRate = 0;
  AudioFormat dopCarrierFormat;
  bool dopCarrierMatched = false;
  bool dopPassthroughProven = false;
  bool nativeDsdRequested = false;
  bool nativeDsdPassthroughProven = false;
  bool sacdIsoSource = false;
  bool supportsOutputPerfect = false;
  bool backendResampled = false;
  std::string backendPerfectReasonCode;
  std::string backendPerfectReason;
  double volume = 1.0;
  double playbackRate = 1.0;
  bool replayGainActive = false;
  bool loudnormActive = false;
  bool eqActive = false;
  bool convolverActive = false;
  bool crossfeedActive = false;
  bool nativeDspActive = false;
  bool crossfadeActive = false;
  ChannelRoutingMode routingMode = ChannelRoutingMode::Auto;
  bool pcmPassthrough = false;
};

struct PerfectResult {
  bool sourceExact = false;
  bool outputPerfect = false;
  bool pcmPassthrough = false;
  bool resampled = false;
  bool processingActive = false;
  bool formatMatched = false;
  bool sourceFormatMatched = false;
  bool routingPreservesSemantics = false;
  std::string perfectReasonCode;
  std::string perfectReason;
};

std::string channelRoutingModeToString(ChannelRoutingMode mode);
ChannelRoutingMode parseChannelRoutingMode(const std::string& mode);
std::string pcmToDsdModeToString(PcmToDsdMode mode);
PcmToDsdMode parsePcmToDsdMode(const std::string& mode);
/** DSD rate multiplier (64/128/256) for a PCM->DSD mode; 0 when Off. */
int pcmToDsdModeRateMultiplier(PcmToDsdMode mode);
std::string dsdModeToString(DsdMode mode);
std::string sampleFormatToString(AudioSampleFormat format);
size_t audioSampleFormatBytes(AudioSampleFormat format);
size_t audioFormatBytesPerFrame(const AudioFormat& format);
int normalizedPcmBitDepth(int bitDepth);
int effectivePcmBitDepth(const AudioFormat& format);
bool pcmFormatsExactMatch(const AudioFormat& left, const AudioFormat& right);
/**
 * Whether two integer PCM sample formats hold the same significant bits.
 * int24 (3 packed bytes) and int24-in-32 (24 significant bits MSB-aligned in a
 * 4-byte word) carry the same 24-bit payload; float32 and DSD carry none.
 */
bool sampleFormatsSameIntegerPayload(AudioSampleFormat left, AudioSampleFormat right);
/**
 * Whether both formats represent identical sample values, even when the byte
 * container differs — i.e. a source in one can reach the other bit for bit.
 *
 * Callers that copy or size raw bytes must keep using pcmFormatsExactMatch:
 * int24 and int24-in-32 are 3 and 4 bytes per sample, so their buffer layouts
 * are not interchangeable even though their payloads are.
 */
bool pcmFormatsSemanticallyMatch(const AudioFormat& left, const AudioFormat& right);
bool isDsdSampleFormat(AudioSampleFormat format);
bool dsdFormatsExactMatch(const AudioFormat& left, const AudioFormat& right);
std::optional<AudioFormat> dopCarrierFormatForDsd(int dsdRate, int sourceSampleRate, int channelCount);
PerfectResult evaluatePerfect(const PerfectEvaluation& evaluation);

}  // namespace twilight::audio
