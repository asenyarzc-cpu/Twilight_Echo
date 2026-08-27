import { NetworkSourceFailure } from './errors.ts'
import { downloadEntryToCache } from './networkCache.ts'
import { enrichNetworkEntry } from './networkMetadata.ts'
import { normalizeRemotePath } from './networkPath.ts'
import type { NetworkLibraryIndex } from './networkLibrary.ts'
import type { NetworkSourceAdapter, NetworkSourceSession, NetworkAuth } from './adapters/types.ts'
import type { NetworkProfileStore, NetworkSourceProfileInput } from './profileStore.ts'
import type {
  NetworkEntry,
  NetworkPlaybackPlan,
  NetworkSourceErrorCode,
  NetworkSourceProfile,
  NetworkSourceProfileSummary
} from '../../shared/networkSources.ts'

export interface NetworkSourcesManager {
  listProfiles(): Promise<NetworkSourceProfileSummary[]>
  createProfile(input: NetworkSourceProfileInput): Promise<NetworkSourceProfileSummary>
  updateProfile(
    id: string,
    patch: Partial<NetworkSourceProfileInput>
  ): Promise<NetworkSourceProfileSummary>
  deleteProfile(id: string): Promise<void>
  listDirectory(
    profileId: string,
    remotePath: string,
    signal?: AbortSignal
  ): Promise<NetworkEntry[]>
  testConnection(profileId: string): Promise<{ ok: boolean; errorCode?: NetworkSourceErrorCode }>
  resolvePlayback(
    profileId: string,
    entry: NetworkEntry,
    signal?: AbortSignal
  ): Promise<NetworkPlaybackPlan>
  scanDirectory(
    profileId: string,
    dirPath: string,
    signal?: AbortSignal
  ): Promise<{ added: number; total: number }>
  listLibrary(profileId: string, query?: string): Promise<NetworkEntry[]>
  removeLibraryEntry(profileId: string, entryId: string): Promise<void>
  enrichLibrary(profileId: string): Promise<{ enriched: number; failed: number }>
  searchLibrary(
    query?: string
  ): Promise<Array<{ profileId: string; profileName: string; entry: NetworkEntry }>>
}

const SCAN_LIMITS = {
  maxDepth: 8,
  maxEntries: 5000
}

export function createNetworkSourcesManager(deps: {
  store: NetworkProfileStore
  cacheRoot: string
  coverCacheRoot: string
  getAdapter: (protocol: NetworkSourceProfile['protocol']) => Promise<NetworkSourceAdapter | null>
  library: NetworkLibraryIndex
}): NetworkSourcesManager {
  const { store, cacheRoot, coverCacheRoot, getAdapter, library } = deps

  async function openSession(profileId: string): Promise<{
    profile: NetworkSourceProfile
    auth: NetworkAuth
    session: NetworkSourceSession
  }> {
    const profile = await store.getProfile(profileId)
    const auth = await store.resolveAuth(profileId)
    const adapter = await getAdapter(profile.protocol)
    if (!adapter) {
      throw new NetworkSourceFailure('unsupportedProtocol', `协议暂不支持：${profile.protocol}`)
    }
    return { profile, auth, session: await adapter.createSession(profile, auth) }
  }

  return {
    async listProfiles() {
      return store.listProfiles()
    },
    async createProfile(input) {
      return store.createProfile(input)
    },
    async updateProfile(id, patch) {
      return store.updateProfile(id, patch)
    },
    async deleteProfile(id) {
      await store.deleteProfile(id)
      await library.removeProfile(id)
    },
    async listDirectory(profileId, remotePath, signal) {
      const { session } = await openSession(profileId)
      try {
        return await session.list(remotePath, signal)
      } finally {
        await session.close()
      }
    },
    async testConnection(profileId) {
      try {
        const { session, profile } = await openSession(profileId)
        try {
          await session.list(profile.rootPath)
          return { ok: true }
        } finally {
          await session.close()
        }
      } catch (err) {
        const failure =
          err instanceof NetworkSourceFailure
            ? err
            : new NetworkSourceFailure('network', String(err))
        return { ok: false, errorCode: failure.code }
      }
    },
    async resolvePlayback(profileId, entry, signal) {
      const { session } = await openSession(profileId)
      try {
        const directUrl = await session.resolvePlaybackUrl(entry.path, signal)
        if (directUrl) {
          return { kind: 'direct-url', url: directUrl, displayName: entry.name }
        }
        const cacheFilePath = await downloadEntryToCache({ session, entry, cacheRoot, signal })
        return { kind: 'local-cache', cacheFilePath, displayName: entry.name }
      } finally {
        await session.close()
      }
    },
    async scanDirectory(profileId, dirPath, signal) {
      const { session } = await openSession(profileId)
      const found: NetworkEntry[] = []
      const visited = new Set<string>()
      const root = normalizeRemotePath(dirPath)

      async function walk(path: string, depth: number): Promise<void> {
        if (depth > SCAN_LIMITS.maxDepth || found.length >= SCAN_LIMITS.maxEntries) return
        const entries = await session.list(path, signal)
        for (const entry of entries) {
          if (found.length >= SCAN_LIMITS.maxEntries) return
          if (entry.kind === 'audio') {
            found.push(entry)
          } else if (entry.kind === 'directory' && !visited.has(entry.path)) {
            visited.add(entry.path)
            await walk(entry.path, depth + 1)
          }
        }
      }

      try {
        visited.add(root)
        await walk(root, 0)
        return library.addEntries(profileId, root, found)
      } finally {
        await session.close()
      }
    },
    async listLibrary(profileId, query) {
      return library.listEntries(profileId, query)
    },
    async removeLibraryEntry(profileId, entryId) {
      return library.removeEntry(profileId, entryId)
    },
    async enrichLibrary(profileId) {
      const entries = await library.listEntries(profileId)
      if (entries.length === 0) return { enriched: 0, failed: 0 }
      const { session } = await openSession(profileId)
      const updated: NetworkEntry[] = []
      let failed = 0
      try {
        for (const entry of entries) {
          const enriched = await enrichNetworkEntry({
            session,
            entry,
            cacheRoot,
            coverCacheRoot
          })
          if (enriched.metadata) {
            updated.push(enriched)
          } else {
            failed += 1
          }
        }
      } finally {
        await session.close()
      }
      if (updated.length > 0) await library.updateEntries(profileId, updated)
      return { enriched: updated.length, failed }
    },
    async searchLibrary(query) {
      const profiles = await store.listProfiles()
      const results: Array<{
        profileId: string
        profileName: string
        entry: NetworkEntry
      }> = []
      for (const profile of profiles) {
        const entries = await library.listEntries(profile.id, query)
        for (const entry of entries) {
          results.push({ profileId: profile.id, profileName: profile.name, entry })
        }
      }
      return results
    }
  }
}
