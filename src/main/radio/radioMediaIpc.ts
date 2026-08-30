import { ipcMain } from 'electron'
import { isRadioStationsDocument, type RadioStationsDocument } from '../../shared/radioStations.ts'
import {
  isPodcastSubscriptionsDocument,
  type PodcastSubscriptionsDocument
} from '../../shared/podcastSubscriptions.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { normalizeIpcString, stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import {
  PersistentDataRevisionConflictError,
  createPersistentDataRevisionConflictResponse
} from '../../shared/versionedPersistence.ts'
import { searchRadioBrowserStations } from './radioBrowserClient.ts'
import { RadioMediaService } from './radioMediaService.ts'

const MAX_RADIO_STATIONS_BYTES = 4 * 1024 * 1024
const MAX_PODCAST_SUBSCRIPTIONS_BYTES = 16 * 1024 * 1024
const MAX_PLAYLIST_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_FEED_URL_LENGTH = 2048

let service: RadioMediaService | null = null

export function setupRadioMediaIpc(
  options?: ConstructorParameters<typeof RadioMediaService>[0]
): RadioMediaService {
  if (service) return service
  service = new RadioMediaService(options)
  service.startScheduledRefresh()

  ipcMain.handle('radio:loadStations', async (event) => {
    assertTrustedIpcSender(event, 'radio media IPC')
    return await service!.loadRadioStations()
  })

  ipcMain.handle(
    'radio:saveStations',
    async (event, document: RadioStationsDocument, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'radio media IPC')
      stringifyJsonForIpcStorage(document, 'radio stations', MAX_RADIO_STATIONS_BYTES)
      if (!isRadioStationsDocument(document)) {
        throw new Error('Radio stations have an invalid structure')
      }
      return await saveVersioned(service!.saveRadioStations(document, expectedRevision))
    }
  )

  ipcMain.handle(
    'radio:importPlaylist',
    async (
      event,
      payload: { text?: unknown; fileNameHint?: unknown; allowInsecureHttp?: unknown }
    ) => {
      assertTrustedIpcSender(event, 'radio media IPC')
      if (typeof payload?.text !== 'string') throw new Error('playlist text must be a string')
      if (Buffer.byteLength(payload.text, 'utf8') > MAX_PLAYLIST_IMPORT_BYTES) {
        throw new Error('playlist text is too large')
      }
      if (/\0/.test(payload.text)) throw new Error('playlist text contains invalid characters')
      const fileNameHint =
        typeof payload?.fileNameHint === 'string' ? payload.fileNameHint.slice(0, 255) : ''
      const allowInsecureHttp = payload?.allowInsecureHttp === true
      return service!.importPlaylistEntries(payload.text, { fileNameHint, allowInsecureHttp })
    }
  )

  ipcMain.handle(
    'radio:searchDirectory',
    async (event, payload: { query?: unknown; limit?: unknown; offset?: unknown }) => {
      assertTrustedIpcSender(event, 'radio media IPC')
      const query =
        typeof payload?.query === 'string'
          ? payload.query
          : normalizeIpcString(payload?.query, 'radio directory query', 120)
      const limit =
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? Math.floor(payload.limit)
          : undefined
      const offset =
        typeof payload?.offset === 'number' && Number.isFinite(payload.offset)
          ? Math.floor(payload.offset)
          : undefined
      return await searchRadioBrowserStations({ query, limit, offset })
    }
  )

  ipcMain.handle('podcast:loadSubscriptions', async (event) => {
    assertTrustedIpcSender(event, 'radio media IPC')
    return await service!.loadPodcastSubscriptions()
  })

  ipcMain.handle(
    'podcast:saveSubscriptions',
    async (event, document: PodcastSubscriptionsDocument, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'radio media IPC')
      stringifyJsonForIpcStorage(document, 'podcast subscriptions', MAX_PODCAST_SUBSCRIPTIONS_BYTES)
      if (!isPodcastSubscriptionsDocument(document)) {
        throw new Error('Podcast subscriptions have an invalid structure')
      }
      return await saveVersioned(service!.savePodcastSubscriptions(document, expectedRevision))
    }
  )

  ipcMain.handle('podcast:subscribe', async (event, feedUrl: unknown) => {
    assertTrustedIpcSender(event, 'radio media IPC')
    const url = normalizeIpcString(feedUrl, 'podcast feed URL', MAX_FEED_URL_LENGTH)
    return await service!.subscribePodcast(url)
  })

  ipcMain.handle('podcast:refresh', async (event, subscriptionId: unknown) => {
    assertTrustedIpcSender(event, 'radio media IPC')
    const id = normalizeIpcString(subscriptionId, 'podcast subscription id', 128)
    return await service!.refreshSubscription(id)
  })

  ipcMain.handle('podcast:refreshAll', async (event) => {
    assertTrustedIpcSender(event, 'radio media IPC')
    return await service!.refreshAllSubscriptions()
  })

  return service
}

export function destroyRadioMediaIpc(): void {
  service?.stopScheduledRefresh()
  service = null
}

async function saveVersioned<T>(
  promise: Promise<T>
): Promise<T | ReturnType<typeof createPersistentDataRevisionConflictResponse>> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof PersistentDataRevisionConflictError) {
      return createPersistentDataRevisionConflictResponse(error)
    }
    throw error
  }
}
