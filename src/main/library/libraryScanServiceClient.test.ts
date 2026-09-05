import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import type {
  LocalLibraryScanWorkerMessage,
  LocalLibraryWorkerScanRequest
} from '../../shared/localLibraryScan.ts'

class ManualUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = []
  killCount = 0

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  kill(): void {
    this.killCount += 1
    this.emit('exit', 0)
  }
}

const scanRequest: LocalLibraryWorkerScanRequest = {
  mode: 'startup',
  roots: ['C:\\Music'],
  knownIdentities: [],
  knownTrackPaths: [],
  excludedPaths: [],
  coverCacheDir: 'C:\\Covers'
}

test('local library scan service forks on its first scan, then waits for ready', async () => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })

  assert.equal(children.length, 0)
  const pending = client.scan('startup-job', scanRequest)
  assert.equal(children.length, 1)
  assert.equal(children[0].messages.length, 0)

  children[0].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[0].messages, [
    { kind: 'scan', requestId: 'startup-job', request: scanRequest }
  ])

  children[0].emit('message', {
    kind: 'response',
    requestId: 'startup-job',
    ok: true,
    value: {
      mode: 'startup',
      completeIdentitySnapshot: true,
      identities: [],
      parsedTracks: [],
      parsedFilePaths: [],
      removedFilePaths: [],
      skippedUnchanged: 0,
      parsedFileCount: 0,
      cancelled: false
    }
  } satisfies LocalLibraryScanWorkerMessage)

  assert.equal((await pending).cancelled, false)
  client.destroy()
})

test('local library scan service rejects first scans when utilityProcess is unavailable', async () => {
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    electron: {}
  })

  await assert.rejects(client.scan('unavailable-job', scanRequest), /utilityProcess is unavailable/)
  client.destroy()
})

test('local library scan service restarts a stalled worker and skips its active paths', async () => {
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })

  let resetCount = 0
  const pending = client.scan('stalled-job', scanRequest, undefined, undefined, undefined, () => {
    resetCount += 1
  })
  children[0].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'stalled-job',
    activity: { filePaths: ['C:\\Music\\stalled.mp3'] }
  } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(children.length, 2)
  assert.equal(resetCount, 1)
  children[1].emit('message', { kind: 'ready' } satisfies LocalLibraryScanWorkerMessage)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(children[1].messages[0], {
    kind: 'scan',
    requestId: 'stalled-job',
    request: { ...scanRequest, skipParsePaths: ['C:\\Music\\stalled.mp3'] }
  })
  children[1].emit('message', {
    kind: 'response',
    requestId: 'stalled-job',
    ok: true,
    value: {
      mode: 'startup',
      completeIdentitySnapshot: true,
      identities: [],
      parsedTracks: [],
      parsedFilePaths: [],
      removedFilePaths: [],
      skippedUnchanged: 0,
      parsedFileCount: 0,
      cancelled: false,
      skippedFilePaths: ['C:\\Music\\stalled.mp3']
    }
  } satisfies LocalLibraryScanWorkerMessage)

  assert.equal((await pending).cancelled, false)
  client.destroy()
})

test('streaming recovery retains completed batches instead of resetting the library', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  let resets = 0
  const batches: unknown[] = []
  const pending = client.scan(
    'resume-job',
    { ...scanRequest, streamResults: true },
    undefined,
    (batch) => batches.push(batch),
    undefined,
    () => {
      resets++
    }
  )
  children[0].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  const identities = ['done.mp3', 'stalled.mp3', 'remaining.mp3'].map((name) => ({
    filePath: `C:\\Music\\${name}`,
    size: 10,
    mtimeMs: 1
  }))
  children[0].emit('message', {
    kind: 'identity-batch',
    requestId: 'resume-job',
    batch: { identities }
  } satisfies LocalLibraryScanWorkerMessage)
  children[0].emit('message', {
    kind: 'batch',
    requestId: 'resume-job',
    batch: {
      parsedTracks: [{ filePath: identities[0].filePath }],
      parsedFilePaths: [identities[0].filePath]
    }
  } satisfies LocalLibraryScanWorkerMessage)
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'resume-job',
    activity: { filePaths: [identities[1].filePath] }
  } satisfies LocalLibraryScanWorkerMessage)
  t.mock.timers.tick(101)
  assert.equal(children.length, 2)
  children[1].emit('message', { kind: 'ready' })
  assert.equal(resets, 0)
  assert.equal(batches.length, 1)
  assert.deepEqual(children[1].messages[0], {
    kind: 'scan',
    requestId: 'resume-job',
    request: {
      ...scanRequest,
      streamResults: true,
      skipParsePaths: [identities[1].filePath],
      resumeCheckpoint: {
        identities,
        completeIdentitySnapshot: true,
        completedFilePaths: [identities[0].filePath],
        parsedFileCount: 1
      }
    }
  })
  client.cancel('resume-job')
  assert.equal((await pending).cancelled, true)
})

test('paused scans do not restart when progress arrives or the watchdog interval elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: ManualUtilityProcess[] = []
  const client = new LocalLibraryScanServiceClient({
    serviceEntry: 'libraryScanService.js',
    scanWatchdogMs: 100,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new ManualUtilityProcess()
          children.push(child)
          return child
        }
      }
    }
  })
  t.after(() => client.destroy())
  const pending = client.scan('pause-job', scanRequest)
  children[0].emit('message', { kind: 'ready' })
  await new Promise((resolve) => setImmediate(resolve))
  client.pause('pause-job')
  children[0].emit('message', {
    kind: 'activity',
    requestId: 'pause-job',
    activity: { filePaths: ['C:\\Music\\slow.mp3'] }
  } satisfies LocalLibraryScanWorkerMessage)
  t.mock.timers.tick(60_000)
  assert.equal(children.length, 1)
  assert.equal(children[0].killCount, 0)
  client.resume('pause-job')
  t.mock.timers.tick(101)
  assert.equal(children.length, 2)
  client.cancel('pause-job')
  assert.equal((await pending).cancelled, true)
})
