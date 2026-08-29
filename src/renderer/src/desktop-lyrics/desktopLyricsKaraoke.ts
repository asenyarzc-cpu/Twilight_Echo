import type { DesktopLyricsWord, DesktopLyricsWritingMode } from '../../../shared/desktopLyrics.ts'

export interface DesktopLyricsKaraokePlan {
  maskImage: string
  maskSize: string
  keyframes: Keyframe[]
  timing: KeyframeAnimationOptions
}

export function buildDesktopLyricsKaraokePlan(
  word: DesktopLyricsWord,
  lineStartMs: number,
  writingMode: DesktopLyricsWritingMode
): DesktopLyricsKaraokePlan {
  const vertical = writingMode === 'vertical'
  return {
    maskImage: vertical
      ? 'linear-gradient(to bottom, #000 50%, transparent 50%)'
      : 'linear-gradient(to right, #000 50%, transparent 50%)',
    maskSize: vertical ? '100% 200%' : '200% 100%',
    keyframes: [{ maskPosition: vertical ? '0 100%' : '100% 0' }, { maskPosition: '0 0' }],
    timing: {
      delay: Math.max(0, word.startMs - lineStartMs),
      duration: Math.max(1, word.endMs - word.startMs),
      fill: 'both',
      easing: 'linear'
    }
  }
}

export function desktopLyricsKaraokeTime(positionMs: number, lineStartMs: number): number {
  return Math.max(0, positionMs - lineStartMs)
}
