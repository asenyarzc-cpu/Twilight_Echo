import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  LocalLibraryScanProgress,
  LocalLibraryWorkerScanRequest,
  LocalLibraryWorkerScanResult
} from '../../shared/localLibraryScan.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import { loadLocalLibraryFileIndex, persistLocalLibraryFileIndex } from './fileIndex.ts'
import {
  LocalLibraryIndexCoordinator,
  type LocalLibraryIndexCoordinatorOptions
} from './libraryIndexCoordinator.ts'
import type { LocalLibraryScanRunner } from './libraryScanServiceClient.ts'
import { loadMusicLibraryDocument, persistMusicLibraryDocument } from './libraryRepository.ts'

type ScanCall = {
  jobId: string
  request: LocalLibraryWorkerScanRequest
  onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void
}

class ScriptedRunner implements LocalLibraryScanRunner {
  readonly calls: ScanCall[] = []
  readonly controls: Array<{ kind: 'pause' | 'resume' | 'cancel'; requestId: string }> = []
  private readonly handler: (call: ScanCall, index: number) => Promise<LocalLibraryWorkerScanResult>

  constructor(handler: (call: ScanCall, index: number) => Promise<LocalLibraryWorkerScanResult>) {
    this.handler = handler
  }

  async scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: ScanCall['onProgress']
  ): Promise<LocalLibraryWorkerScanResult> {
    const call = { jobId, request, onProgress }
    this.calls.push(call)
    return await this.handler(call, this.calls.length - 1)
  }

  pause(requestId: string): void {
    this.controls.push({ kind: 'pause', requestId })
  }

  resume(requestId: string): void {
    this.controls.push({ kind: 'resume', requestId })
  }

  cancel(requestId: string): void {
    this.controls.push({ kind: 'cancel', requestId })
  }

  destroy(): void {}
}

test('missing and revision-mismatched indexes request safe one-time reconciliation', async () => {
  const fixture = createFixture('index-reconcile')
  try {
    const filePath = join(fixture.root, 'song.flac')
    const track = createTrack('existing', filePath)
    fixture.persist(createDocument(4, [fixture.root], [track]))
    const identity = { filePath, size: 100, mtimeMs: 200 }
    const runner = new ScriptedRunner(async (_call, index) =>
      scanResult({
        identities: [identity],
        parsedTracks: index === 0 ? [track] : [],
        parsedFilePaths: index === 0 ? [filePath] : [],
        parsedFileCount: index === 0 ? 1 : 0,
        skippedUnchanged: index === 0 ? 0 : 1
      })
    )
    const coordinator = fixture.coordinator(runner)

    const firstResult = await coordinator.scanStartup()
    assert.equal(runner.calls[0].request.forceParse, true)
    assert.equal(
      loadLocalLibraryFileIndex(fixture.libraryFile).document.libraryRevision,
      firstResult.library.revision
    )

    await coordinator.scanStartup()
    assert.equal(runner.calls[1].request.forceParse, false)

    persistLocalLibraryFileIndex(fixture.libraryFile, {
      version: 1,
      libraryRevision: firstResult.library.revision - 1,
      updatedAt: new Date(0).toISOString(),
      entries: [identity]
    })
    await coordinator.scanStartup()
    assert.equal(runner.calls[2].request.forceParse, true)
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('metadata rescans retain the original library addedAt timestamp', async () => {
  const fixture = createFixture('added-at-retention')
  try {
    const filePath = join(fixture.root, 'rescanned.flac')
    const existing = { ...createTrack('existing-id', filePath), addedAt: 1_000 }
    const rescanned = {
      ...createTrack('worker-id', filePath),
      title: 'Updated title',
      addedAt: 9_000
    }
    fixture.persist(createDocument(1, [fixture.root], [existing]))
    const runner = new ScriptedRunner(async () =>
      scanResult({
        identities: [{ filePath, size: 1, mtimeMs: 2 }],
        parsedTracks: [rescanned],
        parsedFilePaths: [filePath],
        parsedFileCount: 1
      })
    )
    const coordinator = fixture.coordinator(runner)

    const result = await coordinator.scanFull()

    assert.equal((result.library.tracks[0] as Record<string, unknown>).id, 'existing-id')
    assert.equal((result.library.tracks[0] as Record<string, unknown>).title, 'Updated title')
    assert.equal((result.library.tracks[0] as Record<string, unknown>).addedAt, 1_000)
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('root revision drift discards stale scan output instead of re-adding an unmanaged file', async () => {
  const fixture = createFixture('root-drift')
  try {
    const filePath = join(fixture.root, 'removed-root.flac')
    fixture.persist(createDocument(1, [fixture.root], []))
    const runner = new ScriptedRunner(async () => {
      fixture.persist(createDocument(2, [], []))
      return scanResult({
        identities: [{ filePath, size: 1, mtimeMs: 1 }],
        parsedTracks: [createTrack('stale', filePath)],
        parsedFilePaths: [filePath],
        parsedFileCount: 1
      })
    })
    const coordinator = fixture.coordinator(runner)

    const result = await coordinator.scanStartup()

    assert.equal(runner.calls.length, 1)
    assert.deepEqual(result.library.folders, [])
    assert.deepEqual(result.library.tracks, [])
    assert.deepEqual(fixture.load().tracks, [])
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('an exclusion committed during parsing is rechecked and cannot be re-added', async () => {
  const fixture = createFixture('exclusion-race')
  try {
    const filePath = join(fixture.root, 'excluded.flac')
    const existing = createTrack('existing', filePath)
    fixture.persist(createDocument(1, [fixture.root], [existing]))
    const runner = new ScriptedRunner(async (_call, index) => {
      if (index === 0) {
        const removed = createDocument(2, [fixture.root], [])
        removed.exclusions = [
          {
            filePath,
            title: 'Excluded',
            artist: 'Test',
            excludedAt: '2026-07-16T00:00:00.000Z'
          }
        ]
        fixture.persist(removed)
      }
      return scanResult({
        identities: [{ filePath, size: 1, mtimeMs: 1 }],
        parsedTracks: [createTrack('worker-id', filePath)],
        parsedFilePaths: [filePath],
        parsedFileCount: 1
      })
    })
    const coordinator = fixture.coordinator(runner)

    const result = await coordinator.scanStartup()

    assert.equal(runner.calls.length, 2)
    assert.deepEqual(result.library.tracks, [])
    assert.equal(result.library.exclusions.length, 1)
    assert.deepEqual(fixture.load().tracks, [])
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('watcher changes coalesce by canonical path before entering the scan queue', async () => {
  const fixture = createFixture('watch-coalesce')
  try {
    fixture.persist(createDocument(1, [fixture.root], []))
    const firstPath = join(fixture.root, 'first.flac')
    const secondPath = join(fixture.root, 'second.flac')
    const runner = new ScriptedRunner(async () => scanResult({ completeIdentitySnapshot: false }))
    const coordinator = fixture.coordinator(runner, { watcherDebounceMs: 25 })
    const completed = once(coordinator, 'watch-result')

    coordinator.enqueueWatcherChanges([
      { kind: 'add', path: firstPath },
      { kind: 'remove', path: firstPath }
    ])
    coordinator.enqueueWatcherChanges([
      { kind: 'add', path: firstPath },
      { kind: 'add', path: secondPath }
    ])
    await completed

    assert.equal(runner.calls.length, 1)
    assert.deepEqual(runner.calls[0].request.changes, [
      { kind: 'add', path: firstPath },
      { kind: 'add', path: secondPath }
    ])
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('full scan exposes progress, pause, resume, and cancellation without committing partial data', async () => {
  const fixture = createFixture('scan-controls')
  try {
    fixture.persist(createDocument(1, [fixture.root], []))
    let finish: ((result: LocalLibraryWorkerScanResult) => void) | null = null
    const runner = new ScriptedRunner(async (call) => {
      call.onProgress?.({
        phase: 'parsing',
        current: 1,
        total: 2,
        parsedFileCount: 1,
        skippedUnchanged: 0
      })
      return await new Promise<LocalLibraryWorkerScanResult>((resolve) => {
        finish = resolve
      })
    })
    runner.cancel = (requestId: string): void => {
      runner.controls.push({ kind: 'cancel', requestId })
      finish?.(scanResult({ cancelled: true }))
    }
    const coordinator = fixture.coordinator(runner)
    const progressEvent = once(coordinator, 'progress')
    const scan = coordinator.scanFull()
    const [progress] = await progressEvent

    assert.equal((progress as LocalLibraryScanProgress).current, 1)
    assert.equal(coordinator.pause(), true)
    assert.equal(coordinator.getStatus().state, 'paused')
    assert.equal(coordinator.resume(), true)
    assert.equal(coordinator.cancel(), true)
    const result = await scan

    assert.equal(result.state, 'cancelled')
    assert.equal(coordinator.getStatus().state, 'cancelled')
    assert.deepEqual(
      runner.controls.map((control) => control.kind),
      ['pause', 'resume', 'cancel']
    )
    assert.deepEqual(fixture.load().tracks, [])
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

test('background worker failure becomes an observable failed status', () => {
  const fixture = createFixture('worker-status')
  try {
    const runner = new ScriptedRunner(async () => scanResult())
    const coordinator = fixture.coordinator(runner)
    const statuses: string[] = []
    coordinator.on('status', (status) => statuses.push(status.state))

    coordinator.reportServiceError(new Error('worker exited'))

    assert.equal(coordinator.getStatus().state, 'failed')
    assert.equal(coordinator.getStatus().error, 'worker exited')
    assert.deepEqual(statuses, ['failed'])
    coordinator.destroy()
  } finally {
    fixture.cleanup()
  }
})

function createFixture(label: string): {
  root: string
  libraryFile: string
  persist: (document: LocalMusicLibraryDocument) => void
  load: () => LocalMusicLibraryDocument
  coordinator: (
    runner: LocalLibraryScanRunner,
    overrides?: Partial<LocalLibraryIndexCoordinatorOptions>
  ) => LocalLibraryIndexCoordinator
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), `twilight-${label}-`))
  const libraryFile = join(root, 'music-library.json')
  const persist = (document: LocalMusicLibraryDocument): void =>
    persistMusicLibraryDocument(libraryFile, document)
  const load = (): LocalMusicLibraryDocument => loadMusicLibraryDocument(libraryFile).document
  return {
    root,
    libraryFile,
    persist,
    load,
    coordinator: (runner, overrides = {}) =>
      new LocalLibraryIndexCoordinator({
        libraryFilePath: libraryFile,
        scanRunner: runner,
        enqueueTransaction: async (operation) => await operation(),
        loadDocument: () => loadMusicLibraryDocument(libraryFile),
        persistDocument: persist,
        resolveRoots: async (folders) => [...folders],
        getCoverCacheDir: () => join(root, 'covers'),
        ...overrides
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function createDocument(
  revision: number,
  folders: string[],
  tracks: Array<Record<string, unknown>>
): LocalMusicLibraryDocument {
  return { version: 2, revision, folders, tracks, exclusions: [] }
}

function createTrack(id: string, filePath: string): Record<string, unknown> {
  return {
    id,
    title: id,
    artist: 'Test',
    album: 'Test',
    filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    duration: 1,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

function scanResult(
  overrides: Partial<LocalLibraryWorkerScanResult> = {}
): LocalLibraryWorkerScanResult {
  return {
    mode: 'startup',
    completeIdentitySnapshot: true,
    identities: [],
    parsedTracks: [],
    parsedFilePaths: [],
    removedFilePaths: [],
    skippedUnchanged: 0,
    parsedFileCount: 0,
    cancelled: false,
    ...overrides
  }
}
