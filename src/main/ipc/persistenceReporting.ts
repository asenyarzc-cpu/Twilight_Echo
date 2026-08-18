import { dialog } from 'electron'
import { runtime } from '../core/runtime'
import { PersistentJsonFileError, type JsonFileLoadResult } from '../persistence/jsonFile.ts'
import { redactSensitiveText } from '../security/secureStorage.ts'

const persistenceNotifications = new Set<string>()

export function reportPersistentDataRecovery<T>(
  label: string,
  filePath: string,
  result: Extract<JsonFileLoadResult<T>, { status: 'recovered' }>
): void {
  const recoveryDetail = result.restoreError
    ? `已读取备份，但恢复主文件失败：${redactSensitiveText(result.restoreError)}`
    : '主文件已由最后一个有效备份恢复。'
  const corruptDetail = result.corruptCopyPath ? `\n损坏副本保留在：${result.corruptCopyPath}` : ''
  console.warn(`[persistence] ${label} recovered from backup`, filePath, result.restoreError ?? '')
  showPersistenceMessage(
    `recovered:${filePath}`,
    'warning',
    `${label}已从备份恢复`,
    `${recoveryDetail}${corruptDetail}`
  )
}

export function reportLocalLibraryRemovalRecovery(
  filePath: string,
  removedFilePaths: string[]
): void {
  const count = removedFilePaths.length
  console.warn(`[persistence] completed ${count} interrupted local library removal(s)`, filePath)
  showPersistenceMessage(
    `removal-recovered:${filePath}`,
    'warning',
    '已完成中断的回收站操作',
    `Twilight Echo 根据恢复日志清理了 ${count} 条已移入回收站的音乐库记录。`
  )
}

export function reportPersistentDataFailure(
  label: string,
  filePath: string,
  error: unknown
): never {
  const message = errorMessage(error)
  const detail =
    error instanceof PersistentJsonFileError
      ? `主文件错误：${redactSensitiveText(error.primaryError)}\n备份错误：${redactSensitiveText(error.backupError)}\n\n文件：${filePath}`
      : `${redactSensitiveText(message)}\n\n文件：${filePath}`
  console.error(`[persistence] failed to load ${label}:`, redactSensitiveText(message))
  showPersistenceMessage(
    `failed:${filePath}`,
    'error',
    `${label}文件已损坏`,
    `${detail}\n\n应用没有把它当作空数据覆盖，请保留该文件以便恢复。`
  )
  throw error instanceof Error ? error : new Error(message)
}

export function showPersistenceMessage(
  key: string,
  type: 'warning' | 'error',
  message: string,
  detail: string
): void {
  if (persistenceNotifications.has(key)) return
  persistenceNotifications.add(key)
  const options: Electron.MessageBoxOptions = {
    type,
    title: 'Twilight Echo 数据恢复',
    message,
    detail,
    buttons: ['确定'],
    noLink: true
  }
  const win = runtime.mainWindow
  const prompt =
    win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  void prompt.catch(() => {
    persistenceNotifications.delete(key)
  })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
