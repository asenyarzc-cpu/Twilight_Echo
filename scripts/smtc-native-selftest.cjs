// Native smoke for the SMTC addon. Loads the MSVC-built twilight_smtc_node.node
// and verifies its N-API surface. Session registration (Create) is exercised
// only with --smoke so CI remains deterministic.
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  resolveSmtcMsvcBuildDirectory,
  resolveSmtcMsvcEnvironment
} = require('./smtc-msvc-toolchain.cjs')

const root = resolve(__dirname, '..')
const environment = resolveSmtcMsvcEnvironment()
const argumentIndex = process.argv.indexOf('--build-dir')
const buildDir =
  argumentIndex >= 0 && process.argv[argumentIndex + 1]
    ? resolve(process.argv[argumentIndex + 1])
    : resolveSmtcMsvcBuildDirectory(environment, root)
const smoke = process.argv.includes('--smoke')

const candidates = [join(buildDir, 'bin', 'Release'), join(buildDir, 'Release')]
const addonPath = candidates
  .map((directory) => join(directory, 'twilight_smtc_node.node'))
  .find(existsSync)
assert.ok(addonPath, `SMTC addon was not found under:\n${candidates.join('\n')}`)

const addon = require(addonPath)
assert.equal(typeof addon.Create, 'function')
assert.equal(typeof addon.Update, 'function')
assert.equal(typeof addon.Destroy, 'function')
assert.equal(typeof addon.SelfTest, 'function')
assert.equal(typeof addon.GetLastError, 'function')
assert.equal(addon.SelfTest(), true)

if (smoke && process.platform === 'win32') {
  const created = addon.Create((event) => {
    // Events are optional in the smoke; just observe the payload shape.
    assert.ok(event && typeof event.type === 'string')
  })
  assert.equal(typeof created, 'boolean')
  if (created) {
    addon.Update({
      enabled: true,
      hasTrack: true,
      isPlaying: true,
      isLoading: false,
      canNext: true,
      canPrevious: true,
      title: 'SMTC Smoke',
      artist: 'Twilight Echo',
      album: '',
      albumArtist: '',
      positionSeconds: 12,
      durationSeconds: 200,
      shuffle: false,
      autoRepeatMode: 0
    })
  }
  console.log(`SMTC smoke: Create=${created} ${created ? '' : addon.GetLastError()}`.trim())
  addon.Destroy()
}

console.log(`SMTC addon OK: ${addonPath}`)
