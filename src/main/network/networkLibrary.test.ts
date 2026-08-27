import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NetworkSourceFailure } from './errors.ts'
import { createNetworkLibrary } from './networkLibrary.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

function makeEntry(path: string, name?: string): NetworkEntry {
  return {
    id: `id:${path}`,
    profileId: 'p1',
    name: name ?? path.split('/').pop() ?? path,
    kind: 'audio',
    path,
    sizeBytes: 100
  }
}

async function makeLibrary() {
  const dir = await mkdtemp(join(tmpdir(), 'network-library-'))
  const library = createNetworkLibrary({ filePath: join(dir, 'library.json') })
  return { dir, library }
}

test('library persists scanned entries across reloads', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [makeEntry('/music/a.flac')])
    const reloaded = createNetworkLibrary({ filePath: join(dir, 'library.json') })
    const entries = await reloaded.listEntries('p1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, '/music/a.flac')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-scanning the same root replaces stale entries without duplicates', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [
      makeEntry('/music/a.flac'),
      makeEntry('/music/old.flac')
    ])
    await library.addEntries('p1', '/music', [
      makeEntry('/music/a.flac'),
      makeEntry('/music/b.flac')
    ])
    const entries = await library.listEntries('p1')
    assert.equal(entries.length, 2)
    assert.ok(entries.some((entry) => entry.path === '/music/a.flac'))
    assert.ok(entries.some((entry) => entry.path === '/music/b.flac'))
    assert.ok(!entries.some((entry) => entry.path === '/music/old.flac'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listEntries filters by query and removeEntry/removeProfile work', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [
      makeEntry('/music/beautiful.flac', 'beautiful.flac'),
      makeEntry('/music/rock.mp3', 'rock.mp3')
    ])
    assert.equal((await library.listEntries('p1', 'beaut')).length, 1)
    await library.removeEntry('p1', 'id:/music/beautiful.flac')
    assert.equal((await library.listEntries('p1')).length, 1)
    await library.removeProfile('p1')
    assert.equal((await library.listEntries('p1')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('updateEntries merges metadata onto existing entries by id', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await library.addEntries('p1', '/music', [makeEntry('/music/a.flac')])
    await library.updateEntries('p1', [
      {
        ...makeEntry('/music/a.flac'),
        metadata: { title: 'Song', artist: 'Artist', duration: 123.4 },
        coverPath: '/cache/a.jpg'
      }
    ])
    const entries = await library.listEntries('p1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].metadata?.title, 'Song')
    assert.equal(entries[0].metadata?.duration, 123.4)
    assert.equal(entries[0].coverPath, '/cache/a.jpg')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects an excessively nested network media-library document', async () => {
  const { dir, library } = await makeLibrary()
  try {
    await writeFile(
      join(dir, 'library.json'),
      JSON.stringify({
        p1: { roots: ['/music'], entries: [makeEntry('/music/a.flac')] },
        padding: deeplyNestedValue()
      }),
      'utf-8'
    )

    await assert.rejects(
      () => library.listEntries('p1'),
      (error: unknown) => error instanceof NetworkSourceFailure && error.code === 'network'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
