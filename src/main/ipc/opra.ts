import { ipcMain } from 'electron'
import { runtime } from '../core/runtime'
import { OpraCatalog } from '../opraCatalog'
import { getOpraDatabaseCachePath } from '../core/settings'
import { normalizeOptionalIpcString } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const MAX_OPRA_QUERY_LENGTH = 256
const MAX_OPRA_PROFILE_ID_LENGTH = 128

function requireOpraCatalog(): OpraCatalog {
  if (!runtime.opraCatalog) {
    runtime.opraCatalog = new OpraCatalog(getOpraDatabaseCachePath())
  }
  return runtime.opraCatalog
}

export function setupOpraIpc(): void {
  ipcMain.handle('opra:search', async (_event, query: string) => {
    assertTrustedIpcSender(_event, 'OPRA IPC')
    return await requireOpraCatalog().search(
      normalizeOptionalIpcString(query, 'OPRA query', MAX_OPRA_QUERY_LENGTH) ?? ''
    )
  })

  ipcMain.handle('opra:getProfile', async (_event, eqId: string) => {
    assertTrustedIpcSender(_event, 'OPRA IPC')
    return await requireOpraCatalog().getProfile(
      normalizeOptionalIpcString(eqId, 'OPRA profile id', MAX_OPRA_PROFILE_ID_LENGTH) ?? ''
    )
  })

  ipcMain.handle('opra:refresh', async (event) => {
    assertTrustedIpcSender(event, 'OPRA IPC')
    return await requireOpraCatalog().refresh()
  })

  ipcMain.handle('opra:getStatus', async (event) => {
    assertTrustedIpcSender(event, 'OPRA IPC')
    return requireOpraCatalog().getStatus()
  })
}
