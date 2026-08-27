import type { Track } from '../types/music'
import { findBestMetadataMatch } from './musicMetadataMatching.ts'

export interface RepairMovedLocalTracksOptions {
  existingTracks: Track[]
  scannedTracks: Track[]
  fileExists: (path: string) => boolean
}

export interface RepairMovedLocalTracksResult {
  repairedTracks: Track[]
  unresolvedTracks: Track[]
}

export function repairMovedLocalTracks(
  options: RepairMovedLocalTracksOptions
): RepairMovedLocalTracksResult {
  const availableScannedTracks = options.scannedTracks.filter((track) =>
    options.fileExists(track.filePath)
  )
  const repairedTracks: Track[] = []
  const unresolvedTracks: Track[] = []

  for (const track of options.existingTracks) {
    if (getTrackSource(track) !== 'local' || options.fileExists(track.filePath)) continue
    const replacement = findMovedLocalReplacement(track, availableScannedTracks)
    if (!replacement) {
      unresolvedTracks.push(track)
      continue
    }
    repairedTracks.push({
      ...track,
      filePath: replacement.filePath,
      fileName: replacement.fileName,
      dir: replacement.dir,
      subTrack: replacement.subTrack,
      duration: replacement.duration || track.duration,
      size: replacement.size || track.size,
      cover: replacement.cover ?? track.cover ?? null,
      format: replacement.format ?? track.format,
      sampleRate: replacement.sampleRate ?? track.sampleRate,
      bitrate: replacement.bitrate ?? track.bitrate,
      bitDepth: replacement.bitDepth ?? track.bitDepth,
      bpm: replacement.bpm ?? track.bpm,
      bpmAnalysis: replacement.bpmAnalysis ?? track.bpmAnalysis
    })
  }

  return { repairedTracks, unresolvedTracks }
}

export function findProviderRematchCandidate(
  expiredTrack: Track,
  candidates: Track[]
): Track | null {
  for (const candidate of candidates) {
    if (candidate.id === expiredTrack.id) continue
    if (findBestMetadataMatch(expiredTrack, [candidate])) return candidate
  }
  return null
}

function findMovedLocalReplacement(track: Track, candidates: Track[]): Track | null {
  const exactFileNameCandidates = candidates.filter(
    (candidate) => normalizePathName(candidate.fileName) === normalizePathName(track.fileName)
  )
  const candidatesToScore =
    exactFileNameCandidates.length > 0 ? exactFileNameCandidates : candidates
  return findBestMetadataMatch(track, candidatesToScore)?.track ?? null
}

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}

function normalizePathName(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase()
}
