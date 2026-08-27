export type TempoEstimateSource = 'analyzing' | 'metadata' | 'live'

export interface TempoEstimate {
  bpm?: number
  confidence: number
  source: TempoEstimateSource
}

export interface TempoFrameInput {
  timestamp: number
  visualizerBars: ArrayLike<number>
  waveform?: ArrayLike<number>
  rmsDb: number
  active: boolean
  referenceBpm?: number
}

interface OnsetSample {
  timestamp: number
  strength: number
}

const MIN_BPM = 30
const MAX_BPM = 300
const LIVE_MIN_BPM = 60
const LIVE_MAX_BPM = 200
const HISTORY_MS = 20000
const MIN_ANALYSIS_HISTORY_MS = 8000
const ANALYSIS_INTERVAL_MS = 500
const RESET_GAP_MS = 3000
const STABLE_CONFIDENCE = 0.62
const STABLE_BPM_SPREAD = 3
const REQUIRED_STABLE_ESTIMATES = 3
const STABLE_HOLD_MS = 15000

export function normalizeBpm(value: unknown): number | undefined {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(numeric) || numeric < MIN_BPM || numeric > MAX_BPM) return undefined
  return Math.round(numeric * 10) / 10
}

function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.pow(10, db / 20)
}

function emptyEstimate(): TempoEstimate {
  return { source: 'analyzing', confidence: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint]
}

export class AudioTempoEstimator {
  private previousBars: Float32Array | null = null
  private previousRms = 0
  private previousWaveformLevel = 0
  private previousTimestamp: number | null = null
  private samples: OnsetSample[] = []
  private stableCandidates: number[] = []
  private lastAnalysisAt = -Infinity
  private lastStableEstimate: TempoEstimate | null = null
  private lastStableAt = -Infinity
  private referenceBpm: number | undefined
  private estimate: TempoEstimate = emptyEstimate()

  reset(): void {
    this.previousBars = null
    this.previousRms = 0
    this.previousWaveformLevel = 0
    this.previousTimestamp = null
    this.samples = []
    this.stableCandidates = []
    this.lastAnalysisAt = -Infinity
    this.lastStableEstimate = null
    this.lastStableAt = -Infinity
    this.referenceBpm = undefined
    this.estimate = emptyEstimate()
  }

  getState(): TempoEstimate {
    return { ...this.estimate }
  }

  pushFrame(input: TempoFrameInput): TempoEstimate {
    if (!input.active || !Number.isFinite(input.timestamp)) {
      this.reset()
      return this.getState()
    }
    if (
      this.previousTimestamp !== null &&
      input.timestamp - this.previousTimestamp > RESET_GAP_MS
    ) {
      this.reset()
    }

    const bars = this.copyBars(input.visualizerBars)
    const rms = dbToLinear(input.rmsDb)
    this.referenceBpm = normalizeBpm(input.referenceBpm)
    const waveformLevel = this.measureWaveformLevel(input.waveform)
    const onset = this.calculateOnset(bars, rms, waveformLevel)
    this.previousBars = bars
    this.previousRms = rms
    this.previousWaveformLevel = waveformLevel
    this.previousTimestamp = input.timestamp

    this.samples.push({ timestamp: input.timestamp, strength: onset })
    this.pruneSamples(input.timestamp)

    const historyMs = this.samples.length > 0 ? input.timestamp - this.samples[0].timestamp : 0
    if (historyMs < MIN_ANALYSIS_HISTORY_MS) {
      this.estimate = emptyEstimate()
      return this.getState()
    }
    if (input.timestamp - this.lastAnalysisAt < ANALYSIS_INTERVAL_MS) {
      return this.getState()
    }

    this.lastAnalysisAt = input.timestamp
    this.estimate = this.analyzeTempo()
    return this.getState()
  }

  private copyBars(values: ArrayLike<number>): Float32Array {
    const bars = new Float32Array(values.length)
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index])
      bars[index] = Number.isFinite(value) ? Math.max(0, value) : 0
    }
    return bars
  }

  private measureWaveformLevel(values: ArrayLike<number> | undefined): number {
    if (!values || values.length === 0) return 0
    let peak = 0
    for (let index = 0; index < values.length; index += 1) {
      const value = Math.abs(Number(values[index]))
      if (Number.isFinite(value)) peak = Math.max(peak, value)
    }
    return peak
  }

  private calculateOnset(bars: Float32Array, rms: number, waveformLevel: number): number {
    if (!this.previousBars) return 0
    const count = Math.min(bars.length, this.previousBars.length)
    if (count === 0) return 0
    let positiveFlux = 0
    for (let index = 0; index < count; index += 1) {
      positiveFlux += Math.max(0, bars[index] - this.previousBars[index])
    }
    const rmsRise = Math.max(0, rms - this.previousRms)
    const waveformRise = Math.max(0, waveformLevel - this.previousWaveformLevel)
    return positiveFlux / count + rmsRise * 0.35 + waveformRise * 0.55
  }

  private pruneSamples(now: number): void {
    const earliest = now - HISTORY_MS
    while (this.samples.length > 0 && this.samples[0].timestamp < earliest) {
      this.samples.shift()
    }
  }

  private analyzeTempo(): TempoEstimate {
    if (this.samples.length < 2) return emptyEstimate()
    const frameMs = this.estimateFrameMs()
    if (frameMs <= 0) return emptyEstimate()

    const minLag = Math.max(1, Math.round(60000 / LIVE_MAX_BPM / frameMs))
    const maxLag = Math.max(minLag, Math.round(60000 / LIVE_MIN_BPM / frameMs))
    const strengths = this.samples.map((sample) => sample.strength)
    const energy = strengths.reduce((sum, value) => sum + value * value, 0)
    if (energy <= 0.000001) return emptyEstimate()

    let bestLag = 0
    let bestScore = 0
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const score = this.scoreLag(strengths, lag)
      if (score > bestScore) {
        bestScore = score
        bestLag = lag
      }
    }
    if (bestLag === 0) return emptyEstimate()

    let tempoOctaveCorrected = false
    const fasterTempoCandidate = this.findFasterTempoCandidate(
      strengths,
      bestLag,
      bestScore,
      frameMs,
      minLag
    )
    if (fasterTempoCandidate) {
      bestScore = fasterTempoCandidate.score
      tempoOctaveCorrected = true
    }

    let bpm = normalizeBpm(fasterTempoCandidate?.bpm ?? 60000 / (bestLag * frameMs))
    if (bpm === undefined) return emptyEstimate()
    let confidence = clamp((bestScore / energy) * (tempoOctaveCorrected ? 2 : 1), 0, 1)

    const peakTempo = this.estimatePeakIntervalTempo()
    if (peakTempo && peakTempo.confidence >= 0.58) {
      const closeToAutocorrelation = Math.abs(peakTempo.bpm - bpm) <= Math.max(6, bpm * 0.08)
      const strongerThanAutocorrelation =
        !tempoOctaveCorrected && peakTempo.confidence >= confidence * 0.85
      if (closeToAutocorrelation || strongerThanAutocorrelation) {
        bpm = normalizeBpm(peakTempo.bpm)
        if (bpm === undefined) return emptyEstimate()
        confidence = Math.max(confidence, peakTempo.confidence)
      }
    }

    const referenceAlignedBpm = this.alignTempoToReference(bpm)
    if (referenceAlignedBpm !== undefined) {
      bpm = referenceAlignedBpm
      confidence = Math.max(confidence, STABLE_CONFIDENCE)
    }

    this.stableCandidates.push(bpm)
    if (this.stableCandidates.length > REQUIRED_STABLE_ESTIMATES) {
      this.stableCandidates.shift()
    }

    const now = this.samples[this.samples.length - 1]?.timestamp ?? 0
    if (confidence < STABLE_CONFIDENCE || !this.hasStableCandidates()) {
      if (this.lastStableEstimate && now - this.lastStableAt <= STABLE_HOLD_MS) {
        return {
          ...this.lastStableEstimate,
          confidence: Math.min(this.lastStableEstimate.confidence, Math.max(0, confidence))
        }
      }
      return { source: 'analyzing', confidence }
    }
    this.lastStableEstimate = { source: 'live', bpm, confidence }
    this.lastStableAt = now
    return this.lastStableEstimate
  }

  private estimateFrameMs(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0].timestamp
    const last = this.samples[this.samples.length - 1].timestamp
    return (last - first) / Math.max(1, this.samples.length - 1)
  }

  private scoreLag(strengths: number[], lag: number): number {
    let score = 0
    for (let index = lag; index < strengths.length; index += 1) {
      score += strengths[index] * strengths[index - lag]
    }
    return score
  }

  private findFasterTempoCandidate(
    strengths: number[],
    bestLag: number,
    bestScore: number,
    frameMs: number,
    minLag: number
  ): { bpm: number; score: number } | null {
    if (bestLag <= minLag || bestScore <= 0) return null

    const currentBpm = 60000 / (bestLag * frameMs)
    const halfLag = bestLag / 2
    const candidateLags = Array.from(new Set([Math.floor(halfLag), Math.ceil(halfLag)])).filter(
      (lag) => lag >= minLag && lag < bestLag && 60000 / (lag * frameMs) <= LIVE_MAX_BPM
    )
    if (candidateLags.length === 0) return null

    let combinedScore = 0
    let weightedLagSum = 0
    for (const lag of candidateLags) {
      const score = this.scoreLag(strengths, lag)
      combinedScore += score
      weightedLagSum += lag * score
    }
    if (combinedScore <= 0 || weightedLagSum <= 0) return null

    const weightedLag = weightedLagSum / combinedScore
    const candidateBpm = 60000 / (weightedLag * frameMs)
    const fastTempoEvidenceRatio = candidateBpm >= 150 ? 0.3 : 0.45
    const slowTempoAmbiguity = bestLag > Math.round((minLag + 60000 / LIVE_MIN_BPM / frameMs) / 2)
    const highTempoHalfLock = currentBpm >= 85 && currentBpm <= 115 && candidateBpm >= 170
    if (
      (slowTempoAmbiguity || highTempoHalfLock) &&
      combinedScore >= bestScore * fastTempoEvidenceRatio
    ) {
      return { bpm: candidateBpm, score: combinedScore }
    }

    return null
  }

  private estimatePeakIntervalTempo(): { bpm: number; confidence: number } | null {
    if (this.samples.length < 2) return null
    const strengths = this.samples.map((sample) => sample.strength)
    const maxStrength = Math.max(...strengths)
    if (maxStrength <= 0.000001) return null

    const meanStrength = strengths.reduce((sum, value) => sum + value, 0) / strengths.length
    const threshold = Math.max(maxStrength * 0.35, meanStrength * 1.8)
    const minPeakSpacingMs = (60000 / LIVE_MAX_BPM) * 0.55
    const peaks: number[] = []
    const peakStrengths: number[] = []

    for (let index = 1; index < this.samples.length - 1; index += 1) {
      const strength = strengths[index]
      if (strength < threshold) continue
      if (strength < strengths[index - 1] || strength < strengths[index + 1]) continue

      const timestamp = this.samples[index].timestamp
      const previousPeak = peaks[peaks.length - 1]
      if (previousPeak !== undefined && timestamp - previousPeak < minPeakSpacingMs) {
        if (strength > (peakStrengths[peakStrengths.length - 1] ?? 0)) {
          peaks[peaks.length - 1] = timestamp
          peakStrengths[peakStrengths.length - 1] = strength
        }
        continue
      }
      peaks.push(timestamp)
      peakStrengths.push(strength)
    }

    if (peaks.length < 8) return null

    const minIntervalMs = 60000 / LIVE_MAX_BPM
    const maxIntervalMs = 60000 / LIVE_MIN_BPM
    const intervals: number[] = []
    for (let index = 1; index < peaks.length; index += 1) {
      const interval = peaks[index] - peaks[index - 1]
      if (interval >= minIntervalMs && interval <= maxIntervalMs) intervals.push(interval)
    }

    if (intervals.length < 7) return null

    const medianInterval = median(intervals)
    if (medianInterval <= 0) return null

    const consistentIntervals = intervals.filter(
      (interval) => Math.abs(interval - medianInterval) <= medianInterval * 0.18
    )
    if (consistentIntervals.length < 7) return null

    const averageInterval =
      consistentIntervals.reduce((sum, interval) => sum + interval, 0) / consistentIntervals.length
    const averageDeviation =
      consistentIntervals.reduce((sum, interval) => sum + Math.abs(interval - averageInterval), 0) /
      consistentIntervals.length
    const bpm = 60000 / averageInterval
    const confidence =
      clamp(consistentIntervals.length / 12, 0, 1) *
      clamp(1 - averageDeviation / (averageInterval * 0.18), 0, 1)

    return { bpm, confidence }
  }

  private alignTempoToReference(bpm: number): number | undefined {
    const referenceBpm = this.referenceBpm
    if (referenceBpm === undefined) return undefined
    const tolerance = Math.max(5, referenceBpm * 0.08)

    const directDistance = Math.abs(bpm - referenceBpm)
    if (directDistance <= tolerance) {
      return normalizeBpm(referenceBpm >= 150 ? referenceBpm : bpm)
    }

    const octaveCandidates = [0.25, 0.5, 2, 4]
      .map((multiplier) => bpm * multiplier)
      .filter((candidate) => candidate >= LIVE_MIN_BPM && candidate <= LIVE_MAX_BPM)
    let closest: number | undefined
    let closestDistance = Infinity
    for (const candidate of octaveCandidates) {
      const distance = Math.abs(candidate - referenceBpm)
      if (distance < closestDistance) {
        closest = candidate
        closestDistance = distance
      }
    }

    if (closest === undefined) return undefined
    if (closestDistance > tolerance) return undefined
    return normalizeBpm(referenceBpm)
  }

  private hasStableCandidates(): boolean {
    if (this.stableCandidates.length < REQUIRED_STABLE_ESTIMATES) return false
    const min = Math.min(...this.stableCandidates)
    const max = Math.max(...this.stableCandidates)
    return max - min <= STABLE_BPM_SPREAD
  }
}
