import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('actual renderer player store keeps lyric sources and playback position transitions authoritative', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-lyrics-player-runtime-'))
  try {
    const entryPath = join(directory, 'lyrics-player-runtime-entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'lyrics-player-runtime.html')
    const runnerPath = join(directory, 'lyrics-player-runtime-runner.cjs')
    await writeFile(entryPath, runtimeEntrySource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      resolve: { alias: { '@renderer': join(workspaceRoot, 'src/renderer/src') } },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'LyricsPlayerRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const bundleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(bundleName, 'Vite should bundle the real renderer player store')
    await writeFile(htmlPath, runtimeHtml(bundleName), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const electronEnvironment = { ...process.env }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      env: electronEnvironment,
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(stderr, /LYRICS_PLAYER_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /LYRICS_PLAYER_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

function runtimeEntrySource(): string {
  const playerStorePath = join(
    workspaceRoot,
    'src/renderer/src/stores/usePlayerStore.ts'
  ).replaceAll('\\', '/')
  const lyricsStorePath = join(
    workspaceRoot,
    'src/renderer/src/stores/lyricsManagement.ts'
  ).replaceAll('\\', '/')
  return `import { usePlayerStore } from ${JSON.stringify(playerStorePath)}
import { useLyricsManagement } from ${JSON.stringify(lyricsStorePath)}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}
let document = {
  schemaVersion: 1,
  globalOffsetMs: 0,
  showOriginal: true,
  showTranslation: true,
  showRomanization: false,
  tracks: {}
}
let revision = 1
let latestDesktopLyricsTrack = null
let deferProvider = false
let providerFailuresRemaining = 0
const deferredProviderResolvers = []
const deferredProviderStartWaiters = []
const waitForDeferredProviderStart = () =>
  new Promise((resolve) => deferredProviderStartWaiters.push(resolve))
const resolveDeferredProviders = () => {
  while (deferredProviderResolvers.length > 0) {
    deferredProviderResolvers.shift()({
      lyrics: '[00:01.00]Stale provider lyrics',
      translatedLyrics: '[00:01.00]Stale provider translation'
    })
  }
}

window.api = {
  ...window.api,
  desktopLyrics: {
    ...window.api.desktopLyrics,
    updateTrack: (snapshot) => {
      latestDesktopLyricsTrack = clone(snapshot)
    },
    updateTime: () => {},
    updateSettings: () => {},
    onToggle: () => () => {}
  },
  data: {
    getLyrics: async () => null,
    loadLyricsManagement: async () => ({ version: 2, revision, savedAt: '2026-07-18T00:00:00.000Z', data: clone(document) }),
    saveLyricsManagement: async (next, expectedRevision) => {
      expect(expectedRevision === revision, 'lyrics management CAS revision should be current')
      document = clone(next)
      revision += 1
      return { version: 2, revision, savedAt: '2026-07-18T00:00:01.000Z', data: clone(document) }
    }
  },
  providers: {
    list: async () => [{ id: 'fixture-provider', name: 'Fixture provider', capabilities: ['lyrics'], health: { available: true } }],
    call: async (_providerId, method) => {
      expect(method === 'getLyrics', 'forced resolver should request provider lyrics')
      if (providerFailuresRemaining > 0) {
        providerFailuresRemaining -= 1
        throw new Error('fixture lyrics provider unavailable')
      }
      if (deferProvider) {
        for (const resolve of deferredProviderStartWaiters.splice(0)) resolve()
        return await new Promise((resolve) => {
          deferredProviderResolvers.push(resolve)
        })
      }
      return { lyrics: '[00:01.00]Provider lyrics', translatedLyrics: '[00:01.00]Provider translation' }
    }
  }
}

const track = {
  id: 'fixture-provider:track-1',
  title: 'Provider fixture', artist: 'Twilight', album: 'Echo', filePath: '', fileName: '',
  duration: 180, size: 0, cover: null,
  lyrics: '[00:01.00]Automatic lyrics', translatedLyrics: '[00:01.00]Automatic translation',
  lyricsSource: 'embedded', translatedLyricsSource: 'embedded', source: 'fixture-provider'
}

const nextTrack = {
  ...track,
  id: 'fixture-provider:track-2',
  title: 'Next provider fixture',
  lyrics: '[00:01.00]Next lyrics',
  translatedLyrics: null
}

window.runLyricsPlayerRuntime = async () => {
  const player = usePlayerStore()
  const management = useLyricsManagement()
  player.currentTrack.value = clone(track)
  player.queue.value = [clone(track)]
  await management.ensureLoaded()
  await management.selectSource(track.id, 'provider')
  await player.refreshCurrentLyrics()
  expect(player.currentTrack.value.lyrics === '[00:01.00]Provider lyrics', 'forced Provider did not update actual current track')
  expect(
    player.lyricsLoadState.value.trackId === track.id && player.lyricsLoadState.value.status === 'ready',
    'completed provider lookup left lyrics in a loading state'
  )

  await management.selectSource(track.id, 'auto')
  await player.refreshCurrentLyrics()
  expect(player.currentTrack.value.lyrics === '[00:01.00]Automatic lyrics', 'Auto did not restore resolver baseline: ' + player.currentTrack.value.lyrics)
  expect(player.currentTrack.value.translatedLyrics === '[00:01.00]Automatic translation', 'Auto did not restore translated baseline: ' + player.currentTrack.value.translatedLyrics)

  deferProvider = true
  await management.selectSource(track.id, 'provider')
  const deferredProviderStarted = waitForDeferredProviderStart()
  const staleProviderRefresh = player.refreshCurrentLyrics()
  await deferredProviderStarted
  await management.selectSource(track.id, 'auto')
  await player.refreshCurrentLyrics()
  expect(player.currentTrack.value.lyrics === '[00:01.00]Automatic lyrics', 'Auto did not win while a forced Provider lookup was pending')
  deferProvider = false
  resolveDeferredProviders()
  await staleProviderRefresh
  expect(player.currentTrack.value.lyrics === '[00:01.00]Automatic lyrics', 'stale Provider result overwrote the newer Auto selection')

  const pendingTrack = {
    ...track,
    id: 'fixture-provider:pending-track',
    title: 'Pending provider fixture',
    lyrics: null,
    translatedLyrics: null,
    lyricsSource: null,
    translatedLyricsSource: null
  }
  const followingTrack = {
    ...pendingTrack,
    id: 'fixture-provider:following-track',
    title: 'Following provider fixture'
  }
  deferProvider = true
  const pendingProviderStarted = waitForDeferredProviderStart()
  player.currentTrack.value = clone(pendingTrack)
  player.queue.value = [clone(pendingTrack)]
  await pendingProviderStarted

  const followingProviderStarted = waitForDeferredProviderStart()
  player.currentTrack.value = clone(followingTrack)
  player.queue.value = [clone(followingTrack)]
  await followingProviderStarted
  deferProvider = false
  resolveDeferredProviders()
  await waitFor(
    () => player.lyricsLoadState.value.trackId === followingTrack.id && player.lyricsLoadState.value.status === 'ready',
    'following track lookup did not settle'
  )
  expect(
    player.currentTrack.value.id === followingTrack.id &&
      player.currentTrack.value.lyrics === '[00:01.00]Stale provider lyrics',
    'a pending previous-track lookup prevented the current track from fetching lyrics'
  )

  // Provider searches can legitimately take longer than the former four-second
  // UI timeout. Keep this request pending and accept its eventual result
  // instead of permanently committing an empty lyric record.
  const lateLyricsTrack = {
    ...pendingTrack,
    id: 'fixture-provider:late-lyrics-track',
    title: 'Late provider fixture'
  }
  deferProvider = true
  const lateProviderStarted = waitForDeferredProviderStart()
  player.currentTrack.value = clone(lateLyricsTrack)
  player.queue.value = [clone(lateLyricsTrack)]
  await lateProviderStarted
  await new Promise((resolve) => setTimeout(resolve, 4_250))
  expect(
    player.lyricsLoadState.value.trackId === lateLyricsTrack.id &&
      player.lyricsLoadState.value.status === 'loading',
    'a slow provider lookup was settled before it returned'
  )
  expect(
    player.currentTrack.value.lyrics == null,
    'a slow provider lookup permanently replaced pending lyrics with an empty value'
  )
  deferProvider = false
  resolveDeferredProviders()
  await waitFor(
    () =>
      player.lyricsLoadState.value.trackId === lateLyricsTrack.id &&
      player.lyricsLoadState.value.status === 'ready' &&
      player.currentTrack.value.lyrics === '[00:01.00]Stale provider lyrics',
    'a late provider result did not commit to the active track'
  )

  const failedLyricsTrack = {
    ...pendingTrack,
    id: 'fixture-provider:failed-track',
    title: 'Failed provider fixture'
  }
  providerFailuresRemaining = 1
  player.currentTrack.value = clone(failedLyricsTrack)
  player.queue.value = [clone(failedLyricsTrack)]
  await player.refreshCurrentLyrics()
  expect(
    player.lyricsLoadState.value.trackId === failedLyricsTrack.id &&
      player.lyricsLoadState.value.status === 'failed',
    'a provider failure was modeled as an empty completed lyric result'
  )
  expect(
    player.currentTrack.value.lyrics == null,
    'a provider failure replaced pending lyrics with an empty value'
  )
  await player.refreshCurrentLyrics()
  expect(
    player.currentTrack.value.lyrics === '[00:01.00]Provider lyrics',
    'lyrics did not recover after a provider retry'
  )

  const beforeCurrent = clone(player.currentTrack.value)
  const beforeQueue = clone(player.queue.value)
  await management.updateTrack(failedLyricsTrack.id, {
    source: 'manual',
    originalSelection: 'manual',
    translationSelection: 'manual',
    romanizationSelection: 'manual',
    original:
      '[00:03.00][te:voice role=lead lane=start speaker=Alice group=manual-duet]Manual original',
    translation: '[00:03.00]Manual translation',
    romanization: '[00:03.00]Manual romanization'
  })
  await player.refreshCurrentLyrics()
  await waitFor(
    () => latestDesktopLyricsTrack?.lyrics === '[00:03.00]Manual original',
    'managed manual lyrics did not refresh the desktop snapshot'
  )
  expect(JSON.stringify(player.currentTrack.value) === JSON.stringify(beforeCurrent), 'manual original mutated current track')
  expect(JSON.stringify(player.queue.value) === JSON.stringify(beforeQueue), 'manual romanization mutated queue')
  expect(management.entryFor(failedLyricsTrack.id).romanization === '[00:03.00]Manual romanization', 'manual romanization was not persisted')
  expect(latestDesktopLyricsTrack.translatedLyrics === '[00:03.00]Manual translation', 'desktop lyrics kept the stale automatic translation')
  expect(latestDesktopLyricsTrack.lyricsSource === 'manual', 'desktop lyrics did not expose the manual source')
  expect(latestDesktopLyricsTrack.translatedLyricsSource === 'manual', 'desktop translation did not expose the manual source')
  expect(!latestDesktopLyricsTrack.lyrics.includes('[te:voice'), 'desktop lyrics leaked an internal voice tag')

  player.currentTrack.value = clone(track)
  player.queue.value = [clone(track), clone(nextTrack)]
  player.queueIndex.value = 0
  window.__audioFixture.emitPlaybackInfo({
    state: 'playing', position: 0, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  await Promise.resolve()
  expect(player.currentTrack.value.id === nextTrack.id, 'native next did not switch the active track')
  expect(player.currentTime.value === 0, 'native next did not reset progress')

  player.currentTrack.value = clone(track)
  player.queue.value = [clone(track), clone(nextTrack)]
  player.queueIndex.value = 0
  window.__audioFixture.playbackInfo = {
    state: 'playing', position: 179, duration: 180, source: track.id,
    queueIndex: 0, nativePlaybackActive: true, volume: 1, playbackRate: 1
  }
  window.__audioFixture.emitStartFile()
  await new Promise((resolve) => setTimeout(resolve, 100))
  window.__audioFixture.playbackInfo = {
    state: 'playing', position: 0.25, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(player.currentTrack.value.id === nextTrack.id, 'start-file retry did not recover the next track identity')
  expect(player.currentTime.value < 2, 'start-file retry did not reset the progress clock for the next track')

  const stalledLyricsTrack = {
    ...track,
    id: 'fixture-provider:track-3',
    lyrics: null,
    translatedLyrics: null
  }
  deferProvider = true
  const stalledLyricsStarted = waitForDeferredProviderStart()
  player.currentTrack.value = clone(stalledLyricsTrack)
  player.queue.value = [clone(stalledLyricsTrack)]
  player.queueIndex.value = 0
  window.__audioFixture.playbackInfo = {
    state: 'playing', position: 1, duration: 180, source: stalledLyricsTrack.id,
    queueIndex: 0, nativePlaybackActive: true, volume: 1, playbackRate: 1
  }
  await stalledLyricsStarted
  expect(player.lyricsLoadState.value.status === 'loading', 'fixture did not enter pending lyrics state')
  deferProvider = false
  window.dispatchEvent(new Event('focus'))
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(player.currentTrack.value.lyrics === '[00:01.00]Provider lyrics', 'window resume did not retry stalled lyrics')
  resolveDeferredProviders()

  player.queue.value = [clone(track), clone(nextTrack)]
  player.queueIndex.value = 0
  window.__audioFixture.emitPlaybackInfo({
    state: 'playing', position: 0, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  await Promise.resolve()

  window.__audioFixture.emitProperty('time-pos', 42)
  await Promise.resolve()
  expect(player.currentTime.value === 0, 'previous-track time sample overwrote new-track progress')
  window.__audioFixture.emitProperty('time-pos', 0.25)
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(player.currentTime.value >= 0.25, 'new-track progress confirmation was not applied')
  player.isLoading.value = true
  const stalledNextSamples = window.setInterval(
    () => window.__audioFixture.emitProperty('time-pos', 0.25),
    100
  )
  await new Promise((resolve) => setTimeout(resolve, 900))
  window.clearInterval(stalledNextSamples)
  expect(player.currentTime.value > 0.75, 'repeated zero-progress samples froze the new track clock')
  player.isLoading.value = false

  player.seek(60)
  expect(player.currentTime.value === 60, 'lyric seek did not update progress immediately')
  window.__audioFixture.emitProperty('time-pos', 0.5)
  await Promise.resolve()
  expect(player.currentTime.value === 60, 'pre-seek time sample rolled back lyric progress')
  window.__audioFixture.emitProperty('time-pos', 60.25)
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(player.currentTime.value >= 60.25, 'seek target confirmation did not resume progress')
  player.isLoading.value = true
  const stalledSeekSamples = window.setInterval(
    () => window.__audioFixture.emitProperty('time-pos', 60.25),
    100
  )
  await new Promise((resolve) => setTimeout(resolve, 900))
  window.clearInterval(stalledSeekSamples)
  expect(player.currentTime.value > 60.5, 'renderer fallback clock stopped during a pending track hand-off')
  const fallbackPosition = player.currentTime.value
  window.__audioFixture.emitProperty('time-pos', 0.75)
  window.__audioFixture.emitProperty('time-pos', 100)
  await Promise.resolve()
  expect(player.currentTime.value >= fallbackPosition, 'late stale samples displaced fallback progress')
  await new Promise((resolve) => setTimeout(resolve, 2500))
  window.__audioFixture.emitProperty('time-pos', 90)
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(player.currentTime.value >= 90, 'expired transition guard permanently rejected valid engine progress')
  player.isLoading.value = false
  player.isPlaying.value = true
  window.__audioFixture.emitProperty('time-pos', 100)
  window.__audioFixture.emitPlaybackInfo({
    state: 'paused', position: 100, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  window.__audioFixture.emitProperty('time-pos', 100.25)
  const stalePausedSamples = window.setInterval(
    () => window.__audioFixture.emitProperty('time-pos', 100.25),
    100
  )
  await new Promise((resolve) => setTimeout(resolve, 900))
  window.clearInterval(stalePausedSamples)
  expect(player.isPlaying.value, 'stale paused playback-info disabled the shared playback clock')
  expect(player.currentTime.value > 100.5, 'stale paused playback-info froze playbar and lyric progress')

  const confirmedPausePosition = player.currentTime.value
  window.__audioFixture.emitPlaybackInfo({
    state: 'paused', position: confirmedPausePosition, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(!player.isPlaying.value, 'confirmed native pause should stop the shared playback clock')
  window.__audioFixture.emitPlaybackInfo({
    state: 'playing', position: confirmedPausePosition + 0.5, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  // The renderer fallback clock intentionally waits 500ms after the last
  // authoritative engine sample before it advances between native updates.
  await new Promise((resolve) => setTimeout(resolve, 900))
  expect(player.isPlaying.value, 'authoritative playing playback-info did not recover a confirmed stale pause')
  expect(
    player.currentTime.value > confirmedPausePosition + 0.5,
    'playbar and lyric progress did not resume after authoritative playing recovery'
  )

  player.seek(120)
  window.__audioFixture.emitProperty('time-pos', 120.25)
  await new Promise((resolve) => setTimeout(resolve, 280))
  const uiStallUntil = performance.now() + 2000
  while (performance.now() < uiStallUntil) {}
  await new Promise((resolve) => setTimeout(resolve, 50))
  window.__audioFixture.emitProperty('time-pos', 120.5)
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(
    player.currentTime.value < 121.5,
    'a renderer stall made the playbar overrun and reject the recovered engine position'
  )

  // A native gapless hand-off can emit start-file after a stale pause snapshot.
  // The new file is already playing, so time-pos must reopen the shared clock
  // even though the previous UI state was paused.
  player.isPlaying.value = false
  player.isLoading.value = false
  window.__audioFixture.emitPlaybackInfo({
    state: 'stopped', position: 0, duration: 180, source: nextTrack.id,
    queueIndex: 1, nativePlaybackActive: false, volume: 1, playbackRate: 1
  })
  player.currentTrack.value = clone(nextTrack)
  player.queue.value = [clone(track), clone(nextTrack)]
  player.queueIndex.value = 1
  player.currentTime.value = 0
  window.__audioFixture.emitStartFile()
  window.__audioFixture.emitProperty('time-pos', 0.2)
  await new Promise((resolve) => setTimeout(resolve, 280))
  window.__audioFixture.emitProperty('time-pos', 0.6)
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(player.isPlaying.value, 'start-file did not reopen the native playback clock')
  expect(player.currentTime.value > 0.4, 'start-file time-pos did not advance the playbar')

  // A delayed paused snapshot from the previous native session may land just
  // after the next track has started. Keep the shared clock continuous until
  // the new session has had a chance to publish its first advancing sample.
  const handoffTrack = {
    ...nextTrack,
    id: 'fixture-provider:handoff-track',
    title: 'Gapless handoff fixture'
  }
  player.queue.value = [clone(nextTrack), clone(handoffTrack)]
  player.queueIndex.value = 0
  window.__audioFixture.emitPlaybackInfo({
    state: 'playing', position: 0, duration: 180, source: handoffTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  // Let the start-file play intent expire: this is the out-of-order snapshot
  // path rather than an explicit user pause.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  window.__audioFixture.emitPlaybackInfo({
    state: 'paused', position: 0, duration: 180, source: handoffTrack.id,
    queueIndex: 1, nativePlaybackActive: true, volume: 1, playbackRate: 1
  })
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(!player.isPlaying.value, 'fixture did not apply the delayed paused snapshot')
  const pausedHandoffPosition = player.currentTime.value
  const handoffSeekTarget = pausedHandoffPosition + 15
  player.seek(handoffSeekTarget)
  expect(player.currentTime.value === handoffSeekTarget, 'handoff seek did not update the lyric clock')
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(
    player.currentTime.value > handoffSeekTarget + 0.2,
    'a stale hand-off pause froze the shared playbar and word-lyric clock after seek'
  )

  console.log('LYRICS_PLAYER_RUNTIME_OK')
}
`
}

function runtimeHtml(bundleName: string): string {
  return `<!doctype html><html><body><script>
window.process = { env: {} }
window.__audioFixture = {
  propertyCallbacks: [], playbackInfoCallbacks: [], startFileCallbacks: [],
  emitProperty(name, data) { for (const cb of this.propertyCallbacks) cb({ name, data }) },
  emitPlaybackInfo(info) { this.playbackInfo = info; for (const cb of this.playbackInfoCallbacks) cb(info) },
  emitStartFile() { for (const cb of this.startFileCallbacks) cb() },
  playbackInfo: { state: 'stopped', position: 0, duration: 0, source: '', queueIndex: -1, nativePlaybackActive: false }
}
const subscribe = (list, cb) => { list.push(cb); return () => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1) } }
const noopSubscribe = () => () => {}
window.api = {
  audioEngine: {
    onPropertyChange: (cb) => subscribe(window.__audioFixture.propertyCallbacks, cb),
    onPlaybackInfo: (cb) => subscribe(window.__audioFixture.playbackInfoCallbacks, cb),
    onEndFile: noopSubscribe, onStartFile: (cb) => subscribe(window.__audioFixture.startFileCallbacks, cb), onReady: noopSubscribe,
    onError: noopSubscribe, onDisconnected: noopSubscribe,
    getPlaybackInfo: async () => window.__audioFixture.playbackInfo,
    getAudioOutputState: async () => { throw new Error('fixture output unavailable') },
    getAudioProcessing: async () => { throw new Error('fixture processing unavailable') },
    seek: async (position) => { window.__audioFixture.seekPosition = position }
  }
}
</script><script src="bundle/${bundleName}"></script></body></html>`
}

function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runLyricsPlayerRuntime()')
    app.exit(0)
  } catch (error) {
    console.error('LYRICS_PLAYER_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
