import type { AppSettings, PlaybackResumeMode } from '../../shared/appSettings.ts'
import type { PlayMode } from '../../shared/audioEngineTypes.ts'

export type * from '../../shared/appSettings.ts'

export type { MiniPlayerSettings } from '../../shared/miniPlayer'
export type { MotionPreference } from '../../shared/motion.ts'
export type {
  LiquidGlassCoverage,
  LiquidGlassSettings,
  LiquidGlassTheme,
  SurfaceMaterial
} from '../../shared/liquidGlass.ts'
export type { PlayerBarMode, PlayerBarPageMode, PlayerBarSettings } from '../../shared/playerBar.ts'

/** Global shortcuts are string-only; remote control may send structured seek/volume/queue commands. */
export type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'toggleDesktopLyrics'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }

/** Accelerator-bound actions only (excludes structured remote payloads). */
export type PlayerShortcutKeyAction = Extract<PlayerShortcutAction, string>

export interface PlaybackSession {
  version: number
  savedAt: string
  mode: PlaybackResumeMode
  playMode?: PlayMode
  track: unknown
  position: number
  queue?: unknown[]
  queueIndex?: number
  sleepTimer?: unknown
}

export interface SettingsSnapshot extends AppSettings {
  settings: AppSettings
  defaults: {
    cachePath: string
  }
  paths: {
    settingsFile: string
    userDataPath: string
    activeCachePath: string
  }
  appVersion: string
  platform: string
  windowTransparencySupported: boolean
  restartRequired: boolean
  restartReasons: string[]
}

export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
  registered: boolean
  error: string | null
}

export const MEDIA_KEY_SHORTCUTS: {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
}[] = [
  { accelerator: 'MediaPreviousTrack', action: 'previous', label: '上一首（媒体键）' },
  { accelerator: 'MediaNextTrack', action: 'next', label: '下一首（媒体键）' },
  { accelerator: 'MediaPlayPause', action: 'playPause', label: '播放 / 暂停（媒体键）' },
  { accelerator: 'MediaStop', action: 'pause', label: '停止（媒体键）' }
]

export const PLAYER_SHORTCUTS: {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
}[] = [
  { accelerator: 'CommandOrControl+Alt+Left', action: 'previous', label: '上一首' },
  { accelerator: 'CommandOrControl+Alt+Right', action: 'next', label: '下一首' },
  { accelerator: 'CommandOrControl+Alt+Space', action: 'playPause', label: '播放 / 暂停' },
  { accelerator: 'CommandOrControl+Alt+D', action: 'toggleDesktopLyrics', label: '桌面歌词' },
  ...MEDIA_KEY_SHORTCUTS
]
