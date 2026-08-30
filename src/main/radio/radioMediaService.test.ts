import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { RadioMediaService } = (await import(
  new URL('./radioMediaService.ts', import.meta.url).href
)) as typeof import('./radioMediaService')
const { PersistentDataRevisionConflictError } = (await import(
  new URL('../../shared/versionedPersistence.ts', import.meta.url).href
)) as typeof import('../../shared/versionedPersistence')

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>CAS Cast</title>
<item>
  <title>Ep</title>
  <guid>g1</guid>
  <enclosure url="https://cdn.example.com/e.mp3" type="audio/mpeg"/>
  <itunes:duration xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">120</itunes:duration>
</item>
</channel></rss>`

test('radio media service persists stations with CAS revisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-radio-'))
  try {
    const service = new RadioMediaService({
      userDataPath: dir,
      now: () => '2026-07-20T00:00:00.000Z'
    })
    const loaded = await service.loadRadioStations()
    assert.equal(loaded.revision, 0)
    const station = service.createStationInput({
      name: 'Jazz',
      streamUrl: 'https://stream.example/jazz'
    })
    const saved = await service.saveRadioStations(
      { schemaVersion: 1, stations: [station] },
      loaded.revision
    )
    assert.equal(saved.revision, 1)
    assert.equal(saved.data.stations[0].name, 'Jazz')
    await assert.rejects(
      () => service.saveRadioStations({ schemaVersion: 1, stations: [station] }, loaded.revision),
      (error: unknown) => error instanceof PersistentDataRevisionConflictError
    )
    assert.throws(
      () =>
        service.createStationInput({
          name: 'HTTP',
          streamUrl: 'http://stream.example/live'
        }),
      /allowInsecureHttp/
    )
    const httpStation = service.createStationInput({
      name: 'HTTP',
      streamUrl: 'http://stream.example/live',
      allowInsecureHttp: true
    })
    assert.equal(httpStation.allowInsecureHttp, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('radio media service imports playlist and subscribes podcast feeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-podcast-'))
  try {
    const service = new RadioMediaService({
      userDataPath: dir,
      now: () => '2026-07-20T00:00:00.000Z',
      fetchText: async () => RSS
    })
    const imported = service.importPlaylistEntries(
      `#EXTM3U\n#EXTINF:-1,A\nhttps://a.example/s\n#EXTINF:-1,B\nhttp://b.example/s\n`,
      { allowInsecureHttp: false }
    )
    assert.equal(imported.length, 1)
    assert.equal(imported[0].name, 'A')

    const result = await service.subscribePodcast('https://example.com/feed.xml')
    assert.equal(result.revision, 1)
    assert.equal(result.subscription.title, 'CAS Cast')
    assert.equal(result.subscription.episodes[0].mediaUrl, 'https://cdn.example.com/e.mp3')

    await assert.rejects(
      () => service.subscribePodcast('https://example.com/feed.xml'),
      /already subscribed/
    )

    const resolved = await service.resolveSubscribedEpisode(
      result.subscription.id,
      result.subscription.episodes[0].guid
    )
    assert.equal(resolved.episode.mediaUrl, 'https://cdn.example.com/e.mp3')
    assert.equal(resolved.trackId, `podcast:${result.subscription.id}:g1`)
    await assert.rejects(
      () => service.resolveSubscribedEpisode(result.subscription.id, 'missing-guid'),
      /not found/
    )
    await assert.rejects(() => service.resolveSubscribedEpisode('missing-sub', 'g1'), /not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('podcast refresh runs concurrently, isolates failures, and saves once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-radio-refresh-'))
  let active = 0
  let peak = 0
  const requests: string[] = []
  try {
    const service = new RadioMediaService({
      userDataPath: dir,
      now: () => `2026-07-20T00:00:0${requests.length % 10}.000Z`,
      fetchFeed: async (url) => {
        requests.push(url)
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        if (url.endsWith('broken.xml')) throw new Error('feed unavailable')
        if (url.endsWith('unchanged.xml')) {
          return { body: '', status: 304, etag: '"same"', lastModified: null }
        }
        return {
          body: RSS,
          status: 200,
          etag: '"changed"',
          lastModified: 'Tue, 21 Jul 2026 00:00:00 GMT'
        }
      }
    })
    const subscription = (feedUrl: string, etag?: string) => ({
      id: `podcast_${feedUrl.slice(-6)}`,
      feedUrl,
      title: feedUrl,
      episodes: [],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      feedEtag: etag ?? null,
      feedLastModified: null
    })
    await service.savePodcastSubscriptions(
      {
        schemaVersion: 1,
        subscriptions: [
          subscription('https://example.com/first.xml'),
          subscription('https://example.com/broken.xml'),
          subscription('https://example.com/unchanged.xml', '"same"')
        ]
      },
      0
    )

    const refreshed = await service.refreshAllSubscriptions()

    assert.equal(peak, 3)
    assert.equal(requests.length, 3)
    assert.equal(refreshed.subscriptions[0].title, 'CAS Cast')
    assert.equal(refreshed.subscriptions[0].feedEtag, '"changed"')
    assert.match(refreshed.subscriptions[1].lastError ?? '', /feed unavailable/)
    assert.equal(refreshed.subscriptions[2].lastError, null)
    assert.deepEqual(
      refreshed.subscriptions.map((item) => item.feedUrl),
      [
        'https://example.com/first.xml',
        'https://example.com/broken.xml',
        'https://example.com/unchanged.xml'
      ]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
