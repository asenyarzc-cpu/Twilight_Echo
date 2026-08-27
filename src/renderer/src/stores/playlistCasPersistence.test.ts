import assert from 'node:assert/strict'
import test from 'node:test'
import type { Playlist } from './useMusicStore.ts'
import { useMusicStore } from './useMusicStore.ts'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

test('a local action queued during CAS recovery preserves the merged authoritative state', async () => {
  const store = useMusicStore()
  const base: Playlist[] = [
    {
      id: 'pl-favorite',
      name: 'Favorite',
      trackIds: [],
      isDefault: true,
      createdAt: '2026-07-18T00:00:00.000Z'
    },
    {
      id: 'pl-shared',
      name: 'Road Mix',
      trackIds: ['local:base'],
      createdAt: '2026-07-18T00:00:00.000Z'
    }
  ]
  const concurrent: Playlist[] = [
    ...clone(base),
    {
      id: 'pl-remote',
      name: 'Remote Only',
      trackIds: ['remote:track'],
      createdAt: '2026-07-18T00:01:00.000Z'
    }
  ]
  let revision = 1
  let authoritative = clone(base)
  let saveCalls = 0
  let releaseRecovery!: () => void
  let signalRecoveryStarted!: () => void
  const recoveryStarted = new Promise<void>((resolve) => {
    signalRecoveryStarted = resolve
  })
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve
  })

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        loadPlaylists: async () => ({
          version: 2 as const,
          revision,
          savedAt: '',
          data: clone(authoritative)
        }),
        savePlaylists: async (data: Playlist[], expectedRevision: number) => {
          saveCalls += 1
          if (saveCalls === 1) {
            assert.equal(expectedRevision, 1)
            revision = 2
            authoritative = clone(concurrent)
            throw Object.assign(new Error('playlist revision changed'), {
              code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
              current: {
                version: 2 as const,
                revision,
                savedAt: '',
                data: clone(authoritative)
              }
            })
          }
          if (saveCalls === 2) {
            assert.equal(expectedRevision, 2)
            signalRecoveryStarted()
            await recoveryGate
          } else {
            assert.equal(expectedRevision, 3)
          }
          revision += 1
          authoritative = clone(data)
          return {
            version: 2 as const,
            revision,
            savedAt: '',
            data: clone(authoritative)
          }
        }
      }
    }
  }

  await store.loadPlaylists()
  assert.equal(store.renamePlaylist('pl-shared', 'Road Renamed'), true)
  const flushing = store.flushPlaylists()
  await recoveryStarted

  // This action is based on the optimistic local view while the conflict
  // recovery write (which contains pl-remote) is still in flight.
  assert.equal(store.setPlaylistCover('pl-shared', 'cover://second-local-action'), true)
  releaseRecovery()
  assert.equal(await flushing, true)

  assert.equal(saveCalls, 3)
  assert.ok(authoritative.some((playlist) => playlist.id === 'pl-remote'))
  assert.deepEqual(
    authoritative.find((playlist) => playlist.id === 'pl-shared'),
    store.playlists.value.find((playlist) => playlist.id === 'pl-shared')
  )
  assert.equal(authoritative.find((playlist) => playlist.id === 'pl-shared')?.name, 'Road Renamed')
  assert.equal(
    authoritative.find((playlist) => playlist.id === 'pl-shared')?.cover,
    'cover://second-local-action'
  )
  assert.equal(store.playlistPersistenceNotice.value?.kind, 'revision-conflict-recovered')
  store.clearTracks()
})

test('CAS recovery keeps the aggregate playlist fields a local transaction changed', async () => {
  // replayPlaylistRecord 是字段白名单式的回放：kind / pinnedAt / hiddenSources /
  // variantPreferences 少一条分支，置顶和音源隐藏就会在并发写时被静默抹掉。
  const store = useMusicStore()
  const base: Playlist[] = [
    {
      id: 'pl-favorite',
      name: 'Favorite',
      trackIds: [],
      isDefault: true,
      createdAt: '2026-08-20T00:00:00.000Z'
    },
    {
      id: 'pl-aggregate',
      name: '跨源精选',
      trackIds: ['local:one'],
      kind: 'aggregate',
      createdAt: '2026-08-20T00:00:00.000Z'
    }
  ]
  // 另一个窗口给同一个聚合歌单加了一首歌。
  const concurrent = clone(base).map((playlist) =>
    playlist.id === 'pl-aggregate'
      ? { ...playlist, trackIds: [...playlist.trackIds, 'ncm:concurrent'] }
      : playlist
  )
  let revision = 1
  let authoritative = clone(base)
  let saveCalls = 0

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        loadPlaylists: async () => ({
          version: 2 as const,
          revision,
          savedAt: '',
          data: clone(authoritative)
        }),
        savePlaylists: async (data: Playlist[], expectedRevision: number) => {
          saveCalls += 1
          if (saveCalls === 1) {
            assert.equal(expectedRevision, 1)
            revision = 2
            authoritative = clone(concurrent)
            throw Object.assign(new Error('playlist revision changed'), {
              code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
              current: {
                version: 2 as const,
                revision,
                savedAt: '',
                data: clone(authoritative)
              }
            })
          }
          revision += 1
          authoritative = clone(data)
          return {
            version: 2 as const,
            revision,
            savedAt: '',
            data: clone(authoritative)
          }
        }
      }
    }
  }

  await store.loadPlaylists()
  assert.equal(store.setPlaylistPinned('pl-aggregate', true), true)
  assert.equal(store.setPlaylistHiddenSources('pl-aggregate', ['ncm']), true)
  assert.equal(store.setPlaylistVariantPreference('pl-aggregate', 'local:one', 'ncm'), true)
  const createdId = store.createAggregatePlaylist('本地新建的聚合歌单')

  assert.equal(await store.flushPlaylists(), true)

  const merged = authoritative.find((playlist) => playlist.id === 'pl-aggregate')
  assert.ok(merged)
  assert.equal(merged.kind, 'aggregate')
  assert.ok(merged.pinnedAt, 'pinnedAt survives the CAS replay')
  assert.deepEqual(merged.hiddenSources, ['ncm'])
  assert.deepEqual(merged.variantPreferences, { 'local:one': 'ncm' })
  // 并发窗口加进去的曲目不能被这次回放挤掉。
  assert.deepEqual(merged.trackIds, ['local:one', 'ncm:concurrent'])

  const created = authoritative.find((playlist) => playlist.id === createdId)
  assert.equal(created?.kind, 'aggregate')
  store.clearTracks()
})
