import type {
  LocalLibraryMutationFailure,
  LocalLibraryRemoveResult
} from '../../../../shared/localLibrary.ts'
import type { Track } from '../../types/music.ts'
import { getProviderLocalId, type MediaProviderRegistry } from '../../providers/mediaProvider.ts'
import { getTrackSource } from '../../utils/logicalTrackModel.ts'

export interface StreamingBatchRemovalDependencies {
  removeLocalTracks: (tracks: Track[], mode: 'library') => Promise<LocalLibraryRemoveResult>
  removeProviderTrack: (track: Track) => Promise<void> | void
}

export interface StreamingBatchRemovalResult {
  removedTrackIds: string[]
  failures: LocalLibraryMutationFailure[]
}

export interface StreamingProviderFavoriteRemovalDependencies {
  providers: Pick<MediaProviderRegistry, 'getForTrack'>
  removeNcmFavorite: (songId: number) => Promise<void>
  removeSnapshotFavorite: (track: Track) => void
}

export async function executeStreamingBatchRemoval(
  selectedTracks: Track[],
  dependencies: StreamingBatchRemovalDependencies
): Promise<StreamingBatchRemovalResult> {
  const localTracks: Track[] = []
  const providerTracks: Track[] = []
  for (const track of selectedTracks) {
    if (getTrackSource(track) === 'local') localTracks.push(track)
    else providerTracks.push(track)
  }

  const removedTrackIds: string[] = []
  const failures: LocalLibraryMutationFailure[] = []
  if (localTracks.length > 0) {
    try {
      const result = await dependencies.removeLocalTracks(localTracks, 'library')
      removedTrackIds.push(...result.removedTrackIds)
      failures.push(...result.failures)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(...localTracks.map((track) => ({ filePath: track.filePath, message })))
    }
  }

  for (const track of providerTracks) {
    try {
      await dependencies.removeProviderTrack(track)
      removedTrackIds.push(track.id)
    } catch (error) {
      failures.push({
        filePath: track.filePath,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { removedTrackIds, failures }
}

export async function removeStreamingProviderFavorite(
  track: Track,
  dependencies: StreamingProviderFavoriteRemovalDependencies
): Promise<void> {
  const provider = dependencies.providers.getForTrack(track)
  if (provider?.likeTrack) {
    const providerTrackId =
      provider.id === 'ncm' && track.ncmSongId != null
        ? track.ncmSongId
        : (getProviderLocalId(track.id, provider.id) ?? track.id)
    await provider.likeTrack(providerTrackId, false)
    dependencies.removeSnapshotFavorite(track)
    return
  }
  if (track.ncmSongId != null) {
    await dependencies.removeNcmFavorite(track.ncmSongId)
    dependencies.removeSnapshotFavorite(track)
    return
  }
  throw new Error(`Provider ${provider?.id ?? getTrackSource(track)} does not support unfavorite`)
}
