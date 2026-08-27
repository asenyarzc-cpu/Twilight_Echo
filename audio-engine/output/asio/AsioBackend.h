#pragma once

#include "IAsioHost.h"
#include "../IOutputBackend.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {

class AsioBackend final : public IOutputBackend {
 public:
  AsioBackend();
  explicit AsioBackend(std::unique_ptr<IAsioHost> host);
  ~AsioBackend() override;

  const char* id() const override;
  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) override;
  bool setOutputConfig(const OutputConfig& config, std::string* error) override;
  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) override;
  bool startTyped(
      TypedRenderCallback callback,
      RenderCallback fallbackCallback,
      OutputEventCallback eventCallback,
      std::string* error) override;
  void stop() override;
  void close() override;

  AudioFormat outputFormat() const override;
  OutputInfo outputInfo() const override;
  DopRuntimeFacts dopRuntimeFacts() const override;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override;
  std::string deviceName() const override;

 private:
  struct RecoveryRequest {
    AsioHostEvent event;
    std::string message;
  };

  struct FormatCandidate;

  bool chooseFormat(const AsioDeviceInfo& device, const AudioFormat& requestedFormat, AudioFormat* selected) const;
  /**
   * Ranked format candidates, best first. The driver is the only authority on
   * what it accepts, so open() walks this list instead of committing to a
   * single guess that a rejection turns into a hard playback failure.
   */
  std::vector<AudioFormat> rankFormatCandidates(
      const AsioDeviceInfo& device,
      const AudioFormat& requestedFormat) const;
  /**
   * Ensure `device` carries probed capabilities, interrogating the driver on a
   * cache miss. Falls back to the identity-only record when the probe fails so
   * a probe-hostile driver still gets the legacy best-effort path.
   */
  void ensureDeviceCapabilities(AsioDeviceInfo* device) const;
  long chooseBufferSize(const AsioDeviceInfo& device, const AudioFormat& requestedFormat) const;
  int routedOutputChannels(const AsioDeviceInfo& device, int sourceChannels) const;
  void renderBuffer(long bufferIndex);
  void notifyOutputReady() noexcept;
  void recordRenderUnderrun() noexcept;
  void recordRenderBufferDrop() noexcept;
  void queueRecoveryFromHostCallback(AsioHostEvent event, std::string message);
  void recoveryWorkerLoop();
  void joinRecoveryThread();
  /** Stops the recovery worker (clearing pending requests), joins it, and re-arms start. */
  void stopAndJoinRecoveryWorker();
  bool recover(AsioHostEvent event, const std::string& message);
  bool createAndStartHost(std::string* error);

  std::unique_ptr<IAsioHost> host_;
  mutable std::mutex mutex_;
  std::mutex recoveryQueueMutex_;
  std::condition_variable recoveryQueueCv_;
  std::thread recoveryThread_;
  std::deque<RecoveryRequest> recoveryRequests_;
  RenderCallback callback_;
  TypedRenderCallback typedCallback_;
  OutputEventCallback eventCallback_;
  OutputConfig outputConfig_;
  AsioOpenConfig openConfig_;
  AsioDeviceInfo deviceInfo_;
  AudioFormat outputFormat_;
  OutputInfo outputInfo_;
  DopRuntimeFacts dopRuntimeFacts_;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts_;
  std::string deviceName_ = "ASIO";
  std::string driverName_;
  long driverVersion_ = 0;
  long bufferSizeFrames_ = 0;
  long latencyFrames_ = 0;
  OutputInfo::Diagnostics diagnostics_;
  int recoveryAttempts_ = 0;
  int recoveryCount_ = 0;
  std::deque<std::chrono::steady_clock::time_point> recoveryWindow_;
  std::chrono::steady_clock::time_point recoveryCooldownUntil_{};
  bool recoveryInProgress_ = false;
  bool deviceRecovered_ = false;
  bool opened_ = false;
  bool actualOutputFormatObserved_ = false;
  bool actualOutputChannelFormatsMatch_ = true;
  bool nativeDsdTypedCallbackMissing_ = false;
  std::atomic<bool> firstNativeDsdBufferClaimed_{false};
  std::atomic<bool> firstNativeDsdBufferObserved_{false};
  std::atomic<size_t> firstNativeDsdInspectedBytes_{0};
  std::atomic<uint8_t> firstNativeDsdIdleByte_{0};
  std::atomic<uint64_t> firstNativeDsdHash_{0};
  // 0=pending, 1=first typed DoP block alternates markers, 2=invalid marker sequence.
  std::atomic<int> dopMarkerState_{0};
  std::atomic<size_t> dopMarkerFramesVerified_{0};
  std::atomic<bool> running_{false};
  std::atomic<bool> stopRequested_{false};
  // Immutable for the lifetime of a started host session. The driver callback
  // reads these directly and never contends with status polling/recovery locks.
  RenderCallback renderCallbackSession_;
  TypedRenderCallback typedCallbackSession_;
  OutputConfig renderOutputConfigSession_;
  AudioFormat renderOutputFormatSession_;
  AudioFormat renderOpenFormatSession_;
  long renderBufferSizeFramesSession_ = 0;
  bool renderChannelFormatsMatchSession_ = true;
  std::vector<AsioChannelFormat> renderChannelFormatsSession_;
  std::vector<float> renderScratch_;
  std::vector<uint8_t> typedRenderScratch_;
  std::chrono::high_resolution_clock::time_point lastRenderTime_{};
  uint32_t renderCallbacksSeen_ = 0;
  // Consecutive render callbacks whose measured interval matches the 1-bit
  // sample cadence instead of the packed byte-frame cadence this backend
  // writes with. Callback thread only, like renderCallbacksSeen_.
  uint32_t dsdBitUnitCallbackStreak_ = 0;
  std::atomic<uint64_t> pendingRenderUnderruns_{0};
  std::atomic<uint64_t> pendingRenderBufferDrops_{0};
  std::atomic<uint64_t> pendingDsdShortReads_{0};
  std::atomic<uint64_t> pendingDsdIdleFrames_{0};
  std::atomic<bool> outputReadyEnabled_{true};
  std::atomic<bool> pendingNativeDsdTypedCallbackMissing_{false};
  // Set once the callback cadence proves the driver counts DSD buffers in
  // 1-bit samples, meaning the byte-frame writes are 8x too large. Surfaced
  // as an honest passthrough failure instead of continuing the overflow.
  std::atomic<bool> pendingDsdBufferUnitMismatch_{false};
};

bool asioBackendAvailable();

}  // namespace twilight::audio
