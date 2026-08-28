import type { DesktopLyricsLine } from '../../../shared/desktopLyrics.ts'
import type { LyricLine } from './lyrics.ts'

function lineText(line: LyricLine): {
  text: string
  translation: string | null
  words: LyricLine['words']
} {
  const lead = line.voices?.find((voice) => voice.role === 'lead') ?? line.voices?.[0]
  return {
    text: lead?.text ?? line.text,
    translation: lead?.translation?.text ?? line.translation,
    words: lead?.words ?? line.words
  }
}

export function projectDesktopLyricsLines(lines: readonly LyricLine[]): DesktopLyricsLine[] {
  const nextTimedStarts: Array<number | undefined> = new Array(lines.length)
  let nextTimedStart: number | undefined
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextTimedStarts[index] = nextTimedStart
    const currentStart = lines[index].time
    if (currentStart != null) nextTimedStart = currentStart
  }
  return lines
    .map((line, index) => {
      const projected = lineText(line)
      const nextStart = nextTimedStarts[index]
      const startMs = line.time == null ? null : Math.round(line.time * 1000)
      const words = projected.words?.map((word, wordIndex, source) => {
        const start = Math.round(word.time * 1000)
        const nextWord = source[wordIndex + 1]
        const endSeconds =
          word.endTime ?? nextWord?.time ?? nextStart ?? (line.time == null ? null : line.time + 4)
        return {
          text: word.text,
          startMs: start,
          endMs: Math.max(start, Math.round((endSeconds ?? word.time + 0.25) * 1000))
        }
      })
      const explicitEnd = words?.at(-1)?.endMs
      const endMs =
        startMs == null
          ? null
          : (explicitEnd ?? (nextStart == null ? startMs + 4000 : Math.round(nextStart * 1000)))
      return {
        id: `${index}:${startMs ?? 'plain'}`,
        startMs,
        endMs,
        text: projected.text.trim(),
        ...(projected.translation?.trim() ? { translation: projected.translation.trim() } : {}),
        ...(words?.length ? { words } : {})
      }
    })
    .filter((line) => line.text.length > 0)
}
