import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { createWebDavAdapter } from './webdavAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/music/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/music/album/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/music/a.flac</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>1024</d:getcontentlength>
        <d:getcontenttype>audio/flac</d:getcontenttype>
        <d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

const FLAC_BYTES = Buffer.from('FLAC-DATA-0123456789')
const EXPECTED_BASIC = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`
const SINGLE_FILE_STATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/music/a.flac</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>1024</d:getcontentlength>
        <d:getcontenttype>audio/flac</d:getcontenttype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

let server: Server
let basePort = 0

function makeProfile(): NetworkSourceProfile {
  return {
    id: 'p1',
    protocol: 'webdav',
    name: 'Test NAS',
    host: '127.0.0.1',
    port: basePort,
    rootPath: '/music',
    username: 'alice',
    credential: { kind: 'password', encryptedId: 'enc:secret' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 10_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null
  }
}

test.before(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== EXPECTED_BASIC) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end()
      return
    }
    if (req.method === 'PROPFIND') {
      if (req.url === '/music' || req.url === '/music/') {
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(MULTISTATUS)
        return
      }
      if (req.url === '/music/a.flac') {
        res.writeHead(207, { 'Content-Type': 'application/xml' })
        res.end(SINGLE_FILE_STATUS)
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/music/a.flac') {
      const range = req.headers.range
      const match = typeof range === 'string' ? /^bytes=(\d+)-/.exec(range) : null
      if (match) {
        const start = Number(match[1])
        const body = FLAC_BYTES.subarray(start)
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${FLAC_BYTES.length - 1}/${FLAC_BYTES.length}`,
          'Content-Length': body.length
        })
        res.end(body)
        return
      }
      res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': FLAC_BYTES.length })
      res.end(FLAC_BYTES)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address === 'object') basePort = address.port
})

test.after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

test('webdav list parses multistatus into children entries with stable ids', async () => {
  const session = await createWebDavAdapter().createSession(makeProfile(), {
    kind: 'password',
    username: 'alice',
    password: 's3cret'
  })
  const entries = await session.list('/music')
  assert.equal(entries.length, 2)
  const album = entries.find((entry) => entry.name === 'album')
  const track = entries.find((entry) => entry.name === 'a.flac')
  assert.ok(album)
  assert.ok(track)
  assert.equal(album.kind, 'directory')
  assert.equal(album.path, '/music/album')
  assert.equal(track.kind, 'audio')
  assert.equal(track.path, '/music/a.flac')
  assert.equal(track.sizeBytes, 1024)
  assert.equal(track.mimeType, 'audio/flac')
  assert.match(track.id, /^[0-9a-f]{64}$/)
  await session.close()
})

test('webdav stat returns a single entry and notFound for missing paths', async () => {
  const session = await createWebDavAdapter().createSession(makeProfile(), {
    kind: 'password',
    username: 'alice',
    password: 's3cret'
  })
  const entry = await session.stat('/music/a.flac')
  assert.equal(entry?.name, 'a.flac')
  await assert.rejects(
    async () => session.stat('/music/missing.flac'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'notFound')
      return true
    }
  )
  await session.close()
})

test('webdav readStream streams file bytes with the configured auth', async () => {
  const session = await createWebDavAdapter().createSession(makeProfile(), {
    kind: 'password',
    username: 'alice',
    password: 's3cret'
  })
  const stream = await session.readStream('/music/a.flac')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
  await session.close()
})

test('webdav rejects wrong credentials with auth error', async () => {
  const session = await createWebDavAdapter().createSession(makeProfile(), {
    kind: 'password',
    username: 'alice',
    password: 'wrong'
  })
  await assert.rejects(
    async () => session.list('/music'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'auth')
      return true
    }
  )
  await session.close()
})

test('webdav readStream honors byte range resumes', async () => {
  const session = await createWebDavAdapter().createSession(makeProfile(), {
    kind: 'password',
    username: 'alice',
    password: 's3cret'
  })
  const stream = await session.readStream('/music/a.flac', undefined, { start: 4 })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES.subarray(4))
  await session.close()
})
