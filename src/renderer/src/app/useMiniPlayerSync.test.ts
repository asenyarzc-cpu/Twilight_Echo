import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMiniPlayerStateSnapshot,
  findActiveMiniPlayerLyricIndex,
  resolveCurrentLyricForMiniPlayer
} from './useMiniPlayerSync.ts'
import type { Track } from '../types/music.ts'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'ncm:1',
    title: 'Daydream',
    artist: 'Twilight Echo',
    album: 'Afterglow',
    albumArtist: 'Twilight Echo',
    trackNumber: 7,
    fileName: 'daydream.mp3',
    filePath: 'ncm:1',
    duration: 240,
    size: 0,
    cover: null,
    format: 'FLAC',
    sampleRate: 192000,
    bitDepth: 24,
    lyrics: '[00:01.00]first line\n[00:03.00]second line',
    translatedLyrics: '[00:01.00]第一行\n[00:03.00]第二行',
    ...overrides
  }
}

function makeSource(track: Track | null, currentTime: number) {
  return {
    track,
    isPlaying: true,
    isLoading: false,
    currentTime,
    duration: 240,
    playbackRate: 1.25,
    volume: 0.7,
    playMode: 'sequential' as const,
    favoriteAvailable: false,
    favoriteLiked: false,
    favoriteLoading: false,
    dominantColor: '#7c4dff',
    queueIndex: 0,
    queueLength: 1
  }
}

test('mini player snapshot carries the lyric line active at the snapshot time', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 3.5))
  assert.equal(snapshot.currentLyric?.original, 'second line')
  assert.equal(snapshot.currentLyric?.translation, '第二行')
  assert.equal(snapshot.track?.format, 'FLAC')
  assert.equal(snapshot.track?.sampleRate, 192000)
  assert.equal(snapshot.track?.bitDepth, 24)
  assert.equal(snapshot.track?.albumArtist, 'Twilight Echo')
  assert.equal(snapshot.track?.trackNumber, 7)
  assert.equal(snapshot.playbackRate, 1.25)
})

test('mini player snapshot keeps quality fields null when the track has none', () => {
  const snapshot = buildMiniPlayerStateSnapshot(
    makeSource(makeTrack({ format: undefined, sampleRate: undefined, bitDepth: undefined }), 3.5)
  )
  assert.equal(snapshot.track?.format, null)
  assert.equal(snapshot.track?.sampleRate, null)
  assert.equal(snapshot.track?.bitDepth, null)
})

test('mini player lyric resolution returns null before the first timed line', () => {
  assert.equal(resolveCurrentLyricForMiniPlayer(makeTrack(), 0.5), null)
  assert.equal(resolveCurrentLyricForMiniPlayer(null, 10), null)
})

test('mini player lyric resolution ignores plain untimed lyrics', () => {
  const plain = makeTrack({ lyrics: 'Just a plain lyric line', translatedLyrics: '' })
  assert.equal(resolveCurrentLyricForMiniPlayer(plain, 10), null)
})

test('mini player snapshot drops the lyric field when no line is active', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 0.5))
  assert.equal(snapshot.currentLyric, null)
})

test('mini player snapshot carries timed lyric lines for the multi-line view', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 3.5))
  assert.deepEqual(snapshot.lyrics, [
    { time: 1, original: 'first line', translation: '第一行' },
    { time: 3, original: 'second line', translation: '第二行' }
  ])
})

test('mini player projects explicit duet markers to readable text without leaking metadata', () => {
  const duet = makeTrack({
    lyrics: [
      '[00:01.00][te:voice role=lead lane=start group=duet]First',
      '[00:01.00][te:voice role=lead lane=end group=duet]Second',
      '[00:01.20][te:voice role=harmony lane=end group=duet]Harmony'
    ].join('\n'),
    translatedLyrics: '[00:01.00]组合翻译'
  })
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(duet, 1.5))
  assert.equal(snapshot.lyrics[0]?.original, 'First · Second')
  assert.equal(snapshot.lyrics[0]?.translation, '组合翻译')
  assert.ok(!snapshot.lyrics[0]?.original.includes('[te:voice'))
})

test('mini player lyric lines ignore plain untimed lyrics', () => {
  const plain = makeTrack({ lyrics: 'Just a plain lyric line', translatedLyrics: '' })
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(plain, 10))
  assert.deepEqual(snapshot.lyrics, [])
})

test('mini player lyric index picks the latest line at or before current time', () => {
  const lines = [
    { time: 1, original: 'first', translation: null },
    { time: 3, original: 'second', translation: null },
    { time: 7.5, original: 'third', translation: null }
  ]
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 0.5), -1)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 1), 0)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 3.2), 1)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 7.5), 2)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 99), 2)
  assert.equal(findActiveMiniPlayerLyricIndex([], 5), -1)
})
