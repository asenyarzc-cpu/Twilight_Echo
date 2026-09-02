const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  assertLocalVirtualStore,
  assertSingleLockfile,
  readModulesMetadata,
  verifyInstallPolicy
} = require('./verify-install-policy.cjs')

function makeCandidate(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-install-policy-'))
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@11.7.0', scripts: { postinstall: 'x' } })
  )
  fs.writeFileSync(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\npackages:\n  '@neteasecloudmusicapienhanced/api@4.35.1(patch_hash=abc)': {}\n"
  )
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    [
      'nodeLinker: hoisted',
      'overrides:',
      '  form-data: 4.0.6',
      '  qs: 6.16.0',
      'patchedDependencies:',
      "  '@neteasecloudmusicapienhanced/api@4.35.1': patches/@neteasecloudmusicapienhanced__api@4.35.1.patch"
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(root, 'patches', '@neteasecloudmusicapienhanced__api@4.35.1.patch'),
    'patch'
  )
  const store = options.externalStore || path.join(root, 'node_modules', '.pnpm')
  if (!options.externalStore) fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'node_modules', '.modules.yaml'),
    `packageManager: pnpm@11.7.0\nvirtualStoreDir: ${store.replaceAll('\\', '/')}\n`
  )
  return root
}

test('install policy accepts the single-lock pnpm candidate layout', () => {
  const root = makeCandidate()
  try {
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy rejects an additional lockfile and an external virtual store', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-external-store-'))
  const root = makeCandidate({ externalStore: external })
  try {
    assert.throws(() => assertLocalVirtualStore(root), /inside this candidate/)
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
    assert.throws(() => assertSingleLockfile(root), /package-lock\.json must not exist/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test('install policy reads pnpm JSON metadata written by modern pnpm', () => {
  const root = makeCandidate()
  try {
    const metadataPath = path.join(root, 'node_modules', '.modules.yaml')
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        packageManager: 'pnpm@11.7.0',
        virtualStoreDir: path.join(root, 'node_modules', '.pnpm')
      })
    )
    assert.deepEqual(readModulesMetadata(path.join(root, 'node_modules')), {
      packageManager: 'pnpm@11.7.0',
      virtualStoreDir: path.join(root, 'node_modules', '.pnpm')
    })
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy accepts a valid pnpm 11 candidate when metadata omits packageManager', () => {
  const root = makeCandidate()
  try {
    const metadataPath = path.join(root, 'node_modules', '.modules.yaml')
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ virtualStoreDir: path.join(root, 'node_modules', '.pnpm') })
    )
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy accepts pnpm hoisted layout without isolated metadata', () => {
  const root = makeCandidate()
  try {
    fs.rmSync(path.join(root, 'node_modules', '.modules.yaml'))
    fs.rmSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'node_modules', 'local-package'))
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy rejects a hoisted dependency junction that escapes the candidate', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-external-module-'))
  const root = makeCandidate()
  try {
    fs.rmSync(path.join(root, 'node_modules', '.modules.yaml'))
    fs.rmSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true, force: true })
    fs.symlinkSync(external, path.join(root, 'node_modules', 'external-package'), 'junction')
    assert.throws(() => assertLocalVirtualStore(root), /must stay inside this candidate/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})
