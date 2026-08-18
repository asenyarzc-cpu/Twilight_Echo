import { readFile } from 'fs/promises'
import type { IpcMain } from 'electron'
import { resolveAuthorizedAudioFile } from '../security/localPaths'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { encodeAudioFileUrlPath, getMimeType } from '../library/scan'

export function registerFilesystemIpc(ipcMain: IpcMain): void {
  ipcMain.handle('fs:readAudioFile', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    const resolvedPath = await resolveAuthorizedAudioFile(
      normalizeLocalPath(filePath, 'audio file path')
    )
    const buffer = await readFile(resolvedPath)
    return {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      mimeType: getMimeType(resolvedPath)
    }
  })

  ipcMain.handle('fs:getAudioFileUrl', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    const resolvedPath = await resolveAuthorizedAudioFile(
      normalizeLocalPath(filePath, 'audio file path')
    )
    return `twilight-audio:///${encodeAudioFileUrlPath(resolvedPath)}`
  })

  ipcMain.handle('fs:isAudioFileAuthorized', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    try {
      await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'audio file path'))
      return true
    } catch {
      return false
    }
  })
}
