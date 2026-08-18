export interface LyricWord {
  time: number
  endTime: number | null
  text: string
}

export type LyricVoiceRole = 'lead' | 'background' | 'harmony'
export type LyricVoiceLane = 'center' | 'start' | 'end'

export interface LyricVoiceMetadata {
  role: LyricVoiceRole
  lane: LyricVoiceLane
  speaker?: string
  group?: string
}

export interface LyricVoiceLayer extends LyricVoiceMetadata {
  voiceKey: string
  time: number | null
  text: string
  words?: LyricWord[]
}

export interface ParsedTimedLyricLine {
  time: number
  text: string
  words?: LyricWord[]
  voice?: LyricVoiceMetadata
}

export interface LyricLine {
  time: number | null
  text: string
  translation: string | null
  romanization: string | null
  timed: boolean
  words?: LyricWord[]
  rowKey?: string
  voices?: LyricVoiceLayer[]
}

const LINE_TIMESTAMP_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g
const WORD_TIMESTAMP_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?>/g
const YRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/
const YRC_WORD_RE = /\((\d+),(\d+),\d+\)([^()[\]]*)/g
const VOICE_TAG_RE = /\[te:voice\s+([^\]]+)\]/g
const VOICE_VALUE_RE = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/
const VOICE_VALUE_MAX_LENGTH = 96
/** NetEase lyric/new metadata & prose lines: {"t":-1,"c":[{"tx":"作词: "},{"tx":"ACO"}]} */
const NETEASE_JSON_LINE_RE = /^\s*\{[\s\S]*"c"\s*:\s*\[[\s\S]*\]\s*\}\s*$/

function parseVoiceValue(raw: string): string | null {
  if (!raw || !VOICE_VALUE_RE.test(raw)) return null
  try {
    const decoded = decodeURIComponent(raw)
    if (
      !decoded ||
      decoded.length > VOICE_VALUE_MAX_LENGTH ||
      [...decoded].some((character) => character.codePointAt(0)! < 0x20 || character === '\u007f')
    ) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

export function parseLyricVoiceTag(raw: string): LyricVoiceMetadata | null {
  const match = /^\[te:voice\s+([^\]]+)\]$/.exec(raw)
  if (!match) return null

  const values = new Map<string, string>()
  for (const attribute of match[1].trim().split(/\s+/)) {
    const separator = attribute.indexOf('=')
    if (separator <= 0 || separator === attribute.length - 1) return null
    const key = attribute.slice(0, separator)
    const value = attribute.slice(separator + 1)
    if (!['role', 'lane', 'speaker', 'group'].includes(key) || values.has(key)) return null
    values.set(key, value)
  }

  const role = values.get('role')
  const lane = values.get('lane')
  if (role !== 'lead' && role !== 'background' && role !== 'harmony') return null
  if (lane !== 'center' && lane !== 'start' && lane !== 'end') return null

  const speakerRaw = values.get('speaker')
  const groupRaw = values.get('group')
  const speaker = speakerRaw == null ? undefined : parseVoiceValue(speakerRaw)
  const group = groupRaw == null ? undefined : parseVoiceValue(groupRaw)
  if ((speakerRaw != null && speaker == null) || (groupRaw != null && group == null)) return null

  return { role, lane, ...(speaker ? { speaker } : {}), ...(group ? { group } : {}) }
}

function encodeVoiceValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function serializeLyricVoiceTag(metadata: LyricVoiceMetadata): string {
  const attributes = [`role=${metadata.role}`, `lane=${metadata.lane}`]
  if (metadata.speaker) attributes.push(`speaker=${encodeVoiceValue(metadata.speaker)}`)
  if (metadata.group) attributes.push(`group=${encodeVoiceValue(metadata.group)}`)
  return `[te:voice ${attributes.join(' ')}]`
}

export function extractLyricVoiceTag(raw: string): {
  text: string
  metadata: LyricVoiceMetadata | null
} {
  const matches: Array<{ match: RegExpExecArray; metadata: LyricVoiceMetadata }> = []
  for (const match of raw.matchAll(VOICE_TAG_RE)) {
    const metadata = parseLyricVoiceTag(match[0])
    if (metadata) matches.push({ match, metadata })
  }
  if (matches.length !== 1) return { text: raw, metadata: null }
  const { match, metadata } = matches[0]
  const start = match.index ?? 0
  return {
    text: `${raw.slice(0, start)}${raw.slice(start + match[0].length)}`,
    metadata
  }
}

export function stripValidLyricVoiceTags(lyrics: string | null | undefined): string | null {
  if (lyrics == null) return null
  return lyrics
    .split('\n')
    .map((line) => extractLyricVoiceTag(line).text)
    .join('\n')
}

export interface LyricVoiceDraftRow {
  sourceIndex: number
  raw: string
  text: string
  metadata: LyricVoiceMetadata | null
}

export interface LyricVoiceDraftUpdate {
  sourceIndex: number
  metadata: LyricVoiceMetadata | null
}

export function parseLyricVoiceDraftRows(lyrics: string): LyricVoiceDraftRow[] {
  return lyrics.split('\n').map((raw, sourceIndex) => {
    const extracted = extractLyricVoiceTag(raw)
    const text = extracted.text
      .replace(LINE_TIMESTAMP_RE, '')
      .replace(WORD_TIMESTAMP_RE, '')
      .replace(YRC_LINE_RE, '$3')
      .replace(YRC_WORD_RE, '$3')
      .trim()
    return { sourceIndex, raw, text, metadata: extracted.metadata }
  })
}

export function rewriteLyricVoiceDraftRows(
  lyrics: string,
  updates: readonly LyricVoiceDraftUpdate[]
): string {
  const byIndex = new Map(updates.map((update) => [update.sourceIndex, update.metadata]))
  return lyrics
    .split('\n')
    .map((raw, sourceIndex) => {
      if (!byIndex.has(sourceIndex)) return raw
      const extracted = extractLyricVoiceTag(raw)
      const metadata = byIndex.get(sourceIndex)
      const tag = metadata ? serializeLyricVoiceTag(metadata) : ''
      const timestampMatch = /^(?:(?:\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\])+|\[\d+,\d+\])/.exec(
        extracted.text
      )
      const insertion = timestampMatch?.[0].length ?? 0
      return `${extracted.text.slice(0, insertion)}${tag}${extracted.text.slice(insertion)}`
    })
    .join('\n')
}

function parseTimestampParts(min: string, sec: string, frac?: string): number {
  let ms = 0
  if (frac) {
    ms = Number.parseInt(frac, 10)
    if (frac.length === 2) ms *= 10
  }
  return Number.parseInt(min, 10) * 60 + Number.parseInt(sec, 10) + ms / 1000
}

/**
 * Flatten NetEase JSON lyric fragments (`tx` tokens) into display text.
 * Returns null when the line is not that format.
 */
export function parseNeteaseJsonLyricLine(
  raw: string
): { time: number | null; text: string } | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed[0] !== '{' || !NETEASE_JSON_LINE_RE.test(trimmed)) return null
  try {
    const parsed = JSON.parse(trimmed) as {
      t?: unknown
      c?: Array<{ tx?: unknown } | null> | null
    }
    if (!Array.isArray(parsed.c)) return null
    const text = parsed.c
      .map((part) => (part && typeof part.tx === 'string' ? part.tx : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return null
    const timeMs = typeof parsed.t === 'number' && Number.isFinite(parsed.t) ? parsed.t : null
    // t < 0 is NetEase credit / static metadata (作词 / 作曲 / 制作), not a playhead time.
    const time = timeMs != null && timeMs >= 0 ? timeMs / 1000 : null
    return { time, text }
  } catch {
    return null
  }
}

function isRawNeteaseJsonLyricLine(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed.startsWith('{') && NETEASE_JSON_LINE_RE.test(trimmed)
}

function parseEnhancedWords(rawLine: string): { text: string; words: LyricWord[] } | null {
  WORD_TIMESTAMP_RE.lastIndex = 0
  if (!WORD_TIMESTAMP_RE.test(rawLine)) return null

  const timestamps: Array<{ time: number; index: number; end: number }> = []
  let match: RegExpExecArray | null
  WORD_TIMESTAMP_RE.lastIndex = 0
  while ((match = WORD_TIMESTAMP_RE.exec(rawLine)) !== null) {
    timestamps.push({
      time: parseTimestampParts(match[1], match[2], match[3]),
      index: match.index,
      end: match.index + match[0].length
    })
  }
  if (timestamps.length === 0) return null

  const words: LyricWord[] = []
  let plain = ''
  for (let i = 0; i < timestamps.length; i++) {
    const current = timestamps[i]
    const next = timestamps[i + 1]
    const text = rawLine.slice(current.end, next?.index ?? rawLine.length)
    if (!text) continue
    words.push({
      time: current.time,
      endTime: next?.time ?? null,
      text
    })
    plain += text
  }
  const cleaned = plain.replace(LINE_TIMESTAMP_RE, '').trim()
  if (!cleaned || words.length === 0) return null
  return { text: cleaned, words }
}

/** NetEase YRC: [startMs,durationMs](wordStart,wordDur,0)word... plus JSON credit lines. */
export function parseYrc(yrc: string | null | undefined): ParsedTimedLyricLine[] {
  if (!yrc) return []
  const timed: ParsedTimedLyricLine[] = []
  const credits: ParsedTimedLyricLine[] = []
  for (const raw of yrc.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    const jsonLine = parseNeteaseJsonLyricLine(trimmed)
    if (jsonLine) {
      if (jsonLine.time != null) {
        timed.push({ time: jsonLine.time, text: jsonLine.text })
      } else {
        // Credits (t:-1) are shown once at the top with t=0 so they don't scroll as timed lines.
        credits.push({ time: 0, text: jsonLine.text })
      }
      continue
    }
    if (isRawNeteaseJsonLyricLine(trimmed)) continue

    const lineMatch = YRC_LINE_RE.exec(trimmed)
    if (!lineMatch) continue
    const lineStartMs = Number.parseInt(lineMatch[1], 10)
    const extracted = extractLyricVoiceTag(lineMatch[3] ?? '')
    const body = extracted.text
    const words: LyricWord[] = []
    let plain = ''
    let wordMatch: RegExpExecArray | null
    YRC_WORD_RE.lastIndex = 0
    while ((wordMatch = YRC_WORD_RE.exec(body)) !== null) {
      const startMs = Number.parseInt(wordMatch[1], 10)
      const durMs = Number.parseInt(wordMatch[2], 10)
      const text = wordMatch[3] ?? ''
      if (!text) continue
      words.push({
        time: startMs / 1000,
        endTime: (startMs + durMs) / 1000,
        text
      })
      plain += text
    }
    if (!plain.trim()) continue
    timed.push({
      time: lineStartMs / 1000,
      text: plain,
      words: words.length > 0 ? words : undefined,
      ...(extracted.metadata ? { voice: extracted.metadata } : {})
    })
  }
  timed.sort((a, b) => a.time - b.time)
  // Keep credit lines first so "作词 / 作曲" appear above the first sung line.
  return credits.length > 0 ? [...credits, ...timed] : timed
}

export function parseTimedLrc(lrc: string | null | undefined): ParsedTimedLyricLine[] {
  if (!lrc) return []

  const hasYrcWords = /^\[\d+,\d+\]/m.test(lrc) && /\(\d+,\d+,\d+\)/.test(lrc)
  const hasNeteaseJsonCredits = /"tx"\s*:/.test(lrc) && /"c"\s*:\s*\[/.test(lrc)

  // Prefer YRC when the payload looks like NetEase word lyrics. JSON credit lines
  // (作词/作曲) are also handled inside parseYrc when mixed with YRC.
  if (hasYrcWords || (hasNeteaseJsonCredits && hasYrcWords)) {
    const yrc = parseYrc(lrc)
    if (yrc.length > 0) return yrc
  }

  const lines: ParsedTimedLyricLine[] = []
  const credits: ParsedTimedLyricLine[] = []
  const lineRe = LINE_TIMESTAMP_RE

  for (const raw of lrc.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    const jsonLine = parseNeteaseJsonLyricLine(trimmed)
    if (jsonLine) {
      if (jsonLine.time != null) {
        lines.push({ time: jsonLine.time, text: jsonLine.text })
      } else {
        credits.push({ time: 0, text: jsonLine.text })
      }
      continue
    }
    if (isRawNeteaseJsonLyricLine(trimmed)) continue

    const extracted = extractLyricVoiceTag(trimmed)
    const source = extracted.text
    const timestamps: Array<{ time: number; index: number; end: number }> = []
    let match: RegExpExecArray | null
    lineRe.lastIndex = 0

    while ((match = lineRe.exec(source)) !== null) {
      timestamps.push({
        time: parseTimestampParts(match[1], match[2], match[3]),
        index: match.index,
        end: match.index + match[0].length
      })
    }

    const enhanced = parseEnhancedWords(source)
    if (enhanced) {
      const lineTime = timestamps[0]?.time ?? enhanced.words[0]?.time ?? 0
      lines.push({
        time: lineTime,
        text: enhanced.text,
        words: enhanced.words,
        ...(extracted.metadata ? { voice: extracted.metadata } : {})
      })
      continue
    }

    const text = source.replace(lineRe, '').trim()
    if (!text || timestamps.length === 0) continue

    const hasInlineTimestamps = timestamps.some((timestamp, index) => {
      if (index === 0) return timestamp.index > 0
      const previous = timestamps[index - 1]
      return source.slice(previous.end, timestamp.index).trim().length > 0
    })

    if (hasInlineTimestamps) {
      // Legacy multi-tag-with-text mid-line without Enhanced markers: keep line-level only.
      lines.push({
        time: timestamps[0].time,
        text,
        ...(extracted.metadata ? { voice: extracted.metadata } : {})
      })
      continue
    }

    for (const ts of timestamps) {
      lines.push({
        time: ts.time,
        text,
        ...(extracted.metadata ? { voice: extracted.metadata } : {})
      })
    }
  }

  lines.sort((a, b) => a.time - b.time)
  return credits.length > 0 ? [...credits, ...lines] : lines
}

interface ParsedPlainLyricLine {
  text: string
  voice?: LyricVoiceMetadata
}

function parsePlainLyricLines(lyrics: string | null | undefined): ParsedPlainLyricLine[] {
  if (!lyrics) return []

  const timeTagRe = /\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\]/g
  const wordTagRe = /<\d{1,3}:\d{2}(?:[.:]\d{2,3})?>/g
  const metadataTagRe = /^\[[a-zA-Z]+:.*\]$/
  const result: ParsedPlainLyricLine[] = []

  for (const line of lyrics.split('\n')) {
    const jsonLine = parseNeteaseJsonLyricLine(line)
    if (jsonLine) {
      result.push({ text: jsonLine.text })
      continue
    }
    if (isRawNeteaseJsonLyricLine(line)) continue
    const extracted = extractLyricVoiceTag(line)
    const text = extracted.text.replace(timeTagRe, '').replace(wordTagRe, '').trim()
    if (!text || metadataTagRe.test(text)) continue
    result.push({ text, ...(extracted.metadata ? { voice: extracted.metadata } : {}) })
  }
  return result
}

export function parsePlainLyrics(lyrics: string | null | undefined): string[] {
  return parsePlainLyricLines(lyrics).map((line) => line.text)
}

const LAYER_MATCH_TOLERANCE_MS = 1500

/**
 * Pair translation / romanization lines to the original timed lines.
 *
 * NetEase YRC word lyrics carry line timestamps that can drift from the
 * companion tlyric by up to ~1s (same song, same line order). A plain
 * exact-millisecond join therefore hides every translation for word-level
 * lyrics. Exact matches are tried first; remaining lines fall back to an
 * order-preserving nearest match within a bounded tolerance.
 */
function matchTimedLayer(
  originalLines: readonly ParsedTimedLyricLine[],
  layerLines: readonly ParsedTimedLyricLine[],
  toleranceMs: number = LAYER_MATCH_TOLERANCE_MS
): Map<number, string> {
  const result = new Map<number, string>()
  if (originalLines.length === 0 || layerLines.length === 0) return result

  // Exact millisecond pairing (the standard LRC alignment).
  const exactByTime = new Map<number, string>()
  for (const line of layerLines) {
    const key = Math.round(line.time * 1000)
    if (!exactByTime.has(key)) exactByTime.set(key, line.text)
  }
  const usedLayerKeys = new Set<number>()
  for (const line of originalLines) {
    const key = Math.round(line.time * 1000)
    const text = exactByTime.get(key)
    if (text != null && !usedLayerKeys.has(key)) {
      result.set(key, text)
      usedLayerKeys.add(key)
    }
  }

  // Order-preserving nearest fallback for drifted word-level payloads.
  const toleranceSeconds = toleranceMs / 1000
  let layerIndex = 0
  for (const line of originalLines) {
    const key = Math.round(line.time * 1000)
    if (result.has(key)) continue
    while (
      layerIndex < layerLines.length &&
      usedLayerKeys.has(Math.round(layerLines[layerIndex].time * 1000))
    ) {
      layerIndex++
    }
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = layerIndex; i < layerLines.length; i++) {
      const layerKey = Math.round(layerLines[i].time * 1000)
      if (usedLayerKeys.has(layerKey)) continue
      const delta = Math.abs(key - layerKey)
      if (delta > toleranceMs) {
        if (layerLines[i].time - line.time > toleranceSeconds) break
        continue
      }
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = i
      }
    }
    if (bestIndex >= 0) {
      const matched = layerLines[bestIndex]
      result.set(key, matched.text)
      usedLayerKeys.add(Math.round(matched.time * 1000))
      if (bestIndex > layerIndex) layerIndex = bestIndex
    }
  }
  return result
}

function voiceKey(metadata: LyricVoiceMetadata, sourceIndex: number, time: number | null): string {
  const identity = [
    metadata.role,
    metadata.lane,
    metadata.speaker ?? '',
    sourceIndex,
    time ?? 'plain'
  ]
  return identity.map((part) => encodeURIComponent(String(part))).join(':')
}

function compatibleVoiceText(voices: readonly LyricVoiceLayer[]): string {
  const leads = voices.filter((voice) => voice.role === 'lead')
  const visible = leads.length > 0 ? leads : voices
  return visible
    .map((voice) => voice.text)
    .filter(Boolean)
    .join(' · ')
}

function compatibleVoiceWords(voices: readonly LyricVoiceLayer[]): LyricWord[] | undefined {
  const leads = voices.filter((voice) => voice.role === 'lead')
  const visible = leads.length > 0 ? leads : voices
  return visible.length === 1 ? visible[0].words : undefined
}

function groupTimedLyricLines(lines: readonly ParsedTimedLyricLine[]): Array<{
  rowKey?: string
  time: number
  text: string
  words?: LyricWord[]
  voices?: LyricVoiceLayer[]
}> {
  const result: Array<{
    rowKey?: string
    time: number
    text: string
    words?: LyricWord[]
    voices?: LyricVoiceLayer[]
  }> = []
  const groups = new Map<string, (typeof result)[number]>()

  lines.forEach((line, sourceIndex) => {
    if (!line.voice) {
      result.push({ time: line.time, text: line.text, words: line.words })
      return
    }

    const voice: LyricVoiceLayer = {
      ...line.voice,
      voiceKey: voiceKey(line.voice, sourceIndex, line.time),
      time: line.time,
      text: line.text,
      words: line.words
    }
    const explicitGroup = line.voice.group
    if (!explicitGroup) {
      result.push({
        rowKey: `voice:${sourceIndex}:${Math.round(line.time * 1000)}`,
        time: line.time,
        text: line.text,
        words: line.words,
        voices: [voice]
      })
      return
    }

    let group = groups.get(explicitGroup)
    if (!group) {
      group = {
        rowKey: `group:${encodeURIComponent(explicitGroup)}`,
        time: line.time,
        text: line.text,
        words: line.words,
        voices: []
      }
      groups.set(explicitGroup, group)
      result.push(group)
    }
    group.time = Math.min(group.time, line.time)
    group.voices?.push(voice)
    group.text = compatibleVoiceText(group.voices ?? [])
    group.words = compatibleVoiceWords(group.voices ?? [])
  })

  result.sort((left, right) => left.time - right.time)
  return result
}

export function buildLyricLines(
  lyrics: string | null | undefined,
  translatedLyrics: string | null | undefined,
  romanizedLyrics?: string | null | undefined
): LyricLine[] {
  const parsedOriginalLines = parseTimedLrc(lyrics)
  const originalLines = groupTimedLyricLines(parsedOriginalLines)
  const translatedLines = parseTimedLrc(translatedLyrics)
  const romanizedLines = parseTimedLrc(romanizedLyrics)

  if (originalLines.length > 0) {
    const translatedMap = matchTimedLayer(originalLines, translatedLines)
    const romanizedMap = matchTimedLayer(originalLines, romanizedLines)

    return originalLines.map((line) => ({
      time: line.time,
      text: line.text,
      translation: translatedMap.get(Math.round(line.time * 1000)) ?? null,
      romanization: romanizedMap.get(Math.round(line.time * 1000)) ?? null,
      timed: true,
      words: line.words,
      ...(line.rowKey ? { rowKey: line.rowKey } : {}),
      ...(line.voices ? { voices: line.voices } : {})
    }))
  }

  if (translatedLines.length > 0) {
    return translatedLines.map((line) => ({
      time: line.time,
      text: line.text,
      translation: null,
      romanization: null,
      timed: true,
      words: line.words
    }))
  }

  const parsedPlainLines = parsePlainLyricLines(lyrics)
  const plainLines = parsedPlainLines.map((line) => line.text)
  const plainTranslatedLines = parsePlainLyrics(translatedLyrics)
  const plainRomanizedLines = parsePlainLyrics(romanizedLyrics)
  const sourceLines = plainLines.length > 0 ? plainLines : plainTranslatedLines

  return sourceLines.map((line, index) => {
    const voiceMetadata = plainLines.length > 0 ? parsedPlainLines[index]?.voice : undefined
    const voice = voiceMetadata
      ? {
          ...voiceMetadata,
          voiceKey: voiceKey(voiceMetadata, index, null),
          time: null,
          text: line
        }
      : null
    return {
      time: null,
      text: line,
      translation: plainLines.length > 0 ? (plainTranslatedLines[index] ?? null) : null,
      romanization: plainRomanizedLines[index] ?? null,
      timed: false,
      ...(voice
        ? { rowKey: `voice:${index}:plain`, voices: [voice satisfies LyricVoiceLayer] }
        : {})
    }
  })
}

export function findActiveLyricIndex(lines: readonly LyricLine[], currentTime: number): number {
  if (lines.length === 0 || !Number.isFinite(currentTime)) return -1

  let low = 0
  let high = lines.length - 1
  let activeIndex = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const lineTime = lines[mid].time

    if (lineTime == null) {
      high = mid - 1
      continue
    }

    if (lineTime <= currentTime) {
      activeIndex = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return activeIndex
}

export function findActiveWordIndex(words: readonly LyricWord[], currentTime: number): number {
  if (!words.length || !Number.isFinite(currentTime)) return -1
  let activeIndex = -1
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.time <= currentTime) activeIndex = i
    else break
  }
  return activeIndex
}

/**
 * Return the left-to-right karaoke fill for a word.
 *
 * Word timestamps are absolute playback positions. YRC supplies an explicit
 * end time, while older enhanced LRC usually only supplies the next word's
 * start; accepting both keeps the renderer independent of the source format.
 */
export function getLyricWordProgress(
  word: LyricWord,
  nextWordTime: number | null | undefined,
  currentTime: number
): number {
  if (!Number.isFinite(word.time) || !Number.isFinite(currentTime)) return 0
  if (currentTime <= word.time) return 0

  const endTime = word.endTime ?? nextWordTime ?? null
  if (endTime == null || !Number.isFinite(endTime) || endTime <= word.time) return 1

  return Math.min(1, Math.max(0, (currentTime - word.time) / (endTime - word.time)))
}

export function hasLyricContent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
