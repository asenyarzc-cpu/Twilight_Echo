import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const { VersionedDataStore } = (await import(
  new URL('./versionedDataStore.ts', import.meta.url).href
)) as typeof import('./versionedDataStore')
const { DEFAULT_LYRICS_MANAGEMENT, isLyricsManagementDocument } = (await import(
  new URL('../../shared/lyricsManagement.ts', import.meta.url).href
)) as typeof import('../../shared/lyricsManagement')
const { PersistentDataRevisionConflictError } = (await import(
  new URL('../../shared/versionedPersistence.ts', import.meta.url).href
)) as typeof import('../../shared/versionedPersistence')

test('lyrics management persists offsets and manual tracks through the versioned store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-lyrics-management-'))
  try {
    const filePath = join(directory, 'lyrics-management.json')
    const first = new VersionedDataStore({
      filePath,
      label: 'lyrics management',
      maxBytes: 1024 * 1024,
      isData: isLyricsManagementDocument,
      isLegacy: isLyricsManagementDocument,
      now: () => '2026-07-18T00:00:00.000Z'
    })
    const document = {
      ...DEFAULT_LYRICS_MANAGEMENT,
      globalOffsetMs: 125,
      tracks: {
        song: {
          offsetMs: -25,
          source: 'manual' as const,
          original: '[00:01.00]Edited',
          translation: null,
          romanization: null,
          updatedAt: '2026-07-18T00:00:00.000Z'
        }
      }
    }
    const saved = await first.save(document, 0)
    assert.equal(saved.revision, 1)

    const second = new VersionedDataStore({
      filePath,
      label: 'lyrics management',
      maxBytes: 1024 * 1024,
      isData: isLyricsManagementDocument,
      isLegacy: isLyricsManagementDocument
    })
    assert.deepEqual(await second.load(), saved)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lyrics management rejects a stale compare-and-swap write without replacing authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-lyrics-management-cas-'))
  try {
    const filePath = join(directory, 'lyrics-management.json')
    const createStore = () =>
      new VersionedDataStore({
        filePath,
        label: 'lyrics management',
        maxBytes: 1024 * 1024,
        isData: isLyricsManagementDocument,
        isLegacy: isLyricsManagementDocument
      })
    const first = createStore()
    const second = createStore()
    await first.save(DEFAULT_LYRICS_MANAGEMENT, 0)
    const authoritative = { ...DEFAULT_LYRICS_MANAGEMENT, globalOffsetMs: 100 }
    await first.save(authoritative, 1)

    await assert.rejects(
      () => second.save({ ...DEFAULT_LYRICS_MANAGEMENT, globalOffsetMs: -100 }, 1),
      (error: unknown) =>
        error instanceof PersistentDataRevisionConflictError &&
        error.current?.data.globalOffsetMs === 100
    )
    assert.equal((await first.load())?.data.globalOffsetMs, 100)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
