<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '@renderer/types/music'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { getRecentTracks } from '@renderer/stores/useListeningStatsStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { createUnifiedRecentTrackResolver } from '@renderer/utils/unifiedRecentTracks'
import {
  archivePlaybackQueue,
  buildArchiveLibrary
} from '@renderer/components/local-dashboard/archiveLibrary'
import NightHarborHome from '@renderer/components/local-dashboard/NightHarborHome.vue'

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()

const { tracks, albums, artists } = useMusicStore()
const { currentTrack, isPlaying, currentTime, duration, playTrack, togglePlay, setPlayMode, seek } =
  usePlayerStore()
const library = computed(() => buildArchiveLibrary(tracks.value))
const resolveRecentTrack = computed(() => createUnifiedRecentTrackResolver(tracks.value))
const recent = computed(() => {
  const result: Track[] = []
  const seen = new Set<string>()
  for (const stat of getRecentTracks(6)) {
    const track = resolveRecentTrack.value(stat)
    if (!track || seen.has(track.id)) continue
    seen.add(track.id)
    result.push(track)
  }
  return result
})
const hero = computed(
  () => currentTrack.value ?? recent.value[0] ?? library.value.recentlyAdded[0] ?? null
)
const heroIsCurrent = computed(
  () => !!currentTrack.value && hero.value?.id === currentTrack.value.id
)
const selectedAlbums = computed(() => albums.value.slice(0, 4))
const albumCards = computed(() =>
  selectedAlbums.value.map((album) => ({
    key: album.id ?? album.name,
    name: album.name,
    artist: album.artist || album.tracks[0]?.artist || '未知艺术家',
    cover: album.cover,
    coverSource: album.tracks[0]?.coverSource,
    identity: album.tracks[0]?.id,
    trackCount: album.trackCount
  }))
)
const summary = computed(() => ({
  tracks: tracks.value.length,
  albums: albums.value.length,
  artists: artists.value.length,
  hours: Math.round(library.value.totalSeconds / 3600)
}))

function play(track: Track): void {
  if (currentTrack.value?.id === track.id) {
    togglePlay()
    return
  }
  playTrack(track, archivePlaybackQueue(tracks.value, library.value.indexById, track))
}

function shuffle(): void {
  if (!tracks.value.length) return
  const track = tracks.value[Math.floor(Math.random() * tracks.value.length)]
  setPlayMode('shuffle')
  playTrack(track, archivePlaybackQueue(tracks.value, library.value.indexById, track))
}

function openAlbum(index: number): void {
  const album = selectedAlbums.value[index]
  if (album) emit('select-view', 'albums', album.id ?? album.name)
}

function seekHero(position: number): void {
  if (heroIsCurrent.value && duration.value > 0) seek(position)
}
</script>

<template>
  <NightHarborHome
    :summary="summary"
    :hero="hero"
    :recent="recent"
    :added="library.recentlyAdded"
    :albums="albumCards"
    :is-playing="isPlaying"
    :current-track-id="currentTrack?.id ?? null"
    :current-time="heroIsCurrent ? currentTime : 0"
    :duration="heroIsCurrent ? duration : 0"
    @play="play"
    @shuffle="shuffle"
    @seek="seekHero"
    @open-album="openAlbum"
    @select-view="(category, filter) => emit('select-view', category, filter)"
    @open-library-settings="emit('open-library-settings')"
  />
</template>
