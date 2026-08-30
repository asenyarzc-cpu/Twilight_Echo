import assert from 'node:assert/strict'
import test from 'node:test'
import type { StreamingArtistCandidate } from './streamingArtistResolution.ts'

const {
  findBestStreamingArtistMatch,
  findStreamingArtistById,
  getPrimaryStreamingArtistId,
  getPrimaryStreamingArtistName,
  matchStreamingArtistsByName,
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

test('primary artist id comes from the ref backing the displayed name', () => {
  const artists = [
    { id: 9001, name: '沙包--' },
    { id: 9002, name: 'Om Chincholkar' }
  ]

  assert.equal(getPrimaryStreamingArtistId('沙包-- / Om Chincholkar', artists), 9001)
  // 空格差异归一化后仍是同一位歌手。
  assert.equal(getPrimaryStreamingArtistId(' 沙包--  / Om Chincholkar ', artists), 9001)
  assert.equal(
    getPrimaryStreamingArtistId('沙包--', [{ id: 'ncm-9001', name: '沙包--' }]),
    'ncm-9001'
  )
  // refs 只覆盖首位歌手也够用——需要的就是首位那个 id。
  assert.equal(getPrimaryStreamingArtistId('沙包-- / Om Chincholkar', [artists[0]]), 9001)
})

test('primary artist id is withheld when the refs cannot back the displayed name', () => {
  const artists = [{ id: 9001, name: '沙包--' }]

  // 展示串与 refs 对不上（曲目被重新匹配过等）：回退名字搜索，绝不把 9001 安到别人身上。
  assert.equal(getPrimaryStreamingArtistId('在你怀里的桃花', artists), undefined)
  assert.equal(getPrimaryStreamingArtistId('Om Chincholkar / 沙包--', artists), undefined)
  // id 缺失的占位条目不能当作命中。
  assert.equal(getPrimaryStreamingArtistId('沙包--', [{ name: '沙包--' }]), undefined)
  assert.equal(getPrimaryStreamingArtistId('沙包--', []), undefined)
  assert.equal(getPrimaryStreamingArtistId('沙包--', undefined), undefined)
  assert.equal(getPrimaryStreamingArtistId('', artists), undefined)
})

test('every same-named artist surfaces so callers can disambiguate', () => {
  const artists = [
    { id: 1, name: '张三', picUrl: null },
    { id: 2, name: '张 三', picUrl: null },
    { id: 3, name: '李四', picUrl: null }
  ]

  assert.deepEqual(
    matchStreamingArtistsByName('张三', artists).map((item) => item.id),
    [1, 2]
  )
  assert.deepEqual(matchStreamingArtistsByName('', artists), [])
  assert.deepEqual(matchStreamingArtistsByName('王五', artists), [])
  // 取“最佳”仍是同名候选里的第一个——正因为这个选择可能错，才需要歌手 id。
  assert.equal(findBestStreamingArtistMatch('张三', artists)?.id, 1)
})

test('artist lookup by id never degrades into a name comparison', () => {
  const artists = [
    { id: 9001, name: '张三', picUrl: null },
    { id: 9002, name: '张三', picUrl: 'second.png' }
  ]

  assert.equal(findStreamingArtistById(9002, artists)?.picUrl, 'second.png')
  // provider id 在传输中可能变成字符串，比较前统一成字符串。
  assert.equal(findStreamingArtistById('9002', artists)?.picUrl, 'second.png')
  assert.equal(findStreamingArtistById(9003, artists), null)
  assert.equal(findStreamingArtistById(9001, []), null)
})

test('linked musician users resolve to matched artist ids before content fetches', async () => {
  const initialArtist = { id: 123456, name: '沙包--', picUrl: 'user.png' }
  const resolved = await resolveLinkedStreamingArtist(
    initialArtist,
    { name: '沙包--' },
    async (): Promise<StreamingArtistCandidate | null> => ({
      id: 987,
      name: '沙包--',
      picUrl: null
    })
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
