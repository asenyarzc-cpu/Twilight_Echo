import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { enrichNetworkEntry, saveEntryCover } from './networkMetadata.ts'
import type { NetworkSourceSession } from './adapters/types.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function syncsafe(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ])
}

function textFrame(id: string, text: string): Buffer {
  const data = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf8')])
  const header = Buffer.alloc(10)
  header.write(id, 0, 'ascii')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function apicFrame(): Buffer {
  const mime = Buffer.from('image/png\u0000', 'latin1')
  const data = Buffer.concat([Buffer.from([0]), mime, Buffer.from([3]), Buffer.from([0]), TINY_PNG])
  const header = Buffer.alloc(10)
  header.write('APIC', 0, 'ascii')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function makeTaggedMp3(): Buffer {
  const frames = Buffer.concat([
    textFrame('TIT2', 'Test Title'),
    textFrame('TPE1', 'Test Artist'),
    textFrame('TALB', 'Test Album'),
    apicFrame()
  ])
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([3, 0, 0]),
    syncsafe(frames.length)
  ])
  return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
}

const TAGGED_MP3 = makeTaggedMp3()

function makeEntry(name = 'tag.mp3', path = '/tag.mp3'): NetworkEntry {
  return {
    id: 'e1',
    profileId: 'p1',
    name,
    kind: 'audio',
    path,
    sizeBytes: TAGGED_MP3.length
  }
}

function sessionFor(bytes: Buffer): NetworkSourceSession {
  return {
    protocol: 'webdav',
    async list() {
      return []
    },
    async stat() {
      return null
    },
    async readStream() {
      return Readable.from([bytes])
    },
    async resolvePlaybackUrl() {
      return null
    },
    async close() {}
  }
}

test('enrichNetworkEntry extracts id3 tags and persists the embedded cover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'network-metadata-'))
  try {
    const cacheRoot = join(dir, 'cache')
    const coverRoot = join(dir, 'cover')
    const enriched = await enrichNetworkEntry({
      session: sessionFor(TAGGED_MP3),
      entry: makeEntry(),
      cacheRoot,
      coverCacheRoot: coverRoot
    })
    assert.equal(enriched.metadata?.title, 'Test Title')
    assert.equal(enriched.metadata?.artist, 'Test Artist')
    assert.equal(enriched.metadata?.album, 'Test Album')
    assert.ok(enriched.coverPath)
    const cover = await readFile(enriched.coverPath as string)
    assert.deepEqual(cover, TINY_PNG)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('enrichNetworkEntry leaves the entry unchanged when tags cannot be parsed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'network-metadata-'))
  try {
    const enriched = await enrichNetworkEntry({
      session: sessionFor(Buffer.from('not an audio file at all')),
      entry: makeEntry('broken.mp3', '/broken.mp3'),
      cacheRoot: join(dir, 'cache'),
      coverCacheRoot: join(dir, 'cover')
    })
    assert.equal(enriched.metadata, undefined)
    assert.equal(enriched.coverPath, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveEntryCover falls back to jpg and skips empty covers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'network-metadata-'))
  try {
    const coverRoot = join(dir, 'cover')
    const path = await saveEntryCover('e2', TINY_PNG, 'image/png', coverRoot)
    assert.match(path ?? '', /e2\.png$/)
    assert.equal(await saveEntryCover('e3', undefined, undefined, coverRoot), undefined)
    const fallback = await saveEntryCover('e4', TINY_PNG, undefined, coverRoot)
    assert.match(fallback ?? '', /e4\.jpg$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
