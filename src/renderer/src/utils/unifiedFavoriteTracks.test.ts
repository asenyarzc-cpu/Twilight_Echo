import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'

const { resolveUnifiedFavoriteTracks, summarizeUnifiedFavorites } = (await import(
  new URL('./unifiedFavoriteTracks.ts', import.meta.url).href
)) as typeof import('./unifiedFavoriteTracks')

const localFavorite: Track = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Local Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: 'local-cover.jpg',
  lyrics: null,
  source: 'local',
  format: 'flac'
}

const providerFavorite: Track = {
  id: 'ncm:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Online Album',
  filePath: 'ncm:moon',
  fileName: 'Moon River',
  duration: 180,
  size: 0,
  cover: 'provider-cover.jpg',
  coverSource: 'https://music.example/provider-cover.jpg',
  lyrics: null,
  source: 'ncm'
}

test('unified favorites prefer the local default favorite playlist when it has tracks', () => {
  const result = resolveUnifiedFavoriteTracks({
    unifiedTracks: [localFavorite],
    providerTracks: [providerFavorite]
  })

  assert.equal(result.source, 'unified')
  assert.deepEqual(
    result.tracks.map((track) => track.id),
    ['local:moon']
  )
})

test('unified favorites fall back to provider favorites when the default playlist is empty', () => {
  const result = resolveUnifiedFavoriteTracks({
    unifiedTracks: [],
    providerTracks: [providerFavorite]
  })

  assert.equal(result.source, 'provider')
  assert.deepEqual(
    result.tracks.map((track) => track.id),
    ['ncm:moon']
  )
})

test('unified favorite summary uses the first available cover and unified count', () => {
  const summary = summarizeUnifiedFavorites({
    unifiedTracks: [{ ...localFavorite, cover: null }, providerFavorite],
    providerSummary: {
      name: 'Provider Likes',
      trackCount: 8,
      cover: 'provider-list-cover.jpg'
    }
  })

  assert.deepEqual(summary, {
    name: '我收藏的歌曲',
    trackCount: 2,
    cover: 'provider-cover.jpg',
    coverSource: 'https://music.example/provider-cover.jpg'
  })
})
