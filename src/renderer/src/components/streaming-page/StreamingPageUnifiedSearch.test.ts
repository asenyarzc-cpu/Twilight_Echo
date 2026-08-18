import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileStyle } from '@vue/compiler-sfc'
import type { LocalLibraryRemoveResult } from '../../../../shared/localLibrary.ts'
import type { Track } from '../../types/music.ts'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../StreamingHome.vue', import.meta.url), 'utf8')
const { executeStreamingBatchRemoval, removeStreamingProviderFavorite } = (await import(
  new URL('./streamingBatchRemoval.ts', import.meta.url).href
)) as typeof import('./streamingBatchRemoval.ts')
const { MediaProviderRegistry } = (await import(
  new URL('../../providers/mediaProvider.ts', import.meta.url).href
)) as typeof import('../../providers/mediaProvider.ts')

test('streaming page renders NetEase cloud as a dedicated sidebar surface', () => {
  assert.match(source, /import NcmCloudPanel from '\.\/NcmCloudPanel\.vue'/)
  assert.match(source, /activeTab === 'cloud'/)
  assert.match(source, /<NcmCloudPanel[\s\S]*@download="startCloudDownload"/)
  assert.match(source, /if \(item\.tab === 'cloud'\) \{\s*clearSearch\(\)/)
  assert.doesNotMatch(source, /<StreamingLibrary[\s\S]*:show-ncm-cloud=/)
})

test('streaming page exposes unified song search beyond the NetEase-only surface', () => {
  assert.match(source, /useMediaProviders\(\)/)
  assert.match(source, /mediaProviders\.searchAllSongs\(\{/)
  assert.match(source, /localTracks: musicStore\.tracks\.value/)
  assert.match(source, /searchUnifiedSongs/)
  assert.match(source, /const showUnifiedSearch = computed/)
  assert.doesNotMatch(source, /const showNcmSearch = computed/)
})

test('streaming detail, social, and HiFi surfaces compile working dark-theme selectors', () => {
  const detailStyles = readFileSync(new URL('./StreamingDetailStage.css', import.meta.url), 'utf8')
  const socialStyles = readFileSync(new URL('./StreamingSocialStage.css', import.meta.url), 'utf8')
  const hifiSource = readFileSync(new URL('../player-bar/HiFiSidebar.css', import.meta.url), 'utf8')

  const detailCode = compileStyle({
    source: detailStyles,
    filename: 'StreamingDetailStage.css',
    id: 'data-v-streaming-detail-dark',
    scoped: true
  }).code
  const socialCode = compileStyle({
    source: socialStyles,
    filename: 'StreamingSocialStage.css',
    id: 'data-v-streaming-social-dark',
    scoped: true
  }).code
  const hifiCode = compileStyle({
    source: hifiSource,
    filename: 'HiFiSidebar.css',
    id: 'data-v-hifi-dark',
    scoped: true
  }).code

  assert.match(
    detailCode,
    /html\[data-theme=['"]dark['"]\] \.detail-stage\[[^\]]+\]\s*\{[^}]*--stage-paper-raised:\s*#1c1917/
  )
  assert.match(
    socialCode,
    /html\[data-theme=['"]dark['"]\] \.social-stage \.stage-person-card\[[^\]]+\]:hover/
  )
  assert.match(hifiCode, /html\[data-theme=['"]dark['"]\] \.deck\[[^\]]+\]\s*\{[^}]*--d-card:/)
  assert.match(hifiCode, /html\[data-theme=['"]dark['"]\] \.deck \.deck-display\[[^\]]+\]/)
  assert.doesNotMatch(
    [detailCode, socialCode, hifiCode].join('\n'),
    /html\[data-theme=['"]dark['"]\]\s*\{[^}]*(?:--stage-paper-raised|--d-card):/
  )
})

test('streaming page resolves player-bar artist requests through the track provider', () => {
  assert.match(source, /artistNavigationRequest\?: StreamingArtistNavigationRequest \| null/)
  assert.match(source, /mediaProviders\.searchArtists\(providerId, artistName, 8, 0\)/)
  assert.match(source, /findBestStreamingArtistMatch\(artistName, result\.items\)/)
  assert.match(source, /provider\.fetchArtistTopSongs\(artist\.id\)/)
  assert.match(
    source,
    /if \(isExternalActive\.value\)[\s\S]*provider\.fetchArtistTopSongs\(artist\.id\)/
  )
  assert.doesNotMatch(
    source,
    /if \(provider === NCM_PROVIDER_ID\) \{\s*fallbackProvider\.value = null/
  )
})

test('streaming page keeps third-party providers on the generic provider library surface', () => {
  assert.doesNotMatch(source, /import BilibiliPage/)
  assert.doesNotMatch(source, /<BilibiliPage/)
  assert.doesNotMatch(source, /showBilibiliView/)
  assert.doesNotMatch(source, /shouldShowBilibiliViewForSidebarProvider/)
  assert.doesNotMatch(source, /activeProvider\.value === 'bili'/)
  assert.doesNotMatch(source, /bilibili\.setPinnedFavoriteFolder/)
})

test('recent playback detail uses local unified listening history before provider recent APIs', () => {
  assert.match(source, /getRecentTracks\(\)/)
  assert.match(source, /resolveUnifiedRecentTracks\(\{/)
  assert.match(source, /recentStats/)
  assert.match(source, /localTracks: musicStore\.tracks\.value/)
  assert.doesNotMatch(source, /const tracks = await fetchRecentSongs\(\)/)
})

test('ranking detail uses cross-source listening stats before provider play records', () => {
  assert.match(source, /getTopTracks\(\)/)
  assert.match(source, /topStats/)
  assert.match(source, /resolveUnifiedRecentTracks\(\{/)
  assert.doesNotMatch(source, /const tracks = await fetchPlayRecords\(1\)/)
})

test('liked detail loads provider cloud likes instead of local default favorites', () => {
  assert.match(source, /fetchLikedTracksPage\(0, LIKED_TRACKS_PAGE_SIZE, force\)/)
  assert.match(source, /NCM: always load cloud liked tracks/)
  assert.match(source, /must not short-circuit the provider liked list/)
  assert.match(
    source,
    /const unifiedFavoriteTracks = computed\(\(\) => musicStore\.getPlaylistTracks\(/
  )
  // Local unified favorites are only a fallback for external providers without
  // their own liked playlist - never a short-circuit for NCM.
  assert.doesNotMatch(source, /resolveUnifiedFavoriteTracks\(\{/)
  assert.match(source, /if \(state\?\.likedPlaylist\) return providerSummary/)
})

test('liked playback resolves the complete provider list instead of queueing only the first page', () => {
  assert.match(source, /async function resolveDetailPlaybackQueue\(\): Promise<Track\[]>/)
  assert.match(source, /const tracks = await fetchLikedTracks\(\)/)
  assert.match(source, /async function playAllDetailTracks\(\): Promise<void>/)
  assert.match(source, /const tracks = await resolveDetailPlaybackQueue\(\)/)
  // 通过 playStreamingTrack 仍使用完整解析后的列表（同时携带心动模式上下文）。
  assert.match(source, /playStreamingTrack\(tracks\[0\], tracks\)/)
})

test('recommendations retry missing sections without letting populated FM block radar', () => {
  assert.match(source, /const needsDaily = dailySongs\.value\.length === 0/)
  assert.match(source, /const needsFm = personalFmSongs\.value\.length === 0/)
  assert.match(source, /const needsRadar = privateContentSongs\.value\.length === 0/)
  assert.match(source, /const needsPlaylists = recommendPlaylists\.value\.length === 0/)
  assert.match(source, /needsRadar \? fetchPrivateContent\(\)/)
})

test('private FM and radar use a session-fenced queue stream in shuffle mode', () => {
  assert.match(source, /const PERSONALIZED_STREAM_QUEUE_THRESHOLD = 6/)
  assert.match(source, /async function loadMorePersonalizedStream/)
  assert.match(source, /session: PersonalizedStreamSession \| null = null/)
  assert.match(source, /let additions = appendUniqueTracks\(current, incoming\)/)
  assert.match(source, /key === 'radar' && additions\.length === 0/)
  assert.match(source, /appendUniqueTracks\(current, await fetchPersonalFm\(\)\)/)
  assert.match(source, /if \(session\) appendPersonalizedStreamTracks\(session, additions\)/)
  assert.match(source, /playTrack\(track, trackQueue\)[\s\S]*startPersonalizedStream\(streamKey\)/)
  assert.match(source, /personalizedStreamRemaining/)
  assert.match(source, /personalizedStreamLoading\[session\.key\]/)
  assert.doesNotMatch(source, /queueLength - index > PERSONALIZED_STREAM_QUEUE_THRESHOLD/)
  assert.doesNotMatch(source, /activePersonalizedStreamKey/)
  assert.match(homeSource, /function playPersonalizedStream/)
  assert.match(homeSource, /@click="playPersonalizedStream\(fmSection\)"/)
  assert.match(homeSource, /@click="playPersonalizedStream\(radarSection\)"/)
  assert.doesNotMatch(homeSource, /@click="emit\('openRecSection', fmSection\)"/)
  assert.doesNotMatch(homeSource, /@click="emit\('openRecSection', radarSection\)"/)
})

test('streaming page stays mounted across local/streaming switches in one session', () => {
  const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
  assert.match(appSource, /const streamingPageMounted = ref\(false\)/)
  assert.match(appSource, /v-if="streamingPageMounted"/)
  assert.match(appSource, /v-show="showStreamingPage"/)
  assert.match(appSource, /:active="showStreamingPage"/)
  assert.match(source, /async function refreshStreamingSurface/)
  assert.match(source, /\(\) => props\.active/)
})

test('streaming page supports multi-select batch favorite and delete on track lists', () => {
  const searchSource = readFileSync(new URL('../StreamingSearch.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('./StreamingDetailStage.vue', import.meta.url), 'utf8')

  assert.match(source, /useTrackMultiSelect/)
  assert.match(source, /handleStreamingBatchFavorite/)
  assert.match(source, /handleStreamingBatchDelete/)
  assert.match(source, /handleStreamingBatchAddToPlaylist/)
  assert.match(source, /createNcmPlaylist/)
  assert.match(source, /removeNcmTracksFromPlaylist/)
  assert.match(source, /onStreamingTrackContextMenu/)
  assert.match(source, /streaming-context-menu/)
  assert.match(source, /添加到歌单/)
  assert.match(source, /onSearchTrackClickWithSelect/)
  const detailClickHandler = source.match(
    /function onTrackClick\([\s\S]*?\r?\n}\r?\n\r?\nfunction playDetailTrack/
  )
  const searchClickHandler = source.match(
    /function onSearchTrackClickWithSelect\([\s\S]*?\r?\n}\r?\n\r?\nasync function favoriteStreamingTracks/
  )
  assert.ok(detailClickHandler)
  assert.ok(searchClickHandler)
  assert.match(detailClickHandler[0], /trackActivationMode === 'doubleClick'\) return/)
  assert.doesNotMatch(detailClickHandler[0], /selectOnly\(/)
  assert.doesNotMatch(searchClickHandler[0], /selectOnly\(/)
  assert.match(source, /multiSelect\.shouldSuppressRowDoubleClick\(event\)/)
  assert.match(detailSource, /emit\('playTrack', track, index, event\)/)
  assert.match(searchSource, /batchFavorite/)
  assert.match(searchSource, /batchAddToPlaylist/)
  assert.match(searchSource, /trackContextMenu/)
  assert.match(searchSource, /track-selected/)
  assert.match(searchSource, /selection-toolbar/)
  assert.match(detailSource, /batchAddToPlaylist/)
  assert.match(detailSource, /trackContextMenu/)
  assert.match(detailSource, /从歌单移除/)
  assert.match(source, /executeStreamingBatchRemoval\(selected/)
  assert.doesNotMatch(source, /musicStore\.removeTrack\(track\.id\)/)
})

test('local-only streaming deletion uses one library removal transaction', async () => {
  const tracks = [createTrack('local:first', 'local'), createTrack('local:second', 'local')]
  const calls: Array<{ ids: string[]; mode: string }> = []
  const result = await executeStreamingBatchRemoval(tracks, {
    removeLocalTracks: async (selected, mode) => {
      calls.push({ ids: selected.map((track) => track.id), mode })
      return createLocalResult(
        selected,
        selected.map((track) => track.id)
      )
    },
    removeProviderTrack: async () => {
      throw new Error('provider removal must not run for local tracks')
    }
  })

  assert.deepEqual(calls, [{ ids: ['local:first', 'local:second'], mode: 'library' }])
  assert.deepEqual(result.removedTrackIds, ['local:first', 'local:second'])
  assert.deepEqual(result.failures, [])
})

test('mixed streaming deletion batches locals and keeps provider semantics separate', async () => {
  const local = createTrack('local:first', 'local')
  const failedLocal = createTrack('local:failed', 'local')
  const provider = createTrack('ncm:42', 'ncm')
  const localCalls: string[][] = []
  const providerCalls: string[] = []

  const result = await executeStreamingBatchRemoval([local, provider, failedLocal], {
    removeLocalTracks: async (selected) => {
      localCalls.push(selected.map((track) => track.id))
      const response = createLocalResult(selected, [local.id])
      response.failures.push({ filePath: failedLocal.filePath, message: 'local failed' })
      return response
    },
    removeProviderTrack: async (track) => {
      providerCalls.push(track.id)
    }
  })

  assert.deepEqual(localCalls, [['local:first', 'local:failed']])
  assert.deepEqual(providerCalls, ['ncm:42'])
  assert.deepEqual(result.removedTrackIds, ['local:first', 'ncm:42'])
  assert.deepEqual(result.failures, [{ filePath: failedLocal.filePath, message: 'local failed' }])
})

test('external provider unfavorite still runs when the local removal phase rejects', async () => {
  const local = createTrack('local:first', 'local')
  const external = createTrack('bili:BV1xx', 'bili')
  const providerCalls: Array<{ id: string | number; like: boolean }> = []
  const registry = new MediaProviderRegistry()
  registry.register({
    id: 'bili',
    name: 'Bilibili',
    source: 'plugin',
    capabilities: ['library'],
    likeTrack: async (id, like) => {
      providerCalls.push({ id, like })
    }
  })
  const removedSnapshots: string[] = []

  const result = await executeStreamingBatchRemoval([local, external], {
    removeLocalTracks: async () => {
      throw new Error('local transaction failed')
    },
    removeProviderTrack: (track) =>
      removeStreamingProviderFavorite(track, {
        providers: registry,
        removeNcmFavorite: async () => {
          throw new Error('unexpected NCM fallback')
        },
        removeSnapshotFavorite: (removed) => removedSnapshots.push(removed.id)
      })
  })

  assert.deepEqual(providerCalls, [{ id: 'BV1xx', like: false }])
  assert.deepEqual(removedSnapshots, ['bili:BV1xx'])
  assert.deepEqual(result.removedTrackIds, ['bili:BV1xx'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].filePath, local.filePath)
})

test('local dashboard top tracks resolve logical stats to playable local variants', () => {
  const dashboardSource = readFileSync(new URL('../LocalDashboard.vue', import.meta.url), 'utf8')

  assert.match(
    dashboardSource,
    /import \{ createUnifiedRecentTrackResolver \} from '\.\.\/utils\/unifiedRecentTracks'/
  )
  assert.match(dashboardSource, /getMostListenedTracks\(TOP_TRACK_COUNT\)/)
  assert.match(dashboardSource, /createUnifiedRecentTrackResolver\(tracks\.value\)/)
  assert.doesNotMatch(dashboardSource, /recentStats: \[stat\]/)
  assert.doesNotMatch(dashboardSource, /Object\.entries\(listeningStats\.value\.tracks\)/)
  assert.doesNotMatch(dashboardSource, /track: byId\.get\(id\) \?\? stat\.track/)
})

function createTrack(id: string, source: string): Track {
  return {
    id,
    title: id,
    artist: 'Test Artist',
    album: 'Test Album',
    filePath: `C:\\Music\\${id.replace(':', '-')}.flac`,
    fileName: `${id}.flac`,
    duration: 120,
    size: 1,
    cover: null,
    lyrics: null,
    source
  }
}

function createLocalResult(tracks: Track[], removedTrackIds: string[]): LocalLibraryRemoveResult {
  const removed = new Set(removedTrackIds)
  const removedTracks = tracks.filter((track) => removed.has(track.id))
  return {
    mode: 'library',
    library: {
      version: 2,
      revision: 1,
      tracks: tracks.filter((track) => !removed.has(track.id)),
      folders: [],
      exclusions: removedTracks.map((track) => ({
        filePath: track.filePath,
        title: track.title,
        artist: track.artist,
        excludedAt: '2026-01-01T00:00:00.000Z'
      }))
    },
    removedTrackIds,
    removedFilePaths: removedTracks.map((track) => track.filePath),
    failures: []
  }
}
