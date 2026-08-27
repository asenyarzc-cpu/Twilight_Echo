const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync: childProcessSpawnSync } = require('node:child_process')

const PERSISTED_VST3_VARIABLES = [
  'TAE_VST3_SDK_ROOT',
  'TAE_VST3_MSVC_INSTALL_ROOT',
  'TAE_VST3_MSVC_BUILD_DIR'
]

function resolveVst3MsvcEnvironment({ env = process.env, spawnSync = childProcessSpawnSync } = {}) {
  const resolved = { ...env }
  if (process.platform !== 'win32') return resolved
  for (const name of PERSISTED_VST3_VARIABLES) {
    if (resolved[name]) continue
    const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result?.status !== 0 || result.error) continue
    const expression = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im')
    const match = expression.exec(result.stdout ?? '')
    if (match?.[1]) resolved[name] = match[1].trim()
  }
  return resolved
}

function resolveVst3MsvcBuildDirectory(env = process.env, root = process.cwd()) {
  return env.TAE_VST3_MSVC_BUILD_DIR
    ? resolve(env.TAE_VST3_MSVC_BUILD_DIR)
    : join(resolve(root), 'audio-engine', 'build', 'vst3-msvc-x64')
}

function validateVst3MsvcToolchain({
  env = process.env,
  exists = existsSync,
  readDirectories = readdirSync
} = {}) {
  const sdkRoot = env.TAE_VST3_SDK_ROOT ? resolve(env.TAE_VST3_SDK_ROOT) : ''
  const installRoot = env.TAE_VST3_MSVC_INSTALL_ROOT ? resolve(env.TAE_VST3_MSVC_INSTALL_ROOT) : ''
  const missing = []

  if (!sdkRoot || !exists(join(sdkRoot, 'public.sdk', 'source', 'vst', 'hosting', 'module.h'))) {
    missing.push('TAE_VST3_SDK_ROOT must point to the fixed, complete Steinberg VST3 SDK')
  }
  if (!installRoot || !exists(join(installRoot, 'Common7', 'Tools', 'VsDevCmd.bat'))) {
    missing.push('TAE_VST3_MSVC_INSTALL_ROOT must point to a VS 2022 Build Tools installation')
  } else {
    const msvcRoot = join(installRoot, 'VC', 'Tools', 'MSVC')
    const hasMsvc =
      exists(msvcRoot) &&
      readDirectories(msvcRoot, { withFileTypes: true }).some((entry) => entry.isDirectory())
    if (!hasMsvc) missing.push(`No MSVC toolset found under ${msvcRoot}.`)
  }

  return missing.length === 0
    ? { ok: true, message: '', sdkRoot, installRoot }
    : {
        ok: false,
        message: `VST3 MSVC toolchain preflight failed:\n- ${missing.join('\n- ')}`,
        sdkRoot,
        installRoot
      }
}

module.exports = {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment,
  validateVst3MsvcToolchain
}
