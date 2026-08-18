import { readAppSettings } from './settings'
import type { AppSettings } from './types'
import type { DesktopLyricsTrackPayload } from '../../shared/lyricsManagement.ts'
import type { BrowserWindow, Tray } from 'electron'
import type { AudioEngineManager, PlaybackInfo } from '../audioEngineManager'
import type { AudioAnalysisServiceClient } from '../audioAnalysisServiceClient.ts'
import type { LocalLibraryIndexCoordinator } from '../library/libraryIndexCoordinator.ts'
import type { LocalLibraryScanServiceClient } from '../library/libraryScanServiceClient.ts'
import type { OpraCatalog } from '../opraCatalog'
import type { TwilightPluginManager } from '../plugins/manager'
import type { ProviderDownloadManager } from '../plugins/providerDownloadManager.ts'
import type { PluginIndexService } from '../plugins/indexService'
import type { BpmAnalysisManager } from '../bpm/bpmAnalysisManager'
import type { LoudnessAnalysisManager } from '../audio/loudnessAnalysisManager'
import type { DspAssetLibrary } from '../dsp/dspAssetLibrary.ts'
import type { Vst3CatalogService } from '../dsp/vst3Catalog.ts'
import type DiscordRPC from 'discord-rpc'
import type { MiniPlayerStateSnapshot } from '../../shared/miniPlayer'
import type { TrayNavigationTarget } from '../../shared/trayPlayer.ts'

export interface DiscordActivityData {
  title: string
  artist: string
  album?: string
  playing: boolean
  startTime?: number
}

export const runtime = {
  appSettings: readAppSettings(),
  launchSettings: {} as AppSettings,
  pluginManager: null as TwilightPluginManager | null,
  pluginManagerReady: null as Promise<void> | null,
  providerDownloadManager: null as ProviderDownloadManager | null,
  pluginIndexService: null as PluginIndexService | null,
  opraCatalog: null as OpraCatalog | null,
  audioEngineManager: null as AudioEngineManager | null,
  audioAnalysisService: null as AudioAnalysisServiceClient | null,
  localLibraryScanService: null as LocalLibraryScanServiceClient | null,
  localLibraryIndexCoordinator: null as LocalLibraryIndexCoordinator | null,
  dspAssetLibrary: null as DspAssetLibrary | null,
  vst3Catalog: null as Vst3CatalogService | null,
  bpmAnalysisManager: null as BpmAnalysisManager | null,
  loudnessAnalysisManager: null as LoudnessAnalysisManager | null,
  mainWindow: null as BrowserWindow | null,
  miniPlayerWindow: null as BrowserWindow | null,
  trayPlayerWindow: null as BrowserWindow | null,
  pendingTrayNavigation: null as TrayNavigationTarget | null,
  latestMiniPlayerState: null as MiniPlayerStateSnapshot | null,
  desktopLyricsWindow: null as BrowserWindow | null,
  latestDesktopLyricsTrack: null as DesktopLyricsTrackPayload | null,
  latestDesktopLyricsTime: 0,
  ncmServer: null as import('http').Server | null,
  ncmServerPromise: null as Promise<void> | null,
  tray: null as Tray | null,
  refreshTrayMenu: null as (() => void) | null,
  forceQuit: false,
  closingAfterPlaybackSessionSave: false,
  savingPlaybackSessionBeforeClose: false,
  lastPluginPlaybackInfo: null as PlaybackInfo | null,
  discordClient: null as DiscordRPC.Client | null,
  discordConnected: false,
  discordConnectAttempted: false,
  discordLastError: null as string | null,
  discordReconnectTimer: null as NodeJS.Timeout | null,
  lastDiscordActivity: null as DiscordActivityData | null,
  coversMissingNotified: false,
  libraryWatcherDebounceMs: 2000,
  refreshSmtcButtons: null as (() => void) | null
}
