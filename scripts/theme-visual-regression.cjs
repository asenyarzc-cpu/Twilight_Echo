const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { PNG } = require('pngjs')

const TONES = ['pureWhite', 'dark']
const SCALES = [1, 1.25, 1.5]
const PLAYER_LAYOUTS = ['standard', 'full-cover', 'lyrics-focus', 'split', 'minimal']
const NAVIGATION_LAYOUTS = ['expanded', 'compact', 'rail']
const PRESETS = [
  ['builtin:twilight-echo-default', 'pureWhite'],
  ['builtin:aurora-reference', 'dark'],
  ['builtin:obsidian-glass', 'dark'],
  ['builtin:paper-light', 'pureWhite'],
  ['builtin:neon-gradient', 'dark'],
  ['builtin:studio-split', 'dark'],
  ['builtin:zen-minimal', 'pureWhite']
]
const VISUAL_PROFILE_ID = 'user:p7-golden-matrix'

function createThemeGoldenCases() {
  const matrix = []
  for (const tone of TONES) {
    for (const scale of SCALES) {
      for (const playerLayout of PLAYER_LAYOUTS) {
        for (const navigationLayout of NAVIGATION_LAYOUTS) {
          matrix.push({
            id: `matrix-${tone}-${String(scale).replace('.', '_')}x-${playerLayout}-${navigationLayout}-no-cover`,
            kind: 'matrix',
            tone,
            scale,
            playerLayout,
            navigationLayout,
            presetId: null
          })
        }
      }
    }
  }
  const presets = PRESETS.map(([presetId, tone]) => ({
    id: `preset-${presetId.startsWith('builtin:') ? presetId.slice('builtin:'.length) : presetId}-no-cover`,
    kind: 'preset',
    tone,
    scale: 1,
    playerLayout: null,
    navigationLayout: null,
    presetId
  }))
  return [...matrix, ...presets]
}

function createStressLibraryDocument(trackCount = 10_000) {
  return {
    version: 2,
    revision: 1,
    tracks: Array.from({ length: trackCount }, (_, index) => ({
      id: `local:p7-stress:${index}`,
      title: `P7 Theme Stress ${String(index + 1).padStart(5, '0')}`,
      artist: `Artist ${index % 127}`,
      album: `Album ${index % 311}`,
      duration: 180 + (index % 240),
      filePath: `C:\\twilight-p7-stress\\track-${String(index + 1).padStart(5, '0')}.flac`,
      cover: '',
      sampleRate: index % 2 === 0 ? 96_000 : 44_100,
      bitDepth: index % 3 === 0 ? 24 : 16,
      format: 'FLAC'
    })),
    folders: [],
    exclusions: []
  }
}

function generateMiniWavFiles(directory, fileCount, sampleRate = 8000, durationSeconds = 0.01) {
  mkdirSync(directory, { recursive: true })
  const sampleCount = Math.max(1, Math.round(sampleRate * durationSeconds))
  for (let index = 1; index <= fileCount; index += 1) {
    const frequency = 200 + (index % 12) * 40
    const data = Buffer.alloc(sampleCount * 2)
    for (let i = 0; i < sampleCount; i += 1) {
      data.writeInt16LE(
        Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 3000),
        i * 2
      )
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(data.length, 40)
    writeFileSync(
      resolve(directory, `track-${String(index).padStart(5, '0')}.wav`),
      Buffer.concat([header, data])
    )
  }
  return directory
}

function seedStressLibrary(
  userDataPath,
  trackCount = 10_000,
  libraryFolder = null,
  realFileCount = 0
) {
  const root = resolve(userDataPath)
  const output = resolve(root, 'music-library.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(output, JSON.stringify(createStressLibraryDocument(trackCount)))
  // The app clears a seeded library whose file paths do not exist, and a fresh
  // profile shows the onboarding wizard. Write a minimal settings profile that
  // skips onboarding and optionally pre-authorizes a real media folder. It must
  // be UTF-8 without BOM: PowerShell-style BOM output makes the app treat the
  // file as corrupt and restore from backup.
  const mediaFolder =
    realFileCount > 0 ? generateMiniWavFiles(resolve(root, 'media-library'), realFileCount) : null
  const settings = {
    onboardingCompleted: true,
    startupHomePage: 'local',
    libraryFolders: mediaFolder
      ? [mediaFolder]
      : Array.isArray(libraryFolder)
        ? libraryFolder.map(String)
        : []
  }
  const settingsPath = resolve(root, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { library: output, settings: settingsPath, mediaFolder }
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    await new Promise((resolveConnection, reject) => {
      const socket = new WebSocket(this.webSocketUrl)
      this.socket = socket
      socket.addEventListener('open', resolveConnection, { once: true })
      socket.addEventListener('error', reject, { once: true })
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (!message.id) return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      })
      socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error('CDP connection closed'))
        }
        this.pending.clear()
      })
    })
  }

  async send(method, params = {}) {
    if (!this.socket) throw new Error('CDP client is not connected')
    const id = this.nextId++
    const result = new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return await result
  }

  close() {
    this.socket?.close()
  }
}

function sleep(durationMs) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs))
}

async function findPageTarget(port, timeoutMs = 20_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find(
        (entry) => entry.type === 'page' && !String(entry.url).startsWith('devtools://')
      )
      if (target?.webSocketDebuggerUrl) return target
    } catch {}
    await sleep(200)
  }
  throw new Error(`No Electron page target found on CDP port ${port}`)
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Renderer evaluation failed')
  }
  return result.result?.value
}

async function waitForExpression(client, expression, timeoutMs = 15_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, `Boolean(${expression})`)) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`)
}

async function navigateToStressLibrary(client) {
  await waitForExpression(client, `document.querySelector('.menu-btn')`)
  await evaluate(
    client,
    `(async () => {
      document.querySelector('.menu-btn').click()
      await new Promise((resolve) => setTimeout(resolve, 350))
      const songs = [...document.querySelectorAll('.menu-item')].find((item) => item.title === '所有歌曲')
      if (!songs) throw new Error('All Songs navigation item is unavailable')
      songs.click()
    })()`
  )
  await waitForExpression(client, `document.querySelector('.song-list .track-row')`)
}

async function runElectronLibraryStress(client) {
  return await evaluate(
    client,
    `(async () => {
      const presetIds = ${JSON.stringify(PRESETS.map(([id]) => id))}
      const list = document.querySelector('.song-list')
      const originalTbody = document.querySelector('.song-list tbody')
      if (!list || !originalTbody) throw new Error('SongList is not mounted')
      const trackHeight = parseFloat(originalTbody.style.height)
      if (trackHeight < 680000) {
        return {
          skipped: true,
          reason: 'not-enough-rows',
          trackHeight,
          maxMountedRows: document.querySelectorAll('.song-list .track-row').length,
          tbodyReplacements: 0,
          switchSamplesMs: []
        }
      }
      let maxMountedRows = 0
      let tbodyReplacements = 0
      const switchSamplesMs = []
      const positions = [0, 340000, 679999]
      for (const presetId of presetIds) {
        const snapshot = await window.api.themes.list()
        const startedAt = performance.now()
        await window.api.themes.setActive({ kind: 'builtin', id: presetId }, snapshot.revision)
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (document.documentElement.dataset.activeTheme === presetId) break
          await new Promise((resolve) => requestAnimationFrame(resolve))
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        switchSamplesMs.push(performance.now() - startedAt)
        if (document.querySelector('.song-list tbody') !== originalTbody) tbodyReplacements += 1
        for (const scrollTop of positions) {
          list.scrollTop = scrollTop
          list.dispatchEvent(new Event('scroll'))
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          maxMountedRows = Math.max(
            maxMountedRows,
            document.querySelectorAll('.song-list .track-row').length
          )
        }
      }
      return {
        skipped: false,
        trackHeight,
        maxMountedRows,
        tbodyReplacements,
        switchSamplesMs
      }
    })()`
  )
}

async function openNoCoverPlayer(client) {
  await evaluate(
    client,
    `(async () => {
      const list = document.querySelector('.song-list')
      list.scrollTop = 0
      list.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const row = document.querySelector('.song-list .track-row')
      if (!row) throw new Error('No stress-library row is available for the player fixture')
      row.click()
    })()`
  )
  await waitForExpression(client, `document.querySelector('.player-cover-slot')`)
  await evaluate(client, `document.querySelector('.player-cover-slot').click()`)
  await waitForExpression(
    client,
    `document.querySelector('.playing-music .cover-placeholder') && !document.querySelector('.playing-music .cover-frame img')`
  )
}

async function applyGoldenCase(client, currentCase) {
  return await evaluate(
    client,
    `(async () => {
      const currentCase = ${JSON.stringify(currentCase)}
      let snapshot = await window.api.themes.list()
      if (currentCase.kind === 'preset') {
        snapshot = await window.api.themes.setActive(
          { kind: 'builtin', id: currentCase.presetId },
          snapshot.revision
        )
      } else {
        const now = new Date().toISOString()
        const existing = snapshot.data.profiles.find((profile) => profile.id === '${VISUAL_PROFILE_ID}')
        const profile = {
          schemaVersion: 2,
          id: '${VISUAL_PROFILE_ID}',
          name: 'P7 Golden Matrix',
          description: 'Isolated visual regression fixture',
          baseThemeId: 'builtin:twilight-echo-default',
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          overrides: { pureWhite: {}, dark: {} },
          modes: {
            player: { layout: currentCase.playerLayout },
            navigation: { style: currentCase.navigationLayout }
          }
        }
        snapshot = await window.api.themes.save(profile, snapshot.revision)
        if (
          snapshot.data.activeTheme.kind !== 'user' ||
          snapshot.data.activeTheme.id !== profile.id
        ) {
          snapshot = await window.api.themes.setActive(
            { kind: 'user', id: profile.id },
            snapshot.revision
          )
        }
      }
      await window.api.settings.update({ theme: currentCase.tone })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (document.documentElement.dataset.theme === currentCase.tone) break
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const root = document.documentElement
      return {
        activeTheme: root.dataset.activeTheme,
        tone: root.dataset.theme,
        playerLayout: root.dataset.tePlayerLayout,
        navigationLayout: root.dataset.teNavigationStyle,
        noCover: Boolean(document.querySelector('.playing-music .cover-placeholder'))
      }
    })()`
  )
}

function inspectPng(buffer) {
  const png = PNG.sync.read(buffer)
  const colors = new Set()
  let luminanceSum = 0
  let luminanceSquareSum = 0
  let sampleCount = 0
  const pixelCount = png.width * png.height
  const stride = Math.max(1, Math.floor(pixelCount / 20_000))
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4
    const red = png.data[offset]
    const green = png.data[offset + 1]
    const blue = png.data[offset + 2]
    const alpha = png.data[offset + 3]
    if (alpha === 0) continue
    colors.add((red << 16) | (green << 8) | blue)
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
    luminanceSum += luminance
    luminanceSquareSum += luminance * luminance
    sampleCount += 1
  }
  const mean = sampleCount === 0 ? 0 : luminanceSum / sampleCount
  const variance = sampleCount === 0 ? 0 : luminanceSquareSum / sampleCount - mean * mean
  return {
    width: png.width,
    height: png.height,
    sampledColors: colors.size,
    luminanceVariance: variance,
    nonBlank: colors.size >= 32 && variance >= 25
  }
}

function comparePng(currentBuffer, baselineBuffer) {
  const current = PNG.sync.read(currentBuffer)
  const baseline = PNG.sync.read(baselineBuffer)
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return { comparable: false, changedPixelRatio: 1 }
  }
  let changedPixels = 0
  const pixelCount = current.width * current.height
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4
    const delta =
      Math.abs(current.data[offset] - baseline.data[offset]) +
      Math.abs(current.data[offset + 1] - baseline.data[offset + 1]) +
      Math.abs(current.data[offset + 2] - baseline.data[offset + 2]) +
      Math.abs(current.data[offset + 3] - baseline.data[offset + 3])
    if (delta > 24) changedPixels += 1
  }
  return { comparable: true, changedPixelRatio: changedPixels / pixelCount }
}

async function captureGoldenMatrix(client, options) {
  const cases = createThemeGoldenCases()
  const entries = []
  mkdirSync(options.outputDir, { recursive: true })
  for (const currentCase of cases) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: currentCase.scale,
      mobile: false
    })
    const runtime = await applyGoldenCase(client, currentCase)
    if (!runtime.noCover) throw new Error(`${currentCase.id} did not retain the no-cover fixture`)
    const capture = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    const buffer = Buffer.from(capture.data, 'base64')
    const fileName = `${currentCase.id}.png`
    const outputPath = resolve(options.outputDir, fileName)
    writeFileSync(outputPath, buffer)
    const pixels = inspectPng(buffer)
    if (!pixels.nonBlank) throw new Error(`${currentCase.id} produced a blank or flat screenshot`)
    const baselinePath = options.baselineDir ? resolve(options.baselineDir, fileName) : null
    entries.push({
      ...currentCase,
      fileName,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      pixels,
      runtime,
      baseline:
        baselinePath && existsSync(baselinePath)
          ? comparePng(buffer, readFileSync(baselinePath))
          : null
    })
  }
  await client.send('Emulation.clearDeviceMetricsOverride')
  return entries
}

async function exerciseRafPreview(client) {
  await evaluate(client, `document.querySelector('.player-cover-slot').click()`)
  await waitForExpression(client, `!document.querySelector('.playing-music')`)
  await waitForExpression(client, `document.querySelector('.settings-btn')`)
  await evaluate(client, `document.querySelector('.settings-btn').click()`)
  await waitForExpression(
    client,
    `[...document.querySelectorAll('button')].some((button) => button.textContent.includes('打开主题工作室'))`
  )
  await evaluate(
    client,
    `[...document.querySelectorAll('button')].find((button) => button.textContent.includes('打开主题工作室')).click()`
  )
  await waitForExpression(client, `document.querySelector('.theme-studio-page')`)
  return await evaluate(
    client,
    `(async () => {
      const picker = document.querySelector('.theme-profile-picker select')
      picker.value = 'profile:${VISUAL_PROFILE_ID}'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (document.documentElement.dataset.activeTheme === '${VISUAL_PROFILE_ID}') break
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      const domain = [...document.querySelectorAll('.theme-domain-list button')].find((button) =>
        button.textContent.includes('个性化与材质')
      )
      domain.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const range = document.querySelector('.theme-editor-pane input[type="range"]')
      if (!range) throw new Error('Theme Studio range input is unavailable')
      const before = window.__TWILIGHT_THEME_PERFORMANCE__?.preview.count ?? 0
      const minimum = Number(range.min || 0)
      const maximum = Number(range.max || 100)
      for (let index = 0; index < 30; index += 1) {
        const ratio = index % 2 === 0 ? 0.35 : 0.65
        range.value = String(minimum + (maximum - minimum) * ratio)
        range.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const count = window.__TWILIGHT_THEME_PERFORMANCE__?.preview.count ?? 0
        if (count - before >= 30) break
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return {
        before,
        after: window.__TWILIGHT_THEME_PERFORMANCE__?.preview.count ?? 0,
        performance: window.__TWILIGHT_THEME_PERFORMANCE__
      }
    })()`
  )
}

function printEvidenceUsage(errorMessage) {
  const lines = [
    errorMessage ? `error: ${errorMessage}` : '',
    'usage: pnpm run evidence:themes -- [options]',
    '',
    'options:',
    '  --port <n>              CDP port (default 9223)',
    '  --output <dir>          screenshot/manifest dir (default output/theme-golden-p7)',
    '  --baseline <dir>        optional baseline dir for pixel delta review',
    '  --width <n>             viewport width (default 1440)',
    '  --height <n>            viewport height (default 900)',
    '  --seed-user-data <dir>  write isolated 10k library and exit',
    '  --seed-library-folder <dir>  real media folder pre-authorized in the seeded profile',
    '  --seed-real-files <n>   generate n real mini-WAV files in the seeded profile',
    '  --inspect               print live page diagnostics and exit',
    '  --help                  show this help',
    '',
    'flow:',
    '  1) pnpm run evidence:themes -- --seed-user-data C:\\twilight-p7-userData',
    '  2) launch the app with --remote-debugging-port=9223 and that userData dir',
    '  3) pnpm run evidence:themes -- --port 9223 --output output/theme-golden-p7',
    '  4) review output/theme-golden-p7/manifest.json and commit selected PNGs to docs/audit-evidence/'
  ].filter(Boolean)
  process.stderr.write(`${lines.join('\n')}\n`)
}

function parseArgs(args) {
  const options = {
    port: 9223,
    outputDir: resolve('output/theme-golden-p7'),
    baselineDir: null,
    width: 1440,
    height: 900,
    seedUserData: null,
    seedLibraryFolder: null,
    seedRealFiles: 0,
    inspect: false,
    help: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    const next = () => {
      index += 1
      if (!args[index]) throw new Error(`${value} requires a value`)
      return args[index]
    }
    if (value === '--port') options.port = Number(next())
    else if (value === '--output') options.outputDir = resolve(next())
    else if (value === '--baseline') options.baselineDir = resolve(next())
    else if (value === '--width') options.width = Number(next())
    else if (value === '--height') options.height = Number(next())
    else if (value === '--seed-user-data') options.seedUserData = resolve(next())
    else if (value === '--seed-library-folder') options.seedLibraryFolder = resolve(next())
    else if (value === '--seed-real-files') options.seedRealFiles = Number(next())
    else if (value === '--inspect') options.inspect = true
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`Unknown option: ${value}`)
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    printEvidenceUsage(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  if (options.help) {
    printEvidenceUsage()
    return
  }
  if (options.seedUserData) {
    const seeded = seedStressLibrary(
      options.seedUserData,
      10_000,
      options.seedLibraryFolder ? [options.seedLibraryFolder] : null,
      options.seedRealFiles > 0 ? options.seedRealFiles : 0
    )
    process.stdout.write(
      `${JSON.stringify({
        seeded: seeded.library,
        settings: seeded.settings,
        trackCount: 10_000
      })}\n`
    )
    return
  }
  let target
  try {
    target = await findPageTarget(options.port)
  } catch (error) {
    printEvidenceUsage(
      error instanceof Error
        ? `${error.message}. Start Electron with --remote-debugging-port=${options.port} first.`
        : String(error)
    )
    process.exitCode = 1
    return
  }
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await waitForExpression(client, `document.readyState === 'complete' && window.api?.themes`)
    if (options.inspect) {
      const state = await evaluate(
        client,
        `(async () => {
          const library = await window.api.data.loadMusicLibrary()
          return {
            url: location.href,
            title: document.title,
            apiNamespaces: Object.keys(window.api),
            libraryVersion: Array.isArray(library) ? 1 : library.version,
            libraryTracks: Array.isArray(library) ? library.length : library.tracks.length,
            body: document.body.innerText.slice(0, 500),
            menuTitles: [...document.querySelectorAll('.menu-item')].map((item) => item.title),
            songList: Boolean(document.querySelector('.song-list')),
            tbodyHeight: document.querySelector('.song-list tbody')?.style.height ?? null,
            mountedRows: document.querySelectorAll('.track-row').length
          }
        })()`
      )
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
      return
    }
    await navigateToStressLibrary(client)
    const stress = await runElectronLibraryStress(client)
    if (
      !stress.skipped &&
      (stress.trackHeight !== 680_000 || stress.maxMountedRows > 20 || stress.tbodyReplacements > 0)
    ) {
      throw new Error(`10k SongList stress failed: ${JSON.stringify(stress)}`)
    }
    await openNoCoverPlayer(client)
    const screenshots = await captureGoldenMatrix(client, options)
    const preview = await exerciseRafPreview(client)
    const performance = preview.performance
    if (preview.after - preview.before < 20) throw new Error('Insufficient real preview samples')
    if (!performance?.preview?.withinBudget || !performance?.apply?.withinBudget) {
      throw new Error(`Theme performance budget failed: ${JSON.stringify(performance)}`)
    }
    const manifest = {
      generatedAt: new Date().toISOString(),
      methodology: {
        transport: 'Chrome DevTools Protocol',
        screenshotCases: screenshots.length,
        matrixCases: 90,
        presetCases: 7,
        previewBudgetMs: 32,
        applyBudgetMs: 100,
        pixelDiffReview: 'manual'
      },
      stress,
      performance,
      screenshots
    }
    const manifestPath = resolve(options.outputDir, 'manifest.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(
      `${JSON.stringify({ manifest: manifestPath, screenshots: screenshots.length, stress, performance })}\n`
    )
  } finally {
    client.close()
  }
}

module.exports = {
  CdpClient,
  PRESETS,
  createStressLibraryDocument,
  createThemeGoldenCases,
  evaluate,
  findPageTarget,
  inspectPng,
  parseArgs,
  printEvidenceUsage,
  seedStressLibrary
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
