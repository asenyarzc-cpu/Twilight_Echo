import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Track } from '../types/music'
import {
  cachedSourceMatchesTrack,
  getTrackAudioSource,
  getTrackSource,
  hasAnalyzedBpm,
  isAnalyzableAudioPath,
  isLikelyLocalFilePath,
  isStreamLikeTrack,
  mergeTrackTransientData,
  nonEmptyString
} from './playerTrackUtils.ts'

function makeTrack(partial: Partial<Track> = {}): Track {
  return {
    id: 'ncm:1996755298',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    filePath: 'C:\\music\\track.flac',
    fileName: 'track.flac',
    duration: 240,
    size: 4096,
    cover: null,
    lyrics: null,
    ...partial
  }
}

test('getTrackSource uses explicit source and falls back to track id prefixes', () => {
  assert.equal(getTrackSource(makeTrack({ source: 'radio' })), 'radio')
  assert.equal(getTrackSource(makeTrack({ id: 'local:/music/a.flac' })), 'local')
  assert.equal(getTrackSource(makeTrack({ id: 'C:\\music\\a.flac' })), 'local')
  assert.equal(getTrackSource(makeTrack({ id: '/music/a.flac' })), 'local')
  assert.equal(getTrackSource(makeTrack({ id: 'ncm:1996755298' })), 'ncm')
  assert.equal(getTrackSource(makeTrack({ id: 'plain' })), 'local')
})

test('getTrackAudioSource prioritizes cue files, subtracks, stream urls, then file paths', () => {
  const cueRange = { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 }
  assert.equal(
    getTrackAudioSource(
      makeTrack({
        cueRange,
        filePath: 'C:\\album.cue',
        subTrack: 'C:\\track.flac',
        streamUrl: 'https://example.test/audio.flac'
      })
    ),
    'C:\\album.cue'
  )
  assert.equal(
    getTrackAudioSource(
      makeTrack({ subTrack: 'C:\\track.flac', streamUrl: 'https://example.test' })
    ),
    'C:\\track.flac'
  )
  assert.equal(
    getTrackAudioSource(makeTrack({ streamUrl: 'https://example.test/audio.flac' })),
    'https://example.test/audio.flac'
  )
  assert.equal(
    getTrackAudioSource(makeTrack({ filePath: 'C:\\music\\track.flac' })),
    'C:\\music\\track.flac'
  )
})

test('cachedSourceMatchesTrack matches numeric cache files to logical ids', () => {
  const track = makeTrack({ id: 'ncm:1996755298' })
  assert.equal(cachedSourceMatchesTrack(track, 'C:\\music-cache\\ncm-cache\\1996755298.flac'), true)
  assert.equal(cachedSourceMatchesTrack(track, 'C:/music-cache/ncm-cache/1996755298.m4a'), true)
  assert.equal(
    cachedSourceMatchesTrack(makeTrack({ id: '1996755298' }), 'cache/1996755298.flac'),
    true
  )
  assert.equal(cachedSourceMatchesTrack(track, 'C:\\music-cache\\1996755298.foo'), true)
  assert.equal(cachedSourceMatchesTrack(track, 'C:\\music-cache\\1996755299.flac'), false)
  assert.equal(cachedSourceMatchesTrack(track, 'C:\\music-cache\\album.flac'), false)
})

test('nonEmptyString trims strings and rejects other values', () => {
  assert.equal(nonEmptyString('  value  '), 'value')
  assert.equal(nonEmptyString('   '), null)
  assert.equal(nonEmptyString(''), null)
  assert.equal(nonEmptyString(12), null)
  assert.equal(nonEmptyString(null), null)
  assert.equal(nonEmptyString(undefined), null)
})

test('isLikelyLocalFilePath identifies local paths and rejects URI schemes', () => {
  assert.equal(isLikelyLocalFilePath('C:\\Music\\track.flac'), true)
  assert.equal(isLikelyLocalFilePath('D:/Music/track.flac'), true)
  assert.equal(isLikelyLocalFilePath('/Music/track.flac'), true)
  assert.equal(isLikelyLocalFilePath('Music/track.flac'), true)
  assert.equal(isLikelyLocalFilePath('https://example.test/track.flac'), false)
  assert.equal(isLikelyLocalFilePath('twilight-media://audio/token'), false)
  assert.equal(isLikelyLocalFilePath('blob:track'), false)
  assert.equal(isLikelyLocalFilePath(''), false)
})

test('hasAnalyzedBpm only accepts finite positive analyzed bpm values', () => {
  assert.equal(
    hasAnalyzedBpm(makeTrack({ bpmAnalysis: { bpm: 120, confidence: 1 } as Track['bpmAnalysis'] })),
    true
  )
  assert.equal(
    hasAnalyzedBpm(makeTrack({ bpmAnalysis: { bpm: 0, confidence: 1 } as Track['bpmAnalysis'] })),
    false
  )
  assert.equal(
    hasAnalyzedBpm(
      makeTrack({ bpmAnalysis: { bpm: Number.NaN, confidence: 1 } as Track['bpmAnalysis'] })
    ),
    false
  )
  assert.equal(
    hasAnalyzedBpm(makeTrack({ bpmAnalysis: { bpm: -1, confidence: 1 } as Track['bpmAnalysis'] })),
    false
  )
  assert.equal(hasAnalyzedBpm(makeTrack()), false)
})

test('isAnalyzableAudioPath accepts local paths and rejects remote URLs', () => {
  assert.equal(isAnalyzableAudioPath('C:\\music\\track.flac'), true)
  assert.equal(isAnalyzableAudioPath('/music/track.flac'), true)
  assert.equal(isAnalyzableAudioPath('music/track.flac'), true)
  assert.equal(isAnalyzableAudioPath('https://example.test/track.flac'), false)
  assert.equal(isAnalyzableAudioPath('http://example.test/track.flac'), false)
  assert.equal(isAnalyzableAudioPath('twilight-media://audio/token'), false)
  assert.equal(isAnalyzableAudioPath(''), false)
  assert.equal(isAnalyzableAudioPath(undefined), false)
})

test('mergeTrackTransientData preserves previous lyrics for the same track id', () => {
  const current = makeTrack({ id: 'same', lyrics: null, translatedLyrics: null })
  const previous = makeTrack({
    id: 'same',
    lyrics: 'Previous lyrics',
    translatedLyrics: 'Previous translation'
  })
  const merged = mergeTrackTransientData(current, previous)
  assert.equal(merged.lyrics, 'Previous lyrics')
  assert.equal(merged.translatedLyrics, 'Previous translation')

  const currentWithLyrics = makeTrack({
    id: 'same',
    lyrics: 'Current lyrics',
    translatedLyrics: 'Current translation'
  })
  assert.equal(mergeTrackTransientData(currentWithLyrics, previous), currentWithLyrics)
})

test('mergeTrackTransientData does not inherit lyrics from a different track id', () => {
  const current = makeTrack({ id: 'current', lyrics: null, translatedLyrics: null })
  const previous = makeTrack({
    id: 'previous',
    lyrics: 'Previous lyrics',
    translatedLyrics: 'Previous translation'
  })
  assert.equal(mergeTrackTransientData(current, previous), current)
  assert.equal(mergeTrackTransientData(current, null), current)
})

test('isStreamLikeTrack identifies radio, podcast, and http stream tracks', () => {
  assert.equal(isStreamLikeTrack(makeTrack({ source: 'radio' })), true)
  assert.equal(isStreamLikeTrack(makeTrack({ source: 'podcast' })), true)
  assert.equal(isStreamLikeTrack(makeTrack({ filePath: 'https://example.test/live.flac' })), true)
  assert.equal(isStreamLikeTrack(makeTrack({ streamUrl: 'http://example.test/live.flac' })), true)
  assert.equal(
    isStreamLikeTrack(makeTrack({ source: 'ncm', streamUrl: 'https://example.test' })),
    true
  )
  assert.equal(isStreamLikeTrack(makeTrack()), false)
  assert.equal(isStreamLikeTrack(null), false)
  assert.equal(isStreamLikeTrack(undefined), false)
})
