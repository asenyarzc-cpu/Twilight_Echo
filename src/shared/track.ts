import type { CueRange, ParsedCueSheet } from './cue.ts'
import type { BpmAnalysisResult } from './audioEngineTypes.ts'
import type { NcmPlaybackQuality } from './appSettings.ts'

export type BuiltInTrackSource = 'local' | 'ncm'
export type TrackSource = BuiltInTrackSource | (string & {})
export type MetadataMatchConfidence = 'high' | 'medium'

export interface TrackMetadataMatch {
  providerId: string
  trackId: string
  confidence: MetadataMatchConfidence
  score: number
}

export interface TrackData {
  id: string
  title: string
  artist: string
  album: string
  filePath: string
  fileName: string
  dir?: string
  subTrack?: string
  /** Logical source segment for a single-file CUE track. */
  cueRange?: CueRange
  cueSheetPath?: string
  cueEncoding?: ParsedCueSheet['encoding']
  duration: number
  size: number
  cover: string | null
  lyrics: string | null
  translatedLyrics?: string | null
  metadataMatch?: TrackMetadataMatch | null
  source?: TrackSource
  ncmSongId?: number
  streamUrl?: string | null
  streamQuality?: NcmPlaybackQuality
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  bpm?: number
  bpmAnalysis?: BpmAnalysisResult
  discNumber?: number
  trackNumber?: number
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
}
