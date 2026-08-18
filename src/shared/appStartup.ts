import type { AppSettings } from './appSettings.ts'
import type { ThemeBootstrap, ThemeTone } from './theme.ts'
import type { TrayNavigationTarget } from './trayPlayer.ts'

export interface StartupSettingsSnapshot extends AppSettings {
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

export interface AppStartupSnapshot {
  settings: StartupSettingsSnapshot
  pendingNavigation: TrayNavigationTarget | null
  systemTone: ThemeTone
  themeBootstrap: ThemeBootstrap
}
