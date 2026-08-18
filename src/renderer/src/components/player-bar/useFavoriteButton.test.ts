import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useFavoriteButton } from './useFavoriteButton.ts'
import type { Track } from '../../types/music.ts'

const localTrack: Track = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Breakfast',
  duration: 180,
  filePath: 'D:/Music/Moon River.flac',
  fileName: 'Moon River.flac',
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local'
}

const ncmTrack: Track = {
  ...localTrack,
  id: 'ncm:123',
  filePath: 'ncm:123',
  source: 'ncm',
  ncmSongId: 123
}

function createButton(options: {
  track: Track
  provider?: {
    likeTrack?: (trackId: string | number, like: boolean) => Promise<void>
    isTrackLiked?: (trackId: string | number | undefined) => boolean | Promise<boolean>
  }
  isFavorite?: boolean
  calls: string[]
}) {
  return useFavoriteButton({
    currentTrack: ref<Track | null>(options.track),
    playlists: ref([]),
    mediaProviders: {
      get: () => options.provider ?? null
    } as never,
    addToPlaylist: (playlistName, trackId) =>
      options.calls.push(`legacy-add:${playlistName}:${trackId}`),
    removeFromPlaylist: (playlistName, trackId) =>
      options.calls.push(`legacy-remove:${playlistName}:${trackId}`),
    createPlaylist: (name) => options.calls.push(`legacy-create:${name}`),
    isFavoriteTrack: () => options.isFavorite === true,
    addFavoriteTrack: (track) => options.calls.push(`local-add:${track.id}`),
    removeFavoriteTrack: (track) => options.calls.push(`local-remove:${track.id}`)
  })
}

async function settleFavoriteState(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('favorite button keeps local tracks in the local default favorites', async () => {
  const calls: string[] = []
  const button = createButton({ track: localTrack, calls })

  assert.equal(button.favoriteButtonVisible.value, true)
  assert.equal(button.favoriteButtonLiked.value, false)

  await button.toggleFavorite()

  assert.deepEqual(calls, ['local-add:local:moon'])
})

test('favorite button routes NetEase tracks to the NetEase provider instead of local favorites', async () => {
  const calls: string[] = []
  const button = createButton({
    track: ncmTrack,
    calls,
    provider: {
      isTrackLiked: () => false,
      likeTrack: async (trackId, like): Promise<void> => {
        calls.push(`ncm:${trackId}:${like}`)
      }
    }
  })
  await settleFavoriteState()

  assert.equal(button.favoriteButtonVisible.value, true)
  assert.equal(button.favoriteButtonLiked.value, false)

  await button.toggleFavorite()

  assert.equal(button.favoriteButtonLiked.value, true)
  assert.deepEqual(calls, ['ncm:123:true'])
})

test('a pending provider state read cannot overwrite a completed favorite toggle', async () => {
  const calls: string[] = []
  let resolveLiked: ((liked: boolean) => void) | undefined
  const button = createButton({
    track: ncmTrack,
    calls,
    provider: {
      isTrackLiked: () =>
        new Promise<boolean>((resolve) => {
          resolveLiked = resolve
        }),
      likeTrack: async (trackId, like): Promise<void> => {
        calls.push(`ncm:${trackId}:${like}`)
      }
    }
  })
  await settleFavoriteState()

  await button.toggleFavorite()
  resolveLiked?.(false)
  await settleFavoriteState()

  assert.equal(button.favoriteButtonLiked.value, true)
  assert.deepEqual(calls, ['ncm:123:true'])
})

test('favorite button removes liked NetEase tracks through the provider', async () => {
  const calls: string[] = []
  const button = createButton({
    track: ncmTrack,
    calls,
    isFavorite: true,
    provider: {
      isTrackLiked: () => true,
      likeTrack: async (trackId, like): Promise<void> => {
        calls.push(`ncm:${trackId}:${like}`)
      }
    }
  })
  await settleFavoriteState()

  assert.equal(button.favoriteButtonLiked.value, true)

  await button.toggleFavorite()

  assert.equal(button.favoriteButtonLiked.value, false)
  assert.deepEqual(calls, ['ncm:123:false'])
})

test('favorite button routes third-party streaming tracks to their provider', async () => {
  const calls: string[] = []
  const biliTrack: Track = {
    ...localTrack,
    id: 'bili:BV1xx:1',
    filePath: 'bili:BV1xx:1',
    source: 'bili',
    ncmSongId: undefined
  }
  const button = createButton({
    track: biliTrack,
    calls,
    provider: {
      isTrackLiked: () => false,
      likeTrack: async (trackId, like): Promise<void> => {
        calls.push(`bili:${trackId}:${like}`)
      }
    }
  })
  await settleFavoriteState()

  assert.equal(button.favoriteButtonVisible.value, true)

  await button.toggleFavorite()

  assert.deepEqual(calls, ['bili:BV1xx:1:true'])
})

test('favorite button is hidden for streaming providers without remote favorite support', async () => {
  const calls: string[] = []
  const button = createButton({
    track: ncmTrack,
    calls,
    provider: {}
  })
  await settleFavoriteState()

  assert.equal(button.favoriteButtonVisible.value, false)

  await button.toggleFavorite()

  assert.deepEqual(calls, [])
})
