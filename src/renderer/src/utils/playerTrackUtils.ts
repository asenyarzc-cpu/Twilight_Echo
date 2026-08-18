import type { Track } from '../types/music'

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function getTrackSource(track: Track): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}

export function getTrackAudioSource(track: Track): string {
  return track.cueRange ? track.filePath : track.subTrack || track.streamUrl || track.filePath
}

/**
 * 原生引擎在授权/缓存层会把 twilight-media 源解析成磁盘缓存文件
 * （如 music-cache\ncm-cache\1996755298.flac）。渲染层队列条目持有的是
 * 逻辑 id（ncm:1996755298）或流 URL，直接比对会失配，导致原生自动切歌后
 * queueIndex/currentTrack 无法同步（歌单高亮不动、进度条卡住）。这里从缓存
 * 文件名提取纯数字 id，与逻辑 id 的数字段比对。
 */
export function cachedSourceMatchesTrack(track: Track, source: string): boolean {
  const normalized = source.replace(/\\/g, '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  const numericId = fileName.replace(/\.[^.]+$/, '')
  if (!/^\d+$/.test(numericId)) return false
  const idSuffix = `:${numericId}`
  return track.id === numericId || track.id.endsWith(idSuffix)
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function isLikelyLocalFilePath(target: string): boolean {
  if (!target) return false
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(target)) return true
  if (URI_SCHEME_PATTERN.test(target)) return false
  return target.includes('\\') || target.includes('/')
}

export function hasAnalyzedBpm(track: Track): boolean {
  const bpm = track.bpmAnalysis?.bpm
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0
}

export function isAnalyzableAudioPath(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)
}

export function mergeTrackTransientData(nextTrack: Track, previousTrack: Track | null): Track {
  if (!previousTrack || previousTrack.id !== nextTrack.id) return nextTrack
  const lyrics = nextTrack.lyrics ?? previousTrack.lyrics
  const translatedLyrics = nextTrack.translatedLyrics ?? previousTrack.translatedLyrics
  if (lyrics === nextTrack.lyrics && translatedLyrics === nextTrack.translatedLyrics)
    return nextTrack
  return {
    ...nextTrack,
    lyrics,
    translatedLyrics
  }
}

export function isStreamLikeTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  return (
    track.source === 'radio' ||
    track.source === 'podcast' ||
    /^https?:\/\//i.test(track.filePath || '') ||
    /^https?:\/\//i.test(track.streamUrl || '')
  )
}
