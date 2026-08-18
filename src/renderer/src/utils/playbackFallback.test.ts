import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'

const { clampProviderReliability, findPlaybackFallbackTrack } = (await import(
  new URL('./playbackFallback.ts', import.meta.url).href
)) as typeof import('./playbackFallback')

function track(overrides: Partial<Track> & Pick<Track, 'id' | 'title' | 'artist'>): Track {
  return {
    album: 'Album',
    filePath: overrides.id,
    fileName: `${overrides.title}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    ...overrides
  }
}

test('selects the best local lossless variant when provider playback fails', () => {
  const failed = track({
    id: 'ncm:1',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'ncm',
    format: 'aac'
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    unavailableSources: ['ncm'],
    candidates: [
      failed,
      track({
        id: 'bili:BV1',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'bili',
        format: 'aac'
      }),
      track({
        id: 'local:mp3',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'local',
        format: 'mp3'
      }),
      track({
        id: 'local:flac',
        title: ' moon river ',
        artist: 'AUDREY',
        source: 'local',
        duration: 181,
        format: 'flac'
      })
    ]
  })

  assert.equal(fallback?.id, 'local:flac')
})

test('uses provider variants when a local file is unavailable', () => {
  const failed = track({
    id: 'local:missing',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'local',
    format: 'flac'
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    unavailableSources: ['local'],
    candidates: [
      failed,
      track({
        id: 'ncm:1',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'ncm',
        format: 'aac'
      }),
      track({
        id: 'bili:live',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'bili',
        duration: 260,
        format: 'aac'
      })
    ]
  })

  assert.equal(fallback?.id, 'ncm:1')
})

test('uses healthier provider variants when local playback is unavailable', () => {
  const failed = track({
    id: 'local:missing',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'local',
    format: 'flac'
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    unavailableSources: ['local'],
    sourceReliability: {
      aaunstable: 0.1,
      zzhealthy: 1
    },
    candidates: [
      failed,
      track({
        id: 'aaunstable:1',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'aaunstable',
        format: 'aac'
      }),
      track({
        id: 'zzhealthy:1',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'zzhealthy',
        format: 'aac'
      })
    ]
  })

  assert.equal(fallback?.id, 'zzhealthy:1')
})

test('keeps local lossless fallback ahead of healthier provider variants', () => {
  const failed = track({
    id: 'ncm:1',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'ncm',
    format: 'aac'
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    unavailableSources: ['ncm'],
    sourceReliability: {
      provider: 1,
      local: 0.2
    },
    candidates: [
      failed,
      track({
        id: 'provider:1',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'provider',
        format: 'aac'
      }),
      track({
        id: 'local:flac',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'local',
        format: 'flac'
      })
    ]
  })

  assert.equal(fallback?.id, 'local:flac')
})

test('does not fallback to a different performance with a far duration', () => {
  const failed = track({
    id: 'ncm:1',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'ncm',
    duration: 180
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    candidates: [
      track({
        id: 'bili:live',
        title: 'Moon River',
        artist: 'Audrey',
        source: 'bili',
        duration: 260
      })
    ]
  })

  assert.equal(fallback, null)
})

test('does not merge provider variants with incomplete logical identity', () => {
  const failed = track({
    id: 'ncm:missing-artist',
    title: 'Moon River',
    artist: '',
    source: 'ncm'
  })

  const fallback = findPlaybackFallbackTrack({
    failedTrack: failed,
    unavailableSources: ['ncm'],
    candidates: [
      track({
        id: 'bili:missing-artist',
        title: 'Moon River',
        artist: '',
        source: 'bili'
      })
    ]
  })

  assert.equal(fallback, null)
})

test('clampProviderReliability clamps finite values and defaults invalid values to 1', () => {
  assert.equal(clampProviderReliability(0.5), 0.5)
  assert.equal(clampProviderReliability(-1), 0)
  assert.equal(clampProviderReliability(2), 1)
  assert.equal(clampProviderReliability(Number.NaN), 1)
  assert.equal(clampProviderReliability(Number.POSITIVE_INFINITY), 1)
  assert.equal(clampProviderReliability(Number.NEGATIVE_INFINITY), 1)
  assert.equal(clampProviderReliability(undefined), 1)
})
