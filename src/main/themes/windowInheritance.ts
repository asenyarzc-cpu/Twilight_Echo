import {
  TWILIGHT_DEFAULT_THEME,
  getBuiltInThemePreset,
  resolveThemeProfileWindowDefaults,
  type ThemeLibrarySnapshot,
  type ThemeWindowDefaults
} from '../../shared/theme.ts'
import { cloneMiniPlayerSettings } from '../../shared/miniPlayer.ts'
import { runtime } from '../core/runtime.ts'
import type { AppSettings } from '../core/types.ts'

export async function createInheritedThemeSettingsPatch(
  snapshot: ThemeLibrarySnapshot
): Promise<Partial<AppSettings>> {
  const defaults = await resolveThemeWindowDefaults(snapshot)
  const patch: Partial<AppSettings> = {}

  if (snapshot.data.windowInheritance.miniPlayer) {
    const miniPlayer = cloneMiniPlayerSettings(runtime.appSettings.miniPlayer)
    const profile = miniPlayer.profiles[miniPlayer.activeStyleId]
    const appearance = defaults.miniPlayer
    if (profile && appearance) {
      miniPlayer.profiles[miniPlayer.activeStyleId] = {
        ...profile,
        background: {
          ...profile.background,
          ...(appearance.surfaceColor
            ? {
                solidColor: appearance.surfaceColor,
                fallbackColor: appearance.surfaceColor
              }
            : {})
        },
        appearance: {
          ...profile.appearance,
          ...(appearance.accentColor
            ? { accentMode: 'custom' as const, accentColor: appearance.accentColor }
            : {}),
          ...(appearance.primaryTextColor || appearance.mutedTextColor
            ? { textMode: 'custom' as const }
            : {}),
          ...(appearance.primaryTextColor ? { primaryTextColor: appearance.primaryTextColor } : {}),
          ...(appearance.mutedTextColor ? { mutedTextColor: appearance.mutedTextColor } : {}),
          ...(appearance.fontFamily ? { fontFamily: appearance.fontFamily } : {}),
          ...(appearance.surfaceOpacity != null
            ? { surfaceOpacity: appearance.surfaceOpacity }
            : {}),
          ...(appearance.glassBlur != null ? { glassBlur: appearance.glassBlur } : {}),
          ...(appearance.cornerRadius != null ? { cornerRadius: appearance.cornerRadius } : {}),
          ...(appearance.borderWidth != null ? { borderWidth: appearance.borderWidth } : {}),
          ...(appearance.borderColor ? { borderColor: appearance.borderColor } : {}),
          ...(appearance.shadowStrength != null
            ? { shadowStrength: appearance.shadowStrength }
            : {}),
          ...(appearance.shadowColor ? { shadowColor: appearance.shadowColor } : {})
        }
      }
      patch.miniPlayer = miniPlayer
    }
  }

  if (snapshot.data.windowInheritance.desktopLyrics && defaults.desktopLyrics) {
    const lyrics = defaults.desktopLyrics
    patch.desktopLyrics = {
      ...runtime.appSettings.desktopLyrics,
      ...(lyrics.fontFamily ? { fontFamily: lyrics.fontFamily } : {}),
      ...(lyrics.fontSize != null ? { fontSize: lyrics.fontSize } : {}),
      ...(lyrics.fontWeight != null ? { fontWeight: lyrics.fontWeight } : {}),
      ...(lyrics.color ? { color: lyrics.color } : {}),
      // v2 sings through a gradient; a theme that names one colour pins both ends,
      // and has to switch the mode off `accent` or its colours would be ignored.
      ...(lyrics.highlightColor
        ? {
            colorMode: 'custom' as const,
            highlightStart: lyrics.highlightColor,
            highlightEnd: lyrics.highlightColor
          }
        : {}),
      ...(lyrics.backgroundColor ? { bgColor: lyrics.backgroundColor } : {}),
      ...(lyrics.backgroundOpacity != null ? { bgOpacity: lyrics.backgroundOpacity } : {}),
      ...(lyrics.shadow != null ? { shadow: lyrics.shadow } : {}),
      ...(lyrics.shadowBlur != null ? { shadowBlur: lyrics.shadowBlur } : {}),
      ...(lyrics.shadowColor ? { shadowColor: lyrics.shadowColor } : {})
    }
  }

  return patch
}

async function resolveThemeWindowDefaults(
  snapshot: ThemeLibrarySnapshot
): Promise<ThemeWindowDefaults> {
  const base = TWILIGHT_DEFAULT_THEME.windowDefaults ?? {}
  const selection = snapshot.data.activeTheme
  let selected: ThemeWindowDefaults | undefined
  if (selection.kind === 'builtin') {
    selected = getBuiltInThemePreset(selection.id)?.windowDefaults
  } else if (selection.kind === 'user') {
    const profile = snapshot.data.profiles.find((entry) => entry.id === selection.id) ?? null
    selected = resolveThemeProfileWindowDefaults(profile)
  } else if (selection.kind === 'plugin') {
    await runtime.pluginManagerReady
    const extensions = (await runtime.pluginManager?.listExtensions()) ?? []
    selected = extensions
      .find((entry) => entry.pluginId === selection.pluginId)
      ?.themes.find((theme) => theme.id === selection.themeId)?.structured?.windowDefaults
  }
  return {
    miniPlayer: { ...base.miniPlayer, ...selected?.miniPlayer },
    desktopLyrics: { ...base.desktopLyrics, ...selected?.desktopLyrics }
  }
}
