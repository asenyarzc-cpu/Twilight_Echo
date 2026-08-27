import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertOnlineLyricsRateLimit,
  clearOnlineLyricsCache,
  clearOnlineLyricsRateLimit,
  normalizeOnlineLyricsQuery,
  ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW,
  ONLINE_LYRICS_MIN_INTERVAL_MS,
  pickOnlineLyricsText,
  rankOnlineLyricsCandidates,
  searchOnlineLyrics
} from './onlineLyricsSearch.ts'

function makeOkSearchResponse(id = 9): Response {
  return new Response(
    JSON.stringify([
      {
        id,
        trackName: 'Night Drive',
        artistName: 'Echo',
        duration: 210,
        syncedLyrics: '[00:01.00]Hello',
        plainLyrics: null
      }
    ]),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

test.beforeEach(() => {
  clearOnlineLyricsCache()
  clearOnlineLyricsRateLimit()
})

test('rankOnlineLyricsCandidates prefers exact title/artist and close duration', () => {
  const ranked = rankOnlineLyricsCandidates(
    { title: 'Night Drive', artist: 'Echo', album: 'City', durationSeconds: 210 },
    [
      {
        id: 1,
        trackName: 'Night Drive',
        artistName: 'Echo',
        albumName: 'City',
        duration: 211,
        syncedLyrics: '[00:01.00]Go',
        plainLyrics: null
      },
      {
        id: 2,
        trackName: 'Night Drive Live',
        artistName: 'Echo Band',
        duration: 400,
        syncedLyrics: null,
        plainLyrics: 'Go'
      },
      {
        id: 3,
        trackName: 'Day Walk',
        artistName: 'Echo',
        duration: 210,
        syncedLyrics: '[00:01.00]Nope',
        plainLyrics: null
      }
    ]
  )

  assert.equal(ranked[0]?.id, 1)
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0))
  assert.equal(
    ranked.some((item) => item.id === 3),
    false
  )
})

test('normalizeOnlineLyricsQuery rejects incomplete input', () => {
  assert.throws(() => normalizeOnlineLyricsQuery({ title: 'Only' }), /title and artist/)
  assert.deepEqual(
    normalizeOnlineLyricsQuery({ title: ' A ', artist: ' B ', durationSeconds: 12.6 }),
    {
      title: 'A',
      artist: 'B',
      album: undefined,
      durationSeconds: 13
    }
  )
})

test('searchOnlineLyrics uses fetch and returns best candidate', async () => {
  const result = await searchOnlineLyrics(
    { title: 'Night Drive', artist: 'Echo', durationSeconds: 210 },
    {
      fetchImpl: async () => makeOkSearchResponse(9)
    }
  )
  assert.equal(result.candidates.length, 1)
  assert.equal(pickOnlineLyricsText(result.best), '[00:01.00]Hello')
})

test('searchOnlineLyrics cache hit avoids second fetch', async () => {
  let fetchCount = 0
  const fetchImpl: typeof fetch = async () => {
    fetchCount++
    return makeOkSearchResponse(11)
  }
  const query = { title: 'Night Drive', artist: 'Echo', album: 'City', durationSeconds: 210 }

  const first = await searchOnlineLyrics(query, { fetchImpl })
  const second = await searchOnlineLyrics(query, { fetchImpl })

  assert.equal(fetchCount, 1)
  assert.equal(first.best?.id, 11)
  assert.equal(second.best?.id, 11)
  assert.equal(pickOnlineLyricsText(second.best), '[00:01.00]Hello')
})

test('assertOnlineLyricsRateLimit enforces min interval', () => {
  assertOnlineLyricsRateLimit(1_000)
  assert.throws(
    () => assertOnlineLyricsRateLimit(1_000 + ONLINE_LYRICS_MIN_INTERVAL_MS - 1),
    /minimum 800ms between searches/
  )
  assert.doesNotThrow(() => assertOnlineLyricsRateLimit(1_000 + ONLINE_LYRICS_MIN_INTERVAL_MS))
})

test('assertOnlineLyricsRateLimit throws after burst window is full', () => {
  const start = 10_000
  for (let i = 0; i < ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW; i++) {
    assertOnlineLyricsRateLimit(start + i * ONLINE_LYRICS_MIN_INTERVAL_MS)
  }
  assert.throws(
    () =>
      assertOnlineLyricsRateLimit(
        start + ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW * ONLINE_LYRICS_MIN_INTERVAL_MS
      ),
    /max 20 requests per 60s/
  )
})
