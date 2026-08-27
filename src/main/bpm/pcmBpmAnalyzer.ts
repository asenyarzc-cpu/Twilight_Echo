import {
  BPM_ANALYSIS_ALGORITHM_VERSION,
  type BpmAnalysisResult,
  type BpmTempoSegment
} from './bpmCache.ts'

interface AnalyzePcmBpmInput {
  samples: ArrayLike<number>
  sampleRate: number
  referenceBpm?: number
  analyzedAt?: string
}

interface TempoCandidate {
  bpm: number
  confidence: number
}

const MIN_BPM = 60
const MAX_BPM = 240
const FRAME_SIZE = 1024
const HOP_SIZE = 512
const WINDOW_SECONDS = 16
const WINDOW_STEP_SECONDS = 8

export function analyzePcmBpm(input: AnalyzePcmBpmInput): BpmAnalysisResult | null {
  if (
    !Number.isFinite(input.sampleRate) ||
    input.sampleRate <= 0 ||
    input.samples.length < FRAME_SIZE
  ) {
    return null
  }

  const envelope = buildOnsetEnvelope(input.samples, input.sampleRate)
  const global = estimateTempo(envelope.values, envelope.hopMs, input.referenceBpm)
  if (!global) return null

  const tempoMap = estimateTempoMap(envelope.values, envelope.hopMs, input.referenceBpm)
  const stableSegments = tempoMap.filter((segment) => segment.confidence >= 0.45)
  const bpmValues = stableSegments.map((segment) => segment.bpm)
  const bpmRange =
    bpmValues.length >= 2
      ? ([roundBpm(Math.min(...bpmValues)), roundBpm(Math.max(...bpmValues))] as [number, number])
      : undefined
  const variableTempo = Boolean(bpmRange && bpmRange[1] - bpmRange[0] >= 18)

  return {
    bpm: roundBpm(variableTempo && bpmRange ? median(bpmValues) : global.bpm),
    confidence: roundConfidence(global.confidence),
    source: 'analyzed',
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION,
    variableTempo,
    bpmRange,
    tempoMap: tempoMap.length > 0 ? tempoMap : undefined
  }
}

function buildOnsetEnvelope(
  samples: ArrayLike<number>,
  sampleRate: number
): { values: number[]; hopMs: number } {
  const values: number[] = []
  let previousEnergy = 0
  for (let offset = 0; offset + FRAME_SIZE <= samples.length; offset += HOP_SIZE) {
    let energy = 0
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const sample = Number(samples[offset + index])
      if (Number.isFinite(sample)) energy += sample * sample
    }
    energy = Math.sqrt(energy / FRAME_SIZE)
    values.push(Math.max(0, energy - previousEnergy * 0.82))
    previousEnergy = energy
  }
  return { values, hopMs: (HOP_SIZE / sampleRate) * 1000 }
}

function estimateTempo(
  values: number[],
  hopMs: number,
  referenceBpm?: number
): TempoCandidate | null {
  const fromPeaks = estimateTempoFromPeaks(values, hopMs, referenceBpm)
  const fromCorrelation = estimateTempoFromCorrelation(values, hopMs, referenceBpm)
  if (fromPeaks && fromCorrelation) {
    return fromPeaks.confidence >= fromCorrelation.confidence * 0.8 ? fromPeaks : fromCorrelation
  }
  return fromPeaks ?? fromCorrelation
}

function estimateTempoFromPeaks(
  values: number[],
  hopMs: number,
  referenceBpm?: number
): TempoCandidate | null {
  const max = Math.max(...values)
  if (max <= 0.000001) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const threshold = Math.max(max * 0.1, mean * 1.25)
  const minSpacing = (60000 / MAX_BPM / hopMs) * 0.65
  const peaks: number[] = []
  const peakStrengths: number[] = []

  for (let index = 1; index < values.length - 1; index += 1) {
    const value = values[index]
    if (value < threshold || value < values[index - 1] || value < values[index + 1]) continue
    const previousPeak = peaks[peaks.length - 1]
    if (previousPeak !== undefined && index - previousPeak < minSpacing) {
      if (value > (peakStrengths[peakStrengths.length - 1] ?? 0)) {
        peaks[peaks.length - 1] = index
        peakStrengths[peakStrengths.length - 1] = value
      }
      continue
    }
    peaks.push(index)
    peakStrengths.push(value)
  }

  if (peaks.length < 6) return null
  const intervals: number[] = []
  for (let index = 1; index < peaks.length; index += 1) {
    const intervalMs = (peaks[index] - peaks[index - 1]) * hopMs
    const bpm = 60000 / intervalMs
    if (bpm >= MIN_BPM && bpm <= MAX_BPM) intervals.push(intervalMs)
  }
  if (intervals.length < 5) return null

  const middle = median(intervals)
  const consistent = intervals.filter((interval) => Math.abs(interval - middle) <= middle * 0.18)
  if (consistent.length < 5) return null
  const average = consistent.reduce((sum, interval) => sum + interval, 0) / consistent.length
  const deviation =
    consistent.reduce((sum, interval) => sum + Math.abs(interval - average), 0) / consistent.length
  const rawBpm = 60000 / average
  return {
    bpm: alignBpmToReference(rawBpm, referenceBpm),
    confidence: clamp(
      (consistent.length / Math.max(6, intervals.length)) * (1 - deviation / (average * 0.2)),
      0,
      1
    )
  }
}

function estimateTempoFromCorrelation(
  values: number[],
  hopMs: number,
  referenceBpm?: number
): TempoCandidate | null {
  const energy = values.reduce((sum, value) => sum + value * value, 0)
  if (energy <= 0.000001) return null
  const minLag = Math.max(1, Math.round(60000 / MAX_BPM / hopMs))
  const maxLag = Math.max(minLag, Math.round(60000 / MIN_BPM / hopMs))
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = scoreLag(values, lag)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag === 0) return null

  const faster = findFasterTempoCandidate(values, bestLag, bestScore, hopMs, minLag)
  const bpm = alignBpmToReference(faster?.bpm ?? 60000 / (bestLag * hopMs), referenceBpm)
  return {
    bpm,
    confidence: clamp(((faster?.score ?? bestScore) / energy) * (faster ? 2 : 1), 0, 1)
  }
}

function findFasterTempoCandidate(
  values: number[],
  bestLag: number,
  bestScore: number,
  hopMs: number,
  minLag: number
): { bpm: number; score: number } | null {
  const halfLag = bestLag / 2
  const lags = Array.from(new Set([Math.floor(halfLag), Math.ceil(halfLag)])).filter(
    (lag) => lag >= minLag && lag < bestLag && 60000 / (lag * hopMs) <= MAX_BPM
  )
  let score = 0
  let weightedLag = 0
  for (const lag of lags) {
    const lagScore = scoreLag(values, lag)
    score += lagScore
    weightedLag += lag * lagScore
  }
  if (score <= 0 || weightedLag <= 0) return null
  const bpm = 60000 / ((weightedLag / score) * hopMs)
  const currentBpm = 60000 / (bestLag * hopMs)
  if (currentBpm >= 85 && currentBpm <= 120 && bpm >= 165 && score >= bestScore * 0.28) {
    return { bpm, score }
  }
  return null
}

function estimateTempoMap(
  values: number[],
  hopMs: number,
  referenceBpm?: number
): BpmTempoSegment[] {
  const windowSize = Math.max(8, Math.round((WINDOW_SECONDS * 1000) / hopMs))
  const stepSize = Math.max(1, Math.round((WINDOW_STEP_SECONDS * 1000) / hopMs))
  const segments: BpmTempoSegment[] = []
  for (let start = 0; start + windowSize <= values.length; start += stepSize) {
    const estimate = estimateTempo(values.slice(start, start + windowSize), hopMs, referenceBpm)
    if (!estimate) continue
    segments.push({
      startMs: Math.round(start * hopMs),
      endMs: Math.round((start + windowSize) * hopMs),
      bpm: roundBpm(estimate.bpm),
      confidence: roundConfidence(estimate.confidence)
    })
  }
  return mergeTempoSegments(segments)
}

function mergeTempoSegments(segments: BpmTempoSegment[]): BpmTempoSegment[] {
  const result: BpmTempoSegment[] = []
  for (const segment of segments) {
    const previous = result[result.length - 1]
    if (previous && Math.abs(previous.bpm - segment.bpm) <= 4) {
      previous.endMs = segment.endMs
      previous.bpm = roundBpm((previous.bpm + segment.bpm) / 2)
      previous.confidence = roundConfidence(Math.max(previous.confidence, segment.confidence))
    } else {
      result.push({ ...segment })
    }
  }
  return result
}

function scoreLag(values: number[], lag: number): number {
  let score = 0
  for (let index = lag; index < values.length; index += 1) {
    score += values[index] * values[index - lag]
  }
  return score
}

function alignBpmToReference(bpm: number, referenceBpm: number | undefined): number {
  if (!Number.isFinite(referenceBpm) || !referenceBpm) return bpm
  const candidates = [bpm, bpm / 2, bpm * 2].filter(
    (candidate) => candidate >= MIN_BPM && candidate <= MAX_BPM
  )
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - referenceBpm)
    if (distance < bestDistance) {
      bestDistance = distance
    }
  }
  return bestDistance <= Math.max(5, referenceBpm * 0.08) ? referenceBpm : bpm
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function roundBpm(value: number): number {
  return Math.round(value * 10) / 10
}

function roundConfidence(value: number): number {
  return Math.round(clamp(value, 0, 1) * 1000) / 1000
}
