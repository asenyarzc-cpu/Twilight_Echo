import type { IpcMain } from 'electron'

export function registerDebugIpc(ipcMain: IpcMain): void {
  ipcMain.handle('debug:appendNativeTrace', async (_event, message: string) => {
    if (typeof message !== 'string' || message.length > 500) return
    try {
      const { appendFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      appendFileSync(`${tmpdir()}\\twilight-native.log`, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // diagnostics must never break playback
    }
  })
}
