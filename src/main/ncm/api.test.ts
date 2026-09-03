import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { waitForListeningPort } from './serverBinding.ts'

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test('NCM API binding reports its actual isolated port instead of a foreign listener', async () => {
  const foreignServer = createServer((_request, response) => response.end('foreign-service'))
  const ncmServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end('{"service":"ncm"}')
  })

  try {
    foreignServer.listen(0, '127.0.0.1')
    const foreignPort = await waitForListeningPort(foreignServer)

    ncmServer.listen(0, '127.0.0.1')
    const ncmPort = await waitForListeningPort(ncmServer)

    assert.notEqual(ncmPort, foreignPort)
    const response = await fetch(`http://127.0.0.1:${ncmPort}/login/qr/key`)
    assert.deepEqual(await response.json(), { service: 'ncm' })
  } finally {
    await Promise.all([closeServer(ncmServer), closeServer(foreignServer)])
  }
})

test('NCM API binding rejects when the server cannot listen', async () => {
  const foreignServer = createServer()
  const collidingServer = createServer()

  try {
    foreignServer.listen(0, '127.0.0.1')
    const foreignPort = await waitForListeningPort(foreignServer)
    collidingServer.listen(foreignPort, '127.0.0.1')

    await assert.rejects(waitForListeningPort(collidingServer), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'EADDRINUSE')
      return true
    })
  } finally {
    await closeServer(foreignServer)
  }
})

test('NCM API server starts once on the first request and gates fetch on readiness', async () => {
  const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8')

  assert.match(source, /export function ensureNcmServer\(\): Promise<void>/)
  assert.match(source, /if \(runtime\.ncmServerPromise\) return runtime\.ncmServerPromise/)
  assert.match(source, /const startup = startNcmServer\(\)/)
  assert.match(source, /await ensureNcmServer\(\)/)
  assert.match(source, /port: NCM_API_EPHEMERAL_PORT/)
  assert.match(source, /await waitForListeningPort\(ncmApp\.server\)/)
  assert.match(source, /getListeningPort\(runtime\.ncmServer\)/)
  assert.match(source, /const res = await fetch\(url, \{/)
  assert.match(source, /const responseText = await res\.text\(\)/)
  assert.match(source, /signal: controller\.signal,/)
  assert.match(source, /headers,/)
  assert.match(source, /dispatcher: NCM_KEEP_ALIVE_AGENT/)
  assert.doesNotMatch(source, /NCM_API_PORT = 3100/)
  assert.doesNotMatch(source, /export async function setupNcmApi/)
})
