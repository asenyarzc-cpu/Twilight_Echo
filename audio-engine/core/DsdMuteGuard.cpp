#include "DsdMuteGuard.h"

#include <algorithm>

namespace twilight::audio {
namespace {
uint32_t clampFrames(uint32_t value) noexcept {
  return std::min(value, DsdMuteGuard::kMaxFrames);
}
}

void DsdMuteGuard::configure(const DsdMuteGuardConfig& config) noexcept {
  config_.preRollFrames = clampFrames(config.preRollFrames);
  config_.postRollFrames = clampFrames(config.postRollFrames);
  config_.timeoutFrames = config.timeoutFrames == 0 ? 4096 : clampFrames(config.timeoutFrames);
}

DsdMuteGuardPlan DsdMuteGuard::arm(DsdMuteTransport from, DsdMuteTransport to, int fromRate, int toRate) noexcept {
  plan_.from = from;
  plan_.to = to;
  plan_.rateChanged = fromRate > 0 && toRate > 0 && fromRate != toRate;
  plan_.transition = transitionFor(from, to, plan_.rateChanged);
  plan_.preRollFrames = config_.preRollFrames;
  plan_.postRollFrames = config_.postRollFrames;
  plan_.timeoutFrames = config_.timeoutFrames;
  preRollRemaining_.store(plan_.preRollFrames, std::memory_order_release);
  postRollRemaining_.store(plan_.postRollFrames, std::memory_order_release);
  lockWaitFrames_.store(0, std::memory_order_release);
  lockConfirmed_.store(false, std::memory_order_release);
  lockRequired_.store(to != DsdMuteTransport::Pcm, std::memory_order_release);
  state_.store(static_cast<uint8_t>(DsdMuteState::Locking), std::memory_order_release);
  return plan_;
}

size_t DsdMuteGuard::consumePreRoll(size_t callbackFrames) noexcept {
  if (callbackFrames == 0) return 0;
  uint32_t remaining = preRollRemaining_.load(std::memory_order_acquire);
  while (remaining > 0) {
    const uint32_t requested = static_cast<uint32_t>(std::min<size_t>(callbackFrames, remaining));
    if (preRollRemaining_.compare_exchange_weak(remaining, remaining - requested, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return requested;
    }
  }
  return 0;
}

size_t DsdMuteGuard::consumePostRoll(size_t callbackFrames) noexcept {
  if (callbackFrames == 0) return 0;
  uint32_t remaining = postRollRemaining_.load(std::memory_order_acquire);
  while (remaining > 0) {
    const uint32_t requested = static_cast<uint32_t>(std::min<size_t>(callbackFrames, remaining));
    if (postRollRemaining_.compare_exchange_weak(remaining, remaining - requested, std::memory_order_acq_rel, std::memory_order_acquire)) {
      if (remaining == requested && preRollRemaining_.load(std::memory_order_acquire) == 0)
        state_.store(static_cast<uint8_t>(DsdMuteState::Ready), std::memory_order_release);
      return requested;
    }
  }
  if (preRollRemaining_.load(std::memory_order_acquire) == 0 && state_.load(std::memory_order_acquire) == static_cast<uint8_t>(DsdMuteState::Muting)) {
    state_.store(static_cast<uint8_t>(DsdMuteState::Ready), std::memory_order_release);
  }
  return 0;
}

void DsdMuteGuard::markFallback() noexcept {
  preRollRemaining_.store(0, std::memory_order_release);
  postRollRemaining_.store(0, std::memory_order_release);
  state_.store(static_cast<uint8_t>(DsdMuteState::Fallback), std::memory_order_release);
}

bool DsdMuteGuard::muteNext(size_t callbackFrames) noexcept {
  const DsdMuteState current = state();
  if (current == DsdMuteState::Fallback || current == DsdMuteState::Stopped) return current == DsdMuteState::Fallback;
  if (current == DsdMuteState::Ready) return false;
  if (preRollRemaining() > 0) {
    consumePreRoll(callbackFrames);
    return true;
  }
  if (current == DsdMuteState::Locking) {
    if (lockConfirmed_.load(std::memory_order_acquire) || !lockRequired_.load(std::memory_order_acquire)) {
      state_.store(
          static_cast<uint8_t>(postRollRemaining() > 0 ? DsdMuteState::Muting : DsdMuteState::Ready),
          std::memory_order_release);
    } else {
      const uint32_t callbackFrames32 = static_cast<uint32_t>(std::min<size_t>(callbackFrames, kMaxFrames));
      const uint32_t waited = lockWaitFrames_.fetch_add(callbackFrames32, std::memory_order_acq_rel) + callbackFrames32;
      if (waited >= plan_.timeoutFrames) markFallback();
      return true;
    }
  }
  if (state() == DsdMuteState::Muting) {
    consumePostRoll(callbackFrames);
    return true;
  }
  return false;
}

void DsdMuteGuard::confirmLock() noexcept {
  lockConfirmed_.store(true, std::memory_order_release);
}

void DsdMuteGuard::stop() noexcept {
  preRollRemaining_.store(0, std::memory_order_release);
  postRollRemaining_.store(0, std::memory_order_release);
  lockWaitFrames_.store(0, std::memory_order_release);
  state_.store(static_cast<uint8_t>(DsdMuteState::Stopped), std::memory_order_release);
}

DsdMuteState DsdMuteGuard::state() const noexcept { return static_cast<DsdMuteState>(state_.load(std::memory_order_acquire)); }
DsdMuteGuardPlan DsdMuteGuard::plan() const noexcept { return plan_; }
uint32_t DsdMuteGuard::preRollRemaining() const noexcept { return preRollRemaining_.load(std::memory_order_acquire); }
uint32_t DsdMuteGuard::postRollRemaining() const noexcept { return postRollRemaining_.load(std::memory_order_acquire); }

DsdMuteTransition DsdMuteGuard::transitionFor(DsdMuteTransport from, DsdMuteTransport to, bool rateChanged) noexcept {
  if (from == to) return rateChanged ? DsdMuteTransition::RateChange : DsdMuteTransition::None;
  if (from == DsdMuteTransport::Pcm && to == DsdMuteTransport::Dop) return DsdMuteTransition::PcmToDop;
  if (from == DsdMuteTransport::Dop && to == DsdMuteTransport::Pcm) return DsdMuteTransition::DopToPcm;
  if (from == DsdMuteTransport::Pcm && to == DsdMuteTransport::Native) return DsdMuteTransition::PcmToNative;
  if (from == DsdMuteTransport::Native && to == DsdMuteTransport::Pcm) return DsdMuteTransition::NativeToPcm;
  if (from == DsdMuteTransport::Dop && to == DsdMuteTransport::Native) return DsdMuteTransition::DopToNative;
  if (from == DsdMuteTransport::Native && to == DsdMuteTransport::Dop) return DsdMuteTransition::NativeToDop;
  return DsdMuteTransition::RateChange;
}

const char* DsdMuteGuard::transportName(DsdMuteTransport transport) noexcept {
  switch (transport) { case DsdMuteTransport::Dop: return "dop"; case DsdMuteTransport::Native: return "native"; case DsdMuteTransport::Pcm: default: return "pcm"; }
}
const char* DsdMuteGuard::transitionName(DsdMuteTransition transition) noexcept {
  switch (transition) {
    case DsdMuteTransition::PcmToDop: return "pcm-to-dop"; case DsdMuteTransition::DopToPcm: return "dop-to-pcm";
    case DsdMuteTransition::PcmToNative: return "pcm-to-native"; case DsdMuteTransition::NativeToPcm: return "native-to-pcm";
    case DsdMuteTransition::DopToNative: return "dop-to-native"; case DsdMuteTransition::NativeToDop: return "native-to-dop";
    case DsdMuteTransition::RateChange: return "rate-change"; case DsdMuteTransition::None: default: return "none";
  }
}
const char* DsdMuteGuard::stateName(DsdMuteState state) noexcept {
  switch (state) { case DsdMuteState::Locking: return "locking"; case DsdMuteState::Muting: return "muting"; case DsdMuteState::Fallback: return "fallback"; case DsdMuteState::Ready: return "ready"; case DsdMuteState::Stopped: default: return "stopped"; }
}
uint8_t DsdMuteGuard::silenceByte(DsdMuteTransport transport, AudioSampleFormat format) noexcept {
  if (transport == DsdMuteTransport::Pcm) return 0x00;
  if (transport == DsdMuteTransport::Dop) return 0x96;
  switch (format) {
    case AudioSampleFormat::DsdInt8Lsb1: return 0x69;
    case AudioSampleFormat::DsdInt8Msb1: return 0x96;
    case AudioSampleFormat::DsdInt8Ner8: return 0x69;
    default: return 0x69;
  }
}
DsdMuteTransport dsdMuteTransportForMode(DsdMode mode, bool dsdStream) noexcept {
  if (!dsdStream || mode == DsdMode::Pcm || mode == DsdMode::Unsupported) return DsdMuteTransport::Pcm;
  return mode == DsdMode::Native ? DsdMuteTransport::Native : DsdMuteTransport::Dop;
}
}  // namespace twilight::audio
