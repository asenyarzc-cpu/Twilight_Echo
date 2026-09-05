import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Windows Shell identity registers the same AUMID on a Start Menu shortcut', async () => {
  const source = await readFile(new URL('./windowsAppIdentity.ts', import.meta.url), 'utf8')
  assert.match(source, /WINDOWS_APP_USER_MODEL_ID = 'com\.TwilightEcho\.music'/)
  assert.match(source, /Microsoft.*Windows.*Start Menu.*Programs/s)
  assert.match(source, /appUserModelId: WINDOWS_APP_USER_MODEL_ID/)
  assert.match(source, /shell\.writeShortcutLink/)
  assert.match(source, /shell\.readShortcutLink/)
})

test('Windows Shell identity preserves an unrelated production shortcut', async () => {
  const source = await readFile(new URL('./windowsAppIdentity.ts', import.meta.url), 'utf8')
  assert.match(source, /developmentFallback/)
  assert.match(source, /!samePath\(current\.target, process\.execPath\)/)
  assert.match(
    source,
    /current\.appUserModelId === WINDOWS_APP_USER_MODEL_ID &&[\s\S]*samePath\(current\.target, process\.execPath\)/
  )
})
