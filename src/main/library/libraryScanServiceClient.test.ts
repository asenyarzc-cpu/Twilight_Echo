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
