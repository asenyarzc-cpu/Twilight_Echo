import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCueRange } from '../shared/cue.ts'

function readPreloadSources(): string {
  const root = new URL('../preload/', import.meta.url)
  return [
    'index.ts',
    'types.ts',
    'index.d.ts',
    'sleepTimerEvents.ts',
    'domains/dataApi.ts',
    'domains/audioEngineApi.ts',
    'domains/desktopLyricsApi.ts',
    'domains/libraryApi.ts',
    'domains/mediaSubscriptionsApi.ts',
    'domains/networkSourcesApi.ts',
    'domains/settingsApi.ts',
    'domains/themesApi.ts',
    'domains/pluginsApi.ts',
    'domains/systemApi.ts',
    'domains/versionedData.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, root), 'utf8'))
    .join('\n')
}

const source = readFileSync(new URL('./audio/engineIpc.ts', import.meta.url), 'utf8')
const preloadSource = readPreloadSources()
const preloadTypes = readFileSync(new URL('../preload/types.ts', import.meta.url), 'utf8')
const preloadDeclaration = readFileSync(new URL('../preload/index.d.ts', import.meta.url), 'utf8')
const deviceHotplugSource = readFileSync(
  new URL('./audio/deviceHotplug.ts', import.meta.url),
  'utf8'
)
const windowSource = readFileSync(new URL('./app/window.ts', import.meta.url), 'utf8')

test('audioEngine loadQueue IPC accepts renderer queue items with source field', () => {
  const start = source.indexOf('function toQueueItem')
  const end = source.indexOf('ipcMain.handle(IPC.audioEngine.loadQueue', start)
  assert.notEqual(start, -1, 'toQueueItem should exist')
  assert.notEqual(end, -1, 'audioEngine:loadQueue handler should exist')
  const toQueueItem = source.slice(start, end)

  assert.match(toQueueItem, /typeof item\.source === 'string'/)
  assert.match(toQueueItem, /source: normalizedSource,\s*\n\s*title:/)
  assert.match(toQueueItem, /normalizeIpcString\(source, 'queue item source'/)
  assert.equal(
    /typeof item\.filePath === 'string'[\s\S]*typeof item\.source === 'string'/.test(toQueueItem),
    false,
    'source must be checked before filePath because renderer queue items no longer include filePath'
  )
})

test('audio engine cold start passes persisted software volume into the manager', () => {
  assert.match(source, /volume: runtime\.appSettings\.softwareVolume/)
})

test('audioEngine IPC normalizes untrusted renderer parameters', () => {
  assert.match(source, /const MAX_AUDIO_QUEUE_ITEMS = 5000/)
  assert.match(
    source,
    /normalizeIpcArray\(items, 'audio queue', MAX_AUDIO_QUEUE_ITEMS, toQueueItem\)/
  )
  assert.match(source, /queue\.length !== items\.length/)
  assert.match(source, /source: await resolveAuthorizedPlaybackSource\(item\.source\)/)
  assert.match(source, /normalizeIpcString\(source, 'audio source'/)
  assert.match(source, /await resolveAuthorizedPlaybackSource\(/)
  assert.match(source, /normalizeFiniteNumber\(time, 'seek time', 0, 0, Number\.MAX_SAFE_INTEGER\)/)
  assert.match(source, /normalizeFiniteNumber\(volume, 'volume', 1, 0, 1\)/)
  assert.match(source, /normalizeInteger\(points, 'spectrum points', 128, 8, 4096\)/)
  assert.match(
    source,
    /const cueRange = item\.cueRange === undefined \? undefined : normalizeCueRange\(item\.cueRange\)/
  )
  assert.match(source, /if \(cueRange === null\) return null/)
  assert.deepEqual(normalizeCueRange({ startSeconds: 10, endSeconds: 20 }), {
    startSeconds: 10,
    endSeconds: 20,
    pregapSeconds: 0,
    virtualPregapSeconds: 0,
    sourcePregapSeconds: 0
  })
  assert.equal(normalizeCueRange({ startSeconds: 20, endSeconds: 10 }), null)
  assert.equal(normalizeCueRange({ startSeconds: 0, endSeconds: 10, pregapSeconds: -1 }), null)
})

test('config-applied crosses the manager, IPC, and preload boundary', () => {
  assert.match(source, /audioEngineManager\.on\('config-applied'/)
  assert.match(source, /webContents\.send\(IPC\.audioEngine\.configApplied, event\)/)
  assert.match(preloadSource, /ipcRenderer\.on\(IPC\.audioEngine\.configApplied/)
  assert.match(preloadSource, /audioEngineConfigAppliedCallbacks/)
  assert.match(preloadSource, /onConfigApplied:/)

  for (const declaration of [preloadTypes, preloadDeclaration]) {
    assert.match(declaration, /AudioEngineConfigAppliedEvent/)
    assert.match(declaration, /requestedConfigRevision: number/)
    assert.match(declaration, /appliedConfigRevision: number/)
  }
  assert.match(preloadDeclaration, /onConfigApplied:/)
})

test('offline analysis is routed away from the playback audio service', () => {
  const managerSource = readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  const typesSource = readFileSync(new URL('./audio/audioEngineTypes.ts', import.meta.url), 'utf8')
  const serviceClientSource = readFileSync(
    new URL('./audioEngineServiceClient.ts', import.meta.url),
    'utf8'
  )
  const analysisClientSource = readFileSync(
    new URL('./audioAnalysisServiceClient.ts', import.meta.url),
    'utf8'
  )
  const nativeHeaderSource = readFileSync(
    new URL('../../audio-engine/include/twilight_audio_engine.h', import.meta.url),
    'utf8'
  )
  const nativeBridgeSource = readFileSync(
    new URL('../../audio-engine/napi/twilight_audio_node.cpp', import.meta.url),
    'utf8'
  )

  assert.match(typesSource, /AnalyzeBpm\?: \(source: string, optionsJson\?: string\)/)
  assert.match(managerSource, /async analyzeBpm\(/)
  assert.doesNotMatch(managerSource, /audioServiceBinding\.callAsync\?\.\('AnalyzeBpm'/)
  assert.match(serviceClientSource, /must use the isolated audio analysis service/)
  assert.match(analysisClientSource, /class AudioAnalysisServiceClient/)
  assert.match(analysisClientSource, /maxConcurrency/)
  assert.match(analysisClientSource, /maxQueueSize/)
  assert.match(nativeHeaderSource, /TAE_AnalyzeBpm/)
  assert.match(nativeBridgeSource, /define\(env, exports, "AnalyzeBpm", AnalyzeBpm\)/)
})

test('main window installs Windows audio device hotplug watcher', () => {
  assert.match(deviceHotplugSource, /const WM_DEVICECHANGE = 0x0219/)
  assert.match(deviceHotplugSource, /process\.platform !== 'win32'/)
  assert.match(deviceHotplugSource, /win\.hookWindowMessage\(WM_DEVICECHANGE/)
  assert.match(deviceHotplugSource, /AUDIO_DEVICE_CHANGE_DEBOUNCE_MS = 250/)
  assert.match(
    deviceHotplugSource,
    /notifyAudioDeviceOptionsChanged\(\s*'platform-device-change:wm-devicechange'\s*\)/
  )
  assert.match(windowSource, /installAudioDeviceHotplugWatcher\(runtime\.mainWindow\)/)
})

test('audio hotplug watcher listens for ALSA hw device node changes on Linux', () => {
  assert.match(deviceHotplugSource, /const ALSA_DEVICE_DIR = '\/dev\/snd'/)
  assert.match(deviceHotplugSource, /const ALSA_DEVICE_WATCH_RETRY_MS = 5000/)
  assert.match(deviceHotplugSource, /process\.platform === 'linux'/)
  assert.match(deviceHotplugSource, /installAlsaDeviceHotplugWatcher\(\)/)
  assert.match(deviceHotplugSource, /watch\(ALSA_DEVICE_DIR, \{ persistent: false \}/)
  assert.match(deviceHotplugSource, /scheduleAlsaDeviceWatchRetry\(\)/)
  assert.match(deviceHotplugSource, /watcher\.on\('error'/)
  assert.match(deviceHotplugSource, /watcher\.on\('close'/)
  assert.match(deviceHotplugSource, /alsaWatchRetryTimer\.unref\?\.\(\)/)
  assert.match(
    deviceHotplugSource,
    /notifyAudioDeviceOptionsChanged\(\s*'platform-device-change:alsa-dev-snd'\s*\)/
  )
})
