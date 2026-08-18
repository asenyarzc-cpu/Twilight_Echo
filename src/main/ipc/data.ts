import { ipcMain } from 'electron'
import { sleepTimerService } from '../sleepTimer.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { registerWindowIpc } from './windowIpc.ts'
import { registerShellIpc } from './shellIpc.ts'
import { registerDiscordIpc } from './discordIpc.ts'
import { registerAppIpc } from './appIpc.ts'
import { registerFontsIpc } from './fonts.ts'
import { registerSettingsIpc } from './settingsIpc.ts'
import { registerDebugIpc } from './debugIpc.ts'
import { registerFilesystemIpc } from './filesystemIpc.ts'
import { registerLibraryIpc } from './libraryIpc.ts'
import { registerCoverIpc } from './coverIpc.ts'
import { registerLyricsIpc } from './lyricsIpc.ts'
import { registerPersistenceIpc } from './persistenceIpc.ts'
import { registerSleepTimerIpc } from './sleepTimerIpc.ts'

export function setupDataIpc(): void {
  registerWindowIpc(ipcMain)
  registerShellIpc(ipcMain)
  registerDiscordIpc(ipcMain)
  registerAppIpc(ipcMain)
  registerFontsIpc(ipcMain)
  registerSettingsIpc(ipcMain)
  registerDebugIpc(ipcMain)
  registerFilesystemIpc(ipcMain)
  registerLibraryIpc(ipcMain)
  registerCoverIpc(ipcMain)
  registerLyricsIpc(ipcMain)
  registerPersistenceIpc(ipcMain)
  registerSleepTimerIpc(ipcMain, sleepTimerService, assertTrustedIpcSender)
}
