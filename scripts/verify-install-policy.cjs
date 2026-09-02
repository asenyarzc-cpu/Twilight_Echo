const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PNPM_VERSION = 'pnpm@11.7.0'
const REQUIRED_OVERRIDES = Object.freeze({
  'form-data': '4.0.6',
  qs: '6.16.0'
})
const NCM_PATCH = '@neteasecloudmusicapienhanced/api@4.35.1'
const NCM_PATCH_PATH = 'patches/@neteasecloudmusicapienhanced__api@4.35.1.patch'
const DISALLOWED_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb']

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function assertSingleLockfile(root) {
  const pnpmLock = path.join(root, 'pnpm-lock.yaml')
  assert.ok(fs.existsSync(pnpmLock), 'pnpm-lock.yaml is required')
  for (const lockfile of DISALLOWED_LOCKFILES) {
    assert.equal(fs.existsSync(path.join(root, lockfile)), false, `${lockfile} must not exist`)
  }
  const content = readFile(pnpmLock)
  assert.match(
    content,
    /^lockfileVersion:\s*['"]?9(?:\.0)?['"]?\s*$/m,
    'pnpm-lock.yaml must use pnpm lockfile v9'
  )
}

function assertPackageManager(root) {
  const manifest = JSON.parse(readFile(path.join(root, 'package.json')))
  assert.equal(manifest.packageManager, PNPM_VERSION, `packageManager must be ${PNPM_VERSION}`)
  assert.equal(
    typeof manifest.scripts?.postinstall,
    'string',
    'postinstall policy must remain declared'
  )
}

function assertWorkspacePolicy(root) {
  const workspacePath = path.join(root, 'pnpm-workspace.yaml')
  assert.ok(fs.existsSync(workspacePath), 'pnpm-workspace.yaml is required')
  const workspace = readFile(workspacePath)
  assert.match(workspace, /^nodeLinker:\s*hoisted\s*$/m, 'nodeLinker must remain hoisted')
  assert.match(workspace, /^overrides:\s*$/m, 'workspace overrides are required')
  for (const [name, version] of Object.entries(REQUIRED_OVERRIDES)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(
      workspace,
      new RegExp(`^\\s+['"]?${escapedName}['"]?:\\s*['"]?${escapedVersion}['"]?\\s*$`, 'm'),
      `missing ${name}@${version} override`
    )
  }
  assert.match(workspace, /^patchedDependencies:\s*$/m, 'patchedDependencies are required')
  assert.match(
    workspace,
    new RegExp(
      `^\\s+['"]?${NCM_PATCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?:\\s*${NCM_PATCH_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm'
    ),
    'NCM patch declaration is required'
  )
  assert.ok(fs.existsSync(path.join(root, NCM_PATCH_PATH)), 'NCM patch file is required')
  const lockfile = readFile(path.join(root, 'pnpm-lock.yaml'))
  assert.match(
    lockfile,
    /@neteasecloudmusicapienhanced\/api@[\d.]+\(patch_hash=[^)]+\)/,
    'pnpm lockfile must retain the NCM patch hash'
  )
}

function readModulesMetadata(nodeModulesDir) {
  const metadataPath = path.join(nodeModulesDir, '.modules.yaml')
  assert.ok(fs.existsSync(metadataPath), `Missing pnpm metadata: ${metadataPath}`)
  const metadata = readFile(metadataPath)
  try {
    const parsed = JSON.parse(metadata)
    return {
      packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : '',
      virtualStoreDir: typeof parsed.virtualStoreDir === 'string' ? parsed.virtualStoreDir : ''
    }
  } catch {
    // pnpm also supports YAML-form metadata; retain this fallback for older compatible installs.
  }
  const getValue = (key) => {
    const match = metadata.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
    return match ? match[1].replace(/^['"]|['"]$/g, '') : ''
  }
  return {
    packageManager: getValue('packageManager'),
    virtualStoreDir: getValue('virtualStoreDir')
  }
}

function assertLocalVirtualStore(root) {
  const candidateRoot = fs.realpathSync(root)
  const nodeModules = path.join(candidateRoot, 'node_modules')
  if (!fs.existsSync(path.join(nodeModules, '.modules.yaml'))) {
    assertLocalHoistedModules(candidateRoot, nodeModules)
    return
  }
  const metadata = readModulesMetadata(nodeModules)
  // pnpm 11 may omit packageManager from .modules.yaml on an otherwise valid frozen install.
  // package.json is the source of truth; when metadata records a manager, it must agree.
  if (metadata.packageManager) {
    assert.equal(metadata.packageManager, PNPM_VERSION, `.modules.yaml must use ${PNPM_VERSION}`)
  }
  assert.ok(metadata.virtualStoreDir, '.modules.yaml must declare virtualStoreDir')
  const declaredStore = path.isAbsolute(metadata.virtualStoreDir)
    ? metadata.virtualStoreDir
    : path.resolve(nodeModules, metadata.virtualStoreDir)
  assert.ok(fs.existsSync(declaredStore), `pnpm virtual store does not exist: ${declaredStore}`)
  const realStore = fs.realpathSync(declaredStore)
  const relative = path.relative(candidateRoot, realStore)
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'pnpm virtual store must be inside this candidate'
  )
  assert.ok(
    relative.replaceAll('\\', '/').startsWith('node_modules/'),
    'pnpm virtual store must live under this candidate node_modules directory'
  )
}

function assertLocalHoistedModules(candidateRoot, nodeModules) {
  assert.ok(fs.existsSync(nodeModules), `node_modules is required: ${nodeModules}`)
  assert.ok(
    isInsideCandidate(candidateRoot, fs.realpathSync(nodeModules)),
    'node_modules must live inside this candidate'
  )
  const pending = [nodeModules]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        assert.ok(
          isInsideCandidate(candidateRoot, fs.realpathSync(entryPath)),
          `hoisted dependency link must stay inside this candidate: ${entryPath}`
        )
      } else if (entry.isDirectory()) {
        pending.push(entryPath)
      }
    }
  }
}

function isInsideCandidate(candidateRoot, targetPath) {
  const relative = path.relative(candidateRoot, targetPath)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

function assertDiscordFallback() {
  assert.throws(
    () => require.resolve('register-scheme'),
    (error) => error?.code === 'MODULE_NOT_FOUND',
    'register-scheme must remain absent from the application dependency tree'
  )
  const discordRpc = require('discord-rpc')
  assert.equal(typeof discordRpc.Client, 'function')
  assert.equal(
    discordRpc.register('twilight-echo-install-policy-check'),
    false,
    'discord-rpc must use its safe no-op fallback when loaded by plain Node.js'
  )
}

function verifyInstallPolicy(root = path.resolve(__dirname, '..'), options = {}) {
  assertSingleLockfile(root)
  assertPackageManager(root)
  assertWorkspacePolicy(root)
  assertLocalVirtualStore(root)
  if (!options.skipRuntime) assertDiscordFallback()
  return true
}

function main() {
  verifyInstallPolicy()
  console.log(
    'Install policy verified: pnpm lock/overrides/patch/local virtual store and discord-rpc fallback'
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = {
  DISALLOWED_LOCKFILES,
  NCM_PATCH,
  NCM_PATCH_PATH,
  PNPM_VERSION,
  REQUIRED_OVERRIDES,
  assertLocalVirtualStore,
  assertLocalHoistedModules,
  assertPackageManager,
  assertSingleLockfile,
  assertWorkspacePolicy,
  readModulesMetadata,
  verifyInstallPolicy
}
