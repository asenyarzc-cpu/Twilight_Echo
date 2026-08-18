import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamingArtistCandidate } from './streamingArtistResolution.ts'

const {
  findBestStreamingArtistMatch,
  getPrimaryStreamingArtistName,
  normalizeStreamingArtistName,
  resolveLinkedStreamingArtist
} = (await import(
  new URL('./streamingArtistResolution.ts', import.meta.url).href
)) as typeof import('./streamingArtistResolution')

test('resolves the primary artist from provider multi-artist labels', () => {
  assert.equal(getPrimaryStreamingArtistName('Artist A / Artist B'), 'Artist A')
  assert.equal(getPrimaryStreamingArtistName(' AC/DC '), 'AC/DC')
  assert.equal(getPrimaryStreamingArtistName(''), '')
})

test('normalizes artist names for exact linked-user matching', () => {
  assert.equal(normalizeStreamingArtistName(' 沙包 -- '), '沙包--')
  assert.equal(normalizeStreamingArtistName('Om  Chincholkar'), 'omchincholkar')
})

test('uses exact artist name matches and rejects unrelated search fallbacks', () => {
  const artists = [
    { id: 1, name: 'Om Chincholkar', picUrl: null },
    { id: 2, name: '沙包--', picUrl: 'artist.png' }
  ]

  assert.equal(findBestStreamingArtistMatch('沙包--', artists)?.id, 2)
  assert.equal(findBestStreamingArtistMatch('unknown', artists), null)
  assert.equal(
    findBestStreamingArtistMatch('躺在7FIV6怀里', [
      { id: 3, name: '在你怀里的桃花', picUrl: null }
    ]),
    null
  )
})

test('linked musician users resolve to matched artist ids before content fetches', async () => {
  const initialArtist = { id: 123456, name: '沙包--', picUrl: 'user.png' }
  const resolved = await resolveLinkedStreamingArtist(
    initialArtist,
    { name: '沙包--' },
    (async (): Promise<StreamingArtistCandidate | null> => ({
      id: 987,
      name: '沙包--',
      picUrl: null
    }))
  )

  assert.deepEqual(resolved, { id: 987, name: '沙包--', picUrl: 'user.png' })
})

test('linked musician users keep the initial user id only when no artist match exists', async () => {
  const initialArtist = { id: 123456, name: '沙包--', picUrl: 'user.png' }
  const resolved = await resolveLinkedStreamingArtist(
    initialArtist,
    { name: '沙包--' },
    async () => null
  )

  assert.equal(resolved.id, 123456)
})

test('linked musician users are not replaced by the first unrelated search result', async () => {
  const initialArtist = { id: 123456, name: '躺在7FIV6怀里', picUrl: 'user.png' }
  const resolved = await resolveLinkedStreamingArtist(
    initialArtist,
    { name: '躺在7FIV6怀里' },
    async () =>
      findBestStreamingArtistMatch('躺在7FIV6怀里', [
        { id: 987, name: '在你怀里的桃花', picUrl: 'wrong.png' }
      ])
  )

  assert.deepEqual(resolved, initialArtist)
})
