import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readDataIpcSources(): string {
  return [
    '../ipc/data.ts',
    '../ipc/appIpc.ts',
    '../ipc/shellIpc.ts',
    '../ipc/discordIpc.ts',
    '../ipc/windowIpc.ts',
    '../ipc/fonts.ts',
    '../ipc/settingsIpc.ts',
    '../ipc/debugIpc.ts',
    '../ipc/filesystemIpc.ts',
    '../ipc/libraryIpc.ts',
    '../ipc/coverIpc.ts',
    '../ipc/lyricsIpc.ts',
    '../ipc/persistenceIpc.ts',
    '../ipc/persistenceReporting.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
    .join('\n')
}

import test from 'node:test'

const {
  isSafeLocalPath,
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeIpcArray,
  normalizeIpcString,
  normalizeLocalPath,
  normalizeOptionalIpcString,
  stringifyJsonForIpcStorage
} = (await import(
  new URL('./ipcValidation.ts', import.meta.url).href
)) as typeof import('./ipcValidation')

test('accepts native Windows drive paths while still rejecting URL schemes', () => {
  // Electron dialogs and realpath() hand back backslash separators on Windows. Rejecting them
  // broke folder import, library scanning, playback and shell reveal on every drive-letter path.
  for (const path of [
    String.raw`D:\Music`,
    String.raw`D:\Linux Workspace\Music`,
    String.raw`C:\Users\Administrator\Music\track.flac`,
    'D:/Music',
    String.raw`\\NAS\share\Music`,
    '/home/user/Music'
  ]) {
    assert.equal(isSafeLocalPath(path), true, `expected ${path} to be accepted`)
    assert.equal(normalizeLocalPath(path, 'music folder path'), path)
  }

  for (const path of [
    'http://example.com/track.flac',
    'https://example.com/track.flac',
    'file:///D:/Music',
    'javascript:alert(1)',
    'data:audio/flac;base64,AAAA',
    'twilight-audio:///D:/Music'
  ]) {
    assert.equal(isSafeLocalPath(path), false, `expected ${path} to be rejected`)
    assert.throws(() => normalizeLocalPath(path, 'music folder path'), /not a safe local path/)
  }
})

test('scan and playback IPC keep using the shared local path validator', () => {
  const validatorSource = readFileSync(new URL('./ipcValidation.ts', import.meta.url), 'utf8')
  assert.match(validatorSource, /\/\^\[a-zA-Z\]:\[\\\\\/\]\//)
})

test('normalizes IPC strings and rejects control characters or oversized input', () => {
  assert.equal(normalizeIpcString('  ok  ', 'field'), 'ok')
  assert.equal(normalizeOptionalIpcString('', 'field'), undefined)
  assert.throws(() => normalizeIpcString('bad\nvalue', 'field'), /invalid characters/)
  assert.throws(() => normalizeIpcString('x'.repeat(5), 'field', 4), /too long/)
  assert.throws(() => normalizeIpcString(null, 'field'), /must be a string/)
})

test('normalizes finite numbers and arrays from untrusted IPC input', () => {
  assert.equal(normalizeFiniteNumber(2, 'value', 0, 0, 1), 1)
  assert.equal(normalizeFiniteNumber(Number.NaN, 'value', 0.5, 0, 1), 0.5)
  assert.equal(normalizeInteger(2.9, 'value', 0, 0, 10), 2)
  assert.deepEqual(
    normalizeIpcArray([1, 'x', 2, 3], 'items', 3, (item) =>
      typeof item === 'number' ? item * 2 : null
    ),
    [2, 4]
  )
})

test('limits and safely serializes JSON payloads before writing renderer-controlled data to disk', () => {
  assert.equal(stringifyJsonForIpcStorage({ ok: true }, 'payload', 32), '{"ok":true}')
  assert.throws(() => stringifyJsonForIpcStorage('x'.repeat(32), 'payload', 8), /too large/)
  assert.throws(() => stringifyJsonForIpcStorage(undefined, 'payload', 8), /serializable/)

  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.throws(
    () => stringifyJsonForIpcStorage(circular, 'payload', 1024),
    /payload must be JSON serializable/
  )
  assert.throws(
    () => stringifyJsonForIpcStorage({ id: BigInt(1) }, 'payload', 1024),
    /payload must be JSON serializable/
  )
  assert.throws(
    () =>
      stringifyJsonForIpcStorage(
        {
          toJSON() {
            throw new Error('internal serialization detail')
          }
        },
        'payload',
        1024
      ),
    /payload must be JSON serializable/
  )

  const deeplyNested: { child?: unknown } = {}
  let cursor = deeplyNested
  for (let index = 0; index < 128; index += 1) {
    const child: { child?: unknown } = {}
    cursor.child = child
    cursor = child
  }
  assert.throws(
    () => stringifyJsonForIpcStorage(deeplyNested, 'payload', 1024 * 1024),
    /payload is too deeply nested/
  )

  const shared = { value: 'still valid' }
  assert.equal(
    stringifyJsonForIpcStorage({ first: shared, second: shared }, 'payload', 1024),
    '{"first":{"value":"still valid"},"second":{"value":"still valid"}}'
  )
})

test('data IPC applies path and storage limits before touching local files', () => {
  const source = readDataIpcSources()
  const repositorySource = readFileSync(
    new URL('../library/libraryRepository.ts', import.meta.url),
    'utf8'
  )
  const versionedStoreSource = readFileSync(
    new URL('../persistence/versionedDataStore.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /const snapshot = normalizeMusicLibrarySnapshot\(library\)/)
  assert.match(
    source,
    /stringifyJsonForIpcStorage\(snapshot, 'music library', MAX_MUSIC_LIBRARY_BYTES\)/
  )
  assert.match(
    source,
    /assertMusicLibraryRevision\(snapshot\.revision, loaded\.document\.revision\)/
  )
  assert.match(source, /createMusicLibraryDocument\(snapshot, loaded\.document\.exclusions\)/)
  assert.match(source, /persistMusicLibraryDocumentWithIndex\(MUSIC_LIBRARY_FILE, nextDocument\)/)
  assert.match(repositorySource, /export const MAX_MUSIC_LIBRARY_BYTES = 100 \* 1024 \* 1024/)
  assert.match(
    source,
    /stringifyJsonForIpcStorage\(session, 'playback session', MAX_PLAYBACK_SESSION_BYTES\)/
  )
  assert.match(source, /stringifyJsonForIpcStorage\(playlists, 'playlists', MAX_PLAYLISTS_BYTES\)/)
  assert.match(source, /normalizeLocalPath\(folderPath, 'music folder path'\)/)
  assert.match(
    source,
    /resolveAuthorizedAudioFile\(\s*normalizeLocalPath\(filePath, 'audio file path'\)\s*\)/
  )
  assert.match(source, /ipcMain\.handle\('fs:isAudioFileAuthorized'/)
  assert.match(source, /clearManagedMusicCache\(cachePath\)/)
  assert.doesNotMatch(source, /rm\(cachePath, \{ recursive: true, force: true \}\)/)
  assert.match(source, /filterAuthorizedLibraryRoots\(snapshot\.folders\)/)
  assert.match(repositorySource, /loadJsonFileWithBackup\(filePath, MUSIC_LIBRARY_JSON_OPTIONS\)/)
  assert.match(source, /new VersionedDataStore<PlaybackSession \| null>/)
  assert.match(
    source,
    /return await saveVersionedData\(playbackSessionStore, session, expectedRevision\)/
  )
  assert.match(
    source,
    /return await saveVersionedData\(playlistsStore, playlists, expectedRevision\)/
  )
  assert.match(versionedStoreSource, /writeJsonFileAtomic\(/)
  assert.match(source, /reportPersistentDataFailure\('Playback session'/)
  assert.match(source, /reportPersistentDataFailure\('Playlists'/)
  /* Legacy mojibake assertions retained below are intentionally disabled.
  assert.match(source, /reportPersistentDataFailure\('音乐库'/)
  assert.match(source, /reportPersistentDataFailure\('播放会话'/)
  assert.match(source, /reportPersistentDataFailure\('歌单'/)
  */
  assert.match(source, /normalizeCoverDataUrl\(handle\)/)
  assert.match(
    source,
    /resolveAuthorizedAudioFile\(\s*normalizeLocalPath\(filePath, 'lyrics audio file path'\)\s*\)/
  )
  assert.match(source, /const lrc = decodeLyrics\(await readFile\(lrcPath\)\)\.text/)
  assert.match(source, /decodeLyrics\(await readFile\(filePath\)\)\.text/)
  assert.doesNotMatch(source, /readFile\(lrcPath,\s*['"]utf-?8['"]\)/)
  assert.match(
    source,
    /if \(mode === 'trash'\) \{\s*await resolveAuthorizedAudioFile\(requestedPath\)/
  )
  assert.doesNotMatch(source, /authorizeLocalLibrarySelections\([\s\S]*authorizedFolders/)
})

test('plugin and NCM IPC validate renderer-controlled IDs, methods, paths, and payload sizes', () => {
  const pluginsSource = readFileSync(new URL('../ipc/plugins.ts', import.meta.url), 'utf8')
  const ncmSource = readFileSync(new URL('../ncm/api.ts', import.meta.url), 'utf8')
  const providerRoutingSource = readFileSync(
    new URL('../plugins/providerRouting.ts', import.meta.url),
    'utf8'
  )

  assert.match(providerRoutingSource, /export function isTwilightMediaProviderMethod/)
  assert.match(pluginsSource, /normalizePluginId\(id\)/)
  assert.match(pluginsSource, /normalizeProviderId\(providerId\)/)
  assert.match(pluginsSource, /normalizeProviderMethod\(method\)/)
  assert.match(
    pluginsSource,
    /normalizePluginIpcArgs\(args, 'provider call args', MAX_PROVIDER_ARGS\)/
  )
  assert.match(
    pluginsSource,
    /stringifyJsonForIpcStorage\(args, field, MAX_PLUGIN_IPC_ARGS_BYTES\)/
  )
  assert.match(pluginsSource, /normalizeNativeDspParameters\(parameters\)/)
  assert.match(pluginsSource, /realpathSync\(/)

  assert.match(ncmSource, /const MAX_NCM_API_PATH_LENGTH = 4096/)
  assert.match(ncmSource, /normalizeNcmApiPath\(path\)/)
  assert.match(ncmSource, /normalizeNcmCookie\(cookie\)/)
  assert.match(ncmSource, /normalizeNcmSongId\(songId\)/)
  assert.match(ncmSource, /normalizeIpcString\(url, 'NCM cache url', MAX_NCM_REMOTE_URL_LENGTH\)/)
})

test('settings, background image, OPRA, and BPM IPC apply input limits before expensive work', () => {
  const dataSource = readDataIpcSources()
  const coverCacheSource = readFileSync(
    new URL('../library/coverCache.ts', import.meta.url),
    'utf8'
  )
  const opraSource = readFileSync(new URL('../ipc/opra.ts', import.meta.url), 'utf8')
  const bpmSource = readFileSync(new URL('../bpm/bpmIpc.ts', import.meta.url), 'utf8')

  assert.match(coverCacheSource, /export const MAX_BACKGROUND_IMAGE_BYTES = 20 \* 1024 \* 1024/)
  assert.match(coverCacheSource, /fileStat\.size > MAX_BACKGROUND_IMAGE_BYTES/)
  assert.match(dataSource, /const MAX_SETTINGS_PATCH_BYTES = 512 \* 1024/)
  assert.match(dataSource, /const MAX_SETTINGS_BACKUP_BYTES = 2 \* 1024 \* 1024/)
  assert.match(
    dataSource,
    /stringifyJsonForIpcStorage\(patch, 'settings patch', MAX_SETTINGS_PATCH_BYTES\)/
  )
  assert.match(dataSource, /Buffer\.byteLength\(json, 'utf-8'\) > MAX_SETTINGS_BACKUP_BYTES/)
  assert.match(dataSource, /normalizeNcmCookieForSave\(cookie\)/)
  assert.match(dataSource, /const MAX_NCM_COOKIE_FILE_BYTES = 64 \* 1024/)
  assert.match(dataSource, /tryParseJsonWithNestingLimit\(raw\)/)
  assert.match(dataSource, /normalizeLoadedNcmCookie/)
  assert.match(
    dataSource,
    /stringifyJsonForIpcStorage\(data, 'Discord activity', MAX_DISCORD_ACTIVITY_BYTES\)/
  )

  assert.match(
    opraSource,
    /normalizeOptionalIpcString\(query, 'OPRA query', MAX_OPRA_QUERY_LENGTH\)/
  )
  assert.match(
    opraSource,
    /normalizeOptionalIpcString\(eqId, 'OPRA profile id', MAX_OPRA_PROFILE_ID_LENGTH\)/
  )
  assert.match(bpmSource, /await resolveAuthorizedAudioFile/)
  assert.match(
    bpmSource,
    /normalizeIpcString\(value\.filePath, 'BPM file path', MAX_BPM_FILE_PATH_LENGTH\)/
  )
})

test('Electron documents use local CSP, denied permissions, and trusted IPC sender checks', () => {
  const electronSecuritySource = readFileSync(
    new URL('./electronSecurity.ts', import.meta.url),
    'utf8'
  )
  const lifecycleSource = readFileSync(new URL('../app/lifecycle.ts', import.meta.url), 'utf8')
  const rendererHtml = readFileSync(new URL('../../renderer/index.html', import.meta.url), 'utf8')
  const dataSource = readDataIpcSources()
  const pluginsSource = readFileSync(new URL('../ipc/plugins.ts', import.meta.url), 'utf8')
  const audioIpcSource = readFileSync(new URL('../audio/engineIpc.ts', import.meta.url), 'utf8')
  const desktopLyricsSource = readFileSync(
    new URL('../integrations/desktopLyrics.ts', import.meta.url),
    'utf8'
  )
  const miniPlayerSource = readFileSync(
    new URL('../integrations/miniPlayer.ts', import.meta.url),
    'utf8'
  )
  const miniPlayerBoundsPersistence =
    miniPlayerSource.match(/function persistMiniPlayerBounds[\s\S]*?\n\}/)?.[0] ?? ''

  assert.match(lifecycleSource, /installElectronSecurity\(\)/)
  assert.match(electronSecuritySource, /setPermissionRequestHandler/)
  assert.match(electronSecuritySource, /callback\(false\)/)
  assert.match(electronSecuritySource, /setPermissionCheckHandler\(\(\) => false\)/)
  assert.match(electronSecuritySource, /onHeadersReceived/)
  assert.match(electronSecuritySource, /Content-Security-Policy/)
  assert.match(electronSecuritySource, /default-src 'none'/)
  assert.match(electronSecuritySource, /"script-src 'self'"/)
  assert.match(electronSecuritySource, /Permissions-Policy/)
  assert.match(electronSecuritySource, /frame-src 'self'/)
  assert.match(electronSecuritySource, /isAudioVisualizerDocumentUrl/)
  assert.match(electronSecuritySource, /frame-ancestors 'self'/)
  assert.match(
    electronSecuritySource,
    /isAudioVisualizerDocumentUrl\(url\)[\s\S]*script-src 'self' 'unsafe-inline'/
  )
  assert.match(
    electronSecuritySource,
    /img-src 'self' data: blob: cover: background: theme-asset: twilight-media:/
  )
  assert.match(electronSecuritySource, /font-src 'self' data: theme-asset:/)
  assert.match(electronSecuritySource, /media-src 'self' blob: twilight-audio: twilight-media:/)
  assert.match(
    rendererHtml,
    /img-src 'self' data: blob: cover: background: theme-asset: twilight-media:/
  )
  assert.match(rendererHtml, /font-src 'self' data: theme-asset:/)
  assert.match(rendererHtml, /media-src 'self' blob: twilight-audio: twilight-media:/)
  // Playbar cover-theme sampling uses crossOrigin=anonymous on local + remote covers.
  assert.match(lifecycleSource, /scheme: 'twilight-media'[\s\S]*corsEnabled:\s*true/)
  assert.match(lifecycleSource, /scheme: 'cover'[\s\S]*corsEnabled:\s*true/)
  assert.match(lifecycleSource, /scheme: 'background'[\s\S]*corsEnabled:\s*true/)
  assert.match(lifecycleSource, /scheme: 'theme-asset'[\s\S]*corsEnabled:\s*true/)
  assert.match(
    lifecycleSource,
    /protocol\.handle\('cover'[\s\S]*Access-Control-Allow-Origin['"]:\s*['"]\*['"]/
  )
  assert.doesNotMatch(rendererHtml, /(?:img-src|media-src)[^;]*\bhttps?:/)
  assert.doesNotMatch(rendererHtml, /unpkg\.com|fonts\.googleapis\.com|unsafe-inline' https:/)
  assert.match(rendererHtml, /script-src 'self'/)
  assert.match(rendererHtml, /frame-src 'self'/)
  assert.doesNotMatch(rendererHtml, /frame-src 'none'/)

  assert.match(dataSource, /assertTrustedIpcSender|shouldAcceptIpcEvent/)
  assert.match(pluginsSource, /assertTrustedIpcSender/)
  assert.match(audioIpcSource, /assertTrustedIpcSender/)
  assert.match(audioIpcSource, /resolveAuthorizedAudioSource/)
  assert.match(audioIpcSource, /resolveAuthorizedPlaybackSource/)
  assert.match(audioIpcSource, /resolveAuthorizedImpulseResponseFile/)
  assert.match(desktopLyricsSource, /shouldAcceptIpcEvent/)
  assert.match(miniPlayerSource, /assertTrustedIpcSender/)
  assert.match(miniPlayerSource, /shouldAcceptIpcEvent/)
  assert.match(miniPlayerSource, /rejected from unexpected window/)
  assert.match(miniPlayerSource, /transparent: true/)
  assert.match(miniPlayerSource, /resizable: true/)
  assert.match(miniPlayerSource, /minWidth: MINI_PLAYER_MIN_WIDTH/)
  assert.match(miniPlayerSource, /maxHeight: MINI_PLAYER_MAX_HEIGHT/)
  assert.match(miniPlayerSource, /roundedCorners: false/)
  assert.match(miniPlayerSource, /hasShadow: false/)
  assert.match(miniPlayerSource, /thickFrame: process\.platform === 'win32'/)
  assert.match(miniPlayerSource, /win\.on\('resize'/)
  assert.match(miniPlayerSource, /persistMiniPlayerBounds/)
  assert.match(miniPlayerBoundsPersistence, /settings:changed/)
  assert.match(miniPlayerSource, /miniPlayer:chooseBackgroundImage/)
  assert.match(
    miniPlayerSource,
    /assertSenderWindow\(\s*event,\s*runtime\.miniPlayerWindow,\s*'mini player background image IPC'\s*\)/
  )
  assert.match(miniPlayerSource, /importBackgroundImage/)
})
