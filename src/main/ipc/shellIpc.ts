import { shell, type IpcMain } from 'electron'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { resolveAuthorizedOpenPath, resolveAuthorizedShowItemPath } from '../security/localPaths.ts'
import { isSafeExternalUrl } from '../security/externalUrl.ts'
import { normalizeLocalPath } from '../security/ipcValidation.ts'

export function registerShellIpc(ipcMain: IpcMain): void {
  ipcMain.handle('shell:openPath', async (event, targetPath: string) => {
    assertTrustedIpcSender(event, 'shell IPC')
    const resolvedPath = await resolveAuthorizedOpenPath(
      normalizeLocalPath(targetPath, 'open path')
    )
    return await shell.openPath(resolvedPath)
  })
  ipcMain.handle('shell:openExternal', async (event, url: string) => {
    assertTrustedIpcSender(event, 'shell IPC')
    if (!isSafeExternalUrl(url)) return
    await shell.openExternal(url)
  })
  ipcMain.handle('shell:showItemInFolder', async (event, filePath: string) => {
    assertTrustedIpcSender(event, 'shell IPC')
    const resolvedPath = await resolveAuthorizedShowItemPath(
      normalizeLocalPath(filePath, 'show item path')
    )
    shell.showItemInFolder(resolvedPath)
  })
}
