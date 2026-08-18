import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('main-process startup creates the window before deferred runtime work', async () => {
  const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
  const createWindowCall = source.indexOf('createMainWindowAndScheduleDeferredStartup()')
  const deferredStartup = source.indexOf("mainWindow.once('ready-to-show'")
  const desktopLyrics = source.indexOf(
    'if (runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()'
  )
  const engineStartup = source.indexOf('void ensureAudioEngineRuntime().catch')
  const runtimeSettings = source.indexOf('applyRuntimeSettings()')

  assert.notEqual(createWindowCall, -1)
  assert.notEqual(deferredStartup, -1)
  assert.ok(deferredStartup > createWindowCall)
  assert.ok(desktopLyrics > deferredStartup)
  assert.ok(engineStartup > deferredStartup)
  assert.ok(runtimeSettings > deferredStartup)
  assert.doesNotMatch(source, /setupNcmApi\(\)/)
})
test('main window keeps the responsive layout minimum size', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  assert.match(source, /width:\s*1495/)
  assert.match(source, /height:\s*883/)
  assert.match(source, /minWidth:\s*1298/)
  assert.match(source, /minHeight:\s*692/)
})

test('windows main window wires the SMTC taskbar thumbnail buttons', async () => {
  const source = await readFile(new URL('./window.ts', import.meta.url), 'utf8')
  assert.match(source, /createSmtcButtons/)
  assert.match(source, /destroySmtcButtons/)
  assert.match(source, /integrations\/smtc/)
})
