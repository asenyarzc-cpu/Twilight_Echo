#pragma once

#include "AudioPipeline.h"
#include "../playlist/QueueManager.h"
#include "twilight_audio_engine.h"

#include <cstdint>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {

enum class PlaybackState {
  Stopped,
  Playing,
  Paused
};

struct PlaybackInfo {
  PlaybackState state = PlaybackState::Stopped;
  double positionSeconds = 0.0;
  double durationSeconds = 0.0;
  double volume = 1.0;
  double playbackRate = 1.0;
  uint64_t requestedConfigRevision = 0;
  uint64_t appliedConfigRevision = 0;
  int queueIndex = -1;
  std::string playMode = "sequential";
  std::string source;
  std::string codec = "未知";
  int bitrate = 0;
  int sourceSampleRate = 0;
  int sourceBitDepth = 0;
  int decodedSampleRate = 0;
  int decodedBitDepth = 0;
  int decodedChannels = 0;
  std::string decodedSampleFormat;
  std::string outputBackend = "wasapi";
  std::string outputDevice = "auto";
  OutputInfo outputInfo;
  std::string actualBackend;
  std::string driverName;
  long driverVersion = 0;
  std::string actualOutputFormat;
  int actualSampleRate = 0;
  int actualBitDepth = 0;
  int actualChannels = 0;
  int bufferSizeFrames = 0;
  int latencyFrames = 0;
  double latencyMs = 0.0;
  bool deviceRecovered = false;
  int recoveryCount = 0;
  int outputSampleRate = 0;
  int outputBitDepth = 0;
  int channelCount = 0;
  bool supportsOutputPerfect = false;
  bool sourceExact = false;
  bool outputPerfect = false;
  bool pcmPassthrough = false;
  bool dspActive = false;
  bool replayGainActive = false;
  bool loudnormActive = false;
  bool eqActive = false;
  bool convolverActive = false;
  bool crossfeedActive = false;
  bool crossfadeActive = false;
  bool fftActive = false;
  bool irResampled = false;
  double replayGainDb = 0.0;
  double crossfeedStrength = 0.0;
  double crossfadeSeconds = 0.0;
  uint32_t convolverLatencyFrames = 0;
  uint32_t partitionSize = 0;
  std::string channelMappingMode;
  std::string perfectReasonCode;
  std::string perfectReason;
  bool isDsd = false;
  std::string dsdMode = "unsupported";
  int dsdRate = 0;
  bool gaplessActive = false;
  bool preloadReady = false;
  // Empty when gapless path is unblocked; otherwise one of:
  // disabled | dsd_path | typed_passthrough | crossfade | format_mismatch
  std::string gaplessBlockedReason;
  bool hasUpcomingTrack = false;
  QueueItem upcomingTrack;
  /** Live ICY / stream metadata title (radio). Empty when unavailable. */
  std::string streamTitle;
};

class TwilightAudioEngine {
 public:
  TwilightAudioEngine();
  ~TwilightAudioEngine();

  TwilightAudioEngine(const TwilightAudioEngine&) = delete;
  TwilightAudioEngine& operator=(const TwilightAudioEngine&) = delete;

  void setEventCallback(TAE_EventCallback callback, void* userData);

  TAE_Result play(const std::string& source, double startTimeSeconds);
  TAE_Result pause();
  TAE_Result stop();
  TAE_Result seek(double positionSeconds);
  TAE_Result setVolume(double volume);
  TAE_Result setPlaybackRate(double rate);
  TAE_Result setLoopRange(double startSeconds, double endSeconds);
  TAE_Result setOutputDevice(const std::string& deviceId);
  TAE_Result setOutputBackend(const std::string& backendId);

  TAE_Result loadQueue(const std::string& queueJson, int startIndex);
  TAE_Result addToQueue(const std::string& itemJson);
  TAE_Result removeFromQueue(int index);
  TAE_Result next();
  TAE_Result previous();
  TAE_Result setPlayMode(const std::string& mode);

  TAE_Result setDspConfig(const std::string& dspJson);
  TAE_Result setDspGraph(const std::string& graphJson);
  TAE_Result applyDspState(uint64_t revision, const std::string& stateJson);
  TAE_Result setOutputConfig(const std::string& outputConfigJson);
  TAE_Result loadImpulseResponse(const std::string& path);
  TAE_Result unloadImpulseResponse();
  std::string getConvolverInfoJson() const;
  TAE_Result setEqBands(const std::string& eqJson);
  TAE_Result setEqPreset(const std::string& presetJson);
  TAE_Result setCrossfeedStrength(double strength);
  TAE_Result setReplayGainMode(const std::string& mode, double preampDb, double fallbackDb, bool clip);
  TAE_Result setNativeDspPluginChain(const std::string& chainJson);
  std::string getNativeDspPluginStatusJson() const;
  std::string getDspConfig() const;
  std::string getDspGraphStatusJson() const;
  std::string getMetadataJson(const std::string& source) const;
  std::string getQueueJson() const;
  std::string getUpcomingTrackJson() const;
  std::string enumerateDevicesJson() const;
  std::string enumerateBackendsJson() const;
  std::string engineCapabilitiesJson() const;
  std::string getLastErrorJson() const;
  std::string getPlaybackInfoJson() const;
  size_t getSpectrumData(float* buffer, size_t pointCount) const;
  std::string getVisualizationDataJson(const std::string& optionsJson) const;

 private:
  void startClock();
  void stopClock();
  void clockLoop();
  void emit(const char* type, const std::string& payload) const;
  void emitError(
      const std::string& message,
      TAE_Result code = TAE_RESULT_INTERNAL_ERROR,
      const std::string& context = {}) const;
  void publishStateLocked() const;
  void applyPipelineStatusLocked(const PipelineStatus& status);
  void updatePerfectLocked();
  TAE_Result playQueueItem(const QueueItem& item, double startTimeSeconds);
  bool shouldReroutePipelineLocked(std::string* reason, double* position, PlaybackState* state) const;
  TAE_Result restartCurrentPlaybackForReroute(
      double positionSeconds,
      PlaybackState previousState,
      const std::string& reason,
      const std::string& context);
  QueueItem currentItemLocked() const;

  mutable std::mutex mutex_;
  PlaybackInfo info_;
  QueueManager queue_;
  std::string dspConfigJson_ = "{}";
  std::string dspGraphJson_;
  DspConfig dspConfig_;
  std::string nativeDspPluginChainJson_ = "{\"plugins\":[]}";
  OutputConfig outputConfig_;
  bool outputRoutePending_ = false;
  std::unique_ptr<AudioPipeline> pipeline_;
  TAE_EventCallback eventCallback_ = nullptr;
  void* eventUserData_ = nullptr;
  mutable std::mutex errorMutex_;
  mutable std::string lastError_;
  mutable TAE_Result lastErrorCode_ = TAE_RESULT_OK;
  mutable std::string lastErrorContext_;
  std::atomic<bool> running_{true};
  std::thread clockThread_;
  std::chrono::steady_clock::time_point lastTick_;
  uint64_t lastEmittedAppliedConfigRevision_ = 0;
};

}  // namespace twilight::audio
