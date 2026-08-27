import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import { MAX_CUE_BYTES, parseCueSheet, type CueRange } from '../../shared/cue.ts'

export interface CueDerivedTrack extends Record<string, unknown> {
  cueRange: CueRange
  cueSheetPath: string
  cueEncoding: string
}

/**
 * Returns logical tracks for one audio file when a sibling CUE sheet references it. CUE FILE
 * names are never allowed to escape the CUE directory, so scan-time parsing cannot turn an
 * authorized music-folder scan into an arbitrary path probe.
 */
export function deriveCueTracks(
  audioPath: string,
  audioDurationSeconds: number,
  baseTrack: Record<string, unknown>,
  supportedExtensions: readonly string[]
): CueDerivedTrack[] | null {
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) return null
  const directory = resolve(audioPath, '..')
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return null
  }
  const matching: Array<{ cuePath: string; parsed: ReturnType<typeof parseCueSheet> }> = []
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.cue') continue
    const cuePath = resolve(directory, name)
    try {
      const cueInfo = statSync(cuePath)
      if (!cueInfo.isFile() || cueInfo.size <= 0) continue
      if (cueInfo.size > MAX_CUE_BYTES) {
        console.warn(`[library] CUE skipped (${basename(cuePath)}): exceeds ${MAX_CUE_BYTES} bytes`)
        continue
      }
      const bytes = readFileSync(cuePath)
      const parsed = parseCueSheet(bytes, audioDurationSeconds)
      const referenced = resolveCueAudioPath(directory, parsed.fileName, supportedExtensions)
      if (samePath(referenced, audioPath)) matching.push({ cuePath, parsed })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[library] CUE skipped (${basename(cuePath)}): ${detail}`)
    }
  }
  if (!matching.length) return null
  if (matching.length !== 1) {
    console.warn(
      `[library] CUE skipped for ${basename(audioPath)}: ambiguous multiple CUE sheets (${matching.length})`
    )
    return null
  }
  const { cuePath, parsed } = matching[0]
  const fileName = String(baseTrack.fileName ?? basename(audioPath))
  const baseTitle = String(baseTrack.title ?? basename(audioPath, extname(audioPath)))
  const baseArtist = String(baseTrack.artist ?? 'Unknown Artist')
  const baseAlbum = String(baseTrack.album ?? 'Unknown Album')
  return parsed.tracks.map((cueTrack) => {
    const id = stableCueTrackId(audioPath, cuePath, cueTrack.number)
    const duration =
      (cueTrack.range.virtualPregapSeconds ?? 0) +
      cueTrack.range.endSeconds -
      cueTrack.range.startSeconds
    return {
      ...baseTrack,
      id,
      title: cueTrack.title || `${String(cueTrack.number).padStart(2, '0')}. ${baseTitle}`,
      artist: cueTrack.performer || parsed.performer || baseArtist,
      album: parsed.title || baseAlbum,
      filePath: resolve(audioPath),
      fileName,
      duration,
      trackNumber: cueTrack.number,
      cueRange: cueTrack.range,
      cueSheetPath: cuePath,
      cueEncoding: parsed.encoding
    }
  })
}

export function resolveCueAudioPath(
  cueDirectory: string,
  cueFileName: string,
  supportedExtensions: readonly string[]
): string {
  const normalizedName = cueFileName.trim()
  if (!normalizedName || isAbsolute(normalizedName))
    throw new Error('CUE FILE path must be relative')
  const resolved = resolve(cueDirectory, normalizedName)
  const pathRelative = relative(cueDirectory, resolved)
  if (
    pathRelative === '' ||
    pathRelative === '..' ||
    pathRelative.startsWith(`..${String.fromCharCode(92)}`) ||
    pathRelative.startsWith('../')
  ) {
    throw new Error('CUE FILE path escapes its directory')
  }
  if (!supportedExtensions.includes(extname(resolved).toLowerCase())) {
    throw new Error('CUE FILE extension is not supported')
  }
  if (!existsSync(resolved)) throw new Error('CUE referenced audio file does not exist')
  return resolved
}

function stableCueTrackId(audioPath: string, cuePath: string, trackNumber: number): string {
  const key = `${resolve(audioPath)}\u0000${resolve(cuePath)}\u0000${trackNumber}`
  return `local:cue:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b
}
