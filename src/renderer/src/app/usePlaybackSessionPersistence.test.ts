import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import type { PlaybackSession, Track } from '../types/music.ts'

const { createPlaybackSessionPersistence } = (await import(
  new URL('./usePlaybackSessionPersistence.ts', import.meta.url).href
)) as typeof import('./usePlaybackSessionPersistence')
const { PlaybackSessionWriter, playbackSessionWriter } = (await import(
  new URL('./playbackSessionWriter.ts', import.meta.url).href
)) as typeof import('./playbackSessionWriter.ts')
const { pruneUnavailableLocalTracks } = (await import(
  new URL('../utils/localTrackRemovalPolicy.ts', import.meta.url).href
)) as typeof import('../utils/localTrackRemovalPolicy.ts')
const { PersistentDataRevisionConflictError } = (await import(
  new URL('../../../shared/versionedPersistence.ts', import.meta.url).href
)) as typeof import('../../../shared/versionedPersistence.ts')

const track = {
  id: 'local:track',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  filePath: 'D:/Music/track.flac',
  fileName: 'track.flac',
  duration: 180,
  size: 1024,
  cover: null,
  lyrics: null,
  source: 'local' as const
}

test('restore clears persisted session when resume mode is off', async () => {
  const calls: string[] = []
  const writer = new PlaybackSessionWriter()
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'off' }),
    currentTrack: ref(null),
    currentTime: ref(0),
    isPlaying: ref(false),
    restorePlaybackSession: () => calls.push('restore'),
    createPlaybackSession: () => null,
    syncPluginProviders: async () => {
      calls.push('sync')
    },
    sessionWriter: writer,
    dataApi: {
      clearPlaybackSession: async (expectedRevision) => {
        calls.push(`clear:${expectedRevision}`)
        return {
          version: 2 as const,
          revision: expectedRevision + 1,
          savedAt: '2026-07-24T00:00:00.000Z',
          data: null
        }
      },
      loadPlaybackSession: async () => ({
        version: 2 as const,
        revision: 16,
        savedAt: '2026-07-24T00:00:00.000Z',
        data: {
          version: 1 as const,
          savedAt: '',
          mode: 'track' as const,
          track,
          position: 30
        }
      }),
      savePlaybackSession: async () => {
        calls.push('save')
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('off')

  assert.deepEqual(calls, ['clear:16'])
  assert.equal(writer.getRevision(), 17)
})

test('local playback resume restores without waiting for plugin providers', async () => {
  const calls: string[] = []
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'trackAndPosition' }),
    currentTrack: ref(null),
    currentTime: ref(0),
    isPlaying: ref(false),
    restorePlaybackSession: (session) => calls.push(`restore:${session.position}`),
    createPlaybackSession: () => null,
    syncPluginProviders: async () => {
      calls.push('sync')
    },
    dataApi: {
      clearPlaybackSession: async () => {
        calls.push('clear')
      },
      loadPlaybackSession: async () => ({
        version: 1,
        savedAt: '',
        mode: 'track',
        track,
        position: 30
      }),
      savePlaybackSession: async () => {
        calls.push('save')
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')

  assert.deepEqual(calls, ['restore:0'])
})

test('CUE queue/session restore preserves ranges, queue index, and ReplayGain metadata', async () => {
  const first = {
    ...track,
    id: 'local:cue:first',
    duration: 60,
    cueRange: { startSeconds: 0, endSeconds: 60, pregapSeconds: 0 },
    cueSheetPath: 'D:/Music/disc.cue',
    cueEncoding: 'gb18030' as const,
    replayGainTrackGainDb: -3
  }
  const second = {
    ...track,
    id: 'local:cue:second',
    duration: 58,
    cueRange: {
      startSeconds: 60,
      endSeconds: 118,
      pregapSeconds: 2,
      virtualPregapSeconds: 2,
      sourcePregapSeconds: 0
    },
    cueSheetPath: 'D:/Music/disc.cue',
    cueEncoding: 'gb18030' as const,
    replayGainTrackGainDb: -9
  }
  let restored!: {
    track: typeof second
    queue?: Array<typeof first | typeof second>
    queueIndex?: number
    position: number
  } | null
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'trackAndPosition' as const }),
    currentTrack: ref(null),
    currentTime: ref(0),
    isPlaying: ref(false),
    restorePlaybackSession: (session) => {
      restored = structuredClone(session) as typeof restored
    },
    createPlaybackSession: () => null,
    syncPluginProviders: async () => assert.fail('local CUE restore must not wait for plugins'),
    dataApi: {
      clearPlaybackSession: async () => undefined,
      loadPlaybackSession: async () => ({
        version: 1 as const,
        savedAt: '2026-07-18T00:00:00.000Z',
        mode: 'trackAndPosition' as const,
        track: second,
        position: 17,
        queue: [first, second],
        queueIndex: 1
      }),
      savePlaybackSession: async () => undefined
    }
  })

  await persistence.restoreSavedPlaybackSession('trackAndPosition')

  assert.ok(restored)
  const restoredSession = restored as NonNullable<typeof restored>
  assert.equal(restoredSession.position, 17)
  assert.equal(restoredSession.queueIndex, 1)
  assert.deepEqual(restoredSession.track.cueRange, second.cueRange)
  assert.equal(restoredSession.track.replayGainTrackGainDb, -9)
  assert.deepEqual(
    restoredSession.queue?.map((item) => item.cueRange),
    [first.cueRange, second.cueRange]
  )
})

test('plugin playback resume waits for plugin providers before restoring a saved session', async () => {
  const calls: string[] = []
  const pluginTrack = { ...track, id: 'plugin:track', source: 'plugin' as const }
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'trackAndPosition' }),
    currentTrack: ref(null),
    currentTime: ref(0),
    isPlaying: ref(false),
    restorePlaybackSession: (session) => calls.push(`restore:${session.position}`),
    createPlaybackSession: () => null,
    syncPluginProviders: async () => {
      calls.push('sync')
    },
    dataApi: {
      clearPlaybackSession: async () => {
        calls.push('clear')
      },
      loadPlaybackSession: async () => ({
        version: 1,
        savedAt: '',
        mode: 'track',
        track: pluginTrack,
        position: 30
      }),
      savePlaybackSession: async () => {
        calls.push('save')
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')

  assert.deepEqual(calls, ['sync', 'restore:0'])
})

test('autosave clears, saves track-only, and saves track position according to resume mode', async () => {
  const mode = ref<'off' | 'track' | 'trackAndPosition'>('off')
  const currentTrack = ref<typeof track | null>(null)
  const currentTime = ref(0)
  const isPlaying = ref(false)
  const saved: Array<unknown> = []
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: mode }),
    currentTrack,
    currentTime,
    isPlaying,
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (resumeMode) =>
      currentTrack.value
        ? {
            version: 1,
            savedAt: '',
            mode: resumeMode,
            track: currentTrack.value,
            position: currentTime.value
          }
        : null,
    syncPluginProviders: async () => undefined,
    autosaveDelayMs: 0,
    positionAutosaveMs: 0,
    dataApi: {
      clearPlaybackSession: async () => {
        saved.push('clear')
      },
      loadPlaybackSession: async () => null,
      savePlaybackSession: async (session) => {
        saved.push(session)
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('off')
  saved.length = 0
  persistence.startAutosaveWatchers()

  mode.value = 'track'
  currentTrack.value = track
  await nextTick()
  await waitForTimers()

  mode.value = 'trackAndPosition'
  currentTime.value = 42
  isPlaying.value = true
  await nextTick()
  await waitForTimers()
  persistence.stop()

  assert.equal((saved[0] as { mode: string; position: number }).mode, 'track')
  assert.equal((saved[0] as { position: number }).position, 0)
  assert.equal((saved[1] as { mode: string; position: number }).mode, 'trackAndPosition')
  assert.equal((saved[1] as { position: number }).position, 42)
})

test('a track change persists immediately instead of retaining the previous debounced track', async () => {
  const currentTrack = ref<typeof track | null>(track)
  const savedTrackIds: string[] = []
  const nextTrack = { ...track, id: 'local:next-track', title: 'Next Track' }
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'track' as const }),
    currentTrack,
    currentTime: ref(0),
    isPlaying: ref(true),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (mode) => ({
      version: 1,
      savedAt: '',
      mode,
      track: currentTrack.value!,
      position: 0
    }),
    syncPluginProviders: async () => undefined,
    autosaveDelayMs: 1000,
    dataApi: {
      clearPlaybackSession: async () => undefined,
      loadPlaybackSession: async () => null,
      savePlaybackSession: async (session) => {
        savedTrackIds.push(session!.track.id)
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')
  persistence.startAutosaveWatchers()
  currentTrack.value = nextTrack
  await nextTick()
  await waitForTimers()
  persistence.stop()

  assert.deepEqual(savedTrackIds, [track.id, nextTrack.id])
})

test('captures a track that was selected before autosave watchers were installed', async () => {
  const currentTrack = ref<typeof track | null>(track)
  const savedTrackIds: string[] = []
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'track' as const }),
    currentTrack,
    currentTime: ref(0),
    isPlaying: ref(true),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (mode) => ({
      version: 1,
      savedAt: '',
      mode,
      track: currentTrack.value!,
      position: 0
    }),
    syncPluginProviders: async () => undefined,
    dataApi: {
      clearPlaybackSession: async () => undefined,
      loadPlaybackSession: async () => null,
      savePlaybackSession: async (session) => {
        savedTrackIds.push(session!.track.id)
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')
  persistence.startAutosaveWatchers()
  await waitForTimers()
  persistence.stop()

  assert.deepEqual(savedTrackIds, [track.id])
})

test('overlapping playback-session saves commit snapshots in creation order', async () => {
  const currentTrack = ref<typeof track | null>(track)
  const nextTrack = { ...track, id: 'local:next-track', title: 'Next Track' }
  const savedTrackIds: string[] = []
  let releaseFirstWrite: () => void = () => undefined
  let notifyFirstWriteStarted: () => void = () => undefined
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const firstWriteStarted = new Promise<void>((resolve) => {
    notifyFirstWriteStarted = resolve
  })
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'track' as const }),
    currentTrack,
    currentTime: ref(0),
    isPlaying: ref(true),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (mode) => ({
      version: 1,
      savedAt: '',
      mode,
      track: currentTrack.value!,
      position: 0
    }),
    syncPluginProviders: async () => undefined,
    dataApi: {
      clearPlaybackSession: async () => undefined,
      loadPlaybackSession: async () => null,
      savePlaybackSession: async (session) => {
        const trackId = session!.track.id
        if (trackId === track.id) {
          notifyFirstWriteStarted()
          await firstWriteReleased
        }
        savedTrackIds.push(trackId)
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')
  const firstSave = persistence.savePlaybackSessionSnapshot()
  await firstWriteStarted
  currentTrack.value = nextTrack
  const secondSave = persistence.savePlaybackSessionSnapshot()
  await Promise.resolve()
  assert.deepEqual(savedTrackIds, [])

  releaseFirstWrite()
  await Promise.all([firstSave, secondSave])

  assert.deepEqual(savedTrackIds, [track.id, nextTrack.id])
})

test('a deferred old autosave cannot overwrite a later pruned queue session', async () => {
  const removedTrack = {
    ...track,
    id: 'local:removed',
    title: 'Removed',
    filePath: 'D:/Music/removed.flac',
    fileName: 'removed.flac'
  }
  let queue: Track[] = [track, removedTrack]
  let persisted: { queue?: Array<{ id: string }> } | null = null
  let releaseOldWrite!: () => void
  let signalOldWriteStarted!: () => void
  const oldWriteReleased = new Promise<void>((resolve) => {
    releaseOldWrite = resolve
  })
  const oldWriteStarted = new Promise<void>((resolve) => {
    signalOldWriteStarted = resolve
  })
  let saveCalls = 0
  const writer = new PlaybackSessionWriter()
  const dataApi = {
    clearPlaybackSession: async () => {
      persisted = null
    },
    loadPlaybackSession: async () => null,
    savePlaybackSession: async (
      session: {
        queue?: Array<{ id: string }>
      } | null
    ) => {
      saveCalls++
      if (saveCalls === 1) {
        signalOldWriteStarted()
        await oldWriteReleased
      }
      persisted = session ? structuredClone(session) : null
    }
  }
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'track' as const }),
    currentTrack: ref(track),
    currentTime: ref(0),
    isPlaying: ref(true),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (mode) => ({
      version: 1,
      savedAt: '',
      mode,
      track,
      position: 0,
      queue: [...queue],
      queueIndex: 0
    }),
    syncPluginProviders: async () => undefined,
    dataApi,
    sessionWriter: writer
  })

  await persistence.restoreSavedPlaybackSession('track')
  const oldSave = persistence.savePlaybackSessionSnapshot()
  await oldWriteStarted
  const pruned = pruneUnavailableLocalTracks(
    { currentTrack: track, queue, originalQueue: queue, queueIndex: 0 },
    [removedTrack.id],
    [removedTrack.filePath]
  )
  queue = pruned.queue
  const prunedWrite = writer.save(dataApi, {
    version: 1,
    savedAt: '',
    mode: 'track',
    track,
    position: 0,
    queue: pruned.queue,
    queueIndex: pruned.queueIndex
  })
  await Promise.resolve()
  assert.equal(persisted ?? null, null)

  releaseOldWrite()
  await Promise.all([oldSave, prunedWrite.completion])

  assert.deepEqual(
    (persisted as { queue?: Array<{ id: string }> } | null)?.queue?.map((item) => item.id) ?? null,
    [track.id]
  )
  assert.equal(writer.getCommittedSequence(), prunedWrite.sequence)
})

test('default persistence producers share one playback-session writer', async () => {
  await playbackSessionWriter.whenIdle()
  const removedTrack = {
    ...track,
    id: 'local:shared-writer-removed',
    title: 'Shared Writer Removed',
    filePath: 'D:/Music/shared-writer-removed.flac',
    fileName: 'shared-writer-removed.flac'
  }
  let persistedQueue: string[] | null = null
  let releaseOldWrite!: () => void
  let signalOldWriteStarted!: () => void
  const oldWriteReleased = new Promise<void>((resolve) => {
    releaseOldWrite = resolve
  })
  const oldWriteStarted = new Promise<void>((resolve) => {
    signalOldWriteStarted = resolve
  })
  let saveCalls = 0
  const dataApi = {
    clearPlaybackSession: async () => {
      persistedQueue = null
    },
    loadPlaybackSession: async () => null,
    savePlaybackSession: async (
      session: {
        queue?: Array<{ id: string }>
      } | null
    ) => {
      saveCalls++
      if (saveCalls === 1) {
        signalOldWriteStarted()
        await oldWriteReleased
      }
      persistedQueue = session?.queue?.map((item) => item.id) ?? []
    }
  }
  const createPersistence = (queue: (typeof track)[]) =>
    createPlaybackSessionPersistence({
      settings: ref({ playbackResumeMode: 'track' as const }),
      currentTrack: ref(track),
      currentTime: ref(0),
      isPlaying: ref(true),
      restorePlaybackSession: () => undefined,
      createPlaybackSession: (mode) => ({
        version: 1,
        savedAt: '',
        mode,
        track,
        position: 0,
        queue,
        queueIndex: 0
      }),
      syncPluginProviders: async () => undefined,
      dataApi
    })
  const oldProducer = createPersistence([track, removedTrack])
  const prunedProducer = createPersistence([track])

  await oldProducer.restoreSavedPlaybackSession('track')
  await prunedProducer.restoreSavedPlaybackSession('track')
  const oldSave = oldProducer.savePlaybackSessionSnapshot()
  await oldWriteStarted
  const prunedSave = prunedProducer.savePlaybackSessionSnapshot()
  await Promise.resolve()
  assert.equal(persistedQueue, null)

  releaseOldWrite()
  await Promise.all([oldSave, prunedSave])

  assert.deepEqual(persistedQueue, [track.id])
})

test('playback session writer continues after a failed write', async () => {
  const writer = new PlaybackSessionWriter()
  const calls: string[] = []
  const api = {
    savePlaybackSession: async () => {
      calls.push('failed-save')
      throw new Error('write failed')
    },
    clearPlaybackSession: async () => {
      calls.push('clear')
    }
  }
  const failed = writer.save(api, {
    version: 1,
    savedAt: '',
    mode: 'track',
    track,
    position: 0
  })
  const cleared = writer.clear(api)

  await assert.rejects(failed.completion, /write failed/)
  await cleared.completion

  assert.deepEqual(calls, ['failed-save', 'clear'])
  assert.equal(writer.getCommittedSequence(), cleared.sequence)
})

test('CAS conflict adopts the authoritative revision inside the serialized session writer', async () => {
  const writer = new PlaybackSessionWriter()
  const expectedRevisions: number[] = []
  const current = {
    version: 2 as const,
    revision: 1,
    savedAt: '2026-07-17T00:00:00.000Z',
    data: {
      version: 1 as const,
      savedAt: '',
      mode: 'track' as const,
      track,
      position: 0
    }
  }
  const authorityAfterConflict = {
    ...current,
    revision: 2,
    data: { ...current.data, track: { ...track, id: 'local:other-window' } }
  }
  let loads = 0
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: 'track' as const }),
    currentTrack: ref(track),
    currentTime: ref(0),
    isPlaying: ref(true),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (mode) => ({
      version: 1,
      savedAt: '',
      mode,
      track,
      position: 0
    }),
    syncPluginProviders: async () => undefined,
    sessionWriter: writer,
    dataApi: {
      clearPlaybackSession: async () => authorityAfterConflict,
      loadPlaybackSession: async () => {
        loads++
        return loads === 1 ? current : authorityAfterConflict
      },
      savePlaybackSession: async (_session, expectedRevision) => {
        expectedRevisions.push(expectedRevision)
        if (expectedRevision === 1) {
          throw new PersistentDataRevisionConflictError(authorityAfterConflict, expectedRevision)
        }
        return {
          version: 2 as const,
          revision: 3,
          savedAt: '2026-07-17T00:00:03.000Z',
          data: _session
        }
      }
    }
  })

  await persistence.restoreSavedPlaybackSession('track')
  await persistence.savePlaybackSessionSnapshot()

  assert.deepEqual(expectedRevisions, [1, 2])
  assert.equal(loads, 1)
  assert.equal(writer.getRevision(), 3)
})

test('queued stale session writes recover before the exit snapshot reaches storage', async () => {
  const writer = new PlaybackSessionWriter()
  const expectedRevisions: number[] = []
  let revision = 16
  const api = {
    clearPlaybackSession: async () => undefined,
    savePlaybackSession: async (session: PlaybackSession, expectedRevision: number) => {
      expectedRevisions.push(expectedRevision)
      if (expectedRevision !== revision) {
        throw new PersistentDataRevisionConflictError(
          {
            version: 2 as const,
            revision,
            savedAt: '2026-07-23T00:00:00.000Z',
            data: session
          },
          expectedRevision
        )
      }
      revision += 1
      return {
        version: 2 as const,
        revision,
        savedAt: '2026-07-23T00:00:01.000Z',
        data: session
      }
    }
  }
  const currentSession = {
    version: 1 as const,
    savedAt: '',
    mode: 'track' as const,
    track,
    position: 0
  }

  const autosave = writer.save(api, currentSession)
  const exitSave = writer.save(api, { ...currentSession, position: 12 })
  await Promise.all([autosave.completion, exitSave.completion])

  assert.deepEqual(expectedRevisions, [0, 16, 17])
  assert.equal(writer.getRevision(), 18)
  assert.equal(writer.getCommittedSequence(), exitSave.sequence)
})

test('exhausting CAS retries still adopts the authoritative revision for a later retry close', async () => {
  const writer = new PlaybackSessionWriter()
  let diskRevision = 16
  let attempts = 0
  const session = {
    version: 1 as const,
    savedAt: '',
    mode: 'track' as const,
    track,
    position: 0
  }
  const api = {
    clearPlaybackSession: async () => undefined,
    savePlaybackSession: async (_session: PlaybackSession, expectedRevision: number) => {
      attempts += 1
      if (attempts <= 3) {
        // Concurrent writer advances past every retry of the first close.
        diskRevision += 1
        throw new PersistentDataRevisionConflictError(
          {
            version: 2 as const,
            revision: diskRevision,
            savedAt: '2026-07-24T00:00:00.000Z',
            data: session
          },
          expectedRevision
        )
      }
      assert.equal(expectedRevision, diskRevision)
      diskRevision += 1
      return {
        version: 2 as const,
        revision: diskRevision,
        savedAt: '2026-07-24T00:00:01.000Z',
        data: _session
      }
    }
  }

  await assert.rejects(() => writer.save(api, session).completion, /expected 18, current 19/)
  assert.equal(writer.getRevision(), 19)

  await writer.save(api, { ...session, position: 8 }).completion
  assert.equal(attempts, 4)
  assert.equal(writer.getRevision(), 20)
})

test('failed restore leaves autosave available to replace the unusable old session', async () => {
  const mode = ref<'off' | 'track' | 'trackAndPosition'>('track')
  const currentTrack = ref<typeof track | null>(null)
  const writes: string[] = []
  const persistence = createPlaybackSessionPersistence({
    settings: ref({ playbackResumeMode: mode }),
    currentTrack,
    currentTime: ref(0),
    isPlaying: ref(false),
    restorePlaybackSession: () => undefined,
    createPlaybackSession: (resumeMode) =>
      currentTrack.value
        ? {
            version: 1,
            savedAt: '',
            mode: resumeMode,
            track: currentTrack.value,
            position: 0
          }
        : null,
    syncPluginProviders: async () => undefined,
    autosaveDelayMs: 0,
    dataApi: {
      clearPlaybackSession: async () => {
        writes.push('clear')
      },
      loadPlaybackSession: async () => {
        throw new Error('primary and backup are corrupt')
      },
      savePlaybackSession: async () => {
        writes.push('save')
      }
    }
  })

  await assert.rejects(() => persistence.restoreSavedPlaybackSession('track'), /corrupt/)

  persistence.startAutosaveWatchers()
  currentTrack.value = track
  await nextTick()
  persistence.schedulePlaybackSessionAutosave(0)
  await waitForTimers()
  await persistence.savePlaybackSessionSnapshot()
  await persistence.savePlaybackSessionForQuit()
  persistence.stop()

  assert.deepEqual(writes, ['save', 'save', 'save', 'save'])
})

async function waitForTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
