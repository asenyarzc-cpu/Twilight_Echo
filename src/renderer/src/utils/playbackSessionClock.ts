export type PlaybackTransportState = 'idle' | 'loading' | 'playing' | 'paused' | 'stalled' | 'ended'

export type PlaybackSampleSource = 'native-time-pos' | 'native-info' | 'html-audio' | 'intent'

export interface PlaybackClockSnapshot {
  trackId: string
  epoch: number
  position: number
  duration: number
  rate: number
  state: PlaybackTransportState
  revision: number
  sampledAt: number
  source: PlaybackSampleSource
  needsResync: boolean
}

export interface PlaybackClockSample {
  trackId: string
  epoch: number
  position: number
  duration?: number
  rate?: number
  state?: PlaybackTransportState
  sampledAt?: number
  source: PlaybackSampleSource
  expectedRewind?: boolean
}

export interface PlaybackClockTransition {
  trackId: string
  position: number
  duration?: number
  rate?: number
  state?: PlaybackTransportState
}

export interface PlaybackClockOptions {
  now: () => number
  confirmationToleranceSeconds?: number
  transitionGuardMs?: number
  maxPredictionGapMs?: number
  rewindToleranceSeconds?: number
  /**
   * Engine samples this far behind the interpolated playhead are treated as
   * transport lag, not a rewind. Quantized or delayed `time-pos` events otherwise
   * sawtooth the presentation clock and make karaoke / line highlighting jump
   * backward at every boundary.
   */
  laggingSampleToleranceSeconds?: number
}

export type PlaybackClockRejectReason =
  | 'stale-epoch'
  | 'stale-sample'
  | 'wrong-track'
  | 'unexpected-rewind'
  | 'transition-mismatch'
  | 'duplicate-sample'

export interface PlaybackClockIngestResult {
  accepted: boolean
  reason?: PlaybackClockRejectReason
  snapshot: PlaybackClockSnapshot
  advanced: boolean
}

export interface PlaybackSessionClock {
  snapshot: () => PlaybackClockSnapshot
  epoch: () => number
  begin: (transition: PlaybackClockTransition) => PlaybackClockSnapshot
  seek: (position: number, state?: PlaybackTransportState) => PlaybackClockSnapshot
  setTransport: (state: PlaybackTransportState, rate?: number) => PlaybackClockSnapshot
  setDuration: (duration: number) => PlaybackClockSnapshot
  setPosition: (position: number, source?: PlaybackSampleSource) => PlaybackClockSnapshot
  ingest: (sample: PlaybackClockSample) => PlaybackClockIngestResult
  positionAt: (at?: number) => number
  estimate: (at?: number) => PlaybackClockSnapshot | null
  clearResync: () => void
  reset: () => PlaybackClockSnapshot
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positionValue(value: number): number {
  return Math.max(0, finiteNumber(value, 0))
}

function durationValue(value: number): number {
  return Math.max(0, finiteNumber(value, 0))
}

function rateValue(value: number): number {
  return Math.max(0.01, finiteNumber(value, 1))
}

export function createPlaybackSessionClock(options: PlaybackClockOptions): PlaybackSessionClock {
  const maxPredictionGapMs = options.maxPredictionGapMs ?? 1_500
  const confirmationToleranceSeconds = options.confirmationToleranceSeconds ?? 1.5
  const transitionGuardMs = options.transitionGuardMs ?? 3_000
  const rewindToleranceSeconds = options.rewindToleranceSeconds ?? 0.05
  const laggingSampleToleranceSeconds = options.laggingSampleToleranceSeconds ?? 0.5

  let current: PlaybackClockSnapshot = {
    trackId: '',
    epoch: 0,
    position: 0,
    duration: 0,
    rate: 1,
    state: 'idle',
    revision: 0,
    sampledAt: options.now(),
    source: 'intent',
    needsResync: false
  }
  let anchorPosition = 0
  let anchorAt = current.sampledAt
  // A transport can keep emitting the same timestamp while its playhead is
  // stuck. Only an advancing engine position may refresh the interpolation
  // window; presentation estimates deliberately do not.
  let lastProgressAt = current.sampledAt
  let lastObservedPosition = current.position
  let transitionAt: number | null = null
  let transitionGuardUntil = 0
  let transitionPosition = 0

  function publish(
    patch: Partial<Omit<PlaybackClockSnapshot, 'revision' | 'sampledAt'>>,
    at = options.now(),
    observed = true
  ): PlaybackClockSnapshot {
    current = {
      ...current,
      ...patch,
      position: positionValue(patch.position ?? current.position),
      duration: durationValue(patch.duration ?? current.duration),
      rate: rateValue(patch.rate ?? current.rate),
      sampledAt: at,
      revision: current.revision + 1
    }
    if (current.duration > 0) current.position = Math.min(current.position, current.duration)
    anchorPosition = current.position
    anchorAt = at
    if (observed) lastProgressAt = at
    return current
  }

  function begin(transition: PlaybackClockTransition): PlaybackClockSnapshot {
    const now = options.now()
    current = {
      trackId: transition.trackId,
      epoch: current.epoch + 1,
      position: positionValue(transition.position),
      duration: durationValue(transition.duration ?? current.duration),
      rate: rateValue(transition.rate ?? current.rate),
      state: transition.state ?? 'loading',
      revision: current.revision + 1,
      sampledAt: now,
      source: 'intent',
      needsResync: false
    }
    anchorPosition = current.position
    anchorAt = now
    lastProgressAt = now
    lastObservedPosition = current.position
    transitionAt = now
    transitionGuardUntil = now + transitionGuardMs
    transitionPosition = current.position
    return current
  }

  function seek(position: number, state = current.state): PlaybackClockSnapshot {
    const next = begin({
      trackId: current.trackId,
      position,
      duration: current.duration,
      rate: current.rate,
      state
    })
    return { ...next, source: 'intent' }
  }

  function setTransport(state: PlaybackTransportState, rate = current.rate): PlaybackClockSnapshot {
    return publish({ state, rate, needsResync: state !== 'stalled' ? false : current.needsResync })
  }

  function setDuration(duration: number): PlaybackClockSnapshot {
    return publish({ duration })
  }

  function setPosition(
    position: number,
    source: PlaybackSampleSource = 'intent'
  ): PlaybackClockSnapshot {
    const next = publish({ position, source, needsResync: false })
    lastObservedPosition = next.position
    return next
  }

  function ingest(sample: PlaybackClockSample): PlaybackClockIngestResult {
    const at = finiteNumber(sample.sampledAt, options.now())
    if (sample.trackId !== current.trackId) {
      return { accepted: false, reason: 'wrong-track', snapshot: current, advanced: false }
    }
    if (sample.epoch !== current.epoch) {
      return { accepted: false, reason: 'stale-epoch', snapshot: current, advanced: false }
    }
    if (at < lastProgressAt) {
      return { accepted: false, reason: 'stale-sample', snapshot: current, advanced: false }
    }

    const position = positionValue(sample.position)
    if (transitionAt !== null) {
      if (at > transitionGuardUntil) {
        transitionAt = null
      } else if (!sample.expectedRewind) {
        const state = sample.state ?? current.state
        const elapsed =
          state === 'playing' || state === 'loading'
            ? Math.max(0, (at - transitionAt) / 1_000) * current.rate
            : 0
        if (Math.abs(position - (transitionPosition + elapsed)) > confirmationToleranceSeconds) {
          return {
            accepted: false,
            reason: 'transition-mismatch',
            snapshot: current,
            advanced: false
          }
        }
      }
    }
    const rewind = position + rewindToleranceSeconds < lastObservedPosition
    if (rewind && !sample.expectedRewind) {
      return { accepted: false, reason: 'unexpected-rewind', snapshot: current, advanced: false }
    }
    const advanced = position > lastObservedPosition + rewindToleranceSeconds
    if (!advanced && !rewind && at === lastProgressAt) {
      return { accepted: false, reason: 'duplicate-sample', snapshot: current, advanced: false }
    }

    lastObservedPosition = position
    const interpolating =
      (sample.state ?? current.state) === 'playing' || (sample.state ?? current.state) === 'loading'
    if (interpolating && !sample.expectedRewind && !rewind) {
      const behind = positionAt(at) - position
      if (behind > 0 && behind <= laggingSampleToleranceSeconds) {
        // The engine is alive but late. Keep interpolating from the last
        // presentation anchor so karaoke and the playhead never walk backward.
        lastProgressAt = at
        return { accepted: true, snapshot: current, advanced: false }
      }
    }
    if (!advanced && !rewind && interpolating) {
      // Keep the last advancing sample as the anchor. Otherwise repeated
      // time-pos events with a frozen value would stop the shared timeline.
      return { accepted: true, snapshot: current, advanced: false }
    }

    const next = publish(
      {
        position,
        duration: sample.duration ?? current.duration,
        rate: sample.rate ?? current.rate,
        state: sample.state ?? current.state,
        source: sample.source,
        needsResync: false
      },
      at
    )
    return { accepted: true, snapshot: next, advanced }
  }

  function estimate(at = options.now()): PlaybackClockSnapshot | null {
    const elapsed = Math.max(0, at - lastProgressAt)
    if (current.state !== 'playing' && current.state !== 'loading') return null
    if (elapsed > maxPredictionGapMs) {
      if (!current.needsResync) {
        current = {
          ...current,
          state: 'stalled',
          needsResync: true,
          revision: current.revision + 1,
          sampledAt: at
        }
      }
      return current
    }

    return publish({ position: positionAt(at), source: 'intent', needsResync: false }, at, false)
  }

  function positionAt(at = options.now()): number {
    if (current.state !== 'playing' && current.state !== 'loading') return current.position
    const elapsed = Math.max(0, at - lastProgressAt)
    if (elapsed > maxPredictionGapMs) return current.position
    const estimated = positionValue(
      anchorPosition + (Math.max(0, at - anchorAt) / 1_000) * current.rate
    )
    return current.duration > 0 ? Math.min(estimated, current.duration) : estimated
  }

  function clearResync(): void {
    if (!current.needsResync) return
    current = { ...current, needsResync: false, revision: current.revision + 1 }
  }

  function reset(): PlaybackClockSnapshot {
    current = {
      trackId: '',
      epoch: current.epoch + 1,
      position: 0,
      duration: 0,
      rate: 1,
      state: 'idle',
      revision: current.revision + 1,
      sampledAt: options.now(),
      source: 'intent',
      needsResync: false
    }
    anchorPosition = 0
    anchorAt = current.sampledAt
    lastProgressAt = current.sampledAt
    lastObservedPosition = current.position
    transitionAt = null
    transitionGuardUntil = 0
    transitionPosition = 0
    return current
  }

  return {
    snapshot: () => current,
    epoch: () => current.epoch,
    begin,
    seek,
    setTransport,
    setDuration,
    setPosition,
    ingest,
    positionAt,
    estimate,
    clearResync,
    reset
  }
}
