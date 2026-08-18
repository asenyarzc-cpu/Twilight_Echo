import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAudioDeviceOptions } from './player/audioOutputNormalize.ts'

function extractFunctionBody(source: string, functionName: string): string {
  const signatureIndex = source.indexOf(`export function ${functionName}`)
  assert.notEqual(signatureIndex, -1, `${functionName} export should exist`)

  const implementationStart = source.slice(signatureIndex).match(/\r?\n} \{/)
  assert.ok(implementationStart?.index != null, `${functionName} implementation should start`)

  const bodyStart = signatureIndex + implementationStart.index + implementationStart[0].length - 1

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return source.slice(bodyStart + 1, index)
  }

  assert.fail(`${functionName} body should close`)
}

function extractInternalFunctionBody(source: string, functionName: string): string {
  const signature = new RegExp(
    `(?:async\\s+)?function ${functionName}\\([^)]*\\)[:\\w\\s<>\\[\\]'|]*\\s*\\{`
  )
  const match = source.match(signature)
  assert.ok(match?.index != null, `${functionName} function should exist`)
  const bodyStart = match.index + match[0].length - 1

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return source.slice(bodyStart + 1, index)
  }

  assert.fail(`${functionName} body should close`)
}

test('native output-perfect facts stay canonical from store normalization to PlayerBar', () => {
  const storeSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playerBarSource = readFileSync(
    new URL('../components/PlayerBar.vue', import.meta.url),
    'utf8'
  )
  const playbackInfoSource = readFileSync(
    new URL('../utils/playerPlaybackInfo.ts', import.meta.url),
    'utf8'
  )
  const apply = extractInternalFunctionBody(storeSource, 'applyNativePlaybackInfo')
  const canonicalSourceExact = extractInternalFunctionBody(playerBarSource, 'canonicalSourceExact')
  const canonicalOutputPerfect = extractInternalFunctionBody(
    playerBarSource,
    'canonicalOutputPerfect'
  )

  assert.match(playbackInfoSource, /const canonicalOutput = info\.outputInfo/)
  assert.match(playbackInfoSource, /const sourceExact = canonicalOutput\?\.sourceExact === true/)
  assert.match(
    playbackInfoSource,
    /const outputPerfect = canonicalOutput\?\.outputPerfect === true/
  )
  assert.match(
    playbackInfoSource,
    /const pcmPassthrough = canonicalOutput\s*\? canonicalOutput\.pcmPassthrough === true\s*:\s*info\.pcmPassthrough === true/
  )
  assert.match(
    playbackInfoSource,
    /outputInfo:\s*\{[\s\S]*sourceExact,[\s\S]*outputPerfect,[\s\S]*pcmPassthrough/
  )
  assert.match(playbackInfoSource, /sourceExact,[\s\S]*outputPerfect,[\s\S]*pcmPassthrough/)
  assert.match(apply, /const normalizedInfo = normalizeNativePlaybackInfo\(info\)/)
  assert.match(apply, /playbackInfo\.value = normalizedInfo/)
  assert.match(
    storeSource,
    /const outputInfo = computed<NativeOutputInfo \| null>\(\(\) => playbackInfo\.value\?\.outputInfo \?\? null\)/
  )

  assert.match(canonicalSourceExact, /outputInfo\.value\?\.sourceExact === true/)
  assert.match(canonicalOutputPerfect, /outputInfo\.value\?\.outputPerfect === true/)
  assert.doesNotMatch(canonicalSourceExact, /sampleRate|SampleRate/)
  assert.doesNotMatch(canonicalOutputPerfect, /sampleRate|SampleRate/)
  assert.match(playerBarSource, /label: 'Output Perfect',[\s\S]*tone: outputPerfect \? 'success'/)
  assert.match(
    playerBarSource,
    /if \(outputInfo\.value\?\.resampled\)[\s\S]*label: 'Resampled',[\s\S]*tone: 'warning'/
  )
  assert.match(
    playerBarSource,
    /canonicalSourceExact\(\) && canonicalOutputPerfect\(\)[\s\S]*\? 'Bit Perfect'/
  )
})

test('usePlayerStore does not register reactive side effects per caller', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const body = extractFunctionBody(source, 'usePlayerStore')

  assert.match(body, /setupPlayerIntegrationSideEffects\(\)/)
  assert.equal(
    body.includes('watch('),
    false,
    'watchers in usePlayerStore run once per component that calls the store'
  )
})

test('playback info keeps loaded lyrics when reusing the current queue track', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const trackUtilsSource = readFileSync(
    new URL('../utils/playerTrackUtils.ts', import.meta.url),
    'utf8'
  )

  assert.match(trackUtilsSource, /export function mergeTrackTransientData/)
  assert.match(source, /const mergedTrack = mergeTrackTransientData\(track, currentTrack\.value\)/)
  assert.match(source, /patchTrackInQueues\(updatedTrack\)/)
})

test('empty automatic lyric content remains eligible for a later provider retry', () => {
  const source = readFileSync(
    new URL('./player/lyricsLoaderController.ts', import.meta.url),
    'utf8'
  )
  const lyricsSource = readFileSync(new URL('../utils/lyrics.ts', import.meta.url), 'utf8')

  assert.match(
    lyricsSource,
    /export function hasLyricContent\(value: string \| null \| undefined\): boolean/
  )
  assert.match(source, /const hasOriginal = hasLyricContent\(resolverTrack\.lyrics\)/)
  assert.match(
    source,
    /resolverTranslationSource === 'automatic' &&\s*!hasLyricContent\(resolverTrack\.translatedLyrics\)/
  )
  assert.match(source, /if \(!hasLyricContent\(track\.lyrics\) \|\| loading\)/)
})

test('track activation hydrates cover and lyrics stripped by queue snapshots', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')

  assert.match(source, /function hydratePlaybackTrack/)
  assert.match(source, /Queue rows intentionally strip lyrics/)
  assert.match(source, /hydratePlaybackTrack\(/)
  // Native gapless switch must not inherit previous track lyrics.
  assert.match(source, /lyrics: null,\s*translatedLyrics: null,\s*romanizedLyrics: null/)
  assert.match(source, /function activateCurrentTrack/)
})

test('desktop lyrics receives the current playback snapshot when enabled', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')

  assert.match(source, /function syncDesktopLyricsSnapshot\(\)/)
  assert.match(source, /const desktopLyricsApi = window\.api\?\.desktopLyrics/)
  assert.match(source, /desktopLyricsApi\.updateTrack\(\{/)
  assert.match(source, /lyricsSource: track\.lyricsSource \?\? null/)
  assert.match(source, /translatedLyricsSource: track\.translatedLyricsSource \?\? null/)
  assert.match(source, /desktopLyricsApi\.updateTime\(currentTime\.value\)/)
  assert.match(
    source,
    /window\.api\?\.desktopLyrics\?\.onToggle\(\(enabled: boolean\) => \{\s*if \(enabled\) syncDesktopLyricsSnapshot\(\)\s*\}\)/
  )
})

test('desktop lyrics sends plain settings through Electron IPC', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')

  assert.match(source, /desktopLyrics\?\.updateSettings\(\{ \.\.\.dl \}\)/)
  assert.doesNotMatch(source, /desktopLyrics\?\.updateSettings\(dl\)/)
})

test('desktop lyrics window replays cached track and time on creation', () => {
  const desktopLyricsSource = readFileSync(
    new URL('../../../main/integrations/desktopLyrics.ts', import.meta.url),
    'utf8'
  )
  const runtimeSource = readFileSync(
    new URL('../../../main/core/runtime.ts', import.meta.url),
    'utf8'
  )

  assert.match(runtimeSource, /latestDesktopLyricsTrack:/)
  assert.match(runtimeSource, /latestDesktopLyricsTime: 0,/)
  assert.match(desktopLyricsSource, /function sendDesktopLyricsSnapshot\(\): void/)
  assert.match(
    desktopLyricsSource,
    /runtime\.desktopLyricsWindow\.webContents\.send\(\s*'desktopLyrics:updateTrack',\s*runtime\.latestDesktopLyricsTrack\s*\)/
  )
  assert.match(
    desktopLyricsSource,
    /runtime\.desktopLyricsWindow\.webContents\.send\(\s*'desktopLyrics:updateTime',\s*runtime\.latestDesktopLyricsTime\s*\)/
  )
  assert.match(desktopLyricsSource, /runtime\.latestDesktopLyricsTrack = data/)
  assert.match(desktopLyricsSource, /Number\.isFinite\(time\)/)
  assert.match(desktopLyricsSource, /runtime\.latestDesktopLyricsTime = Math\.max\(0, time\)/)
  assert.match(desktopLyricsSource, /clampNumber\(Math\.round\(data\.x\)/)
})

test('desktop lyrics window is destroyed on quit so the process can exit', () => {
  const desktopLyricsSource = readFileSync(
    new URL('../../../main/integrations/desktopLyrics.ts', import.meta.url),
    'utf8'
  )
  const lifecycleSource = readFileSync(
    new URL('../../../main/app/lifecycle.ts', import.meta.url),
    'utf8'
  )
  const windowSource = readFileSync(new URL('../../../main/app/window.ts', import.meta.url), 'utf8')

  assert.match(desktopLyricsSource, /export function destroyDesktopLyrics\(\): void/)
  assert.match(desktopLyricsSource, /win\.destroy\(\)/)
  assert.match(
    desktopLyricsSource,
    /export function hideDesktopLyrics\(\): void \{\s*destroyDesktopLyrics\(\)/
  )
  assert.match(lifecycleSource, /destroyDesktopLyrics/)
  assert.match(lifecycleSource, /app\.on\('before-quit'[\s\S]*destroyDesktopLyrics\(\)/)
  assert.match(lifecycleSource, /app\.on\('will-quit'[\s\S]*destroyDesktopLyrics\(\)/)
  assert.match(windowSource, /destroyDesktopLyrics\(\)/)
  assert.match(
    windowSource,
    /function closeMainWindowAfterSuccessfulPersistence[\s\S]*destroyDesktopLyrics\(\)/
  )
})

test('desktop lyrics uses the built renderer asset in packaged builds', () => {
  const integrationSource = readFileSync(
    new URL('../../../main/integrations/desktopLyrics.ts', import.meta.url),
    'utf8'
  )
  const securitySource = readFileSync(
    new URL('../../../main/security/electronSecurity.ts', import.meta.url),
    'utf8'
  )
  const viteSource = readFileSync(
    new URL('../../../../electron.vite.config.ts', import.meta.url),
    'utf8'
  )
  const builderSource = readFileSync(
    new URL('../../../../electron-builder.yml', import.meta.url),
    'utf8'
  )

  assert.match(integrationSource, /is\.dev[\s\S]*\.\.\/\.\.\/resources\/desktop-lyrics\.html/)
  assert.match(integrationSource, /\.\.\/renderer\/desktop-lyrics\.html/)
  assert.match(securitySource, /\(\?:resources\|renderer\)\\\/desktop-lyrics/)
  assert.match(viteSource, /publicDir: resolve\('resources'\)/)
  assert.match(builderSource, /- out\/\*\*/)
})

test('desktop lyrics html falls back to untimed plain lyrics', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )

  assert.match(source, /function parsePlainLyrics\(lyrics\)/)
  assert.match(source, /function buildMergedLyrics\(lyrics, translatedLyrics\)/)
  assert.match(source, /var plain = parsePlainLyrics\(lyrics\)/)
  assert.match(source, /time: null/)
  assert.match(source, /mergedLines = buildMergedLyrics\(data\.lyrics, data\.translatedLyrics\)/)
})

test('desktop lyrics html flattens NetEase JSON credit lines (作词/作曲)', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )

  assert.match(source, /function parseNeteaseJsonLyricLine\(raw\)/)
  assert.match(source, /NETEASE_JSON_LINE_RE/)
  assert.match(source, /t < 0 is NetEase credit/)
  assert.match(source, /credits\.push\(\{ time: 0, text: jsonLine\.text/)
  assert.match(source, /parseNeteaseJsonLyricLine\(line\)/)
})

test('desktop lyrics html rotates single lyrics (row0 becomes 3rd while row1 highlights)', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )

  assert.match(source, /Single-lyric rotation/)
  assert.match(source, /active=1 → \[2,1\] hl row1/)
  assert.match(source, /base \+ pageSize \+ ri/)
  assert.doesNotMatch(source, /activeIndex - Math\.floor\(\(count - 1\) \/ 2\)/)
})

test('desktop lyrics html applies configurable lineOffset stagger', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )
  const settingsSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /settings\.lineOffset/)
  assert.match(source, /translateX\(' \+ rowOffsetX/)
  assert.match(settingsSource, /highlightColor: '#3b82f6'/)
  assert.match(settingsSource, /lineOffset: 0/)
  assert.match(settingsSource, /lineOffset: clampNumber\(d\.lineOffset, -200, 200/)
})

test('desktop lyrics html supports bilingual original+translation layout', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )
  const settingsSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /settings\.layout === 'multi' \? 'multi' : 'bilingual'/)
  assert.match(source, /Bilingual: row0 = original/)
  assert.match(settingsSource, /layout: 'bilingual'/)
  assert.match(
    settingsSource,
    /d\.layout === 'multi'[\s\S]*\? 'multi'[\s\S]*d\.layout === 'bilingual'[\s\S]*\? 'bilingual'[\s\S]*DEFAULT_DESKTOP_LYRICS\.layout/
  )
})

test('playback history behavior lives in its injected controller while the store keeps its API', () => {
  const storeSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const historySource = readFileSync(
    new URL('./player/playbackHistoryController.ts', import.meta.url),
    'utf8'
  )

  assert.match(historySource, /export interface PlaybackHistoryControllerOptions/)
  assert.match(historySource, /getPlaybackBookmarks: \(\) => PlaybackBookmarksService/)
  assert.match(historySource, /getPodcastStore: \(\) => PodcastProgressService/)
  assert.match(historySource, /position < 15/)
  assert.match(historySource, /position > dur - 10/)
  assert.match(historySource, /Math\.abs\(seconds - lastPodcastProgressSeconds\) < 2/)
  assert.match(historySource, /now - lastPodcastProgressWriteAt < 4_000/)
  assert.match(historySource, /updateEpisodeProgress\(/)
  assert.match(historySource, /const resumeOffer = ref<PlaybackResumeOffer \| null>\(null\)/)
  assert.match(historySource, /function dispose\(\): void/)
  assert.match(historySource, /generation \+= 1/)
  assert.doesNotMatch(
    historySource,
    /PlaybackRate|getPodcastDefaultPlaybackRate|setPodcastDefaultPlaybackRate/
  )
  assert.match(storeSource, /createPlaybackHistoryController\(\{/)
  assert.match(storeSource, /playbackHistoryController\.recordTrackDeparture\(previousTrack\)/)
  assert.match(
    storeSource,
    /playbackHistoryController\.maybeOfferResumeForTrack\(track, resumeAt\)/
  )
  assert.match(storeSource, /playbackHistoryController\.flushPodcastEpisodeProgress\(false\)/)
  assert.match(storeSource, /const \{ resumeOffer, acceptResumeOffer, dismissResumeOffer/)
  assert.match(
    storeSource,
    /if \(currentTrack\.value\?\.source === 'podcast'\) \{[\s\S]*setPodcastDefaultPlaybackRate\(rounded\)/
  )
  assert.match(
    storeSource,
    /if \(track\.source === 'podcast'\) \{[\s\S]*getPodcastDefaultPlaybackRate\(\)/
  )
  assert.match(storeSource, /acceptResumeOffer: \(\) => void/)
  assert.match(storeSource, /dismissResumeOffer: \(\) => void/)
  assert.match(storeSource, /addManualBookmarkAtCurrentTime: \(\) => void/)
  assert.match(storeSource, /playbackHistoryController\.dispose\(\)/)
  assert.doesNotMatch(storeSource, /let lastPodcastProgressWriteAt = 0/)
  assert.doesNotMatch(storeSource, /function maybeOfferResumeForTrack\(/)
})

test('player lyric loading records local and provider lyric sources', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const clockControllerSource = readFileSync(
    new URL('./player/playbackClockController.ts', import.meta.url),
    'utf8'
  )
  const lyricsLoaderSource = readFileSync(
    new URL('./player/lyricsLoaderController.ts', import.meta.url),
    'utf8'
  )
  const ensureCurrentTrackLyricsLoaded = extractInternalFunctionBody(
    lyricsLoaderSource,
    'ensureCurrentTrackLyricsLoaded'
  )
  const commitResolvedLyrics = extractInternalFunctionBody(
    lyricsLoaderSource,
    'commitResolvedLyrics'
  )
  const findLibraryTrackHint = extractInternalFunctionBody(source, 'findLibraryTrackHint')
  const loadAndPlay = extractInternalFunctionBody(source, 'loadAndPlay')

  assert.match(
    lyricsLoaderSource,
    /import \{[\s\S]*resolveLyricsWithSources[\s\S]*\} from '\.\.\/\.\.\/utils\/lyricSourceResolution\.ts'/
  )
  assert.match(ensureCurrentTrackLyricsLoaded, /resolveLyricsWithSources\(\{/)
  assert.match(ensureCurrentTrackLyricsLoaded, /loadLocalLyrics:/)
  assert.match(ensureCurrentTrackLyricsLoaded, /loadProviderLyrics:/)
  assert.match(
    ensureCurrentTrackLyricsLoaded,
    /commitResolvedLyrics\(triggerTrack, resolverTrack, resolved\)/
  )
  assert.match(commitResolvedLyrics, /lyricsSource: resolved\.lyricsSource/)
  assert.match(commitResolvedLyrics, /translatedLyricsSource: resolved\.translatedLyricsSource/)
  // Switch hot path must use O(1) trackById — linear find freezes PlayingMusic.
  assert.match(findLibraryTrackHint, /getTrackById\(/)
  assert.doesNotMatch(findLibraryTrackHint, /tracks\.value\.find/)
  // Superseded/abandoned loads must clear isLoading when they still own the token.
  assert.match(loadAndPlay, /releaseLoadIfOwned/)
  assert.match(loadAndPlay, /if \(loadToken === activeLoadToken\) isLoading\.value = false/)
  // The store delegates fallback timing to one authority rather than keeping
  // a second independent position clock next to the lyric resolver.
  assert.match(clockControllerSource, /createPlaybackSessionClock/)
  assert.match(
    clockControllerSource,
    /createPlaybackClock\(\{[\s\S]*onTick: \(\) => \{[\s\S]*playbackSessionClock\.estimate\(\)[\s\S]*requestPlaybackClockResync\(\)/
  )
})

test('plugin playback resume waits for plugin providers while local sessions restore immediately', () => {
  const sessionPersistenceSource = readFileSync(
    new URL('../app/usePlaybackSessionPersistence.ts', import.meta.url),
    'utf8'
  )
  const pluginsSource = readFileSync(
    new URL('../../../main/ipc/plugins.ts', import.meta.url),
    'utf8'
  )
  const runtimeSource = readFileSync(
    new URL('../../../main/core/runtime.ts', import.meta.url),
    'utf8'
  )

  assert.match(
    sessionPersistenceSource,
    /function requiresPluginProviderSync\(track: Track\): boolean/
  )
  assert.match(
    sessionPersistenceSource,
    /if \(requiresPluginProviderSync\(session\.track\)\) \{\s*await options\.syncPluginProviders\(\)\s*\}[\s\S]*const restoredSession: PlaybackSession/
  )
  assert.match(runtimeSource, /pluginManagerReady: null as Promise<void> \| null,/)
  assert.match(
    pluginsSource,
    /runtime\.pluginManagerReady = runtime\.pluginManager\s*\.\s*initialize\(\)/
  )
  assert.match(
    pluginsSource,
    /ipcMain\.handle\('providers:list', async \(event\) => \{\s*assertTrustedIpcSender\(event, 'provider IPC'\)\s*await runtime\.pluginManagerReady\s*return runtime\.pluginManager!\.listProviders\(\)\s*\}\)/
  )
  assert.match(
    pluginsSource,
    /'providers:call',[\s\S]*await runtime\.pluginManagerReady[\s\S]*runtime\.pluginManager!\.callProvider/
  )
})

test('startup restores the playback session without waiting for the library scan', () => {
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const restoreStart = appSource.indexOf('const playbackSessionSetupPromise')
  const libraryStart = appSource.indexOf('const libraryPromise')
  const libraryWait = appSource.indexOf('await libraryPromise')

  assert.notEqual(restoreStart, -1)
  assert.notEqual(libraryStart, -1)
  assert.notEqual(libraryWait, -1)
  assert.ok(restoreStart < libraryStart)
  assert.ok(restoreStart < libraryWait)
  assert.match(appSource, /await libraryPromise\s*await playbackSessionSetupPromise/)
  assert.match(
    appSource,
    /\.finally\(\(\) => \{[\s\S]*onSavePlaybackSession\([\s\S]*startAutosaveWatchers\(\)/
  )
})

test('playback session autosaves while playback changes instead of only on window close', () => {
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const sessionPersistenceSource = readFileSync(
    new URL('../app/usePlaybackSessionPersistence.ts', import.meta.url),
    'utf8'
  )

  assert.match(appSource, /createPlaybackSessionPersistence\(\{/)
  assert.match(sessionPersistenceSource, /function schedulePlaybackSessionAutosave\(/)
  assert.match(sessionPersistenceSource, /async function savePlaybackSessionSnapshot\(/)
  assert.match(appSource, /currentTrack[\s\S]*currentTime[\s\S]*isPlaying/)
  assert.match(
    sessionPersistenceSource,
    /watch\(\s*\[\(\) => options\.currentTrack\.value\?\.id, \(\) => getPlaybackResumeMode\(\)\]/
  )
  assert.match(sessionPersistenceSource, /DEFAULT_PLAYBACK_SESSION_POSITION_AUTOSAVE_MS/)
  assert.match(sessionPersistenceSource, /sessionWriter\.save\(options\.dataApi, session\)/)
})

test('player state persists a selected track before shell-level autosave is available', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const sessionSource = readFileSync(
    new URL('./player/playbackSessionController.ts', import.meta.url),
    'utf8'
  )
  const setupSideEffects = extractInternalFunctionBody(source, 'setupPlayerIntegrationSideEffects')
  const persistSelectedTrackSession = extractInternalFunctionBody(
    sessionSource,
    'persistSelectedTrackSession'
  )

  assert.match(
    persistSelectedTrackSession,
    /const mode = options\.getAppSettings\(\)\.value\.playbackResumeMode/
  )
  assert.match(persistSelectedTrackSession, /playbackSessionWriter\.save\(dataApi, session\)/)
  assert.match(
    setupSideEffects,
    /currentTrack\.value\?\.id[\s\S]*persistSelectedTrackSession\(\)[\s\S]*flush: 'sync'/
  )
})

test('removing a non-current local queue item persists the pruned restart session', () => {
  const sessionSource = readFileSync(
    new URL('./player/playbackSessionController.ts', import.meta.url),
    'utf8'
  )
  const removeUnavailableTracks = extractInternalFunctionBody(
    sessionSource,
    'removeUnavailableTracks'
  )
  const persistAfterMutation = extractInternalFunctionBody(
    sessionSource,
    'persistPlaybackSessionAfterQueueMutation'
  )
  const clearPersistedSession = extractInternalFunctionBody(
    sessionSource,
    'clearPersistedSelectedTrackSession'
  )

  assert.match(removeUnavailableTracks, /const queueChanged =/)
  assert.match(
    removeUnavailableTracks,
    /if \(queueChanged\) persistPlaybackSessionAfterQueueMutation\(\)/
  )
  assert.match(persistAfterMutation, /persistSelectedTrackSession\(\)/)
  assert.match(persistAfterMutation, /clearPersistedSelectedTrackSession\(\)/)
  assert.match(clearPersistedSession, /playbackSessionWriter\.clear\(dataApi\)/)
})

test('renderer streaming resume seeks only after media metadata is available', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playWithRendererAudio =
    source.match(/async function playWithRendererAudio[\s\S]*?\n}/)?.[0] ?? ''

  assert.match(source, /function seekRendererAudioWhenReady\(/)
  assert.match(source, /audio\.readyState >= HTMLMediaElement\.HAVE_METADATA/)
  assert.match(source, /audio\.addEventListener\('loadedmetadata', applySeek, \{ once: true \}\)/)
  assert.match(
    playWithRendererAudio,
    /seekRendererAudioWhenReady\(audio, startTime, track, loadToken\)/
  )
  assert.equal(
    playWithRendererAudio.includes('audio.currentTime = Math.max(0, startTime)'),
    false,
    'streaming resume must not seek before remote media metadata is available'
  )
})

test('renderer HTMLAudio starts only after the native engine is stopped', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playWithRendererAudio =
    source.match(/async function playWithRendererAudio[\s\S]*?\n}/)?.[0] ?? ''
  const togglePlayState = extractInternalFunctionBody(source, 'togglePlayState')
  const watchdog = source.match(/function scheduleRendererPlaybackWatchdog[\s\S]*?\n}/)?.[0] ?? ''

  // Every place that starts the shared-mode HTMLAudio element must first stop the
  // native engine; otherwise WASAPI shared (Chromium) and WASAPI exclusive can
  // both render the same track and the user hears two sounds.
  assert.match(playWithRendererAudio, /await stopNativeAudio\(\)/)
  assert.match(
    togglePlayState,
    /const audio = getPlaybackAudio\(\)[\s\S]*?if \(audio\.paused\) \{[\s\S]*?await stopNativeAudio\(\)[\s\S]*?await audio\.play\(\)/
  )
  assert.match(watchdog, /await stopNativeAudio\(\)[\s\S]*?await audio\.play\(\)/)
  const audioPlayCalls = source.match(/await audio\.play\(\)/g) ?? []
  assert.ok(audioPlayCalls.length >= 3, 'expected renderer audio play call sites to be covered')
})

test('streaming renderer playback is allowed after asynchronous provider URL resolution', () => {
  const mainSource = readFileSync(
    new URL('../../../main/app/lifecycle.ts', import.meta.url),
    'utf8'
  )

  assert.match(
    mainSource,
    /app\.commandLine\.appendSwitch\('autoplay-policy', 'no-user-gesture-required'\)/
  )
})

test('renderer createPlayableUrl accepts twilight-media grant URLs without local file lookup', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const createPlayableUrl = extractInternalFunctionBody(source, 'createPlayableUrl')

  assert.match(createPlayableUrl, /\^twilight-media:/i)
  assert.match(createPlayableUrl, /releasePlaybackObjectUrl\(\)/)
  // Grant URLs must not be forced through the local audio file URL path.
  assert.ok(
    createPlayableUrl.indexOf('twilight-media:') < createPlayableUrl.indexOf('getAudioFileUrl'),
    'twilight-media grants should short-circuit before getAudioFileUrl'
  )
})

test('only the active streaming load commits its resolved target into shared track state', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const resolvePlayTarget = extractInternalFunctionBody(source, 'resolvePlayTarget')
  const loadAndPlay = extractInternalFunctionBody(source, 'loadAndPlay')
  const resolvedAt = loadAndPlay.indexOf('const playTarget = await resolvePlayTarget(track)')
  const activeCheckAt = loadAndPlay.indexOf('if (!isActiveLoad(loadToken, track))', resolvedAt)
  const commitAt = loadAndPlay.indexOf('track.streamUrl = playTarget', resolvedAt)
  const patchAt = loadAndPlay.indexOf('patchTrackInQueues(track)', resolvedAt)

  assert.doesNotMatch(resolvePlayTarget, /track\.streamUrl\s*=/)
  assert.doesNotMatch(resolvePlayTarget, /track\.streamQuality\s*=(?!=)/)
  assert.ok(resolvedAt >= 0, 'stream URL resolution should remain in loadAndPlay')
  assert.ok(
    activeCheckAt > resolvedAt,
    'resolved streams require a post-resolution generation check'
  )
  assert.ok(commitAt > activeCheckAt, 'stale stream resolutions must not mutate the shared track')
  assert.ok(
    patchAt > commitAt,
    'queue snapshots should update only after the active target commits'
  )
})

test('NetEase streams re-resolve after a quality preference change', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const resolvePlayTarget = extractInternalFunctionBody(source, 'resolvePlayTarget')
  const loadAndPlay = extractInternalFunctionBody(source, 'loadAndPlay')

  assert.match(
    resolvePlayTarget,
    /const ncmPlaybackQuality = appSettings\.value\.ncmPlaybackQuality/
  )
  assert.match(resolvePlayTarget, /track\.streamQuality === ncmPlaybackQuality/)
  assert.match(
    resolvePlayTarget,
    /source === 'ncm' \? \{ quality: ncmPlaybackQuality \} : undefined/
  )
  assert.match(
    loadAndPlay,
    /if \(getTrackSource\(track\) === 'ncm'\) \{\s*track\.streamQuality = appSettings\.value\.ncmPlaybackQuality/
  )
  assert.match(resolvePlayTarget, /当前网易云账号没有可播放的音质/)
})

test('cached playback paths are validated before reuse after a cache clear', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const resolvePlayTarget = extractInternalFunctionBody(source, 'resolvePlayTarget')

  // NCM local cache paths must not be replayed blindly: the managed music cache
  // may have been cleared, so a missing file must fall back to the provider.
  // loadAndPlay commits the resolved target, so resolvePlayTarget itself never
  // writes streamUrl (see the doesNotMatch assertion below).
  assert.match(
    resolvePlayTarget,
    /if \(await isUsableLocalPlaybackFile\(track\.streamUrl\)\) return track\.streamUrl/
  )
  assert.doesNotMatch(resolvePlayTarget, /track\.streamUrl\s*=/)
  // Network source cache paths follow the same rule before a lazy re-download.
  assert.match(
    resolvePlayTarget,
    /if \(track\.filePath\) \{[\s\S]*!isLikelyLocalFilePath\(track\.filePath\)[\s\S]*isUsableLocalPlaybackFile\(track\.filePath\)[\s\S]*track\.filePath = ''/
  )
  assert.match(
    source,
    /async function isUsableLocalPlaybackFile[\s\S]*window\.api\?\.fs\?\.isAudioFileAuthorized\?\.\(filePath\)/
  )
})

test('mini player switching recovers from stale unauthorized local tracks', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const preloadSource = readFileSync(
    new URL('../../../preload/domains/libraryApi.ts', import.meta.url),
    'utf8'
  )
  const windowSource = readFileSync(new URL('../../../main/app/window.ts', import.meta.url), 'utf8')
  const resolvePlayTarget = extractInternalFunctionBody(source, 'resolvePlayTarget')
  const handlePlaybackFallback = extractInternalFunctionBody(source, 'handlePlaybackFallback')
  const handleProviderRematchFallback = extractInternalFunctionBody(
    source,
    'handleProviderRematchFallback'
  )

  assert.match(resolvePlayTarget, /window\.api\.fs\.isAudioFileAuthorized\(track\.filePath\)/)
  assert.match(preloadSource, /ipcRenderer\.invoke\('fs:isAudioFileAuthorized', filePath\)/)
  assert.match(handlePlaybackFallback, /await loadAndPlay\(fallback\)/)
  assert.match(handleProviderRematchFallback, /if \(failedSource !== 'local'\)/)
  assert.match(handleProviderRematchFallback, /await loadAndPlay\(rematched\)/)
  assert.doesNotMatch(windowSource, /backgroundThrottling: false/)
})

test('provider queues use native for resolved current targets without native queue delegation', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const trackUtilsSource = readFileSync(
    new URL('../utils/playerTrackUtils.ts', import.meta.url),
    'utf8'
  )
  const syncNativeQueueState = extractInternalFunctionBody(source, 'syncNativeQueueState')
  const loadAndPlay = source.match(/async function loadAndPlay[\s\S]*?function next\(\)/)?.[0] ?? ''
  const isNativeQueueDelegated = extractInternalFunctionBody(source, 'isNativeQueueDelegated')
  const sessionSource = readFileSync(
    new URL('./player/playbackSessionController.ts', import.meta.url),
    'utf8'
  )
  const restorePlaybackSession = extractInternalFunctionBody(
    sessionSource,
    'restorePlaybackSession'
  )
  const resetPlaybackRuntimeStateForRestore = extractInternalFunctionBody(
    source,
    'resetPlaybackRuntimeStateForRestore'
  )

  assert.match(restorePlaybackSession, /options\.resetPlaybackRuntimeStateForRestore\(\)/)
  assert.match(resetPlaybackRuntimeStateForRestore, /nativePlaybackActive = false/)
  assert.match(resetPlaybackRuntimeStateForRestore, /loadedTrackId = ''/)
  assert.match(resetPlaybackRuntimeStateForRestore, /stopRendererAudio\(true\)/)
  assert.match(resetPlaybackRuntimeStateForRestore, /void stopNativeAudio\(\)/)
  assert.match(
    trackUtilsSource,
    /\^\[a-zA-Z\]:\[\\\\\/\]/,
    'legacy local tracks whose id is a Windows path must not be mistaken for a provider prefix'
  )
  assert.match(isNativeQueueDelegated, /return nativeQueueDelegated/)
  assert.doesNotMatch(isNativeQueueDelegated, /canUseNativeQueuePlayback/)
  assert.match(
    syncNativeQueueState,
    /synchronizeLatestNativeQueue\(\s*nativeQueueRevisionFence,\s*snapshot\.revision,\s*\{[\s\S]*prepare: \(\) =>\s*preparePlayerNativeQueue\([\s\S]*isAudioFileAuthorized: window\.api\.fs\.isAudioFileAuthorized/,
    'queue synchronization must authorize candidates through the latest-revision fence before delegating them to native playback'
  )
  assert.match(syncNativeQueueState, /if \(!synchronized\.applied\) return/)
  assert.match(
    loadAndPlay,
    /const useNativePlayback = shouldUseNativePlayback\(track, playTarget\)/
  )
  assert.match(loadAndPlay, /if \(useNativePlayback\) \{[\s\S]*window\.api\.audioEngine\.loadQueue/)
})

test('player store prepares native queues before loading or synchronizing them', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const syncNativeQueueState = extractInternalFunctionBody(source, 'syncNativeQueueState')
  const loadAndPlay = source.match(/async function loadAndPlay[\s\S]*?function next\(\)/)?.[0] ?? ''

  assert.match(
    source,
    /import \{ preparePlayerNativeQueue \} from '\.\.\/utils\/nativeQueuePreparation\.ts'/
  )
  assert.match(loadAndPlay, /const preparedQueue = await preparePlayerNativeQueue\(/)
  assert.match(loadAndPlay, /isAudioFileAuthorized: window\.api\.fs\.isAudioFileAuthorized/)
  assert.match(
    loadAndPlay,
    /if \(!isActiveLoad\(loadToken, track\)\) \{[\s\S]*?return[\s\S]*?\}\s*await window\.api\.audioEngine\.loadQueue/,
    'an old async queue preparation must not reach native LoadQueue'
  )
  assert.match(loadAndPlay, /preparedQueue\.items,\s*preparedQueue\.startIndex/)
  assert.match(loadAndPlay, /nativeQueueDelegated = preparedQueue\.delegated/)
  assert.match(
    syncNativeQueueState,
    /synchronizeLatestNativeQueue\(\s*nativeQueueRevisionFence,\s*snapshot\.revision,\s*\{[\s\S]*prepare: \(\) =>\s*preparePlayerNativeQueue\(/
  )
  assert.match(syncNativeQueueState, /if \(!synchronized\.applied\) return/)
  assert.match(syncNativeQueueState, /preparedQueue\.items, preparedQueue\.startIndex/)
})

test('next and previous only use native controls when the native queue is delegated', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const nextBody = extractInternalFunctionBody(source, 'next')
  const previousBody = extractInternalFunctionBody(source, 'previous')
  const togglePlayState = extractInternalFunctionBody(source, 'togglePlayState')
  const seekPlayback = extractInternalFunctionBody(source, 'seekPlayback')
  const playQueueTrack = extractInternalFunctionBody(source, 'playQueueTrack')

  assert.match(
    nextBody,
    /if \(!castTargetUsn\.value && nativePlaybackActive && isNativeQueueDelegated\(\)\)/
  )
  assert.match(
    previousBody,
    /if \(!castTargetUsn\.value && nativePlaybackActive && isNativeQueueDelegated\(\)\)/
  )
  assert.match(togglePlayState, /if \(casting\)/)
  assert.match(togglePlayState, /if \(nativePlaybackActive\)/)
  // Optimistic toggle must keep the intent after togglePause returns so a
  // stale pre-toggle pause/playback-info tick cannot flip the button back.
  assert.match(togglePlayState, /setPlaybackToggleIntent\(nextPlaying\)/)
  assert.match(togglePlayState, /await window\.api\.audioEngine\.togglePause\(\)/)
  assert.doesNotMatch(
    togglePlayState.match(
      /if \(nativePlaybackActive\) \{[\s\S]*?await window\.api\.audioEngine\.togglePause\(\)[\s\S]*?\n    \} else \{/
    )?.[0] ?? '',
    /clearPlaybackToggleIntent\(\)/
  )
  assert.match(togglePlayState, /setPlaybackToggleIntent\(isPlaying\.value\)/)
  assert.match(seekPlayback, /nativePlaybackActive \|\| nativeQueueDelegated/)
  assert.match(playQueueTrack, /if \(castTargetUsn\.value\)[\s\S]*castCurrentTrackToDevice/)
  assert.match(playQueueTrack, /void loadAndPlay\(track\)/)
  assert.match(nextBody, /playQueueTrack\(track\)/)
  assert.match(previousBody, /playQueueTrack\(/)
  assert.match(previousBody, /controlCast\?\.\(\{ seek: 0 \}\)/)
  assert.match(
    previousBody,
    /appSettings\.value\.previousButtonAction === 'restart' &&[\s\S]*getLatestPlaybackTime\(\) > 3/
  )
})

test('applyNativePlayingState ignores stale pause events during toggle intent grace', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playerConstantsSource = readFileSync(
    new URL('../utils/playerConstants.ts', import.meta.url),
    'utf8'
  )
  const applyNativePlayingState = extractInternalFunctionBody(source, 'applyNativePlayingState')
  assert.match(applyNativePlayingState, /playing !== playbackToggleIntent\.playing/)
  assert.match(applyNativePlayingState, /return/)
  // Matching confirmations must apply UI state without immediately clearing the intent.
  assert.doesNotMatch(applyNativePlayingState, /clearPlaybackToggleIntent\(\)\s*\n\s*isPlaying/)
  assert.match(playerConstantsSource, /PLAYBACK_TOGGLE_INTENT_GRACE_MS = 1200/)
})

test('togglePlayState and seek/volume fan out to cast when castTargetName is active', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const togglePlayState = extractInternalFunctionBody(source, 'togglePlayState')
  const seekPlayback = extractInternalFunctionBody(source, 'seekPlayback')

  assert.match(togglePlayState, /const casting = Boolean\(castTargetName\.value\)/)
  assert.match(
    togglePlayState,
    /controlCast\?\.\(\s*nextPlaying \? \{ play: true \} : \{ pause: true \}\s*\)/
  )
  // Cast path must return before local engine toggle; avoid [\s\S]* spanning both branches.
  const castingBranch = togglePlayState.match(/if \(casting\) \{[\s\S]*?\n    \}/)?.[0]
  assert.ok(castingBranch, 'casting branch should return before nativePlaybackActive')
  assert.match(castingBranch, /return/)
  assert.doesNotMatch(castingBranch, /audioEngine\.togglePause/)
  assert.doesNotMatch(castingBranch, /getPlaybackAudio/)
  assert.match(
    seekPlayback,
    /if \(castTargetName\.value\)[\s\S]*controlCast\?\.\(\{ seek: position \}\)/
  )
  assert.match(source, /if \(castTargetName\.value\)[\s\S]*controlCast\?\.\(\{ volume: val \}\)/)
})

test('native queue switching guards the target track before applying playback-info events', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const clockControllerSource = readFileSync(
    new URL('./player/playbackClockController.ts', import.meta.url),
    'utf8'
  )
  const playbackSessionClockSource = readFileSync(
    new URL('../utils/playbackSessionClock.ts', import.meta.url),
    'utf8'
  )
  const advanceNativePlayback = extractInternalFunctionBody(source, 'advanceNativePlayback')
  const applyNativePlaybackInfo = extractInternalFunctionBody(source, 'applyNativePlaybackInfo')
  const setupAudioEngineListeners = extractInternalFunctionBody(source, 'setupAudioEngineListeners')
  const refreshPlaybackInfoAfterStartFile = extractInternalFunctionBody(
    source,
    'refreshPlaybackInfoAfterStartFile'
  )
  const refreshPlaybackAfterRendererResume = extractInternalFunctionBody(
    source,
    'refreshPlaybackAfterRendererResume'
  )
  const lyricsLoaderSource = readFileSync(
    new URL('./player/lyricsLoaderController.ts', import.meta.url),
    'utf8'
  )
  const retryCurrentTrackLyricsIfNeeded = extractInternalFunctionBody(
    lyricsLoaderSource,
    'retryCurrentTrackLyricsIfNeeded'
  )
  const advanceAfterPlaybackEnded = extractInternalFunctionBody(source, 'advanceAfterPlaybackEnded')
  const playQueueTrack = extractInternalFunctionBody(source, 'playQueueTrack')
  const resetPlaybackUiForTrackSwitch = extractInternalFunctionBody(
    source,
    'resetPlaybackUiForTrackSwitch'
  )

  assert.match(source, /evaluateNativePlaybackInfoIntent/)
  assert.match(
    advanceNativePlayback,
    /const target = playMode\.value === 'shuffle' \? null : getNativeQueueAdvanceTarget\(direction\)/
  )
  assert.match(advanceNativePlayback, /activateCurrentTrack\(target\.track/)
  assert.match(source, /function activateCurrentTrack/)
  assert.match(source, /function hydratePlaybackTrack/)
  assert.match(
    advanceNativePlayback,
    /setNativePlaybackInfoIntent\(\s*activeLoadToken,\s*target\.track,\s*getTrackAudioSource\(target\.track\),\s*target\.queueIndex\s*\)/
  )
  // Fallback load must not demote nativePlaybackActive before loadAndPlay runs.
  assert.doesNotMatch(
    advanceNativePlayback,
    /nativePlaybackActive = false\s*\n\s*await loadAndPlay/
  )
  assert.match(
    applyNativePlaybackInfo,
    /const infoIndex = findTrackIndexFromPlaybackInfo\(info\)\s*if \(shouldIgnoreNativePlaybackInfo\(info, infoIndex\)\) return false\s*const normalizedInfo/
  )
  assert.match(applyNativePlaybackInfo, /applyNativeStreamBufferingFromInfo\(normalizedInfo\)/)
  assert.match(applyNativePlaybackInfo, /if \(switchedTrack\)[\s\S]*clearAbLoop\(\)/)
  assert.match(applyNativePlaybackInfo, /previousQueueIndex !== infoIndex/)
  // After a confirmed switch keep the intent/guard — do not clear it (delayed
  // previous-track ticks would flash the old song).
  assert.match(applyNativePlaybackInfo, /markNativePlaybackInfoIntentConfirmed\(/)
  assert.match(advanceNativePlayback, /clearPlaybackToggleIntent\(/)
  assert.match(advanceNativePlayback, /wasPlaying/)
  // Hydrate cover/lyrics from queue + library on switch so previous art/lyrics cannot stick.
  assert.match(applyNativePlaybackInfo, /hydratePlaybackTrack\(/)
  assert.match(applyNativePlaybackInfo, /nonEmptyString\(track\.cover\)/)
  assert.match(applyNativePlaybackInfo, /lyrics: null/)
  // Never demote nativePlaybackActive from a transient false snapshot while playing.
  assert.match(
    applyNativePlaybackInfo,
    /if \(info\.nativePlaybackActive === true\)[\s\S]*nativePlaybackActive = true/
  )
  assert.doesNotMatch(
    applyNativePlaybackInfo,
    /nativePlaybackActive = info\.nativePlaybackActive === true/
  )
  assert.match(resetPlaybackUiForTrackSwitch, /clearAbLoop\(\)/)
  assert.match(resetPlaybackUiForTrackSwitch, /beginPlaybackPositionTransition/)
  assert.doesNotMatch(source, /softClock/)
  assert.match(
    source,
    /async function loadAndPlay[\s\S]*beginPlaybackPositionTransition\(normalizedStartTime, \{ keepRendererClockAlive: true \}\)[\s\S]*function next\(/
  )
  assert.match(clockControllerSource, /function applyPlaybackPositionSample/)
  assert.match(clockControllerSource, /playbackSessionClock\.ingest\(\{/)
  assert.match(clockControllerSource, /playbackSessionClock\.estimate\(\)/)
  assert.match(playbackSessionClockSource, /maxPredictionGapMs/)
  assert.match(playbackSessionClockSource, /needsResync: true/)
  assert.match(source, /restoredPlaybackPending &&\s*Number\.isFinite\(restoredPlaybackPosition\)/)
  assert.match(source, /if \(isLoading\.value \|\| loadedTrackId !== track\.id\)/)
  assert.match(advanceAfterPlaybackEnded, /activateCurrentTrack\(track/)
  assert.match(playQueueTrack, /activateCurrentTrack\(track, \{ resetUi: true, position: 0 \}\)/)
  assert.match(
    setupAudioEngineListeners,
    /api\.onPlaybackInfo\(\(info\) => \{\s*applyNativePlaybackInfo\(info\)\s*\}\)/
  )
  assert.match(setupAudioEngineListeners, /const startAt = pendingLoadStartTime/)
  assert.match(setupAudioEngineListeners, /pendingLoadStartTime = 0/)
  // Gapless auto-advance must refresh track identity even when nativePlaybackActive
  // briefly lags, otherwise cover + progress stick on the previous track.
  assert.match(setupAudioEngineListeners, /api\.onStartFile\(\(\) => \{/)
  assert.doesNotMatch(
    setupAudioEngineListeners.match(/api\.onStartFile\(\(\) => \{[\s\S]*?\n    \}\)/)?.[0] ?? '',
    /if \(!nativePlaybackActive\) return/
  )
  assert.match(setupAudioEngineListeners, /refreshPlaybackInfoAfterStartFile\(\)/)
  assert.match(setupAudioEngineListeners, /document\.addEventListener\('visibilitychange'/)
  assert.match(setupAudioEngineListeners, /window\.addEventListener\('focus'/)
  assert.match(refreshPlaybackInfoAfterStartFile, /START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS/)
  assert.match(refreshPlaybackInfoAfterStartFile, /api\.getPlaybackInfo\(\)/)
  assert.match(
    refreshPlaybackInfoAfterStartFile,
    /applyNativePlaybackInfo\(info, \{ applyTrackWhenInactive: true \}\)/
  )
  assert.match(refreshPlaybackInfoAfterStartFile, /currentTrack\.value\?\.id !== trackIdAtStart/)
  assert.match(refreshPlaybackAfterRendererResume, /getPlaybackInfo\(\)/)
  assert.match(refreshPlaybackAfterRendererResume, /retryCurrentTrackLyricsIfNeeded\(true\)/)
  assert.match(retryCurrentTrackLyricsIfNeeded, /lyricsLoadState\.value\.status === 'loading'/)
  assert.match(
    retryCurrentTrackLyricsIfNeeded,
    /ensureCurrentTrackLyricsLoaded\(track, true, forceReload\)/
  )
  // time-pos is routed through the shared fallback-aware policy: native engine
  // and delegated queues drive progress, while HTMLAudio fallback ignores the
  // native ghost clock so a second time source cannot freeze the bar.
  assert.match(
    setupAudioEngineListeners,
    /shouldApplyNativeTimePosition\(\{\s*nativePlaybackActive,\s*nativeQueueDelegated\s*\}\)/
  )
  assert.match(
    source,
    /import \{[^}]*shouldApplyNativeTimePosition[^}]*\} from '\.\/playerProgressPolicy\.ts'/
  )
  // onStartFile must apply playback-info but must not clear the switch intent —
  // clearing after an ignored previous-track snapshot re-opened the flash race.
  const onStartFile =
    setupAudioEngineListeners.match(/api\.onStartFile\(\(\) => \{[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(onStartFile, /refreshPlaybackInfoAfterStartFile\(\)/)
  assert.doesNotMatch(onStartFile, /clearNativePlaybackInfoIntent\(\)/)
  assert.match(source, /intentionalTrackGuard/)
  assert.match(source, /function markNativePlaybackInfoIntentConfirmed/)
})

test('native LIVE buffering maps sessionUnderrunCount rises onto isStreamBuffering', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const trackUtilsSource = readFileSync(
    new URL('../utils/playerTrackUtils.ts', import.meta.url),
    'utf8'
  )
  const applyNativeStreamBufferingFromInfo = extractInternalFunctionBody(
    source,
    'applyNativeStreamBufferingFromInfo'
  )
  const resetNativeStreamBufferingState = extractInternalFunctionBody(
    source,
    'resetNativeStreamBufferingState'
  )
  const isStreamLikeTrack = extractInternalFunctionBody(trackUtilsSource, 'isStreamLikeTrack')

  assert.match(source, /let lastNativeSessionUnderrunCount = 0/)
  assert.match(source, /let nativeStreamBufferingClearTimer/)
  assert.match(isStreamLikeTrack, /track\.source === 'radio'/)
  assert.match(isStreamLikeTrack, /track\.source === 'podcast'/)
  assert.match(applyNativeStreamBufferingFromInfo, /sessionUnderrunCount/)
  assert.match(applyNativeStreamBufferingFromInfo, /underruns > lastNativeSessionUnderrunCount/)
  assert.match(applyNativeStreamBufferingFromInfo, /isStreamBuffering\.value = true/)
  assert.match(applyNativeStreamBufferingFromInfo, /1500/)
  assert.match(resetNativeStreamBufferingState, /lastNativeSessionUnderrunCount = 0/)
  assert.match(resetNativeStreamBufferingState, /isStreamBuffering\.value = false/)
  // Load path and restore path clear sticky buffering state.
  assert.match(source, /resetNativeStreamBufferingState\(\)/)
})

test('player store does not pretend DSP bypass is strict bit-perfect mode', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const loadAndPlay = source.match(/async function loadAndPlay[\s\S]*?function next\(\)/)?.[0] ?? ''
  const setVolume = extractInternalFunctionBody(source, 'setVolume')

  assert.doesNotMatch(source, /strictBitPerfectMode/)
  assert.doesNotMatch(source, /function strictBitPerfectModeEnabled\(\)/)
  assert.doesNotMatch(loadAndPlay, /严格 Bit-Perfect 模式拒绝 renderer fallback/)
  assert.match(loadAndPlay, /isHtmlAudioFallbackAllowed/)
  assert.match(loadAndPlay, /原生音频引擎不可用：/)
  assert.match(loadAndPlay, /原生音频引擎不可用，已启用临时播放通道/)
  assert.match(loadAndPlay, /playWithRendererAudio\(/)
  assert.match(setVolume, /volume\.value = vol/)
})

test('player store keeps default volume at 0.7, persists softwareVolume, and exposes setUnityVolume', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const settingsSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const setUnityVolume = extractInternalFunctionBody(source, 'setUnityVolume')

  assert.match(source, /const volume = ref\(DEFAULT_SOFTWARE_VOLUME\)/)
  assert.match(source, /DEFAULT_SOFTWARE_VOLUME/)
  assert.match(source, /scheduleSoftwareVolumePersist/)
  assert.match(source, /createDebouncedVolumePersistence\(persistSoftwareVolume\)/)
  assert.match(source, /async function flushSoftwareVolumePersist\(\): Promise<void>/)
  assert.match(appSource, /await flushSoftwareVolumePersist\(\)/)
  assert.match(source, /updateSettings\(\{ softwareVolume: next \}\)/)
  assert.match(source, /watch\(\s*\(\) => appSettings\.value\.softwareVolume,/)
  assert.match(settingsSource, /softwareVolume: 0\.7/)
  assert.match(mainSettings, /softwareVolume: DEFAULT_SOFTWARE_VOLUME/)
  assert.match(mainSettings, /softwareVolume: clampNumber\(settings\.softwareVolume/)
  assert.match(source, /function setUnityVolume\(\): void/)
  assert.match(setUnityVolume, /setVolume\(1\)/)
  assert.doesNotMatch(source, /const volume = ref\(1\)/)
  assert.doesNotMatch(setUnityVolume, /ref\(1\)/)
})

test('player store exposes setOutputStage for HiFi sample-rate lock (graph.outputStage)', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const setOutputStage = extractInternalFunctionBody(source, 'setOutputStage')
  const refresh = extractInternalFunctionBody(source, 'refreshAudioOutputState')

  assert.match(source, /dspOutputStage/)
  assert.match(source, /DEFAULT_DSP_OUTPUT_STAGE/)
  assert.match(source, /async function setOutputStage\(/)
  assert.match(setOutputStage, /audioEngine\.setOutputStage/)
  assert.match(refresh, /getDspSceneState/)
})

test('local dashboard playback keeps a multi-track queue for next and previous controls', () => {
  const source = readFileSync(new URL('../components/LocalDashboard.vue', import.meta.url), 'utf8')
  const playDashboardTrack = source.match(/function playDashboardTrack[\s\S]*?\n}/)?.[0] ?? ''

  assert.match(source, /const heroTrack = computed<Track \| null>/)
  assert.match(source, /@click="handleHeroPlay"/)
  assert.match(source, /@click="playDashboardTrack\(track\)"/)
  assert.match(source, /@click="playDashboardTrack\(entry\.track\)"/)
  assert.match(playDashboardTrack, /DASHBOARD_QUEUE_WINDOW/)
  assert.match(playDashboardTrack, /tracks\.value\.slice\(queueStart, end\)/)
  assert.match(
    playDashboardTrack,
    /if \(sourceIndex < 0\) \{\s*playTrack\(track, \[track\]\)\s*return\s*\}/,
    'dashboard playback should only fall back to a single-track queue when the track is not in the local library'
  )
})

test('local dashboard keeps the restored editorial masthead in Chinese', () => {
  const source = readFileSync(new URL('../components/LocalDashboard.vue', import.meta.url), 'utf8')

  assert.match(source, /class="masthead-kicker"/)
  assert.match(source, /class="masthead-title"/)
  assert.match(source, /class="masthead-sub"/)
  assert.match(source, /本地音乐库/)
  assert.doesNotMatch(source, /Good (morning|afternoon|evening)/i)
})

test('playback session strips transient provider stream URLs before restore', () => {
  const sessionSource = readFileSync(
    new URL('./player/playbackSessionController.ts', import.meta.url),
    'utf8'
  )
  const sessionTrackSource = readFileSync(
    new URL('../utils/playerSessionTrack.ts', import.meta.url),
    'utf8'
  )

  assert.equal(
    /streamUrl: track\.source === 'ncm' \? null : track\.streamUrl/.test(sessionTrackSource),
    false,
    'provider URL stripping must not be limited to the built-in ncm provider'
  )
  assert.match(sessionTrackSource, /const source = getTrackSource\(track\)/)
  assert.match(
    sessionTrackSource,
    /streamUrl: source === 'local' \? track\.streamUrl : null/,
    'restored provider playback should resolve a fresh stream URL instead of reusing a stale proxy URL'
  )
  assert.match(sessionTrackSource, /bpm: track\.bpm/)
  assert.match(sessionTrackSource, /bpmAnalysis: track\.bpmAnalysis/)
  assert.match(
    sessionSource,
    /const track = options\.hydratePlaybackTrack\(cloneTrackForPlaybackSession\(session\.track\)\)/
  )
})

test('player store requests background BPM analysis and merges completed results', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const trackUtilsSource = readFileSync(
    new URL('../utils/playerTrackUtils.ts', import.meta.url),
    'utf8'
  )
  const setupSideEffects = extractInternalFunctionBody(source, 'setupPlayerIntegrationSideEffects')
  const requestBpmAnalysis = extractInternalFunctionBody(source, 'requestBpmAnalysisForTrack')
  const applyBpmAnalysis = extractInternalFunctionBody(source, 'applyBpmAnalysisToTrack')
  const clearBpmAnalysis = extractInternalFunctionBody(source, 'clearBpmAnalysisFromPlaybackState')

  assert.match(trackUtilsSource, /export function hasAnalyzedBpm\(/)
  assert.match(source, /function isAutoBpmAnalysisEnabled\(/)
  assert.match(trackUtilsSource, /export function isAnalyzableAudioPath\(/)
  assert.match(requestBpmAnalysis, /window\.api\?\.bpmAnalysis\?\.request/)
  assert.match(requestBpmAnalysis, /!isAutoBpmAnalysisEnabled\(\)/)
  assert.match(requestBpmAnalysis, /hasAnalyzedBpm\(track\)/)
  assert.match(requestBpmAnalysis, /!isAnalyzableAudioPath\(track\.filePath\)/)
  assert.match(requestBpmAnalysis, /referenceBpm: track\.bpm/)
  assert.match(applyBpmAnalysis, /currentTrack\.value = updatedTrack/)
  assert.match(applyBpmAnalysis, /patchTrackInQueues\(updatedTrack\)/)
  assert.match(applyBpmAnalysis, /useMusicStore\(\)\.applyBpmAnalysis/)
  assert.match(clearBpmAnalysis, /currentTrack\.value/)
  assert.match(clearBpmAnalysis, /queue\.value = queue\.value\.map/)
  assert.match(clearBpmAnalysis, /originalQueue\.value = originalQueue\.value\.map/)
  assert.match(clearBpmAnalysis, /useMusicStore\(\)\.clearBpmAnalysis\(\)/)
  assert.match(source, /clearBpmAnalysisFromPlaybackState: \(\) => void/)
  assert.match(setupSideEffects, /window\.api\?\.bpmAnalysis\?\.onCompleted/)
  assert.match(setupSideEffects, /requestBpmAnalysisForTrack\(track\)/)
})

test('playback failure tries a same-song fallback variant from the queue', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const handlePlaybackFallback = extractInternalFunctionBody(source, 'handlePlaybackFallback')
  const loadAndPlay = source.match(/async function loadAndPlay[\s\S]*?function next\(\)/)?.[0] ?? ''

  assert.match(
    source,
    /import \{ (?:clampProviderReliability, )?findPlaybackFallbackTrack \} from '\.\.\/utils\/playbackFallback\.ts'/
  )
  assert.match(handlePlaybackFallback, /findPlaybackFallbackTrack\(\{/)
  assert.match(handlePlaybackFallback, /failedTrack/)
  assert.match(handlePlaybackFallback, /candidates: queue\.value/)
  assert.match(handlePlaybackFallback, /sourceReliability: getProviderSourceReliability\(\)/)
  assert.match(handlePlaybackFallback, /queue\.value = queue\.value\.map/)
  assert.match(handlePlaybackFallback, /currentTrack\.value = fallback/)
  assert.match(handlePlaybackFallback, /await loadAndPlay\(fallback\)/)
  assert.match(loadAndPlay, /if \(await handlePlaybackFallback\(track, err, loadToken\)\) return/)
})

test('audio engine errors use the global notice channel instead of the player bar', () => {
  const storeSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../components/PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(storeSource, /function setAudioEngineError\(error: string \| null\): void/)
  assert.match(
    storeSource,
    /pushNotice\(\{ kind: isFallbackNotice \? 'warning' : 'error', message \}\)/
  )
  assert.doesNotMatch(source, /audioEngineError/)
  assert.doesNotMatch(source, /player-playback-diagnostic"[^>]*>[\s\S]*audioEngineError/)
})

test('audio visualizer iframe controls are wired to the player store', () => {
  const panelSource = readFileSync(
    new URL('../components/AudioVisualizerPanel.vue', import.meta.url),
    'utf8'
  )
  const visualizerSource = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(panelSource, /togglePlay,\s*next,\s*prev,\s*seek/)
  assert.match(panelSource, /const visualizerSrc = ref\(buildVisualizerSrc\(\)\)/)
  assert.match(panelSource, /function buildVisualizerSrc\(\): string/)
  assert.match(panelSource, /visualizerSrc\.value = buildVisualizerSrc\(\)/)
  assert.match(panelSource, /iframeReady\.value = false/)
  assert.match(panelSource, /event\.data\?\.kind !== 'control'/)
  assert.match(panelSource, /case 'togglePlay':\s*void togglePlay\(\)/)
  assert.match(panelSource, /case 'previous':\s*prev\(\)/)
  assert.match(panelSource, /case 'next':\s*next\(\)/)
  assert.match(panelSource, /case 'seek':[\s\S]*seek\(position\)/)
  assert.match(
    panelSource,
    /window\.api\.audioEngine\.getVisualizationData\(visualizationOptions\)/
  )
  assert.match(panelSource, /const VISUALIZER_ANALYSIS_POINTS = 4096/)
  assert.match(panelSource, /spectrumPoints: VISUALIZER_ANALYSIS_POINTS/)
  assert.match(panelSource, /const VISUALIZER_BAR_COUNT = 140/)
  assert.match(panelSource, /visualizerBarCount: VISUALIZER_BAR_COUNT/)
  assert.match(panelSource, /spectrogramFrames: 0/)
  assert.match(panelSource, /oscilloscopePoints: 0/)
  assert.match(panelSource, /VISUALIZER_POLL_INTERVAL_MS = 50/)
  assert.match(panelSource, /function scheduleVisualizationFrame\(delayMs = 0\)/)
  assert.match(panelSource, /visualizationTimer = window\.setTimeout\(async \(\) => \{/)
  assert.match(panelSource, /await pollVisualizationFrame\(\)/)
  assert.match(panelSource, /scheduleVisualizationFrame\(VISUALIZER_POLL_INTERVAL_MS\)/)
  assert.match(panelSource, /window\.clearTimeout\(visualizationTimer\)/)
  assert.doesNotMatch(panelSource, /window\.setInterval\(/)
  assert.match(panelSource, /CONTROL_VISUALIZATION_PAUSE_MS = 220/)
  assert.match(panelSource, /let visualizationPausedUntil = 0/)
  assert.match(panelSource, /if \(performance\.now\(\) < visualizationPausedUntil\) return/)
  assert.match(panelSource, /function pauseVisualizationForControl\(\)/)
  assert.match(panelSource, /pauseVisualizationForControl\(\)/)
  assert.match(panelSource, /audioEngineReady/)
  assert.match(panelSource, /const shouldPollVisualization = computed/)
  assert.match(
    panelSource,
    /props\.active &&\s*iframeReady\.value &&\s*documentVisible\.value &&\s*isPlaying\.value &&\s*audioEngineReady\.value &&\s*currentTrack\.value/
  )
  assert.match(
    panelSource,
    /if \(visualizerUnmounted \|\| !shouldPollVisualization\.value \|\| visualizationRequestInFlight\) return/
  )
  assert.match(panelSource, /function syncVisualizationPolling\(\)/)
  assert.match(panelSource, /postInactiveVisualizationFrame\(\)/)
  assert.doesNotMatch(panelSource, /Float32Array\.from\(v\.spectrum\)/)
  assert.match(panelSource, /Float32Array\.from\(v\.waveform\)/)
  assert.match(
    panelSource,
    /if \(v\.tapStatus === 'synthetic-fallback'\) \{[\s\S]*postInactiveVisualizationFrame\(\)[\s\S]*return/
  )
  assert.doesNotMatch(
    panelSource,
    /if \(v\.tapStatus !== 'synthetic-fallback'\) \{[\s\S]*tempoEstimator\.pushFrame/
  )
  assert.match(panelSource, /v\.visualizerBars/)
  assert.doesNotMatch(panelSource, /function mapSpectrumToVisualizerBars/)
  assert.match(panelSource, /const bars = Float32Array\.from\(v\.visualizerBars \?\? \[\]\)/)
  assert.doesNotMatch(panelSource, /function spectrumValueToAmplitude/)
  assert.doesNotMatch(panelSource, /function amplitudeToVisualizerLevel/)
  assert.doesNotMatch(panelSource, /function applyVisualizerSpectralContrast/)
  assert.doesNotMatch(panelSource, /spectralTilt/)
  assert.doesNotMatch(panelSource, /subBinTexture/)
  assert.match(panelSource, /\[bars\.buffer, waveform\.buffer\]/)
  assert.match(panelSource, /kind: 'spectrum'/)
  assert.doesNotMatch(panelSource, /data: spectrum/)
  assert.match(panelSource, /bars,/)
  assert.match(panelSource, /waveform,/)
  assert.match(panelSource, /startVisualizationPolling\(\)/)

  assert.match(visualizerSource, /let dataArray = new Float32Array\(4096\)/)
  assert.match(visualizerSource, /let precomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/)
  assert.match(
    visualizerSource,
    /let previousPrecomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/
  )
  assert.match(
    visualizerSource,
    /let displayPrecomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/
  )
  assert.match(visualizerSource, /let precomputedBarsTransitionStartedAt = performance\.now\(\)/)
  assert.match(visualizerSource, /const PRECOMPUTED_BAR_TRANSITION_MS = 48/)
  assert.match(visualizerSource, /let usingPrecomputedBars = false/)
  assert.match(visualizerSource, /function currentPrecomputedBarValue\(/)
  assert.match(visualizerSource, /function retargetPrecomputedBars\(/)
  assert.match(visualizerSource, /progress \* progress \* \(3 - 2 \* progress\)/)
  assert.match(visualizerSource, /const binWidth = sampleRate \/ fftSize/)
  assert.doesNotMatch(visualizerSource, /function spectrumValueToAmplitude\(value\)/)
  assert.doesNotMatch(visualizerSource, /function amplitudeToVisualizerLevel\(amplitude\)/)
  assert.doesNotMatch(visualizerSource, /function applyVisualizerSpectralContrast\(bars\)/)
  assert.doesNotMatch(visualizerSource, /weightedSquares \+= amplitude \* amplitude \* overlap/)
  assert.doesNotMatch(
    visualizerSource,
    /amplitudeToVisualizerLevel\(rms \* 0\.85 \+ peak \* 0\.15\)/
  )
  assert.doesNotMatch(
    visualizerSource,
    /rawComputedBars = applyVisualizerSpectralContrast\(rawComputedBars\)/
  )
  assert.doesNotMatch(visualizerSource, /subBinTexture/)
  assert.doesNotMatch(visualizerSource, /spectralTilt/)
  assert.match(visualizerSource, /const barSpacing = 1\.5/)
  assert.match(visualizerSource, /const totalSpacing = barSpacing \* \(barCount - 1\)/)
  assert.match(visualizerSource, /const barWidth = \(width - totalSpacing\) \/ barCount/)
  assert.match(
    visualizerSource,
    /function buildLogFrequencyBinCenters\(barCount, sampleRate, fftSize\)/
  )
  assert.match(
    visualizerSource,
    /const frequency = minF \* Math\.pow\(frequencyRatio, i \/ frequencyStepCount\)/
  )
  assert.match(visualizerSource, /spectrumBinCenters\[i\] = frequency \/ binWidth/)
  assert.match(visualizerSource, /const valLow = \(dataArray\[indexLow\] \|\| 0\) \* 255/)
  assert.match(visualizerSource, /const valHigh = \(dataArray\[indexHigh\] \|\| 0\) \* 255/)
  assert.match(visualizerSource, /const val = valLow \+ \(valHigh - valLow\) \* fract/)
  assert.match(visualizerSource, /let sourceLevels = new Float32Array\(SPECTRUM_BAR_COUNT\)/)
  assert.match(visualizerSource, /currentPrecomputedBarValue\(i, now\)/)
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawComputedBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawPrecomputedBars, binCenters, contourPhase\)/
  )
  assert.doesNotMatch(visualizerSource, /SPECTRUM_GAIN_TARGET_MIX/)
  assert.doesNotMatch(visualizerSource, /const sourceFloorLevel = frameContrastFloor/)
  assert.doesNotMatch(visualizerSource, /const sourceLevel = expandFrameContrast/)
  assert.doesNotMatch(visualizerSource, /adaptiveDisplayGain/)
  assert.match(visualizerSource, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
  assert.doesNotMatch(visualizerSource, /Math\.max\(lastSpectrumHeights\[i\], 2\)/)
  assert.match(visualizerSource, /i \* \(barWidth \+ barSpacing\)/)
  assert.match(visualizerSource, /specCtx\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/)
  assert.match(visualizerSource, /new ResizeObserver\(resizeCanvases\)/)
  assert.match(visualizerSource, /function isNumericSequence\(value\)/)
  assert.match(visualizerSource, /ArrayBuffer\.isView\(value\)/)
  assert.match(
    visualizerSource,
    /const incomingBars = isNumericSequence\(msg\.bars\) \? msg\.bars : null/
  )
  assert.match(visualizerSource, /\? Math\.max\(0, Math\.min\(1, incomingBars\[i\]\)\)/)
  assert.match(visualizerSource, /retargetPrecomputedBars\(incomingBars\)/)
  assert.doesNotMatch(visualizerSource, /\? Math\.max\(0, incomingBars\[i\]\)/)
  assert.match(visualizerSource, /usingPrecomputedBars = true/)
  assert.match(visualizerSource, /usingPrecomputedBars = false/)
  assert.match(visualizerSource, /if \(msg\.active === false\) \{/)
  assert.doesNotMatch(visualizerSource, /msg\.active === false \|\| !isPlaying/)
  assert.match(visualizerSource, /let spectrumAnimationFrame = 0/)
  assert.match(visualizerSource, /const SPECTRUM_ATTACK_SECONDS = 0\.014/)
  assert.match(visualizerSource, /const SPECTRUM_DECAY_SECONDS = 0\.16/)
  assert.match(visualizerSource, /const SPECTRUM_BAR_COUNT = 140/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_GAIN = 1\.32;/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_RANGE = 1\.42/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_GAMMA = 0\.78/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_HEADROOM = 1/)
  assert.match(visualizerSource, /const SPECTRUM_CONTRAST_FLOOR = 0\.16/)
  assert.match(visualizerSource, /const SPECTRUM_CONTRAST_POWER = 0\.68/)
  assert.match(visualizerSource, /let lowFrequencyContourPhase = 0/)
  assert.match(visualizerSource, /function updateLowFrequencyContourPhase\(rawBars, deltaSeconds\)/)
  assert.match(visualizerSource, /justify-content: flex-start;/)
  assert.match(visualizerSource, /flex: 0 0 calc\(250px \+ var\(--spectrum-top-growth\)\);/)
  assert.match(visualizerSource, /height: calc\(250px \+ var\(--spectrum-top-growth\)\);/)
  assert.doesNotMatch(visualizerSource, /\.spectrum-outer-container \{[^}]*flex-grow: 1;/)
  assert.match(visualizerSource, /const SPECTRUM_HEIGHT_SCALE = 1/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_BAR_LIMIT = 72/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_FLAT_RANGE = 0\.2/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_BASE_DEPTH = 0\.24/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_DEPTH = 0\.52/)
  assert.match(
    visualizerSource,
    /const tertiary = Math\.sin\(\(barIndex \+ 1\) \* 2\.37 \+ phase \* 0\.9\)/
  )
  assert.match(visualizerSource, /function visualizerDisplayLevel\(value\)/)
  assert.doesNotMatch(visualizerSource, /function smoothPeakSourceLevel/)
  assert.doesNotMatch(visualizerSource, /function frameContrastFloor/)
  assert.doesNotMatch(visualizerSource, /function expandFrameContrast/)
  assert.match(
    visualizerSource,
    /return Math\.pow\(level, SPECTRUM_DISPLAY_GAMMA\) \* SPECTRUM_DISPLAY_HEADROOM/
  )
  assert.match(
    visualizerSource,
    /function applyLowFrequencyShelfContour\(rawBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawComputedBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawPrecomputedBars, binCenters, contourPhase\)/
  )
  assert.match(visualizerSource, /lowFrequencyContourPhase: contourPhase/)
  assert.match(visualizerSource, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
  assert.match(
    visualizerSource,
    /const targetHeight = \(val \/ 255\) \* height \* SPECTRUM_HEIGHT_SCALE/
  )
  assert.match(visualizerSource, /window\.__twilightVisualizerDebug = \(\) => lastSpectrumDebug/)
  assert.match(visualizerSource, /function smoothSpectrumHeight\(/)
  assert.match(visualizerSource, /1 - Math\.exp\(-deltaSeconds \/ smoothingSeconds\)/)
  assert.match(
    visualizerSource,
    /lastSpectrumHeights\[i\] = smoothSpectrumHeight\(\s*lastSpectrumHeights\[i\],\s*targetHeight,\s*deltaSeconds\s*\)/
  )
  assert.match(visualizerSource, /function startSpectrumLoop\(\)/)
  assert.match(visualizerSource, /function stopSpectrumLoop\(\)/)
  assert.match(visualizerSource, /cancelAnimationFrame\(spectrumAnimationFrame\)/)
  assert.match(visualizerSource, /spectrumAnimationFrame = requestAnimationFrame\(drawSpectrum\)/)
  assert.doesNotMatch(
    visualizerSource,
    /function drawSpectrum\(\) \{\s*requestAnimationFrame\(drawSpectrum\)/
  )
  assert.match(
    visualizerSource,
    /if \(msg\.active === false\) \{[\s\S]*if \(isPlaying\) \{[\s\S]*dataArray\.fill\(0\)[\s\S]*startSpectrumLoop\(\)[\s\S]*\} else \{[\s\S]*lastSpectrumHeights\.fill\(0\)[\s\S]*stopSpectrumLoop\(\)[\s\S]*renderSpectrumFrame\(performance\.now\(\)\)/
  )
  assert.match(visualizerSource, /function postHostControl\(action, payload = \{\}\)/)
  assert.match(visualizerSource, /waveCtx\.strokeStyle = 'rgba\(60, 62, 68, 0\.78\)'/)
  assert.match(visualizerSource, /waveCtx\.lineWidth = 1\.35/)
  assert.match(visualizerSource, /waveCtx\.lineTo\(x, y\)/)
  assert.match(visualizerSource, /const amplitudeScale = height \* 0\.38/)
  assert.match(visualizerSource, /const visualGain = maxAbs > 0/)
  assert.match(visualizerSource, /Math\.min\(3\.2, Math\.max\(1, 0\.72 \/ maxAbs\)\)/)
  assert.doesNotMatch(visualizerSource, /const barWidth = Math\.max\(1, step - gap\)/)
  assert.doesNotMatch(visualizerSource, /waveCtx\.fillRect\(x, y, barWidth, h\)/)
  assert.doesNotMatch(visualizerSource, /background: #111827/)
  assert.match(visualizerSource, /kind: 'control'/)
  assert.match(visualizerSource, /btnPlayPause\.addEventListener\('click'[\s\S]*'togglePlay'/)
  assert.match(visualizerSource, /btn-prev'\)\.addEventListener\('click'[\s\S]*'previous'/)
  assert.match(visualizerSource, /btn-next'\)\.addEventListener\('click'[\s\S]*'next'/)
  assert.match(
    visualizerSource,
    /scrubber\.addEventListener\('click'[\s\S]*postHostControl\('seek', \{ position \}\)/
  )
})

test('player bar exposes a HiFi console drawer instead of visualization meters', () => {
  const playerBarSource = readFileSync(
    new URL('../components/PlayerBar.vue', import.meta.url),
    'utf8'
  )
  const hifiSidebarSource = readFileSync(
    new URL('../components/player-bar/HiFiSidebar.vue', import.meta.url),
    'utf8'
  )

  assert.match(playerBarSource, /import HiFiSidebar from '\.\/player-bar\/HiFiSidebar\.vue'/)
  assert.match(playerBarSource, /<HiFiSidebar/)
  assert.match(playerBarSource, /class="hifi-overlay"/)
  assert.match(playerBarSource, /title="HiFi 控制台"/)
  assert.match(playerBarSource, /ph ph-faders/)
  assert.match(playerBarSource, /openEqualizer/)
  assert.match(playerBarSource, /onReloadLyrics/)
  assert.match(playerBarSource, /setAudioDevice/)
  assert.match(playerBarSource, /setUnityVolume/)
  assert.match(playerBarSource, /volume-unity-btn/)
  assert.match(playerBarSource, /@set-unity-volume="setUnityVolume"/)
  assert.doesNotMatch(playerBarSource, /const visualizationStateText = computed/)
  assert.doesNotMatch(playerBarSource, /class="visualization-panel"/)
  assert.doesNotMatch(playerBarSource, /oscilloscopeCanvasRef/)
  assert.doesNotMatch(playerBarSource, /spectrogramCanvasRef/)
  assert.match(hifiSidebarSource, /链路|Signal Path/)
  assert.match(hifiSidebarSource, /Master DSP|DSP/)
  assert.match(hifiSidebarSource, /输出|Devices/)
  assert.match(hifiSidebarSource, /歌词|Lyrics/)
  assert.match(hifiSidebarSource, /Sleep Timer|定时/)
  assert.match(hifiSidebarSource, /Playback Rate|倍速/)
  assert.match(hifiSidebarSource, /A-B Loop|A-B/)
  assert.match(hifiSidebarSource, /Cast \/ DLNA|投送|DLNA/)
  assert.match(hifiSidebarSource, /Bookmarks|书签/)
  assert.match(hifiSidebarSource, /id: 'tools'/)
  assert.match(playerBarSource, /@cycle-playback-rate="cyclePlaybackRate"/)
  assert.match(playerBarSource, /@toggle-ab-loop="toggleAbLoopAtCurrentTime"/)
  assert.match(playerBarSource, /@sleep-timer-select="onSleepTimerSelectValue"/)
  assert.match(playerBarSource, /@refresh-cast-devices="refreshCastDevices"/)
  assert.match(playerBarSource, /@add-bookmark="onAddBookmark"/)
  // Playbar destroys the left rail on track identity change so cover art remounts.
  assert.match(playerBarSource, /playerLeftKey/)
  assert.match(playerBarSource, /:key="playerLeftKey"/)
  assert.match(playerBarSource, /CoverImg/)
  assert.doesNotMatch(playerBarSource, /coverLoadFailed/)
  assert.match(playerBarSource, /progress:\$\{currentTrack\.id\}/)
  assert.doesNotMatch(playerBarSource, /class="sleep-timer-select"/)
  assert.doesNotMatch(playerBarSource, /class="cast-anchor"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn ab-loop-btn"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn rate-btn"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn bookmark-btn"/)
  assert.doesNotMatch(playerBarSource, /@click="toggleMute"/)
  assert.match(hifiSidebarSource, /setUnityVolume/)
  assert.match(hifiSidebarSource, /HIFI_STATUS_COPY\.unityButton/)
  assert.match(hifiSidebarSource, /volume_not_unity/)
  assert.match(hifiSidebarSource, /VOLUME_NORMALIZATION_OPTIONS/)
  assert.match(hifiSidebarSource, /openEqualizer/)
  assert.match(hifiSidebarSource, /DSP_OUTPUT_SAMPLE_RATE_OPTIONS/)
  assert.match(hifiSidebarSource, /OUTPUT STAGE|Output Stage|采样率锁/)
  assert.match(playerBarSource, /dsp-output-stage/)
  assert.match(playerBarSource, /@set-output-stage="setOutputStage"/)
})

test('player bar visualization polling stays light and stops behind the full visualizer', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const pollingSource = readFileSync(
    new URL('./player/useVisualizationPolling.ts', import.meta.url),
    'utf8'
  )

  assert.match(pollingSource, /spectrumPoints: 64/)
  assert.match(pollingSource, /waveformPoints: 48/)
  assert.match(pollingSource, /spectrogramFrames: 32/)
  assert.match(pollingSource, /oscilloscopePoints: 512/)
  assert.match(pollingSource, /if \(options\.active\.value\) return/)
  assert.match(pollingSource, /let pollingGeneration = 0/)
  assert.match(pollingSource, /const generation = pollingGeneration/)
  assert.match(pollingSource, /if \(generation !== pollingGeneration\) return/)
  assert.match(pollingSource, /pollingGeneration \+= 1/)
  assert.match(source, /createVisualizationPolling\(/)
  assert.match(source, /stopVisualizationPolling\(/)
  assert.match(source, /startVisualizationPolling\(/)
  assert.match(
    source,
    /\[isPlaying, audioEngineReady, \(\) => currentTrack\.value\?\.id, visualizerActive\]/
  )
})

test('audio service recovery uses the global notice channel instead of the player bar', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playerBarSource = readFileSync(
    new URL('../components/PlayerBar.vue', import.meta.url),
    'utf8'
  )

  assert.match(source, /const audioEngineRecoveryNotice = ref/)
  assert.match(source, /function publishAudioEngineRecoveryNotice/)
  assert.match(source, /pushNotice\(\{/)
  assert.match(source, /kind: notice\.kind === 'service-crash'/)
  assert.match(source, /label: notice\.actionLabel \|\| '继续播放'/)
  assert.match(source, /run: \(\) => void togglePlayState\(\)/)
  assert.match(source, /sticky: notice\.kind === 'service-crash' \|\| notice\.canResume === false/)
  assert.match(source, /function setAudioServiceCrashNotice/)
  assert.match(source, /function setAudioServiceReadyNotice/)
  assert.match(source, /outputRouteSynced/)
  assert.match(source, /restoreErrors/)
  assert.match(source, /canResume: outputRouteSynced/)
  assert.match(source, /api\.onServiceCrash/)
  assert.match(source, /api\.onServiceReady/)
  assert.match(source, /message\.includes\('音频服务已重启'\)/)
  assert.doesNotMatch(playerBarSource, /audioEngineRecoveryNotice/)
  assert.doesNotMatch(playerBarSource, /关闭恢复提示/)
})

test('renderer audio device normalization derives tri-state capability fallbacks', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const normalizeSource = readFileSync(
    new URL('./player/audioOutputNormalize.ts', import.meta.url),
    'utf8'
  )
  const helper = extractInternalFunctionBody(normalizeSource, 'normalizeAudioDeviceOptions')

  assert.match(normalizeSource, /function deriveDopSupportState/)
  assert.match(normalizeSource, /function deriveNativeDsdSupportState/)
  assert.match(normalizeSource, /fallbackBackend: AudioOutputId \| '' = ''/)
  assert.match(normalizeSource, /id\.startsWith\('hw:'\)/)
  assert.match(
    source,
    /normalizeAudioDeviceOptions\(\s*state\.deviceOptions,\s*state\.device,\s*state\.output\s*\)/
  )
  assert.match(normalizeSource, /dopSupportState: 'runtime-probed'/)
  assert.match(normalizeSource, /nativeDsdSupportState: 'unsupported'/)
  assert.match(
    helper,
    /withAudioCapabilitySupportStates\(\s*\{\s*id,\s*label: formatAudioDeviceLabel\(id\),\s*isDefault: id === 'auto'\s*\},\s*selectedOutput\s*\)/
  )
  assert.match(
    helper,
    /withAudioCapabilitySupportStates\(\s*\{\s*\.\.\.\(record as Partial<AudioDeviceOption>\),/
  )
  assert.doesNotMatch(helper, /id: selectedDevice/)
})

test('renderer audio device normalization uses native names and omits stale selected devices', () => {
  const canonicalAsioId = 'asio:{6b3ba606-8664-4426-8994-0f1d9d12a345}'
  const options = normalizeAudioDeviceOptions(
    [
      {
        id: 'auto',
        label: '系统默认',
        isDefault: true
      },
      {
        id: canonicalAsioId,
        label: '',
        name: 'FiiO ASIO Driver',
        backend: 'asio',
        isDefault: false,
        pathKind: 'asio'
      }
    ],
    'asio:{stale-device}',
    'asio'
  )

  assert.equal(options.find((device) => device.id === canonicalAsioId)?.label, 'FiiO ASIO Driver')
  assert.equal(
    options.some((device) => device.id === 'asio:{stale-device}'),
    false
  )
})

test('dominant cover color extraction ignores stale async results', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')

  assert.match(source, /let dominantColorRequestId = 0/)
  assert.match(source, /const requestId = \+\+dominantColorRequestId/)
  // Resolve durable coverSource (or re-grant) before sampling so restored NCM
  // sessions do not blank the playbar accent from a dead twilight-media token.
  assert.match(source, /const displayCover = await resolveCover\(cover, coverSource\)/)
  assert.match(source, /await extractDominantColor\(displayCover\)/)
  assert.match(source, /requestId !== dominantColorRequestId/)
  assert.match(source, /currentTrack\.value\?\.cover !== cover/)
  assert.match(source, /currentTrack\.value\?\.coverSource !== coverSource/)
  assert.match(source, /appSettings\.value\?\.useCoverTheme/)
})

test('audio output refresh reruns when hotplug arrives during an in-flight request', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const helper = extractInternalFunctionBody(source, 'refreshAudioOutputState')

  assert.match(source, /let audioEngineStateRefreshQueued = false/)
  assert.match(
    helper,
    /if \(audioEngineStateRequest\) \{\s*audioEngineStateRefreshQueued = true\s*return audioEngineStateRequest\s*\}/
  )
  assert.match(helper, /audioEngineStateRefreshQueued = false[\s\S]*api\.getAudioOutputState\(\)/)
  assert.match(helper, /audioEngineStateRequest = null/)
  assert.match(
    helper,
    /if \(audioEngineStateRefreshQueued\) \{\s*await refreshAudioOutputState\(\)\s*\}/
  )
})

test('playback fallback ranks provider variants by playback url health', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playbackFallbackSource = readFileSync(
    new URL('../utils/playbackFallback.ts', import.meta.url),
    'utf8'
  )
  const helper = extractInternalFunctionBody(source, 'getProviderSourceReliability')
  const handlePlaybackFallback = extractInternalFunctionBody(source, 'handlePlaybackFallback')

  assert.match(helper, /useMediaProviders\(\)\.list\(\)/)
  assert.match(helper, /provider\.health\?\.methodStats\?\.getPlaybackUrl\?\.successRate/)
  assert.match(helper, /provider\.health\?\.successRate/)
  assert.match(helper, /reliability\[provider\.id\] = clampProviderReliability/)
  assert.match(playbackFallbackSource, /export function clampProviderReliability\(/)
  assert.match(handlePlaybackFallback, /sourceReliability: getProviderSourceReliability\(\)/)
})

test('provider playback failure searches provider results to rematch expired ids when queue fallback misses', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const handleProviderRematchFallback = extractInternalFunctionBody(
    source,
    'handleProviderRematchFallback'
  )
  const handlePlaybackFallback = extractInternalFunctionBody(source, 'handlePlaybackFallback')

  assert.match(
    source,
    /import \{[\s\S]*findProviderRematchCandidate[\s\S]*\} from '\.\.\/utils\/libraryRepair\.ts'/
  )
  assert.match(
    handlePlaybackFallback,
    /await handleProviderRematchFallback\(failedTrack, loadToken\)/
  )
  assert.match(handleProviderRematchFallback, /useMediaProviders\(\)\.searchAllSongs\(\{/)
  assert.match(
    handleProviderRematchFallback,
    /findProviderRematchCandidate\(failedTrack, candidates\)/
  )
  assert.match(handleProviderRematchFallback, /queue\.value = queue\.value\.map/)
  assert.match(handleProviderRematchFallback, /currentTrack\.value = rematched/)
  assert.match(handleProviderRematchFallback, /await loadAndPlay\(rematched\)/)
})

test('missing local playback searches provider results instead of stopping at the local file error', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const handleProviderRematchFallback = extractInternalFunctionBody(
    source,
    'handleProviderRematchFallback'
  )

  assert.doesNotMatch(handleProviderRematchFallback, /if \(failedSource === 'local'\) return false/)
  assert.match(
    handleProviderRematchFallback,
    /failedSource === 'local'\s*\?\s*getTrackSource\(track\) !== 'local'/
  )
  assert.match(handleProviderRematchFallback, /已重新匹配到/)
})

test('play mode is persisted in settings and restored on launch', () => {
  const playerSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const queueSource = readFileSync(
    new URL('./player/playbackQueueController.ts', import.meta.url),
    'utf8'
  )
  const settingsTypes = readFileSync(
    new URL('../../../shared/audioEngineTypes.ts', import.meta.url),
    'utf8'
  )
  const settingsStoreSource = readFileSync(
    new URL('./useSettingsStore.ts', import.meta.url),
    'utf8'
  )
  const mainSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const setPlayModeInternal = extractInternalFunctionBody(playerSource, 'setPlayModeInternal')
  const advanceAfterPlaybackEnded = extractInternalFunctionBody(
    playerSource,
    'advanceAfterPlaybackEnded'
  )

  assert.match(
    settingsTypes,
    /export type PlayMode = 'sequential' \| 'listLoop' \| 'repeat' \| 'shuffle' \| 'heart'/
  )
  assert.match(settingsTypes, /playMode: PlayMode/)
  assert.match(settingsStoreSource, /playMode: 'sequential'/)
  assert.match(mainSource, /import type \{ PlayMode \} from '\.\.\/audioEngineManager'/)
  assert.match(mainSource, /export function normalizePlayMode\(mode: unknown\): PlayMode/)
  assert.match(mainSource, /playMode: normalizePlayMode\(settings\.playMode\)/)
  assert.match(playerSource, /import type \{[\s\S]*PlayMode[\s\S]*\} from '\.\.\/types\/settings'/)
  assert.match(playerSource, /watch\(\s*\(\) => appSettings\.value\.playMode,/)
  const queueNativePlayModeSync = extractInternalFunctionBody(
    playerSource,
    'queueNativePlayModeSync'
  )
  const applyPendingRendererPlayModeAtBoundary = extractInternalFunctionBody(
    queueSource,
    'applyPendingRendererPlayModeAtBoundary'
  )
  const next = extractInternalFunctionBody(playerSource, 'next')
  const previous = extractInternalFunctionBody(playerSource, 'previous')
  const loadAndPlay =
    playerSource.match(/async function loadAndPlay[\s\S]*?function next\(\)/)?.[0] ?? ''

  assert.match(setPlayModeInternal, /if \(mode === playMode\.value\) return/)
  assert.match(setPlayModeInternal, /rendererPlayModeBoundaryPending\.value = true/)
  assert.match(setPlayModeInternal, /void updateSettings\(\{ playMode: mode \}\)/)
  assert.match(setPlayModeInternal, /queueNativePlayModeSync\(mode\)/)
  assert.doesNotMatch(setPlayModeInternal, /queueNativeQueueStateSync\(/)
  assert.doesNotMatch(setPlayModeInternal, /loadQueue\(/)
  assert.doesNotMatch(setPlayModeInternal, /playQueueTrack\(|loadAndPlay\(/)
  assert.match(
    queueNativePlayModeSync,
    /mode === 'repeat' \|\| mode === 'shuffle' \? mode : 'sequential'/
  )
  assert.match(queueNativePlayModeSync, /window\.api\.audioEngine\.setPlayMode\(nativePlayMode\)/)
  assert.doesNotMatch(queueNativePlayModeSync, /loadQueue\(/)
  assert.match(
    applyPendingRendererPlayModeAtBoundary,
    /rendererPlayModeBoundaryPending\.value = false/
  )
  assert.match(
    applyPendingRendererPlayModeAtBoundary,
    /track\.queueEntryId === current\.queueEntryId/
  )
  assert.match(
    applyPendingRendererPlayModeAtBoundary,
    /originalQueue\.value\.findIndex\(\(track\) => track\.id === current\.id\)/
  )
  assert.match(
    applyPendingRendererPlayModeAtBoundary,
    /queue\.value = \[current, \.\.\.shuffleArray\(remaining\)\]/
  )
  assert.match(advanceAfterPlaybackEnded, /applyPendingRendererPlayModeAtBoundary\(\)/)
  assert.match(next, /applyPendingRendererPlayModeAtBoundary\(\)/)
  assert.match(previous, /applyPendingRendererPlayModeAtBoundary\(\)/)
  assert.match(
    loadAndPlay,
    /playMode\.value === 'repeat' \|\| playMode\.value === 'shuffle'[\s\S]*await window\.api\.audioEngine\.setPlayMode\(nativePlayMode\)/
  )
  assert.match(
    playerSource,
    /const modes: PlayMode\[\] = \['sequential', 'listLoop', 'repeat', 'shuffle', 'heart'\]/
  )
  assert.match(
    advanceAfterPlaybackEnded,
    /playMode\.value === 'listLoop' \|\| playMode\.value === 'shuffle'/
  )
})

test('heart mode is gated to the liked NCM playlist and drives smart-list playback', () => {
  const playerSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const cyclePlayMode = extractInternalFunctionBody(playerSource, 'cyclePlayMode')
  const setPlayModeInternal = extractInternalFunctionBody(playerSource, 'setPlayModeInternal')
  const enterHeartMode = extractInternalFunctionBody(playerSource, 'enterHeartMode')
  const refillHeartQueue = extractInternalFunctionBody(playerSource, 'refillHeartQueue')
  const next = extractInternalFunctionBody(playerSource, 'next')
  const advanceAfterPlaybackEnded = extractInternalFunctionBody(
    playerSource,
    'advanceAfterPlaybackEnded'
  )
  const advanceHeartPlayback = extractInternalFunctionBody(playerSource, 'advanceHeartPlayback')
  const syncNativeQueueState = extractInternalFunctionBody(playerSource, 'syncNativeQueueState')

  // 可用性只取决于“我喜欢的音乐”歌单上下文 + 网易云流媒体曲目。
  assert.match(
    playerSource,
    /heartModeContext\.value\.likedPlaylistId != null[\s\S]*getTrackSource\(currentTrack\.value\) === 'ncm'/
  )
  assert.match(playerSource, /function setHeartModeContext\(playlistId: number \| null\): void/)
  assert.match(
    cyclePlayMode,
    /heartModeAvailable\.value \? modes : modes\.filter\(\(mode\) => mode !== 'heart'\)/
  )
  assert.match(
    setPlayModeInternal,
    /if \(mode === 'heart'\) \{[\s\S]*if \(!heartModeAvailable\.value\) return/
  )
  assert.match(playerSource, /let heartModeFetchRequest: Promise<number> \| null = null/)
  assert.match(playerSource, /function fetchHeartRecommendations[\s\S]*fetchIntelligenceList/)
  assert.match(playerSource, /function enterHeartMode[\s\S]*fetchHeartRecommendations/)
  assert.match(enterHeartMode, /commitHeartQueue\(\[seed\]\)/)
  assert.match(refillHeartQueue, /if \(heartModeFetchRequest\) return heartModeFetchRequest/)
  assert.match(refillHeartQueue, /heartModeFetchRequest = request/)
  assert.match(
    advanceHeartPlayback,
    /if \(playMode\.value !== 'heart'\) \{[\s\S]*await advanceAfterPlaybackEnded\(\)/
  )
  assert.match(next, /if \(playMode\.value === 'heart'\) \{[\s\S]*advanceHeartPlayback\(\)/)
  assert.match(
    advanceAfterPlaybackEnded,
    /if \(playMode\.value === 'heart'\) \{[\s\S]*advanceHeartPlayback\(\)/
  )
  // 心动模式边界由渲染层处理：原生引擎只加载当前曲目且不代管队列。
  assert.match(syncNativeQueueState, /queue: heartModeActive \? \[current\] : snapshot\.queue/)
  assert.match(
    syncNativeQueueState,
    /nativeQueueDelegated = heartModeActive \? false : preparedQueue\.delegated/
  )
})

test('playback end auto-advance stops at queue end without changing manual next wrap', () => {
  const playerSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const handlePlaybackEnded = extractInternalFunctionBody(playerSource, 'handlePlaybackEnded')
  const handleNativePlaybackEnded = extractInternalFunctionBody(
    playerSource,
    'handleNativePlaybackEnded'
  )
  const advanceAfterPlaybackEnded = extractInternalFunctionBody(
    playerSource,
    'advanceAfterPlaybackEnded'
  )
  const setupAudioEngineListeners = extractInternalFunctionBody(
    playerSource,
    'setupAudioEngineListeners'
  )
  const next = extractInternalFunctionBody(playerSource, 'next')
  const scheduleCrossfadeIfNeeded = extractInternalFunctionBody(
    playerSource,
    'scheduleCrossfadeIfNeeded'
  )

  assert.match(handlePlaybackEnded, /advanceAfterPlaybackEnded\(\)/)
  assert.doesNotMatch(handlePlaybackEnded, /\n\s*next\(\)/)
  assert.match(advanceAfterPlaybackEnded, /const nextIndex = queueIndex\.value \+ 1/)
  assert.match(advanceAfterPlaybackEnded, /nextIndex < queue\.value\.length/)
  assert.match(advanceAfterPlaybackEnded, /isPlaying\.value = false/)
  assert.match(advanceAfterPlaybackEnded, /stopVisualizationPolling\(true\)/)
  assert.match(handleNativePlaybackEnded, /if \(!nativePlaybackActive\) return/)
  assert.match(handleNativePlaybackEnded, /if \(isNativeQueueDelegated\(\)\) return/)
  assert.match(handleNativePlaybackEnded, /handlePlaybackEnded\(\)/)
  assert.match(setupAudioEngineListeners, /case 'eof-reached':\s*handleNativePlaybackEnded\(\)/)
  assert.match(
    setupAudioEngineListeners,
    /if \(\(nativePlaybackActive \|\| nativeQueueDelegated\) && reason === 'eof'\) \{\s*handleNativePlaybackEnded\(\)/
  )
  assert.match(next, /queueIndex\.value = 0/)
  assert.match(scheduleCrossfadeIfNeeded, /queueIndex\.value \+ 1 >= queue\.value\.length/)
})

test('current playlist selection preserves the existing shuffled queue order', () => {
  const playerBarSource = readFileSync(
    new URL('../components/PlayerBar.vue', import.meta.url),
    'utf8'
  )
  const playTrackAt = extractInternalFunctionBody(playerBarSource, 'playTrackAt')

  assert.doesNotMatch(
    playTrackAt,
    /playTrack\(track,\s*queue\.value\)/,
    'selecting from the current queue must not pass that queue back through the shuffle initializer'
  )
})

test('ordinary queue playback ends a personalized stream without adding a play mode', () => {
  const playerSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const playTrack = extractInternalFunctionBody(playerSource, 'playTrack')
  const playTrackFromPosition = extractInternalFunctionBody(playerSource, 'playTrackFromPosition')

  assert.match(
    playTrack,
    /if \(trackList \|\| !isPersonalizedStreamTrack\(track\)\) endPersonalizedStream\(\)/
  )
  assert.match(
    playTrackFromPosition,
    /if \(trackList \|\| !isPersonalizedStreamTrack\(track\)\) endPersonalizedStream\(\)/
  )
  assert.match(playerSource, /export type PersonalizedStreamKey = 'fm' \| 'radar'/)
  assert.doesNotMatch(playerSource, /const modes: PlayMode\[\] = \[[^\]]*personalizedStream/)
})

test('playback session carries play mode for quit-time restore', () => {
  const sessionSource = readFileSync(
    new URL('./player/playbackSessionController.ts', import.meta.url),
    'utf8'
  )
  const musicTypes = readFileSync(new URL('../types/music.ts', import.meta.url), 'utf8')
  const restorePlaybackSession = extractInternalFunctionBody(
    sessionSource,
    'restorePlaybackSession'
  )
  const createPlaybackSession = extractInternalFunctionBody(sessionSource, 'createPlaybackSession')

  assert.match(musicTypes, /import type \{ PlaybackResumeMode, PlayMode \} from '\.\/settings'/)
  assert.match(musicTypes, /playMode\?: PlayMode/)
  assert.match(
    createPlaybackSession,
    /playMode: options\.playMode\.value === 'heart' \? 'sequential' : options\.playMode\.value/
  )
  assert.match(restorePlaybackSession, /if \(session\.playMode\) \{/)
  assert.match(
    restorePlaybackSession,
    /setPlayModeInternal\(session\.playMode, \{ persist: false \}\)/
  )
})

test('queue editing commands commit snapshots, persistence, and revision-fenced native synchronization', () => {
  const source = readFileSync(
    new URL('./player/playbackQueueController.ts', import.meta.url),
    'utf8'
  )
  const commit = extractInternalFunctionBody(source, 'commitQueueEdit')
  const enqueue = extractInternalFunctionBody(source, 'enqueueTrack')
  const append = extractInternalFunctionBody(source, 'appendQueueTracks')
  const appendPersonalized = extractInternalFunctionBody(source, 'appendPersonalizedStreamTracks')
  const startPersonalized = extractInternalFunctionBody(source, 'startPersonalizedStream')
  const endPersonalized = extractInternalFunctionBody(source, 'endPersonalizedStream')
  const playNext = extractInternalFunctionBody(source, 'playNextTrack')
  const remove = extractInternalFunctionBody(source, 'removeQueueItem')
  const clear = extractInternalFunctionBody(source, 'clearQueue')
  const reorder = extractInternalFunctionBody(source, 'reorderQueue')

  assert.match(commit, /toPlaybackQueueSnapshots\(nextQueue\)/)
  assert.match(commit, /originalQueue\.value = \[\.\.\.snapshots\]/)
  assert.match(commit, /persistPlaybackSessionAfterQueueMutation\(\)/)
  assert.match(commit, /queueNativeQueueStateSync\(\)/)
  assert.match(enqueue, /\[\.\.\.options\.queue\.value, track\]/)
  assert.match(append, /toPlaybackQueueSnapshots\(tracks\)/)
  assert.match(
    append,
    /originalQueue\.value = \[\.\.\.options\.originalQueue\.value, \.\.\.additions\]/
  )
  assert.match(append, /endPersonalizedStream\(\)/)
  assert.match(append, /persistPlaybackSessionAfterQueueMutation\(\)/)
  assert.match(append, /queueNativeQueueStateSync\(\)/)
  assert.match(startPersonalized, /options\.personalizedStreamEntryIds\.clear\(\)/)
  assert.match(startPersonalized, /options\.personalizedStreamPlayedEntryIds\.clear\(\)/)
  assert.match(startPersonalized, /markCurrentPersonalizedStreamTrackPlayed\(\)/)
  assert.match(appendPersonalized, /!isPersonalizedStreamSessionCurrent\(session\)/)
  assert.match(
    appendPersonalized,
    /options\.personalizedStreamEntryIds\.add\(track\.queueEntryId\)/
  )
  assert.match(
    appendPersonalized,
    /playMode\.value === 'shuffle' \? shuffleArray\(additions\) : additions/
  )
  assert.match(endPersonalized, /options\.personalizedStreamSession\.value = null/)
  assert.match(source, /function markCurrentPersonalizedStreamTrackPlayed\(\)/)
  assert.match(
    source,
    /options\.personalizedStreamPlayedEntryIds\.add\(entryId\)[\s\S]*refreshPersonalizedStreamRemaining\(\)/
  )
  assert.match(playNext, /next\.splice\(insertAt, 0, track\)/)
  assert.match(remove, /next\.splice\(index, 1\)/)
  assert.match(clear, /commitQueueEdit\(\[\], -1\)/)
  assert.match(reorder, /next\.splice\(fromIndex, 1\)/)
  assert.match(reorder, /next\.splice\(toIndex, 0, moved\)/)
  assert.match(reorder, /queueIndex\.value === fromIndex/)
  assert.match(
    source,
    /function saveQueueAsPlaylist[\s\S]*createPlaylistWithTracks\(name, \[\.\.\.options\.queue\.value\]\)/
  )
})

test('single-song repeat replays the current track when playback ends in fallback mode', () => {
  const source = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const getPlaybackAudio = extractInternalFunctionBody(source, 'getPlaybackAudio')
  const handlePlaybackEnded = extractInternalFunctionBody(source, 'handlePlaybackEnded')
  const loadAndPlay = extractInternalFunctionBody(source, 'loadAndPlay')

  // The HTMLAudio 'ended' event must feed handlePlaybackEnded.
  assert.match(getPlaybackAudio, /audio.addEventListener\('ended',[\s\S]*handlePlaybackEnded\(\)/)
  // Guard fields exist and are reset at the end of a successful load so the
  // next natural end can trigger another replay.
  assert.match(
    handlePlaybackEnded,
    /autoAdvanceInFlight \|\| advancingFromEndedTrackId === trackId/
  )
  assert.match(handlePlaybackEnded, /advancingFromEndedTrackId = trackId/)
  assert.match(handlePlaybackEnded, /autoAdvanceInFlight = true/)
  // Repeat must restart the same track without consulting the queue.
  const repeatBranch = handlePlaybackEnded.match(
    /if \(playMode\.value === 'repeat'\) \{[\s\S]*?\n  \}/
  )?.[0]
  assert.ok(repeatBranch, 'repeat branch should exist')
  assert.match(repeatBranch, /void loadAndPlay\(track\)/)
  assert.doesNotMatch(repeatBranch, /advanceAfterPlaybackEnded\(\)/)
  // loadAndPlay must clear the guards on success so the loop can repeat.
  assert.match(loadAndPlay, /advancingFromEndedTrackId = ''[\s\S]*autoAdvanceInFlight = false/)
  assert.match(loadAndPlay, /loadedTrackId = track\.id/)
})

test('applyAudioProcessingState replaces processing locally without engine IPC', () => {
  const storeSource = readFileSync(new URL('./usePlayerStore.ts', import.meta.url), 'utf8')
  const dspSource = readFileSync(new URL('./useAudioOutputDspStore.ts', import.meta.url), 'utf8')
  const body = extractInternalFunctionBody(storeSource, 'applyAudioProcessingState')
  assert.match(body, /audioProcessing\.value = cloneAudioProcessingSettings\(processing\)/)
  assert.doesNotMatch(body, /window\.api/)
  assert.match(dspSource, /applyAudioProcessingState: player\.applyAudioProcessingState/)
})
