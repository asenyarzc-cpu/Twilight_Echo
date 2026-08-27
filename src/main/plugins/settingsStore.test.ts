import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { deletePluginSetting, getPluginSetting, pluginSettingsPath, setPluginSetting } =
  (await import(
    new URL('./settingsStore.ts', import.meta.url).href
  )) as typeof import('./settingsStore')
const { protectString, redactSensitiveText } = (await import(
  new URL('../security/secureStorage.ts', import.meta.url).href
)) as typeof import('../security/secureStorage')

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

test('stores plugin settings inside plugin private data directory', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-'))

  await setPluginSetting(storagePath, 'launchCount', 2)
  await setPluginSetting(storagePath, 'nested', { ok: true })

  assert.equal(await getPluginSetting(storagePath, 'launchCount'), 2)
  assert.deepEqual(await getPluginSetting(storagePath), {
    launchCount: 2,
    nested: { ok: true }
  })

  await deletePluginSetting(storagePath, 'launchCount')
  assert.equal(await getPluginSetting(storagePath, 'launchCount'), undefined)

  const raw = await readFile(pluginSettingsPath(storagePath), 'utf-8')
  assert.deepEqual(JSON.parse(raw), { nested: { ok: true } })
})

test('rejects blank plugin setting keys', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-'))
  await assert.rejects(() => setPluginSetting(storagePath, '  ', true), /settings key/)
})

test('limits plugin setting keys and values before writing to disk', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-'))

  await assert.rejects(() => setPluginSetting(storagePath, 'x'.repeat(129), true), /too long/)
  await assert.rejects(() => setPluginSetting(storagePath, 'bad\nkey', true), /invalid characters/)
  await assert.rejects(
    () => setPluginSetting(storagePath, 'largeValue', 'x'.repeat(512 * 1024 + 1)),
    /too large/
  )
})

test('encrypts sensitive plugin settings on disk and decrypts for plugins', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-'))

  await setPluginSetting(storagePath, 'cookie', 'MUSIC_U=test-token;__csrf=csrf-token')
  await setPluginSetting(storagePath, 'refreshToken', 'refresh-token')
  await setPluginSetting(storagePath, 'apiKey', 'amdw_live_private-key')

  assert.equal(
    await getPluginSetting(storagePath, 'cookie'),
    'MUSIC_U=test-token;__csrf=csrf-token'
  )
  assert.equal(await getPluginSetting(storagePath, 'refreshToken'), 'refresh-token')
  assert.equal(await getPluginSetting(storagePath, 'apiKey'), 'amdw_live_private-key')

  const raw = await readFile(pluginSettingsPath(storagePath), 'utf-8')
  assert.equal(raw.includes('MUSIC_U=test-token'), false)
  assert.equal(raw.includes('refresh-token'), false)
  assert.equal(raw.includes('amdw_live_private-key'), false)

  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
  assert.equal(parsed.cookie.__twilightSecure, true)
  assert.equal(parsed.refreshToken.__twilightSecure, true)
  assert.equal(parsed.apiKey.__twilightSecure, true)
})

test('migrates legacy plaintext sensitive plugin settings after read', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-'))
  await writeFile(
    pluginSettingsPath(storagePath),
    JSON.stringify({ cookie: 'MUSIC_U=legacy-token', api_key: 'legacy-api-key', launchCount: 2 }),
    'utf-8'
  )

  assert.equal(await getPluginSetting(storagePath, 'cookie'), 'MUSIC_U=legacy-token')
  assert.deepEqual(await getPluginSetting(storagePath), {
    cookie: 'MUSIC_U=legacy-token',
    api_key: 'legacy-api-key',
    launchCount: 2
  })

  const raw = await readFile(pluginSettingsPath(storagePath), 'utf-8')
  assert.equal(raw.includes('MUSIC_U=legacy-token'), false)
  assert.equal(raw.includes('legacy-api-key'), false)
  assert.equal(JSON.parse(raw).cookie.__twilightSecure, true)
  assert.equal(JSON.parse(raw).api_key.__twilightSecure, true)
})

test('redacts login secrets from plugin-visible logs', () => {
  const redacted = redactSensitiveText(
    '/login?phone=13800138000&password=p@ss#word&token=abc&api_key=private ' +
      'MUSIC_U=music-token;__csrf=csrf-token Authorization: Bearer amdw_live_secret ' +
      'X-Signature: signature-value'
  )

  for (const secret of [
    'p@ss#word',
    'token=abc',
    'private',
    'MUSIC_U=music-token',
    '__csrf=csrf-token',
    'amdw_live_secret',
    'signature-value'
  ]) {
    assert.equal(redacted.includes(secret), false)
  }
  assert.match(redacted, /password=\[REDACTED\]/)
  assert.match(redacted, /MUSIC_U=\[REDACTED\]/)
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/)
  assert.match(redacted, /X-Signature: \[REDACTED\]/)
})

test('rejects an excessively nested plugin settings document as a whole', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-deep-file-'))
  await writeFile(
    pluginSettingsPath(storagePath),
    JSON.stringify({ safe: true, padding: deeplyNestedValue() }),
    'utf-8'
  )

  assert.deepEqual(await getPluginSetting(storagePath), {})
})

test('drops encrypted plugin values whose decrypted JSON exceeds the nesting limit', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'twilight-plugin-settings-deep-value-'))
  const encrypted = protectString(
    JSON.stringify(deeplyNestedValue()),
    `plugin-settings:${storagePath}:cookie`
  )
  await writeFile(pluginSettingsPath(storagePath), JSON.stringify({ cookie: encrypted }), 'utf-8')

  assert.equal(await getPluginSetting(storagePath, 'cookie'), undefined)
})
