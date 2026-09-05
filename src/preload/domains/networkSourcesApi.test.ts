import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { RemoteRendererRequest } from '../../shared/remoteControl.ts'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'test:remote-preload-electron', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'test:remote-preload-electron')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const listeners = new Map(); export const replies = []; export const ipcRenderer = { on: (name, fn) => listeners.set(name, fn), invoke: async (...args) => { replies.push(args); return true } }'
      }
    return nextLoad(url, context)
  }
})
const electron = (await import('electron')) as unknown as {
  listeners: Map<string, (event: unknown, request: RemoteRendererRequest) => Promise<void>>
  replies: unknown[][]
}
const { networkSourcesApi } = await import('./networkSourcesApi.ts')
hooks.deregister()

test('preload remote bridge forwards only typed request data, acknowledges errors and removes listeners', async () => {
  const request: RemoteRendererRequest = {
    id: 'request-id',
    kind: 'browse',
    payload: { view: 'library', query: '', offset: 0, limit: 40 }
  }
  const handler = electron.listeners.get('remote:request')!
  const remove = networkSourcesApi.remote.onRequest((received) => {
    assert.equal(received, request)
    assert.equal('sender' in received, false)
    return { items: [], total: 0, offset: 0, limit: 40 }
  })
  await handler({ sender: 'private-electron-event' }, request)
  assert.deepEqual(electron.replies.at(-1), [
    'remote:rendererResponse',
    'request-id',
    true,
    { items: [], total: 0, offset: 0, limit: 40 }
  ])
  remove()
  await handler({}, request)
  assert.deepEqual(electron.replies.at(-1), [
    'remote:rendererResponse',
    'request-id',
    false,
    'renderer_not_ready'
  ])
  const removeFailure = networkSourcesApi.remote.onRequest(() => {
    throw new Error('queue_changed')
  })
  await handler({}, request)
  assert.deepEqual(electron.replies.at(-1), [
    'remote:rendererResponse',
    'request-id',
    false,
    'queue_changed'
  ])
  removeFailure()
})
