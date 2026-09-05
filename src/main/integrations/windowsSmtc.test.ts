import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('native Windows SMTC routes explicit transport commands through the player bridge', async () => {
  const source = await readFile(new URL('./windowsSmtc.ts', import.meta.url), 'utf8')
  assert.match(source, /type: 'play'/)
  assert.match(source, /type: 'pause'/)
  assert.match(source, /type: 'seek'/)
  assert.match(source, /type: 'set-play-mode'/)
  assert.match(source, /runtime\.refreshWindowsSmtc = refreshWindowsSmtc/)
})

test('native window handles are converted to a safe integer before crossing N-API', async () => {
  const source = await readFile(new URL('./windowsSmtcBinding.ts', import.meta.url), 'utf8')
  assert.match(source, /readBigUInt64LE/)
  assert.match(source, /Number\.MAX_SAFE_INTEGER/)
})

test('native Windows SMTC loader searches staged and development addon locations', async () => {
  const source = await readFile(new URL('./windowsSmtcBinding.ts', import.meta.url), 'utf8')
  assert.match(source, /audio-engine.*twilight_smtc_node\.node/s)
  assert.match(source, /smtc-msvc-x64/)
  assert.match(source, /mtimeMs/)
  assert.match(source, /Create\/Update\/Destroy/)
})

test('native Windows SMTC binds to the Electron BrowserWindow handle when available', async () => {
  const mainSource = await readFile(new URL('./windowsSmtc.ts', import.meta.url), 'utf8')
  const nativeSource = await readFile(
    new URL('../../../audio-engine/smtc/twilight_smtc_node.cpp', import.meta.url),
    'utf8'
  )
  assert.match(mainSource, /getNativeWindowHandle\(\)/)
  assert.match(mainSource, /WINDOWS_APP_USER_MODEL_ID/)
  assert.match(mainSource, /Create\([\s\S]*nativeWindowHandle,[\s\S]*WINDOWS_APP_USER_MODEL_ID/)
  assert.match(nativeSource, /targetHwnd/)
  assert.match(nativeSource, /messageHwnd/)
  assert.match(nativeSource, /SHGetPropertyStoreForWindow/)
  assert.match(nativeSource, /PKEY_AppUserModel_ID/)
  assert.match(nativeSource, /GetForWindow\(smtcHwnd/)
})
