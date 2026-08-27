import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import {
  normalizeOptionalIpcString,
  normalizeIpcString,
  stringifyJsonForIpcStorage
} from '../security/ipcValidation.ts'
import { isSecureValueEnvelope, protectString, unprotectString } from '../security/secureStorage.ts'
import { runtime } from '../core/runtime.ts'
import { NetworkSourceFailure } from './errors.ts'
import { clearDirectory, getDirectorySize, networkCacheDir } from './networkCache.ts'
import { readCoverDataUrl } from './networkCover.ts'
import { createNetworkProfileStore, type CredentialCodec } from './profileStore.ts'
import { createNetworkLibrary } from './networkLibrary.ts'
import { createNetworkSourcesManager, type NetworkSourcesManager } from './sourcesManager.ts'
import { createWebDavAdapter } from './adapters/webdavAdapter.ts'
import { createFtpAdapter } from './adapters/ftpAdapter.ts'
import { createSftpSystemAdapter } from './adapters/sftpSystemAdapter.ts'
import { createNfsMountAdapter, createSmbMountAdapter } from './adapters/smbMountAdapter.ts'
import { createDlnaAdapter } from './adapters/dlnaAdapter.ts'
import type { NetworkEntry, NetworkSourceProfileInput } from '../../shared/networkSources.ts'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

const CREDENTIAL_SCOPE = 'network-source-credentials'

/** 生产凭据 codec：优先 Electron safeStorage，回退机器级 AES-GCM。 */
const secureStorageCodec: CredentialCodec = {
  encrypt(plain) {
    return JSON.stringify(protectString(plain, CREDENTIAL_SCOPE))
  },
  decrypt(encrypted) {
    let envelope: unknown
    try {
      envelope = parseJsonWithNestingLimit(encrypted)
    } catch {
      throw new NetworkSourceFailure('auth', '凭据数据损坏')
    }
    if (!isSecureValueEnvelope(envelope)) {
      throw new NetworkSourceFailure('auth', '凭据数据损坏')
    }
    const value = unprotectString(envelope, CREDENTIAL_SCOPE)
    if (value === null) throw new NetworkSourceFailure('auth', '凭据无法解密')
    return value
  }
}

let manager: NetworkSourcesManager | null = null

export function getNetworkSourcesManager(): NetworkSourcesManager {
  if (!manager) {
    const musicCacheRoot =
      runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
    manager = createNetworkSourcesManager({
      store: createNetworkProfileStore({
        filePath: join(app.getPath('userData'), 'network-sources', 'profiles.json'),
        codec: secureStorageCodec
      }),
      library: createNetworkLibrary({
        filePath: join(app.getPath('userData'), 'network-sources', 'library.json')
      }),
      cacheRoot: join(musicCacheRoot, 'network-cache'),
      coverCacheRoot: join(musicCacheRoot, 'cover-cache'),
      getAdapter: async (protocol) => {
        if (protocol === 'webdav') return createWebDavAdapter()
        if (protocol === 'ftp' || protocol === 'ftps') return createFtpAdapter()
        if (protocol === 'sftp' || protocol === 'scp') return createSftpSystemAdapter()
        if (protocol === 'smb') return createSmbMountAdapter()
        if (protocol === 'nfs') return createNfsMountAdapter()
        if (protocol === 'dlna') return createDlnaAdapter()
        return null
      }
    })
  }
  return manager
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event, 'network sources IPC')
}

function normalizeProfileId(value: unknown): string {
  return normalizeIpcString(value, 'profile id', 128)
}

function parseProfileInput(value: unknown): NetworkSourceProfileInput {
  return parseJsonWithNestingLimit(
    stringifyJsonForIpcStorage(value, 'profile input', 16 * 1024)
  ) as NetworkSourceProfileInput
}

function normalizeEntry(value: unknown): NetworkEntry {
  if (!value || typeof value !== 'object') throw new Error('entry must be an object')
  const entry = value as Partial<NetworkEntry>
  return {
    id: normalizeIpcString(entry.id, 'entry id', 128),
    profileId: normalizeIpcString(entry.profileId, 'entry profile id', 128),
    name: normalizeIpcString(entry.name, 'entry name', 512),
    kind: (entry.kind ?? 'file') as NetworkEntry['kind'],
    path: normalizeIpcString(entry.path, 'entry path', 4096)
  }
}

export function setupNetworkSourceIpc(): void {
  const sources = getNetworkSourcesManager()

  ipcMain.handle('networkSources:listProfiles', (event) => {
    assertTrusted(event)
    return sources.listProfiles()
  })

  ipcMain.handle('networkSources:createProfile', (event, input: unknown) => {
    assertTrusted(event)
    return sources.createProfile(parseProfileInput(input))
  })

  ipcMain.handle('networkSources:updateProfile', (event, id: unknown, patch: unknown) => {
    assertTrusted(event)
    return sources.updateProfile(normalizeProfileId(id), parseProfileInput(patch))
  })

  ipcMain.handle('networkSources:deleteProfile', (event, id: unknown) => {
    assertTrusted(event)
    return sources.deleteProfile(normalizeProfileId(id))
  })

  ipcMain.handle('networkSources:listDirectory', (event, id: unknown, remotePath: unknown) => {
    assertTrusted(event)
    return sources.listDirectory(
      normalizeProfileId(id),
      normalizeIpcString(remotePath, 'remote path', 4096)
    )
  })

  ipcMain.handle('networkSources:testConnection', (event, id: unknown) => {
    assertTrusted(event)
    return sources.testConnection(normalizeProfileId(id))
  })

  ipcMain.handle('networkSources:resolvePlayback', (event, id: unknown, entry: unknown) => {
    assertTrusted(event)
    return sources.resolvePlayback(normalizeProfileId(id), normalizeEntry(entry))
  })

  ipcMain.handle('networkSources:scanDirectory', (event, id: unknown, remotePath: unknown) => {
    assertTrusted(event)
    return sources.scanDirectory(
      normalizeProfileId(id),
      normalizeIpcString(remotePath, 'remote path', 4096)
    )
  })

  ipcMain.handle('networkSources:listLibrary', (event, id: unknown, query: unknown) => {
    assertTrusted(event)
    return sources.listLibrary(
      normalizeProfileId(id),
      normalizeOptionalIpcString(query, 'query', 256)
    )
  })

  ipcMain.handle('networkSources:removeLibraryEntry', (event, id: unknown, entryId: unknown) => {
    assertTrusted(event)
    return sources.removeLibraryEntry(
      normalizeProfileId(id),
      normalizeIpcString(entryId, 'entry id', 128)
    )
  })

  ipcMain.handle('networkSources:enrichLibrary', (event, id: unknown) => {
    assertTrusted(event)
    return sources.enrichLibrary(normalizeProfileId(id))
  })

  ipcMain.handle('networkSources:searchLibrary', (event, query: unknown) => {
    assertTrusted(event)
    return sources.searchLibrary(normalizeOptionalIpcString(query, 'query', 256))
  })

  ipcMain.handle('networkSources:coverDataUrl', (event, id: unknown, entryId: unknown) => {
    assertTrusted(event)
    normalizeProfileId(id)
    const normalizedEntryId = normalizeIpcString(entryId, 'entry id', 128)
    const musicCacheRoot =
      runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
    return readCoverDataUrl(normalizedEntryId, join(musicCacheRoot, 'cover-cache'))
  })

  ipcMain.handle('networkSources:cacheInfo', (event) => {
    assertTrusted(event)
    const musicCacheRoot =
      runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
    return getDirectorySize(networkCacheDir(musicCacheRoot)).then((sizeBytes) => ({
      sizeBytes
    }))
  })

  ipcMain.handle('networkSources:clearCache', (event) => {
    assertTrusted(event)
    const musicCacheRoot =
      runtime.appSettings.musicCachePath || join(app.getPath('userData'), 'music-cache')
    return clearDirectory(networkCacheDir(musicCacheRoot)).then(() => ({ ok: true }))
  })
}
