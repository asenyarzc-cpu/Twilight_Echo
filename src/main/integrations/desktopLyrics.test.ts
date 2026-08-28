import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('desktop lyrics v3 isolates host and satellite IPC capabilities', async () => {
  const main = await source('./desktopLyrics.ts')
  const preload = await source('../../preload/domains/desktopLyricsApi.ts')
  const entry = await source('../../preload/index.ts')

  assert.match(main, /isMainSender\(event\)/)
  assert.match(main, /isDesktopLyricsSender\(event\)/)
  assert.match(main, /desktopLyrics:publishSession/)
  assert.match(main, /desktopLyrics:bootstrap/)
  assert.match(preload, /desktopLyricsHostApi/)
  assert.match(preload, /desktopLyricsWindowApi/)
  assert.match(entry, /desktopLyrics: desktopLyricsHostApi/)
  assert.match(
    entry,
    /if \(isDesktopLyricsDocument\(\)\) return \{ desktopLyrics: desktopLyricsWindowApi \}/
  )
  assert.doesNotMatch(preload, /desktopLyrics:toggle/)
})

test('desktop lyrics validates payload size, shape, ranges, and message order', async () => {
  const main = await source('./desktopLyrics.ts')

  assert.match(main, /DESKTOP_LYRICS_MAX_CONTENT_BYTES/)
  assert.match(main, /stringifyJsonForIpcStorage\(raw, 'desktop lyrics session'/)
  assert.match(main, /lines\.length <= 10000/)
  assert.match(main, /words\.length <= 512/)
  assert.match(main, /Number\(value\.rate\) >= 0\.5/)
  assert.match(main, /clock\.epoch < current\.epoch/)
  assert.match(main, /clock\.sequence <= current\.sequence/)
})

test('desktop lyrics bootstraps before reveal and performs one crash recovery', async () => {
  const main = await source('./desktopLyrics.ts')
  const app = await source('../../renderer/src/desktop-lyrics/DesktopLyricsApp.vue')

  assert.match(main, /show: false/)
  assert.match(main, /desktopLyrics:ready/)
  assert.match(app, /await api\.bootstrap\(\)/)
  assert.match(app, /api\.ready\(\)/)
  assert.ok(app.indexOf('await api.bootstrap()') < app.indexOf('api.ready()'))
  assert.match(main, /desktopLyricsCrashRestarts >= 1/)
  assert.match(main, /runtime\.desktopLyricsCrashRestarts \+= 1/)
})

test('desktop lyrics uses constrained manual dragging and real locked click-through', async () => {
  const main = await source('./desktopLyrics.ts')
  const app = await source('../../renderer/src/desktop-lyrics/DesktopLyricsApp.vue')

  assert.match(main, /screen\.getDisplayMatching/)
  assert.match(main, /win\.setIgnoreMouseEvents\(settings\.locked\)/)
  assert.doesNotMatch(main, /forward:\s*true/)
  assert.match(app, /setPointerCapture/)
  assert.match(app, /api\.moveTo/)
  assert.match(app, /api\.moveEnd/)
})

test('desktop lyrics resumes frozen and requests an authoritative snapshot', async () => {
  const main = await source('./desktopLyrics.ts')
  const clock = await source('../../renderer/src/desktop-lyrics/desktopLyricsClock.ts')

  assert.match(main, /powerMonitor\.on\('resume', requestDesktopLyricsResync\)/)
  assert.match(main, /desktopLyrics:freezeClock/)
  assert.match(main, /desktopLyrics:resyncRequested/)
  assert.match(clock, /current\.state === 'playing' && !frozen/)
})

test('desktop lyrics v3 removes presets and keeps a dedicated lock shortcut', async () => {
  const settings = await source('../core/settings.ts')
  const shared = await source('../../shared/appSettings.ts')
  const tray = await source('./shortcutsTray.ts')

  assert.match(settings, /normalizeDesktopLyricsSettings/)
  assert.doesNotMatch(settings, /desktopLyricsPresets/)
  assert.doesNotMatch(shared, /DesktopLyricsPreset/)
  assert.match(settings, /CommandOrControl\+Alt\+L/)
  assert.match(tray, /toggleDesktopLyricsLock/)
  assert.match(tray, /type: 'checkbox'/)
})
