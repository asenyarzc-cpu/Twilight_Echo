import {
  LYRICS_FONT_FAMILY_STACKS,
  resolveLyricsFontFamily,
  type LyricsAppearanceFontFamily,
  type LyricsTextStyle
} from './lyricsAppearance.ts'

export const DESKTOP_LYRICS_FOLLOW_FONT = 'follow' as const
export const DESKTOP_LYRICS_SYSTEM_FONT = 'system' as const

export type DesktopLyricsFontPreset =
  | typeof DESKTOP_LYRICS_FOLLOW_FONT
  | typeof DESKTOP_LYRICS_SYSTEM_FONT
  | Exclude<LyricsAppearanceFontFamily, 'inherit' | 'custom'>

const PRESET_STACKS: Readonly<Record<Exclude<DesktopLyricsFontPreset, 'follow'>, string>> = {
  system: LYRICS_FONT_FAMILY_STACKS.system,
  inter: LYRICS_FONT_FAMILY_STACKS.inter,
  lxgw: LYRICS_FONT_FAMILY_STACKS.lxgw,
  sarasa: LYRICS_FONT_FAMILY_STACKS.sarasa,
  comic: LYRICS_FONT_FAMILY_STACKS.comic
}

const INVALID_FONT_NAME_CHARACTERS = /["'(),;:{}[\]<>\\/]/u
const MAX_FONT_NAME_LENGTH = 96

function isSafeSystemFontName(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return false
  }
  return (
    value.length > 0 &&
    value.length <= MAX_FONT_NAME_LENGTH &&
    !INVALID_FONT_NAME_CHARACTERS.test(value)
  )
}

export function resolveDesktopLyricsFontFamily(
  fontFamily: string | null | undefined,
  linkedStyle: Pick<LyricsTextStyle, 'fontFamily' | 'customFontFamily'>
): string {
  const value = typeof fontFamily === 'string' ? fontFamily.trim() : ''
  if (value === DESKTOP_LYRICS_FOLLOW_FONT) return resolveLyricsFontFamily(linkedStyle)
  if (value === 'inherit') return 'inherit'

  const preset = PRESET_STACKS[value as Exclude<DesktopLyricsFontPreset, 'follow'>]
  if (preset) return preset

  if (!isSafeSystemFontName(value)) return PRESET_STACKS[DESKTOP_LYRICS_SYSTEM_FONT]
  return `${JSON.stringify(value)}, sans-serif`
}
