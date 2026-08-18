import { nativeTheme, type IpcMain } from 'electron'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { relaunchApplication } from '../audio/state.ts'
import { resolvePlaybackSessionSave } from '../app/window.ts'
import { createSettingsSnapshot } from '../core/settings.ts'
import { runtime } from '../core/runtime.ts'
import { loadThemeLibrary } from '../themes/themeLibrary.ts'
import { TWILIGHT_DEFAULT_THEME } from '../../shared/theme.ts'
import type { AppStartupSnapshot } from '../../shared/appStartup.ts'
import type { RendererClosePersistenceOutcome } from '../../shared/closePersistence.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import { consumePendingTrayNavigation } from '../integrations/trayPlayer.ts'
import {
  cancelAppUpdateDownload,
  checkForAppUpdate,
  downloadAppUpdate,
  installDownloadedAppUpdate
} from '../app/appUpdateService.ts'

const MAX_PLAYBACK_SAVE_REQUEST_ID_LENGTH = 128
const MAX_PLAYBACK_SAVE_ERROR_LENGTH = 2048

function normalizeRendererClosePersistenceOutcome(value: unknown): RendererClosePersistenceOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Renderer close persistence outcome must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.status === 'saved') return { status: 'saved' }
  if (record.status === 'failed') {
    return {
      status: 'failed',
      error: normalizeIpcString(
        record.error,
        'renderer close persistence error',
        MAX_PLAYBACK_SAVE_ERROR_LENGTH
      )
    }
  }
  throw new Error('Renderer close persistence outcome has an invalid status')
}

export function registerAppIpc(ipcMain: IpcMain): void {
  ipcMain.handle('app:getStartupSnapshot', async (event): Promise<AppStartupSnapshot> => {
    assertTrustedIpcSender(event, 'app startup IPC')
    const [settings, themeBootstrap] = await Promise.all([
      Promise.resolve(createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)),
      loadThemeLibrary().then((library) => ({ library, defaultTheme: TWILIGHT_DEFAULT_THEME }))
    ])
    return {
      settings,
      pendingNavigation: consumePendingTrayNavigation(),
      systemTone: nativeTheme.shouldUseDarkColors ? 'dark' : 'pureWhite',
      themeBootstrap
    }
  })
  ipcMain.handle('app:consumePendingNavigation', (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    return consumePendingTrayNavigation()
  })
  ipcMain.handle('app:relaunch', (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    setTimeout(() => {
      relaunchApplication()
    }, 0)
    return true
  })
  ipcMain.handle(
    'app:playback-session-saved',
    async (event, requestId: string, outcome: unknown) => {
      assertTrustedIpcSender(event, 'app IPC')
      resolvePlaybackSessionSave(
        normalizeIpcString(
          requestId,
          'playback session save request id',
          MAX_PLAYBACK_SAVE_REQUEST_ID_LENGTH
        ),
        normalizeRendererClosePersistenceOutcome(outcome)
      )
      return true
    }
  )
  ipcMain.handle('app:checkForUpdates', async (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    return await checkForAppUpdate()
  })
  ipcMain.handle('app:downloadUpdate', async (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    return await downloadAppUpdate()
  })
  ipcMain.handle('app:cancelUpdateDownload', async (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    return cancelAppUpdateDownload()
  })
  ipcMain.handle('app:installUpdate', async (event) => {
    assertTrustedIpcSender(event, 'app IPC')
    return await installDownloadedAppUpdate()
  })
}
