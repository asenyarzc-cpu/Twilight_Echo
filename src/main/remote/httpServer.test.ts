import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { RemoteAuthSession } from './auth.ts'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'test:remote-electron', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'test:remote-electron') {
      return {
        format: 'module',
        source: 'export const app = { getAppPath: () => process.cwd() }',
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})
const { RemoteHttpServer, RemoteCommandError } = await import('./httpServer.ts')
hooks.deregister()

async function fixture(t: test.TestContext) {
  const server = new RemoteHttpServer({
    auth: new RemoteAuthSession({ pin: '123456' }),
    staticRoot: fileURLToPath(new URL('../../../resources/remote', import.meta.url))
  })
  const status = await server.start()
  t.after(() => server.stop())
  const base = `http://127.0.0.1:${status.port}`
  const pair = await fetch(`${base}/api/pair`, {
    method: 'POST',
    body: JSON.stringify({ pin: '123456' })
  })
  const { token } = (await pair.json()) as { token: string }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } })
  return { server, base, request }
}

test('real remote HTTP requires auth, validates and bounds browse before invoking renderer', async (t) => {
  const { server, base, request } = await fixture(t)
  let calls = 0
  server.setBrowseHandler(async (query) => {
    calls++
    assert.equal(query.limit, 100)
    return { items: [], total: 0, offset: query.offset, limit: query.limit }
  })
  assert.equal((await fetch(`${base}/api/browse?view=library`)).status, 401)
  assert.equal((await request('/api/browse?view=invalid')).status, 400)
  assert.equal((await request('/api/browse?view=library&offset=-1')).status, 400)
  assert.equal(calls, 0)
  const response = await request('/api/browse?view=library&limit=10000')
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as { limit: number }).limit, 100)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})

test('real remote HTTP propagates stale queue and unavailable renderer, rejects missing revision', async (t) => {
  const { server, request } = await fixture(t)
  server.setCommandHandler(async () => {
    throw new RemoteCommandError('queue_changed', 409)
  })
  const command = (body: unknown) =>
    request('/api/command', { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await command({ action: 'jumpQueue', index: 0 })).status, 400)
  const stale = await command({ action: 'jumpQueue', index: 0, revision: 0 })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), { error: 'queue_changed' })
  server.setCommandHandler(async () => {
    throw new RemoteCommandError('renderer_not_ready')
  })
  assert.equal((await command({ action: 'playTrack', id: 'opaque-id' })).status, 503)
  server.setCommandHandler(async () => {
    throw new Error('C:/private/library/secret.flac')
  })
  const failure = await command({ action: 'play' })
  assert.equal(failure.status, 500)
  assert.doesNotMatch(await failure.text(), /private|secret/)
})

test('real remote HTTP limits outstanding browsing and recovers its slots after failures', async (t) => {
  const { server, request } = await fixture(t)
  let entered = 0
  let enteredResolve!: () => void
  let release!: () => void
  const allEntered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  server.setBrowseHandler(async () => {
    if (++entered === 2) enteredResolve()
    await gate
    throw new RemoteCommandError('renderer_timeout')
  })
  const first = request('/api/browse?view=library')
  const second = request('/api/browse?view=queue')
  try {
    await allEntered
    assert.equal((await request('/api/browse?view=library')).status, 429)
  } finally {
    release()
  }
  assert.equal((await first).status, 503)
  assert.equal((await second).status, 503)
  server.setBrowseHandler(async (query) => ({ items: [], total: 0, ...query }))
  assert.equal((await request('/api/browse?view=library')).status, 200)
})

test('real remote HTTP mediaOnly closes control surface and PIN rotation revokes browsing', async (t) => {
  const { server, request } = await fixture(t)
  server.setBrowseHandler(async (query) => ({ items: [], total: 0, ...query }))
  assert.equal((await request('/remote.js')).status, 200)
  server.rotatePin()
  assert.equal((await request('/api/browse?view=library')).status, 401)
  await server.start(0, { mode: 'mediaOnly' })
  for (const path of ['/', '/remote.js', '/api/state', '/api/browse?view=library', '/api/events']) {
    assert.equal((await request(path)).status, 404, path)
  }
  assert.equal(server.getStatus().pin, null)
  assert.equal(server.getStatus().enabled, false)
})
