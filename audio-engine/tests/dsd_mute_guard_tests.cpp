#include "../core/DsdMuteGuard.h"

#include <cassert>

using namespace twilight::audio;

int main() {
  DsdMuteGuard guard;
  guard.configure({3, 2, 9});
  const auto pcmDop = guard.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Dop, 44100, 176400);
  assert(pcmDop.transition == DsdMuteTransition::PcmToDop);
  assert(guard.state() == DsdMuteState::Locking);
  assert(guard.consumePreRoll(2) == 2);
  assert(guard.preRollRemaining() == 1);
  assert(guard.consumePreRoll(8) == 1);
  assert(guard.state() == DsdMuteState::Locking);
  guard.confirmLock();
  assert(guard.muteNext(1));
  assert(guard.state() == DsdMuteState::Muting);
  assert(guard.consumePostRoll(1) == 1);
  assert(guard.consumePostRoll(4) == 0);
  assert(guard.state() == DsdMuteState::Ready);

  DsdMuteGuard timeout;
  timeout.configure({0, 0, 3});
  timeout.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Dop, 44100, 176400);
  assert(timeout.state() == DsdMuteState::Locking);
  assert(timeout.muteNext(2));
  assert(timeout.state() == DsdMuteState::Locking);
  assert(timeout.muteNext(2));
  assert(timeout.state() == DsdMuteState::Fallback);

  DsdMuteGuard pcm;
  pcm.configure({0, 0, 3});
  pcm.arm(DsdMuteTransport::Pcm, DsdMuteTransport::Pcm, 44100, 44100);
  assert(!pcm.muteNext(1));
  assert(pcm.state() == DsdMuteState::Ready);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Dop, DsdMuteTransport::Pcm, false) == DsdMuteTransition::DopToPcm);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Pcm, DsdMuteTransport::Native, false) == DsdMuteTransition::PcmToNative);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Pcm, false) == DsdMuteTransition::NativeToPcm);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Dop, DsdMuteTransport::Native, false) == DsdMuteTransition::DopToNative);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Dop, false) == DsdMuteTransition::NativeToDop);
  assert(DsdMuteGuard::transitionFor(DsdMuteTransport::Native, DsdMuteTransport::Native, true) == DsdMuteTransition::RateChange);
  guard.markFallback();
  assert(guard.state() == DsdMuteState::Fallback);
  guard.stop();
  assert(guard.state() == DsdMuteState::Stopped);
  assert(dsdMuteTransportForMode(DsdMode::Native, false) == DsdMuteTransport::Pcm);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Pcm, AudioSampleFormat::Float32Interleaved) == 0x00);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Dop, AudioSampleFormat::Int24Interleaved) == 0x96);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Native, AudioSampleFormat::DsdInt8Lsb1) == 0x69);
  assert(DsdMuteGuard::silenceByte(DsdMuteTransport::Native, AudioSampleFormat::DsdInt8Msb1) == 0x96);
  return 0;
}
