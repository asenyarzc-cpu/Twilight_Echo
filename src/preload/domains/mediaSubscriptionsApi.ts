import { ipcRenderer } from 'electron'
import type { VersionedDataEnvelope } from '../types'
import {
  isRadioStationsDocument,
  type RadioStation,
  type RadioStationsDocument
} from '../../shared/radioStations.ts'
import {
  isPodcastSubscriptionsDocument,
  type PodcastSubscription,
  type PodcastSubscriptionsDocument
} from '../../shared/podcastSubscriptions.ts'
import { invokeVersionedDataWrite } from './versionedData.ts'

export const mediaSubscriptionsApi = {
  radio: {
    loadStations: (): Promise<VersionedDataEnvelope<RadioStationsDocument>> =>
      ipcRenderer.invoke('radio:loadStations'),
    saveStations: (
      document: RadioStationsDocument,
      expectedRevision: number
    ): Promise<VersionedDataEnvelope<RadioStationsDocument>> =>
      invokeVersionedDataWrite(
        'radio:saveStations',
        [document, expectedRevision],
        isRadioStationsDocument
      ),
    importPlaylist: (payload: {
      text: string
      fileNameHint?: string
      allowInsecureHttp?: boolean
    }): Promise<RadioStation[]> => ipcRenderer.invoke('radio:importPlaylist', payload),
    searchDirectory: (payload: {
      query: string
      limit?: number
      offset?: number
    }): Promise<
      Array<{
        stationuuid: string
        name: string
        url: string
        urlResolved: string
        homepage?: string
        favicon?: string
        tags: string[]
        countryCode?: string
        bitrate?: number
        codec?: string
        votes?: number
      }>
    > => ipcRenderer.invoke('radio:searchDirectory', payload)
  },
  podcast: {
    loadSubscriptions: (): Promise<VersionedDataEnvelope<PodcastSubscriptionsDocument>> =>
      ipcRenderer.invoke('podcast:loadSubscriptions'),
    saveSubscriptions: (
      document: PodcastSubscriptionsDocument,
      expectedRevision: number
    ): Promise<VersionedDataEnvelope<PodcastSubscriptionsDocument>> =>
      invokeVersionedDataWrite(
        'podcast:saveSubscriptions',
        [document, expectedRevision],
        isPodcastSubscriptionsDocument
      ),
    subscribe: (
      feedUrl: string
    ): Promise<{
      subscription: PodcastSubscription
      document: PodcastSubscriptionsDocument
      revision: number
    }> => ipcRenderer.invoke('podcast:subscribe', feedUrl),
    refresh: (
      subscriptionId: string
    ): Promise<{
      subscription: PodcastSubscription
      document: PodcastSubscriptionsDocument
      revision: number
    }> => ipcRenderer.invoke('podcast:refresh', subscriptionId),
    refreshAll: (): Promise<PodcastSubscriptionsDocument> =>
      ipcRenderer.invoke('podcast:refreshAll')
  }
}
