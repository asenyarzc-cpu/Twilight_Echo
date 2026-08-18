import { dialog, BrowserWindow, type IpcMain } from 'electron'
import { resolve } from 'path'
import { rm } from 'fs/promises'
import { runtime } from '../core/runtime'
import type { AppSettings } from '../core/types'
import { createSettingsSnapshot, getDefaultCachePath, normalizeAppSettings } from '../core/settings'
import { exportAppSettingsForBackup, importAppSettingsBackup } from '../core/settingsBackup'
import { loadThemeLibrary } from '../themes/themeLibrary.ts'
import { restoreThemeLibraryFromBackup } from './themes.ts'
import { ensureMusicCacheDirectories } from '../cache/ncmCache'
import { clearManagedMusicCache, getManagedMusicCacheSize } from '../cache/musicCacheLayout.ts'
import {
  getLegacyCoverCacheDir,
  importBackgroundImageBuffer,
  importBackgroundImage,
  normalizeBackgroundImageImportData
} from '../library/coverCache'
import { updateAppSettings } from '../audio/state'
import { getPlayerShortcutStatuses } from '../integrations/shortcutsTray'
import {
  grantUserSelectedCacheRoot,
  grantUserSelectedLibraryRoot,
  resolveAuthorizedCacheRoot,
  resolveAuthorizedImpulseResponseFile,
  resolveAuthorizedLibraryRootSettings
} from '../security/localPaths'
import { normalizeIpcString, stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const MAX_SETTINGS_PATCH_BYTES = 512 * 1024
const MAX_SETTINGS_BACKUP_BYTES = 2 * 1024 * 1024
const MAX_BACKGROUND_IMAGE_FILE_NAME_LENGTH = 255

async function authorizeSettingsPathPatch(
  patch: Partial<AppSettings>
): Promise<Partial<AppSettings>> {
  const authorizedPatch: Partial<AppSettings> = { ...patch }
  const normalizedSettings = normalizeAppSettings({ ...runtime.appSettings, ...patch })

  if (
    Object.prototype.hasOwnProperty.call(patch, 'cachePath') ||
    Object.prototype.hasOwnProperty.call(patch, 'musicCachePath')
  ) {
    const requestedCachePath = normalizedSettings.musicCachePath || getDefaultCachePath()
    if (resolve(requestedCachePath) === resolve(getDefaultCachePath())) {
      ensureMusicCacheDirectories(requestedCachePath)
      await grantUserSelectedCacheRoot(requestedCachePath)
    }
    const cachePath = await resolveAuthorizedCacheRoot(requestedCachePath)
    authorizedPatch.cachePath = cachePath
    authorizedPatch.musicCachePath = cachePath
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'libraryFolders')) {
    authorizedPatch.libraryFolders = await resolveAuthorizedLibraryRootSettings(
      normalizedSettings.libraryFolders
    )
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'audioProcessing')) {
    const audioProcessing = { ...normalizedSettings.audioProcessing }
    if (audioProcessing.convolverIrPath) {
      audioProcessing.convolverIrPath = await resolveAuthorizedImpulseResponseFile(
        audioProcessing.convolverIrPath
      )
    }
    authorizedPatch.audioProcessing = audioProcessing
  }

  return authorizedPatch
}

export function registerSettingsIpc(ipcMain: IpcMain): void {
  ipcMain.handle('dialog:openFolder', async (event) => {
    assertTrustedIpcSender(event, 'dialog IPC')
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = await grantUserSelectedLibraryRoot(result.filePaths[0])
    const libraryFolders = await resolveAuthorizedLibraryRootSettings([
      ...runtime.appSettings.libraryFolders,
      folder
    ])
    await updateAppSettings({ libraryFolders })
    return folder
  })

  ipcMain.handle('settings:chooseBackgroundImage', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: '背景图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    }
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return importBackgroundImage(result.filePaths[0])
  })

  ipcMain.handle(
    'settings:importBackgroundImage',
    async (event, fileName: string, data: unknown) => {
      assertTrustedIpcSender(event, 'settings IPC')
      const buffer = normalizeBackgroundImageImportData(data)
      if (typeof fileName !== 'string' || !buffer) return null
      return importBackgroundImageBuffer(
        normalizeIpcString(
          fileName,
          'background image file name',
          MAX_BACKGROUND_IMAGE_FILE_NAME_LENGTH
        ),
        buffer
      )
    }
  )

  ipcMain.handle('settings:get', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    return createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  })

  ipcMain.handle('settings:update', async (event, patch: Partial<AppSettings>) => {
    assertTrustedIpcSender(event, 'settings IPC')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Settings patch must be an object')
    }
    stringifyJsonForIpcStorage(patch, 'settings patch', MAX_SETTINGS_PATCH_BYTES)
    return await updateAppSettings(await authorizeSettingsPathPatch(patch))
  })

  ipcMain.handle('settings:export', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    return exportAppSettingsForBackup(runtime.appSettings, (await loadThemeLibrary()).data)
  })

  ipcMain.handle('settings:import', async (event, json: string) => {
    assertTrustedIpcSender(event, 'settings IPC')
    if (typeof json !== 'string') {
      throw new Error('Settings backup must be a JSON string')
    }
    if (Buffer.byteLength(json, 'utf-8') > MAX_SETTINGS_BACKUP_BYTES) {
      throw new Error('Settings backup is too large')
    }
    const imported = importAppSettingsBackup(json, runtime.appSettings, normalizeAppSettings)
    const settingsSnapshot = await updateAppSettings(
      await authorizeSettingsPathPatch(imported.settings)
    )
    if (!imported.themeLibrary) return settingsSnapshot
    await restoreThemeLibraryFromBackup(imported.themeLibrary)
    return createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  })

  ipcMain.handle('settings:getShortcutStatuses', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    return getPlayerShortcutStatuses()
  })

  ipcMain.handle('settings:chooseCacheFolder', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      title: '选择缓存位置',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    ensureMusicCacheDirectories(result.filePaths[0])
    return await grantUserSelectedCacheRoot(result.filePaths[0])
  })

  ipcMain.handle('settings:getCacheSize', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    const cachePath = await resolveAuthorizedCacheRoot(
      runtime.appSettings.musicCachePath || getDefaultCachePath()
    )
    return await getManagedMusicCacheSize(cachePath)
  })

  ipcMain.handle('settings:clearCache', async (event) => {
    assertTrustedIpcSender(event, 'settings IPC')
    const cachePath = await resolveAuthorizedCacheRoot(
      runtime.appSettings.musicCachePath || getDefaultCachePath()
    )
    try {
      await clearManagedMusicCache(cachePath)
      await rm(getLegacyCoverCacheDir(), { recursive: true, force: true })
    } catch (error) {
      console.warn('清理缓存失败：', error)
    }
    ensureMusicCacheDirectories(cachePath)
    return await getManagedMusicCacheSize(cachePath)
  })
}
