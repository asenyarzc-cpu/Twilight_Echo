import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('real Vue, Pinia and Electron DOM exercise the complete playlist lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playlist-lifecycle-'))
  try {
    const entryPath = join(directory, 'playlist-lifecycle-entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'playlist-lifecycle.html')
    const runnerPath = join(directory, 'playlist-lifecycle-runner.cjs')
    await writeFile(entryPath, runtimeEntrySource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env': '{}'
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'PlaylistLifecycleRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const bundleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(bundleName, 'Vite should bundle the production playlist composable and store')
    await writeFile(htmlPath, runtimeHtml(bundleName), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.match(stderr, /PLAYLIST_LIFECYCLE_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /PLAYLIST_LIFECYCLE_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

function runtimeEntrySource(): string {
  const actionsPath = join(
    workspaceRoot,
    'src/renderer/src/components/song-list/usePlaylistLifecycleActions.ts'
  ).replaceAll('\\', '/')
  const storePath = join(workspaceRoot, 'src/renderer/src/stores/useMusicStore.ts').replaceAll(
    '\\',
    '/'
  )
  const lifecyclePath = join(
    workspaceRoot,
    'src/renderer/src/utils/playlistLifecycle.ts'
  ).replaceAll('\\', '/')
  return `import { computed, createApp, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaylistLifecycleActions } from ${JSON.stringify(actionsPath)}
import { useMusicStore } from ${JSON.stringify(storePath)}
import { MAX_PLAYLIST_IMPORT_BYTES } from ${JSON.stringify(lifecyclePath)}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function track(id, filePath, title = id) {
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    filePath,
    fileName: filePath.split(/[\\\\/]/).at(-1) || filePath,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await tick()
    if (predicate()) return
  }
  throw new Error(message + '; status=' + document.querySelector('#playlist-status')?.textContent)
}

const statusText = () => document.querySelector('#playlist-status')?.textContent || ''
const click = async (selector) => {
  const element = document.querySelector(selector)
  expect(element, 'missing control ' + selector)
  element.click()
  await tick()
}

const setInputFile = async (selector, file) => {
  const input = document.querySelector(selector)
  expect(input, 'missing file input ' + selector)
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}

const runtimeReady = (async () => {
const pinia = createPinia()
setActivePinia(pinia)
const music = useMusicStore()
await music.loadPlaylists()
music.tracks.value = [
  track('a', 'C:\\\\Music\\\\A.flac', 'A'),
  track('b', 'C:\\\\Music\\\\B.flac', 'B'),
  track('c', 'C:\\\\Music\\\\C.flac', 'C')
]
music.refreshLibraryIndex()

const activePlaylistId = ref('pl-source')
const selectedIds = ref([])
const repairMessage = ref('')
const currentPlaylist = computed(
  () => music.playlists.value.find((playlist) => playlist.id === activePlaylistId.value) || null
)
const Root = {
  setup() {
    const actions = usePlaylistLifecycleActions({
      currentPlaylist,
      isPlaylistDetail: computed(() => !!currentPlaylist.value),
      repairMessage,
      getSelectedTracks: () =>
        music.tracks.value.filter((item) => selectedIds.value.includes(item.id)),
      isSelected: (trackId) => selectedIds.value.includes(trackId),
      clearSelection: () => {
        selectedIds.value = []
      },
      selectPlaylist: (name) => {
        window.__playlistFixture.lastSelectedPlaylist = name
      }
    })
    return () =>
      h('main', [
        h(
          'select',
          {
            id: 'playlist-export-format',
            value: actions.playlistExportFormat.value,
            onChange: (event) => {
              actions.playlistExportFormat.value = event.target.value
            }
          },
          ['m3u', 'm3u8', 'pls'].map((format) => h('option', { value: format }, format))
        ),
        h(
          'button',
          {
            id: 'playlist-export',
            onClick: () => actions.downloadPlaylistDocument(actions.playlistExportFormat.value)
          },
          'Export'
        ),
        h('input', {
          id: 'playlist-import',
          ref: actions.playlistImportInput,
          type: 'file',
          onChange: actions.handlePlaylistImport
        }),
        h('input', {
          id: 'playlist-cover',
          ref: actions.playlistCoverInput,
          type: 'file',
          onChange: actions.handlePlaylistCover
        }),
        h('button', { id: 'playlist-rename', onClick: actions.handleRenamePlaylist }, 'Rename'),
        h('button', { id: 'playlist-copy', onClick: actions.handleCopyPlaylist }, 'Copy'),
        h(
          'button',
          { id: 'playlist-reorder-start', onClick: () => actions.handleMoveSelectedWithinPlaylist(false) },
          'Move start'
        ),
        h('button', { id: 'playlist-move', onClick: actions.handleMoveSelectedToPlaylist }, 'Move'),
        h('button', { id: 'playlist-repair', onClick: actions.handlePlaylistRepair }, 'Repair'),
        h('output', { id: 'playlist-status' }, repairMessage.value),
        h('pre', { id: 'playlist-state' }, JSON.stringify(music.playlists.value))
      ])
  }
}
createApp(Root).use(pinia).mount('#app')

const runPlaylistLifecycleRuntime = async () => {
  await tick()

  for (const format of ['m3u', 'm3u8', 'pls']) {
    const select = document.querySelector('#playlist-export-format')
    select.value = format
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await click('#playlist-export')
  }
  expect(window.__playlistFixture.downloads.length === 3, 'all three exports must download')
  for (const format of ['m3u', 'm3u8', 'pls']) {
    const download = window.__playlistFixture.downloads.find((item) => item.name === 'Road Mix.' + format)
    expect(download, 'missing .' + format + ' filename')
    const contents = await window.__playlistFixture.blobs.get(download.url).text()
    if (format === 'pls') {
      expect(contents.startsWith('[playlist]'), 'PLS download has wrong contents')
      expect(window.__playlistFixture.blobs.get(download.url).type.startsWith('audio/x-scpls'), 'PLS MIME mismatch')
    } else {
      expect(contents.startsWith('#EXTM3U'), format + ' download has wrong contents')
      expect(window.__playlistFixture.blobs.get(download.url).type.startsWith('audio/x-mpegurl'), format + ' MIME mismatch')
    }
  }

  let oversizedReads = 0
  await setInputFile('#playlist-import', {
    name: 'too-large.m3u8',
    size: MAX_PLAYLIST_IMPORT_BYTES + 1,
    text: async () => {
      oversizedReads += 1
      return '#EXTM3U'
    }
  })
  await waitFor(() => statusText().includes('8 MiB'), 'oversized import feedback was not visible')
  expect(oversizedReads === 0, 'oversized import called File.text before rejection')

  let validReads = 0
  await setInputFile('#playlist-import', {
    name: 'valid.m3u8',
    size: 64,
    text: async () => {
      validReads += 1
      return '#EXTM3U\\nC:\\\\Music\\\\C.flac'
    }
  })
  await waitFor(() => statusText().includes('已导入 1 首'), 'successful import feedback was not visible')
  expect(validReads === 1, 'valid import must read exactly once')
  expect(currentPlaylist.value.trackIds.includes('c'), 'valid import did not update the real store')

  await setInputFile('#playlist-import', {
    name: 'invalid.txt',
    size: 8,
    text: async () => 'not a playlist'
  })
  await waitFor(
    () => statusText().includes('M3U') && statusText().includes('PLS'),
    'invalid import feedback was not visible'
  )

  await setInputFile('#playlist-cover', { name: 'bad.gif', size: 8, type: 'image/gif' })
  await waitFor(() => statusText().includes('PNG, JPEG, or WebP'), 'cover validation feedback missing')
  const goodCover = new File([new Uint8Array([137, 80, 78, 71])], 'cover.png', { type: 'image/png' })
  await setInputFile('#playlist-cover', goodCover)
  await waitFor(() => statusText().includes('歌单封面已更新'), 'valid cover feedback missing')
  expect(currentPlaylist.value.cover?.startsWith('data:image/png;base64,'), 'valid cover not applied')

  window.__playlistFixture.prompts.push('Road Renamed')
  window.__playlistFixture.conflictNext = true
  await click('#playlist-rename')
  expect(window.__playlistFixture.lastSelectedPlaylist === 'Road Renamed', 'rename did not select the renamed playlist')
  expect(await music.flushPlaylists(), 'rename persistence did not flush')
  await waitFor(
    () => statusText().includes('其他窗口更新') && statusText().includes('权威版本'),
    'recovered CAS conflict was not visible in the UI'
  )
  expect(music.playlists.value.some((playlist) => playlist.id === 'pl-remote'), 'authoritative remote playlist was lost')
  expect(music.playlists.value.find((playlist) => playlist.id === 'pl-source')?.name === 'Road Renamed', 'local rename was lost during CAS recovery')

  window.__playlistFixture.prompts.push('Road Copy')
  await click('#playlist-copy')
  expect(music.playlists.value.some((playlist) => playlist.name === 'Road Copy'), 'copy action did not use the real store')

  selectedIds.value = ['b']
  await click('#playlist-reorder-start')
  expect(currentPlaylist.value.trackIds[0] === 'b', 'manual reorder did not move the selected track')

  selectedIds.value = ['a', 'c']
  window.__playlistFixture.prompts.push('Target')
  await click('#playlist-move')
  const target = music.playlists.value.find((playlist) => playlist.id === 'pl-target')
  expect(target.trackIds.includes('a') && target.trackIds.includes('c'), 'batch move did not populate target')
  expect(!currentPlaylist.value.trackIds.includes('a') && !currentPlaylist.value.trackIds.includes('c'), 'batch move did not remove source ids')

  await click('#playlist-repair')
  await waitFor(() => statusText().includes('已重新定位 1 首'), 'unique relocation feedback missing')
  expect(currentPlaylist.value.trackIds.includes('relocated-missing'), 'unique relocation was not applied')
  expect(!currentPlaylist.value.trackIds.includes('missing'), 'stale missing id survived relocation')

  expect(await music.flushPlaylists(), 'final lifecycle transaction did not flush')
  expect(window.__playlistFixture.authoritative.some((playlist) => playlist.id === 'pl-remote'), 'final CAS state discarded authoritative data')
  console.log('PLAYLIST_LIFECYCLE_RUNTIME_OK')
}
return runPlaylistLifecycleRuntime
})()
window.runPlaylistLifecycleRuntime = async () => (await runtimeReady)()
`
}

function runtimeHtml(bundleName: string): string {
  return `<!doctype html><html><body><div id="app"></div><script>
window.__playlistFixture = {
  revision: 1,
  conflictNext: false,
  prompts: [],
  downloads: [],
  blobs: new Map(),
  lastSelectedPlaylist: '',
  authoritative: [
    { id: 'pl-favorite', name: 'Favorite', trackIds: [], isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'pl-source',
      name: 'Road Mix',
      trackIds: ['a', 'b', 'missing'],
      trackSnapshots: {
        missing: {
          id: 'missing', title: 'Missing', artist: 'Artist', album: 'Album',
          filePath: 'D:\\\\Gone\\\\Missing.flac', fileName: 'Missing.flac', duration: 180,
          size: 1, cover: null, lyrics: null, source: 'local'
        }
      },
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    { id: 'pl-target', name: 'Target', trackIds: [], createdAt: '2026-01-01T00:00:00.000Z' }
  ]
}
const fixture = window.__playlistFixture
const clone = (value) => JSON.parse(JSON.stringify(value))
const envelope = () => ({ version: 2, revision: fixture.revision, savedAt: new Date().toISOString(), data: clone(fixture.authoritative) })
window.prompt = () => fixture.prompts.shift() ?? null
window.URL.createObjectURL = (blob) => {
  const url = 'blob:playlist-' + (fixture.blobs.size + 1)
  fixture.blobs.set(url, blob)
  return url
}
window.URL.revokeObjectURL = () => {}
HTMLAnchorElement.prototype.click = function () {
  fixture.downloads.push({ name: this.download, url: this.href })
}
window.createImageBitmap = async () => ({ width: 800, height: 800, close() {} })
window.api = {
  data: {
    loadPlaylists: async () => envelope(),
    savePlaylists: async (data, expectedRevision) => {
      if (fixture.conflictNext) {
        fixture.conflictNext = false
        fixture.revision += 1
        fixture.authoritative = [
          ...fixture.authoritative,
          { id: 'pl-remote', name: 'Remote', trackIds: [], createdAt: '2026-01-02T00:00:00.000Z' }
        ]
        const error = new Error('concurrent playlist write')
        error.code = 'ERR_PERSISTENCE_REVISION_CONFLICT'
        error.current = envelope()
        error.expectedRevision = expectedRevision
        throw error
      }
      if (expectedRevision !== fixture.revision) throw new Error('unexpected revision ' + expectedRevision)
      fixture.revision += 1
      fixture.authoritative = clone(data)
      return envelope()
    }
  },
  dialog: { openFolder: async () => 'E:\\\\Relocated' },
  fs: {
    scanMusicFiles: async () => [
      {
        id: 'relocated-missing', title: 'Missing', artist: 'Artist', album: 'Album',
        filePath: 'E:\\\\Relocated\\\\Missing.flac', fileName: 'Missing.flac', duration: 180,
        size: 1, cover: null, lyrics: null, source: 'local'
      }
    ]
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
    await window.webContents.executeJavaScript('window.runPlaylistLifecycleRuntime()')
    app.exit(0)
  } catch (error) {
    console.error('PLAYLIST_LIFECYCLE_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
