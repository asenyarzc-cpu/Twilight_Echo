import type { Track } from '../types/music'

export type MetadataMatchConfidence = 'high' | 'medium'

export interface MetadataMatch {
  track: Track
  confidence: MetadataMatchConfidence
  score: number
}

export interface MetadataMatchCandidate extends MetadataMatch {
  providerId: string
  sourceLabel: string
  fills: {
    cover: boolean
    lyrics: boolean
    translatedLyrics: boolean
    metadata: boolean
  }
}

export interface MetadataEnrichmentPolicy {
  cover: boolean
  lyrics: boolean
  metadata: boolean
}

interface IndexedMetadataMatch extends MetadataMatch {
  index: number
}

const EXACT_DURATION_TOLERANCE_SECONDS = 8
const LOOSE_DURATION_TOLERANCE_SECONDS = 20

export function findBestMetadataMatch(
  localTrack: Track,
  candidates: Track[]
): MetadataMatch | null {
  const matches = candidates
    .map((candidate, index) => {
      const match = scoreMetadataMatch(localTrack, candidate)
      return match ? { ...match, index } : null
    })
    .filter((match): match is IndexedMetadataMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)

  return matches[0] ?? null
}

export function buildMetadataMatchCandidates(
  localTrack: Track,
  candidates: Track[]
): MetadataMatchCandidate[] {
  return candidates
    .map((candidate, index) => {
      if (getProviderId(candidate) === 'local') return null
      const match = scoreMetadataMatch(localTrack, candidate)
      if (!match) return null
      const providerId = getProviderId(candidate)
      return {
        ...match,
        providerId,
        sourceLabel: providerId || 'unknown',
        fills: {
          cover: !metadataAvailable(localTrack.cover) && metadataAvailable(candidate.cover),
          lyrics: !metadataAvailable(localTrack.lyrics) && metadataAvailable(candidate.lyrics),
          translatedLyrics:
            !metadataAvailable(localTrack.translatedLyrics) &&
            metadataAvailable(candidate.translatedLyrics),
          metadata:
            (!metadataAvailable(localTrack.artist) && metadataAvailable(candidate.artist)) ||
            (!metadataAvailable(localTrack.album) && metadataAvailable(candidate.album))
        },
        index
      }
    })
    .filter((match): match is MetadataMatchCandidate & { index: number } => match !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...match }) => match)
}

export function enrichLocalTrackMetadata(
  localTrack: Track,
  match: MetadataMatch | null,
  policy: MetadataEnrichmentPolicy = DEFAULT_METADATA_ENRICHMENT_POLICY
): Track {
  if (!match) return localTrack
  const metadata = match.track
  const nextLyrics = policy.lyrics
    ? (localTrack.lyrics ?? metadata.lyrics ?? null)
    : localTrack.lyrics
  const nextTranslatedLyrics = policy.lyrics
    ? (localTrack.translatedLyrics ?? metadata.translatedLyrics ?? null)
    : localTrack.translatedLyrics
  const enriched: Track = {
    ...localTrack,
    artist: policy.metadata ? localTrack.artist || metadata.artist : localTrack.artist,
    album: policy.metadata ? localTrack.album || metadata.album : localTrack.album,
    genre: policy.metadata ? localTrack.genre || metadata.genre || null : localTrack.genre,
    cover: policy.cover ? (localTrack.cover ?? metadata.cover ?? null) : localTrack.cover,
    lyrics: nextLyrics,
    translatedLyrics: nextTranslatedLyrics,
    lyricsSource: resolveEnrichedLyricSource(
      localTrack.lyrics,
      localTrack.lyricsSource,
      metadata.lyrics,
      nextLyrics,
      policy.lyrics
    ),
    translatedLyricsSource: resolveEnrichedLyricSource(
      localTrack.translatedLyrics,
      localTrack.translatedLyricsSource,
      metadata.translatedLyrics,
      nextTranslatedLyrics,
      policy.lyrics
    ),
    metadataMatch: {
      providerId: getProviderId(metadata),
      trackId: metadata.id,
      confidence: match.confidence,
      score: match.score
    }
  }
  delete enriched.streamUrl
  return enriched
}

const DEFAULT_METADATA_ENRICHMENT_POLICY: MetadataEnrichmentPolicy = {
  cover: true,
  lyrics: true,
  metadata: true
}

function resolveEnrichedLyricSource(
  localValue: string | null | undefined,
  localSource: Track['lyricsSource'],
  providerValue: string | null | undefined,
  nextValue: string | null | undefined,
  enabled: boolean
): Track['lyricsSource'] {
  if (!enabled) return localSource
  if (localValue != null && localValue !== '') return localSource
  if (providerValue != null && providerValue !== '' && nextValue === providerValue)
    return 'provider'
  return localSource ?? null
}

function getProviderId(track: Track): string {
  if (track.source && track.source !== 'local') return track.source
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : (track.source ?? '')
}

function scoreMetadataMatch(localTrack: Track, candidate: Track): MetadataMatch | null {
  const localTitle = normalizeMetadataText(localTrack.title)
  const candidateTitle = normalizeMetadataText(candidate.title)
  const localArtist = normalizeMetadataText(localTrack.artist)
  const candidateArtist = normalizeMetadataText(candidate.artist)
  if (!localTitle || !candidateTitle || localTitle !== candidateTitle) return null
  if (localArtist && (!candidateArtist || localArtist !== candidateArtist)) return null

  const durationDelta = durationDeltaSeconds(localTrack, candidate)
  if (durationDelta != null && durationDelta > LOOSE_DURATION_TOLERANCE_SECONDS) return null
  if (!localArtist && durationDelta != null && durationDelta > EXACT_DURATION_TOLERANCE_SECONDS)
    return null

  let score = 70
  if (!localArtist && candidateArtist) score -= 12
  if (durationDelta == null) {
    score += 5
  } else if (durationDelta <= EXACT_DURATION_TOLERANCE_SECONDS) {
    score += 20
  } else {
    score += 8
  }
  if (metadataAvailable(candidate.cover)) score += 3
  if (metadataAvailable(candidate.lyrics)) score += 2
  if (metadataAvailable(candidate.translatedLyrics)) score += 1

  return {
    track: candidate,
    confidence: score >= 90 ? 'high' : 'medium',
    score
  }
}

function durationDeltaSeconds(left: Track, right: Track): number | null {
  if (!left.duration || !right.duration) return null
  return Math.abs(left.duration - right.duration)
}

function metadataAvailable(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeMetadataText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s*([/,&、，;；])\s*/g, '$1')
    .replace(/\s+/g, ' ')
}
