import type { Track, TrackSource } from '../types/music'
import { getLogicalTrackKey } from './logicalTrackIdentity.ts'
import {
  canShareLogicalTrack,
  compareSourceVariants,
  getTrackSource,
  toSourceVariant
} from './logicalTrackModel.ts'

export interface PlaybackFallbackOptions {
  failedTrack: Track
  candidates: Track[]
  unavailableSources?: string[]
  sourceReliability?: Record<string, number | undefined>
}

export function findPlaybackFallbackTrack(options: PlaybackFallbackOptions): Track | null {
  const unavailableSources = new Set((options.unavailableSources ?? []).map(normalizeSource))
  const failedSource = getTrackSource(options.failedTrack)
  const failedKey = getLogicalTrackKey(options.failedTrack)

  const candidates = options.candidates
    .filter((candidate) => candidate.id !== options.failedTrack.id)
    .filter((candidate) => getLogicalTrackKey(candidate) === failedKey)
    .filter((candidate) => canShareLogicalTrack(options.failedTrack, candidate))
    .filter((candidate) => !unavailableSources.has(getTrackSource(candidate)))
    .filter((candidate) => getTrackSource(candidate) !== failedSource || failedSource === 'local')
    .sort((left, right) => compareFallbackCandidates(left, right, options.sourceReliability))

  return candidates[0] ?? null
}

function compareFallbackCandidates(
  left: Track,
  right: Track,
  sourceReliability: Record<string, number | undefined> = {}
): number {
  return compareSourceVariants(
    toSourceVariant({
      track: left,
      providerReliability: getSourceReliability(getTrackSource(left), sourceReliability)
    }),
    toSourceVariant({
      track: right,
      providerReliability: getSourceReliability(getTrackSource(right), sourceReliability)
    })
  )
}

export function clampProviderReliability(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, value))
}

function getSourceReliability(
  source: TrackSource,
  sourceReliability: Record<string, number | undefined>
): number {
  if (source === 'local') return 1
  return clampProviderReliability(sourceReliability[normalizeSource(source)])
}

function normalizeSource(source: string): TrackSource {
  return source.trim().toLowerCase() as TrackSource
}
