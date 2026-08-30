import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDlnaAdapter, type DlnaTransport } from './dlnaAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const DESC_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>Test Media Server</friendlyName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <controlURL>/upnp/control/content_directory</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

function didl(result: string): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<Result>${result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</Result>
</u:BrowseResponse>
</s:Body>
</s:Envelope>`
}

const DIRECT_CHILDREN = didl(
  `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<container id="1" parentID="0" restricted="1"><dc:title>Music</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>
<item id="2" parentID="0" restricted="1"><dc:title>Song</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res>http://127.0.0.1:9000/music/a.flac</res></item>
</DIDL-Lite>`
)

const METADATA = didl(
  `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<item id="2" parentID="0" restricted="1"><dc:title>Song</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res>http://127.0.0.1:9000/music/a.flac</res></item>
</DIDL-Lite>`
)

const FLAC_BYTES = Buffer.from('DLNA-DATA')

function makeProfile(overrides: Partial<NetworkSourceProfile> = {}): NetworkSourceProfile {
  return {
    id: 'dlna1',
    protocol: 'dlna',
    name: 'DLNA Server',
    host: '127.0.0.1',
    port: 9000,
    rootPath: '/',
    credential: { kind: 'anonymous', encryptedId: '' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 30_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

function makeTransport(
  overrides: {
    browseDirectChildren?: string
    browseMetadata?: string
    authFail?: boolean
  } = {}
): DlnaTransport & { posts: Array<{ soapAction: string; body: string }> } {
  const posts: Array<{ soapAction: string; body: string }> = []
  const transport: DlnaTransport = {
    async get(_url) {
      if (overrides.authFail) return { status: 401, body: Buffer.from('unauthorized') }
      if (_url.includes('/rootDesc.xml') || _url === 'http://127.0.0.1:9000/') {
        return { status: 200, body: Buffer.from(DESC_XML) }
      }
      return { status: 200, body: FLAC_BYTES }
    },
    async post(_url, soapAction, body) {
      posts.push({ soapAction, body })
      if (overrides.authFail) return { status: 401, body: Buffer.from('unauthorized') }
      if (soapAction.includes('Browse') && body.includes('BrowseMetadata')) {
        return { status: 200, body: Buffer.from(overrides.browseMetadata ?? METADATA) }
      }
      return { status: 200, body: Buffer.from(overrides.browseDirectChildren ?? DIRECT_CHILDREN) }
    }
  }
  return Object.assign(transport, { posts })
}

test('dlna list browses ContentDirectory and maps containers and audio items', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const entries = await session.list('/')
  assert.equal(entries.length, 2)
  const music = entries.find((entry) => entry.name === 'Music')
  const song = entries.find((entry) => entry.name === 'Song')
  assert.ok(music)
  assert.ok(song)
  assert.equal(music.kind, 'directory')
  assert.equal(song.kind, 'audio')
  assert.equal(song.path, '/2')
  assert.match(transport.posts[0].soapAction, /ContentDirectory:1#Browse/)
  assert.ok(transport.posts[0].body.includes('BrowseDirectChildren'))
  assert.ok(transport.posts[0].body.includes('ObjectID'))
  await session.close()
})

test('dlna resolvePlaybackUrl returns the item res url via BrowseMetadata', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const url = await session.resolvePlaybackUrl('/2')
  assert.equal(url, 'http://127.0.0.1:9000/music/a.flac')
  assert.ok(transport.posts[0].body.includes('BrowseMetadata'))
  await session.close()
})

test('dlna readStream downloads the item res url', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const stream = await session.readStream('/2')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
  await session.close()
})

test('dlna surfaces device description failures as network errors', async () => {
  const adapter = createDlnaAdapter({
    transport: makeTransport({ authFail: true }),
    descriptionPaths: ['/rootDesc.xml']
  })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  await assert.rejects(
    async () => session.list('/'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'network')
      return true
    }
  )
})

test('dlna transport readStream returns a stream from the body buffer', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const stream = await session.readStream('/2')
  assert.ok(stream instanceof Readable)
  await session.close()
})
