#pragma once

#include "AudioBuffer.h"
#include "AudioTypes.h"
#include "FixedSpscQueue.h"
#include "../decoder/DopPacker.h"
#include "DsdMuteGuard.h"
#include "../decoder/DsdReader.h"
#include "../decoder/FFmpegDecoder.h"
#include "../dsp/DspChain.h"
#include "../dsp/FftSpectrumAnalyzer.h"
#include "../dsp/ChannelRouter.h"
#include "../dsp/PcmToDsdModulator.h"
#include "../dsp/WsolaResampler.h"
#include "../output/IOutputBackend.h"

#include "twilight_audio_engine.h"

#include <array>
#include <atomic>
#include <bit>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {

static_assert(
    std::atomic<uint64_t>::is_always_lock_free,
    "AudioPipeline realtime controls require lock-free 64-bit atomics");
static_assert(
    std::atomic<uint32_t>::is_always_lock_free,
    "AudioPipeline realtime routing controls require lock-free 32-bit atomics");

size_t visualizationFftResolutionForConfig(size_t configuredFftResolution);

enum class PipelineState {
  Stopped,
  Playing,
  Paused
};

struct PipelineStatus {
  PipelineState state = PipelineState::Stopped;
  double positionSeconds = 0.0;
  AudioStreamInfo stream;
  AudioFormat outputFormat;
  OutputInfo outputInfo;
  std::string backendId;
  std::string deviceName;
  QueueItem currentItem;
  bool dspActive = false;
  bool replayGainActive = false;
  bool loudnormActive = false;
  bool eqActive = false;
  bool convolverActive = false;
  bool crossfeedActive = false;
  bool nativeDspActive = false;
  bool crossfadeActive = false;
  bool fftActive = false;
  bool irResampled = false;
  double replayGainDb = 0.0;
  double crossfeedStrength = 0.0;
  double crossfadeSeconds = 0.0;
  uint32_t convolverLatencyFrames = 0;
  uint32_t partitionSize = 0;
  std::string channelMappingMode;
  std::string nativeDspJson = "{\"plugins\":[]}";
  std::string dspGraphJson = "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}";
  bool sourceExact = false;
  bool outputPerfect = false;
  bool gaplessActive = false;
  bool preloadReady = false;
  // Empty when gapless path is unblocked; otherwise one of:
  // disabled | dsd_path | typed_passthrough | crossfade | format_mismatch
  std::string gaplessBlockedReason;
  std::string perfectReason;
  uint64_t requestedConfigRevision = 0;
  uint64_t appliedConfigRevision = 0;
};

class AudioPipeline {
 public:
  using BackendFactory = std::function<std::unique_ptr<IOutputBackend>(const std::string&)>;
  /**
   * Device ids of output devices that a capability probe proved can accept a
   * raw DSD stream. Used to auto-discover a DSD compatibility route when the
   * main output cannot carry DSD and the user has not pinned one.
   *
   * Injectable so routing policy stays testable without linking a platform
   * driver host, and so builds without ASIO simply report nothing.
   */
  using NativeDsdDeviceDiscovery = std::function<std::vector<std::string>()>;

  AudioPipeline();
  ~AudioPipeline();

  AudioPipeline(const AudioPipeline&) = delete;
  AudioPipeline& operator=(const AudioPipeline&) = delete;

  TAE_Result play(
      const QueueItem& item,
      const std::optional<QueueItem>& upcomingItem,
      double startTimeSeconds,
      const std::string& backendId,
      const std::string& deviceId,
      double volume,
      const std::string& dspConfigJson,
      bool gaplessEnabled,
      std::string* error);
  TAE_Result play(
      const std::string& source,
      double startTimeSeconds,
      const std::string& backendId,
      const std::string& deviceId,
      double volume,
      const std::string& dspConfigJson,
      std::string* error);
  TAE_Result togglePause();
  TAE_Result stop();
  /** stop() body without the transport lock; callers must hold transportMutex_. */
  TAE_Result stopUnlocked();
  TAE_Result seek(double seconds, std::string* error);
  void setVolume(double volume);
  void setPlaybackRate(double rate);
  /** A-B loop; end <= start or non-finite clears. Enforced on control/status path. */
  void setLoopRange(double startSeconds, double endSeconds);
  void clearLoopRange();
  /** If loop is active and position crossed end, seek to start. Returns true if seek ran. */
  bool enforceLoopRange(std::string* error);
  void setDspConfig(const std::string& dspConfigJson);
  bool setDspGraph(const std::string& graphJson, std::string* error);
  bool applyDspState(uint64_t revision, const std::string& stateJson, std::string* error);
  std::string dspGraphStatusJson() const;
  bool setOutputConfig(const OutputConfig& config, std::string* error);
  bool loadImpulseResponse(const std::string& path, std::string* error);
  void unloadImpulseResponse();
  ConvolverInfo convolverInfo() const;
  bool setEqBands(const std::string& json, std::string* error);
  bool setEqPreset(const std::string& json, std::string* error);
  void setCrossfeedStrength(double strength);
  void setReplayGainMode(ReplayGainMode mode, double preampDb, double fallbackDb, bool clip);
  /** Overlay host-injected RG / loudnorm measurements onto the active (and matching preload) stream without reopen. */
  void refreshQueueReplayGainTags(const QueueItem& item);
  void setNativeDspPluginChain(const std::string& json);
  std::string nativeDspPluginStatusJson() const;
  bool preloadNext(const std::optional<QueueItem>& item, std::string* error);
  bool skipToPreloaded(const QueueItem& item, std::string* error);

  PipelineStatus status();
  bool consumeEnded();
  bool consumeDeviceInvalidated(std::string* message);
  bool consumeRenderError(std::string* message);
  bool consumeTrackStarted(QueueItem* item);
  size_t getSpectrumData(float* buffer, size_t pointCount) const;
  std::string getVisualizationDataJson(
      size_t spectrumPoints,
      size_t waveformPoints,
      size_t spectrogramFrames,
      size_t oscilloscopePoints = 1024) const;
  bool isDopPathActive() const;
  bool isNativeDsdPathActive() const;
  bool needsPcmFallback(std::string* reason) const;
  /** True when volume/rate/routing/DSP would force a DSD source onto PCM. */
  bool processingForcesDsdPcmFallback() const;
  void setRerouteInProgress(bool active, const std::string& reason = {});

  // Deterministic diagnostics used by the native lifecycle stress gate.
  size_t renderDspGraphGenerationCountForTests() const;
  size_t maxRenderDspGraphGenerationCountForTests() const;
  uint64_t appliedRenderDspEpochForTests() const noexcept;
  OutputInfo::RenderPerformanceSnapshot renderPerformanceSnapshot() const noexcept;

  static void setBackendFactoryForTests(BackendFactory factory);

  /**
   * Override DSD-capable device discovery. Passing an empty function restores
   * the platform default (the ASIO capability probe, or nothing when ASIO is
   * not built).
   */
  static void setNativeDsdDeviceDiscoveryForTests(NativeDsdDeviceDiscovery discovery);

 private:
  enum class ControlCommandType : uint8_t {
    Volume,
    PlaybackRate,
    Routing,
    DspGraph
  };

  struct ControlCommand {
    ControlCommandType type = ControlCommandType::Volume;
    double volume = 1.0;
    double playbackRate = 1.0;
    uint64_t revision = 0;
    uint64_t dspEpoch = 0;
    ChannelRoutingMode routingMode = ChannelRoutingMode::Auto;
    UpmixConfig upmix;
    DspChain* activeDspGraph = nullptr;
    DspChain* preloadDspGraph = nullptr;
    bool gaplessEnabled = true;
    double crossfadeSeconds = 0.0;
  };

  struct LatestControlCommandSlot {
    void publish(const ControlCommand& command) noexcept;
    bool read(ControlCommand* command) const noexcept;

    std::atomic<uint64_t> sequence{0};
    std::atomic<uint64_t> revision{0};
    std::atomic<uint64_t> volumeBits{std::bit_cast<uint64_t>(1.0)};
    std::atomic<uint64_t> playbackRateBits{std::bit_cast<uint64_t>(1.0)};
    std::atomic<uint8_t> type{static_cast<uint8_t>(ControlCommandType::Volume)};
  };

  struct LatestRoutingCommandSlot {
    void publish(const ControlCommand& command) noexcept;
    bool read(ControlCommand* command) const noexcept;

    std::atomic<uint64_t> sequence{0};
    std::atomic<uint32_t> routingMode{static_cast<uint32_t>(ChannelRoutingMode::Auto)};
    std::atomic<uint32_t> centerGainBits{std::bit_cast<uint32_t>(0.7071f)};
    std::atomic<uint32_t> lfeGainBits{std::bit_cast<uint32_t>(0.5f)};
    std::atomic<uint32_t> lfeLowpassHzBits{std::bit_cast<uint32_t>(120.0f)};
    std::atomic<uint32_t> surroundGainBits{std::bit_cast<uint32_t>(0.5f)};
    std::atomic<uint32_t> sideGainBits{std::bit_cast<uint32_t>(0.3f)};
    std::atomic<uint32_t> surroundDelayMsBits{std::bit_cast<uint32_t>(0.0f)};
  };

  struct LatestDspGraphCommandSlot {
    void publish(const ControlCommand& command) noexcept;
    bool read(ControlCommand* command) const noexcept;

    std::atomic<uint64_t> sequence{0};
    std::atomic<uint64_t> revision{0};
    std::atomic<uint64_t> dspEpoch{0};
    std::atomic<uint64_t> activeGraphBits{0};
    std::atomic<uint64_t> preloadGraphBits{0};
    std::atomic<bool> gaplessEnabled{true};
    std::atomic<uint64_t> crossfadeSecondsBits{std::bit_cast<uint64_t>(0.0)};
  };

  struct DecodeStream;
  struct DecodeStreamReaper;

  struct RenderDspGraphGeneration {
    uint64_t epoch = 0;
    uint64_t configRevision = 0;
    bool updatesGraphStatus = false;
    std::unique_ptr<DspChain> active;
    std::unique_ptr<DspChain> preload;
    std::string graphStatusJson;
  };

  static std::shared_ptr<DecodeStream> makeDecodeStream();
  static DecodeStreamReaper& decodeStreamReaper();
  bool configureActiveStreamLocked(
      const std::shared_ptr<DecodeStream>& stream,
      const QueueItem& item,
      double startTimeSeconds,
      std::string* error);
  // `graphProcessingActive` is the applied DSP graph's own verdict on whether it
  // processes audio, which outranks the legacy module flags in `dspConfig`.
  // Absent for config-only callers that never applied a graph.
  bool shouldAttemptDopForCurrentConfig(
      const DspConfig& dspConfig,
      const OutputConfig& outputConfig,
      const std::optional<DsdStreamInfo>& dsdProbe,
      double volume,
      const std::string& backendId,
      std::optional<bool> graphProcessingActive = std::nullopt) const;
  bool shouldAttemptNativeDsdForCurrentConfig(
      const DspConfig& dspConfig,
      const OutputConfig& outputConfig,
      const std::optional<DsdStreamInfo>& dsdProbe,
      double volume,
      const std::string& backendId,
      std::optional<bool> graphProcessingActive = std::nullopt) const;
  std::string determineDsdPcmFallbackReason(
      const DspConfig& dspConfig,
      const OutputConfig& outputConfig,
      const AudioStreamInfo& stream,
      double volume,
      const std::string& backendId,
      const std::string& attemptedDopReason,
      bool dopModeRequested,
      std::optional<bool> graphProcessingActive = std::nullopt) const;
  TAE_Result playInternal(
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
      std::string* error);
  bool updatePerfectLocked();
  PipelineStatus buildStatusLocked();
  PipelineStatus fallbackStatus() const;
  void publishStatusLocked();
  void prepareRenderScratchLocked(size_t maxFrames);
  bool retireDecodeStreamLocked(std::shared_ptr<DecodeStream> stream);
  void cleanupRetiredDecodeStreams() const;
  void tryCleanupRetiredDecodeStreams() const;
  DspChain& activeDspChainLocked();
  const DspChain& activeDspChainLocked() const;
  DspChain& spareDspChainLocked();
  size_t render(float* output, size_t frameCount);
  size_t renderTyped(PcmBlock& output);
  void recordRenderPerformance(size_t frameCount, int sampleRate, uint64_t elapsedNanoseconds) noexcept;
  void enqueueControlCommand(const ControlCommand& command) noexcept;
  void applyPendingControlCommands() noexcept;
  void applyControlCommand(const ControlCommand& command) noexcept;
  void resetRateResampler() noexcept;
  void synchronizeRenderPromotionLocked();
  void reclaimRetiredRenderDspGraphsLocked() const;
  std::string appliedDspGraphStatusJsonLocked() const;
  std::unique_ptr<DspChain> makeDspGraphCandidateLocked(
      const DspConfig& config,
      const std::string& graphJson,
      const DspTrackContext& context,
      std::string* error);
  std::unique_ptr<DspChain> makeRenderDspGraphLocked(
      const DspTrackContext& context,
      std::string* error);
  void commitPreparedRenderDspGraphsLocked(
      uint64_t revision,
      std::unique_ptr<DspChain> activeGraph,
      std::unique_ptr<DspChain> preloadGraph,
      std::string graphStatusJson) noexcept;
  bool publishPreparedRenderDspGraphsLocked(uint64_t revision, std::string* error);
  bool publishPreparedRenderPreloadDspGraphLocked(std::string* error);
  void publishRenderDspPointerTransitionLocked(DspChain* active, DspChain* preload);

  mutable std::mutex mutex_;
  // Serializes the long transport sequences (playInternal's device open and
  // post-commit start, stop's close, skipToPreloaded's promotion, the WASAPI
  // Exclusive topology reopen) that run without mutex_ held. The engine's
  // clock thread (device recovery, EOF auto-next) and the NAPI thread call
  // these concurrently; without this lock their unlocked sections interleave
  // (use-after-free on output_, half-open devices). Recursive because
  // playInternal calls stop() internally and retries itself on DSD fallback.
  // Lock order: transportMutex_ before mutex_, never the reverse.
  std::recursive_mutex transportMutex_;
  std::unique_ptr<IOutputBackend> output_;
  std::shared_ptr<DecodeStream> activeStream_;
  std::shared_ptr<DecodeStream> preloadStream_;
  static constexpr size_t kRetiredStreamSlots = 16;
  mutable std::array<std::shared_ptr<DecodeStream>, kRetiredStreamSlots> retiredStreams_;
  mutable size_t retiredStreamCount_ = 0;
  mutable std::vector<std::shared_ptr<DecodeStream>> deferredRetiredStreams_;
  FftSpectrumAnalyzer spectrum_;
  std::unique_ptr<DspChain> dspChain_;
  std::unique_ptr<DspChain> preloadDspChain_;
  static constexpr size_t kMaxRenderDspGraphGenerations = 8;
  mutable std::vector<RenderDspGraphGeneration> renderDspGraphs_;
  mutable uint64_t appliedDspGraphStatusEpoch_ = 0;
  mutable std::string appliedDspGraphStatusJson_{
      "{\"revision\":0,\"activeSceneId\":null,\"totalLatencyFrames\":0,\"totalTailFrames\":0,\"nodes\":[]}"};
  DspChain* publishedActiveDspGraph_ = nullptr;
  DspChain* publishedPreloadDspGraph_ = nullptr;
  std::string nativeDspPluginChainJson_{"{\"plugins\":[]}"};
  std::string dspGraphJson_;
  DspConfig dspConfig_;
  OutputConfig outputConfig_;
  DspStatus dspStatus_;
  DspStatus preloadDspStatus_;
  AudioStreamInfo stream_;
  AudioFormat outputFormat_;
  AudioFormat decodeFormat_;
  QueueItem currentItem_;
  std::string backendId_;
  std::string deviceId_;
  std::string deviceName_;
  std::string perfectReason_;
  OutputInfo outputInfo_;
  std::atomic<bool> ended_{false};
  std::atomic<bool> deviceInvalidated_{false};
  std::atomic<bool> renderError_{false};
  std::atomic<bool> trackStarted_{false};
  static constexpr size_t kControlCommandCapacity = 32;
  FixedSpscQueue<ControlCommand, kControlCommandCapacity> controlCommands_;
  LatestControlCommandSlot latestOverflowCommand_;
  LatestRoutingCommandSlot latestRoutingCommand_;
  LatestDspGraphCommandSlot latestDspGraphCommand_;
  uint64_t appliedLatestRoutingSequence_ = 0;
  std::atomic<uint64_t> requestedVolumeBits_{std::bit_cast<uint64_t>(1.0)};
  std::atomic<uint64_t> appliedVolumeBits_{std::bit_cast<uint64_t>(1.0)};
  std::atomic<uint64_t> requestedPlaybackRateBits_{std::bit_cast<uint64_t>(1.0)};
  std::atomic<uint64_t> appliedPlaybackRateBits_{std::bit_cast<uint64_t>(1.0)};
  std::atomic<uint64_t> requestedConfigRevision_{0};
  std::atomic<uint64_t> appliedConfigRevision_{0};
  std::atomic<uint64_t> requestedRenderDspEpoch_{0};
  std::atomic<uint64_t> appliedRenderDspEpoch_{0};
  std::atomic<uint64_t> renderedFrames_{0};
  // Render-thread-owned DoP marker phase. Decoder chunks have their own packer
  // phase; this counter also covers backend idle/underrun frames without gaps.
  // Control-side discontinuities publish a reset request; only the render
  // thread mutates the phase itself.
  uint64_t renderDopMarkerIndex_ = 0;
  std::atomic<bool> renderDopMarkerResetRequested_{false};
  // Render-thread volume-ramp state: last gain applied to the output.
  // Negative means "snap to the next applied volume" (fresh stream /
  // promotion). Reset on the control path at transport transitions. Stored as
  // bits per the project's portable-atomics convention (no atomic<double>).
  std::atomic<uint64_t> renderVolumeCurrentBits_{std::bit_cast<uint64_t>(-1.0)};
  // A-B loop (seconds). Enabled only when end > start and both finite/non-negative.
  std::atomic<bool> loopEnabled_{false};
  std::atomic<uint64_t> loopStartBits_{std::bit_cast<uint64_t>(0.0)};
  std::atomic<uint64_t> loopEndBits_{std::bit_cast<uint64_t>(0.0)};
  std::atomic<bool> loopEnforceBusy_{false};
  std::atomic<int> renderChannelCount_{2};
  std::atomic<uint64_t> renderCallbackCount_{0};
  std::atomic<uint64_t> renderTotalCallbackNanoseconds_{0};
  std::atomic<uint64_t> renderPeakCallbackNanoseconds_{0};
  std::atomic<uint64_t> renderTotalDeadlineNanoseconds_{0};
  std::atomic<uint64_t> renderDeadlineMissCount_{0};
  // The output callback owns these values. The control thread only publishes
  // primitive hand-off values or retains the DecodeStream lifetime.
  std::atomic<PipelineState> renderState_{PipelineState::Stopped};
  std::atomic<DecodeStream*> renderActiveStream_{nullptr};
  std::atomic<DecodeStream*> renderPreloadStream_{nullptr};
  std::atomic<bool> renderGaplessEnabled_{true};
  std::atomic<bool> renderDopPathActive_{false};
  std::atomic<bool> renderNativeDsdPathActive_{false};
  std::atomic<bool> renderPcmToDsdPathActive_{false};
  std::atomic<bool> renderTypedPassthroughActive_{false};
  std::atomic<bool> renderActiveUsesPreloadDspChain_{false};
  std::atomic<bool> renderPromotionPending_{false};
  std::atomic<bool> renderCrossfadeResetRequested_{false};
  std::atomic<uint32_t> renderDitherMode_{static_cast<uint32_t>(DspDitherMode::Off)};
  std::atomic<bool> renderDitherResetRequested_{false};
  std::atomic<DspChain*> renderActiveDspGraph_{nullptr};
  std::atomic<DspChain*> renderPreloadDspGraph_{nullptr};
  std::atomic<uint32_t> renderRoutingMode_{static_cast<uint32_t>(ChannelRoutingMode::Auto)};
  std::atomic<uint64_t> renderCrossfadeSecondsBits_{std::bit_cast<uint64_t>(0.0)};
  AudioFormat renderOutputFormat_;
  AudioFormat renderDecodeFormat_;
  // Written only by the render callback, but read on the control path by
  // skipToPreloaded's overlap guard — atomic so that read is defined.
  std::atomic<bool> renderCrossfadeMixActive_{false};
  uint64_t renderCrossfadeFramesProcessed_ = 0;
  uint64_t renderCrossfadeTotalFrames_ = 0;
  std::array<uint32_t, 8> renderDitherRandom_{{0x12345678U, 0x23456789U, 0x3456789aU, 0x456789abU,
                                                0x56789abcU, 0x6789abcdU, 0x789abcdeU, 0x89abcdefU}};
  std::array<float, 8> renderDitherPreviousNoise_{};
  std::array<float, 8> renderDitherError_{};
  PipelineState state_ = PipelineState::Stopped;
  bool dspActive_ = false;
  bool outputPerfect_ = false;
  bool gaplessEnabled_ = true;
  bool dopPathActive_ = false;
  bool nativeDsdPathActive_ = false;
  bool pcmToDsdPathActive_ = false;
  bool typedPassthroughActive_ = false;
  PcmToDsdModulator pcmToDsdModulator_;
  DopPacker pcmToDsdDopPacker_;
  DsdMuteGuard dsdMuteGuard_;
  DsdMuteTransport lastDsdMuteTransport_ = DsdMuteTransport::Pcm;
  int lastDsdMuteRate_ = 0;
  std::vector<float> pcmToDsdFloatScratch_;
  std::vector<uint8_t> pcmToDsdPlanarBytes_;
  std::vector<uint8_t> pcmToDsdInterleavedBytes_;
  std::vector<uint8_t*> pcmToDsdChannelPtrs_;
  // Sticky reason when the most recent preload attempt failed due to format/config mismatch.
  bool lastPreloadFormatMismatch_ = false;
  bool activeUsesPreloadDspChain_ = false;
  bool crossfadeMixActive_ = false;
  uint64_t crossfadeFramesProcessed_ = 0;
  uint64_t crossfadeTotalFrames_ = 0;
  std::string dsdFallbackReason_;
  std::optional<NativeDsdRuntimeFacts> nativeDsdFallbackFacts_;
  bool rerouteInProgress_ = false;
  std::string outputEventMessage_;
  std::vector<float> routingScratch_;
  std::vector<float> preloadRoutingScratch_;
  std::vector<float> preloadMixScratch_;
  std::vector<float> typedVisualizationScratch_;
  // Rate path: WSOLA preserves pitch (prepared on control path only).
  WsolaResampler rateWsola_;
  bool rateWsolaReady_ = false;
  /** True after a non-unity rate callback used WSOLA; cleared when unity flush resets it. */
  bool rateWsolaDirty_ = false;
  ChannelRouter channelRouter_;
  mutable std::mutex statusMutex_;
  PipelineStatus lastStatus_;
};

}  // namespace twilight::audio
