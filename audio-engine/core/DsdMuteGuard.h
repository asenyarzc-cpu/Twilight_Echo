#pragma once

#include "AudioTypes.h"

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace twilight::audio {

enum class DsdMuteTransport : uint8_t { Pcm, Dop, Native };

enum class DsdMuteTransition : uint8_t {
  None,
  PcmToDop,
  DopToPcm,
  PcmToNative,
  NativeToPcm,
  DopToNative,
  NativeToDop,
  RateChange
};

enum class DsdMuteState : uint8_t { Ready, Locking, Muting, Fallback, Stopped };

struct DsdMuteGuardConfig {
  uint32_t preRollFrames = 256;
  uint32_t postRollFrames = 256;
  uint32_t timeoutFrames = 4096;
};

struct DsdMuteGuardPlan {
  DsdMuteTransition transition = DsdMuteTransition::None;
  DsdMuteTransport from = DsdMuteTransport::Pcm;
  DsdMuteTransport to = DsdMuteTransport::Pcm;
  uint32_t preRollFrames = 0;
  uint32_t postRollFrames = 0;
  uint32_t timeoutFrames = 0;
  bool rateChanged = false;
};

class DsdMuteGuard {
 public:
  static constexpr uint32_t kMaxFrames = 4096;

  void configure(const DsdMuteGuardConfig& config) noexcept;
  DsdMuteGuardPlan arm(DsdMuteTransport from, DsdMuteTransport to, int fromRate, int toRate) noexcept;
  size_t consumePreRoll(size_t callbackFrames) noexcept;
  size_t consumePostRoll(size_t callbackFrames) noexcept;
  bool muteNext(size_t callbackFrames) noexcept;
  void confirmLock() noexcept;
  void markFallback() noexcept;
  void stop() noexcept;
  DsdMuteState state() const noexcept;
  DsdMuteGuardPlan plan() const noexcept;
  uint32_t preRollRemaining() const noexcept;
  uint32_t postRollRemaining() const noexcept;
  static DsdMuteTransition transitionFor(DsdMuteTransport from, DsdMuteTransport to, bool rateChanged) noexcept;
  static const char* transportName(DsdMuteTransport transport) noexcept;
  static const char* transitionName(DsdMuteTransition transition) noexcept;
  static const char* stateName(DsdMuteState state) noexcept;
  static uint8_t silenceByte(DsdMuteTransport transport, AudioSampleFormat format) noexcept;

 private:
  DsdMuteGuardConfig config_{};
  DsdMuteGuardPlan plan_{};
  std::atomic<uint32_t> preRollRemaining_{0};
  std::atomic<uint32_t> postRollRemaining_{0};
  std::atomic<uint32_t> lockWaitFrames_{0};
  std::atomic<bool> lockConfirmed_{false};
  std::atomic<bool> lockRequired_{false};
  std::atomic<uint8_t> state_{static_cast<uint8_t>(DsdMuteState::Stopped)};
};

DsdMuteTransport dsdMuteTransportForMode(DsdMode mode, bool dsdStream) noexcept;

}  // namespace twilight::audio
