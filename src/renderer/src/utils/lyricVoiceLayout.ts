import type {
  LyricLine,
  LyricVoiceLane,
  LyricVoiceLayer,
  LyricVoiceRole
} from './lyrics.ts'

export type LyricTextDirection = 'ltr' | 'rtl'

export interface LyricVoiceLayout {
  center: LyricVoiceLayer[]
  start: LyricVoiceLayer[]
  end: LyricVoiceLayer[]
  ordered: LyricVoiceLayer[]
  ariaText: string
  hasDuet: boolean
}

const ROLE_ORDER: Record<LyricVoiceRole, number> = {
  lead: 0,
  background: 1,
  harmony: 2
}

function fallbackVoice(line: LyricLine): LyricVoiceLayer {
  return {
    voiceKey: line.rowKey ? `${line.rowKey}:fallback` : `fallback:${line.time ?? 'plain'}`,
    role: 'lead',
    lane: 'center',
    time: line.time,
    text: line.text,
    words: line.words
  }
}

function compareVoices(left: LyricVoiceLayer, right: LyricVoiceLayer): number {
  const time = (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY)
  if (time !== 0) return time
  const role = ROLE_ORDER[left.role] - ROLE_ORDER[right.role]
  if (role !== 0) return role
  return left.voiceKey.localeCompare(right.voiceKey)
}

export function physicalLyricLane(
  lane: LyricVoiceLane,
  direction: LyricTextDirection
): LyricVoiceLane {
  if (lane === 'center' || direction === 'ltr') return lane
  return lane === 'start' ? 'end' : 'start'
}

export function resolveLyricVoiceLayout(
  line: LyricLine,
  direction: LyricTextDirection = 'ltr'
): LyricVoiceLayout {
  const source = line.voices?.length ? [...line.voices] : [fallbackVoice(line)]
  source.sort(compareVoices)

  const center: LyricVoiceLayer[] = []
  const start: LyricVoiceLayer[] = []
  const end: LyricVoiceLayer[] = []
  for (const voice of source) {
    const lane = physicalLyricLane(voice.lane, direction)
    if (lane === 'start') start.push(voice)
    else if (lane === 'end') end.push(voice)
    else center.push(voice)
  }

  const ordered = (['start', 'center', 'end'] as const).flatMap((lane) =>
    source.filter((voice) => voice.lane === lane).sort(compareVoices)
  )
  const spoken = ordered.map((voice) => voice.text.trim()).filter(Boolean)
  return {
    center,
    start,
    end,
    ordered,
    ariaText: [spoken.join('；'), line.translation, line.romanization].filter(Boolean).join('。'),
    hasDuet:
      start.some((voice) => voice.role === 'lead') && end.some((voice) => voice.role === 'lead')
  }
}
