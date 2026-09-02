const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const {
  VST3_HELPER_FILES,
  VST3_RUNTIME_FILES,
  prepareVst3Msvc,
  stagedVst3Files,
  withStagedRuntimePath
} = require('./prepare-vst3-msvc.cjs')

function createExistsSync(paths) {
  const existing = new Set(paths.map((entry) => path.normalize(entry)))
  return (entry) => existing.has(path.normalize(entry))
}

test('VST3 preparation is limited to Windows x64', () => {
  assert.throws(() => prepareVst3Msvc({ platform: 'linux', arch: 'x64' }), /Windows x64 build/)
  assert.throws(() => prepareVst3Msvc({ platform: 'win32', arch: 'arm64' }), /Windows x64 build/)
})

test('VST3 self-tests receive the staged VC runtime path', () => {
  assert.deepEqual(withStagedRuntimePath({ Path: 'C:/windows/system32' }, 'C:/repo/resources'), {
    Path: 'C:/repo/resources;C:/windows/system32'
  })
  assert.equal(withStagedRuntimePath({}, 'C:/repo/resources').PATH, 'C:/repo/resources')
})

test('staged VST3 files must all be Windows x64 PE binaries', () => {
  const root = 'C:/repo'
  const nativeDir = path.join(root, 'resources', 'audio-engine')
  const existing = createExistsSync(
    [...VST3_HELPER_FILES, ...VST3_RUNTIME_FILES].map((file) => path.join(nativeDir, file))
  )
  const result = stagedVst3Files(
    root,
    existing,
    (filePath) => !filePath.endsWith('twilight-vst3-host.exe')
  )
  assert.equal(result.complete, false)
  assert.deepEqual(result.wrongArchitecture, ['twilight-vst3-host.exe'])
})

test('complete staged VST3 helpers can be reused without a toolchain', () => {
  const root = 'C:/repo'
  const nativeDir = path.join(root, 'resources', 'audio-engine')
  const existing = createExistsSync(
    [...VST3_HELPER_FILES, ...VST3_RUNTIME_FILES].map((file) => path.join(nativeDir, file))
  )
  let refreshed = ''
  const result = prepareVst3Msvc({
    root,
    platform: 'win32',
    arch: 'x64',
    environment: {},
    exists: existing,
    isPeX64: () => true,
    refresh: (directory) => {
      refreshed = directory
    },
    run: () => {
      throw new Error('the complete staged set should not invoke the toolchain')
    }
  })

  assert.equal(result.reused, true)
  assert.equal(result.nativeDir, nativeDir)
  assert.equal(refreshed, nativeDir)
})

test('VST3 preparation configures, builds, stages, and refreshes capability artifacts', () => {
  const root = 'C:/repo'
  const sdkRoot = 'C:/sdk/vst3'
  const installRoot = 'C:/tools/vs2022'
  const nativeDir = path.join(root, 'resources', 'audio-engine')
  const buildDir = path.join(root, 'audio-engine', 'build', 'vst3-msvc-x64')
  const existingPaths = new Set([
    path.join(sdkRoot, 'CMakeLists.txt'),
    path.join(sdkRoot, 'cmake', 'modules', 'SMTG_VST3_SDK.cmake'),
    path.join(sdkRoot, 'pluginterfaces', 'vst', 'ivstaudioprocessor.h'),
    path.join(sdkRoot, 'public.sdk', 'source', 'vst', 'hosting', 'module.h'),
    path.join(installRoot, 'Common7', 'Tools', 'VsDevCmd.bat'),
    path.join(installRoot, 'VC', 'Tools', 'MSVC')
  ])
  const exists = (entry) => existingPaths.has(path.normalize(entry))
  const calls = []
  let refreshCount = 0
  const result = prepareVst3Msvc({
    root,
    platform: 'win32',
    arch: 'x64',
    environment: {
      TAE_VST3_SDK_ROOT: sdkRoot,
      TAE_VST3_MSVC_INSTALL_ROOT: installRoot,
      TAE_VST3_MSVC_BUILD_DIR: buildDir
    },
    exists,
    isPeX64: () => true,
    readDirectories: () => [{ isDirectory: () => true }],
    run: (_command, args) => {
      calls.push(args)
      if (args.includes('configure-vst3-msvc.cjs'))
        existingPaths.add(path.join(buildDir, 'CMakeCache.txt'))
      if (args.includes('stage')) {
        for (const file of [...VST3_HELPER_FILES, ...VST3_RUNTIME_FILES]) {
          existingPaths.add(path.join(nativeDir, file))
        }
      }
      return { status: 0 }
    },
    refresh: () => {
      refreshCount += 1
    }
  })

  assert.equal(result.reused, false)
  assert.equal(result.buildDir, buildDir)
  assert.equal(refreshCount, 1)
  assert.equal(calls.length, 4)
  assert.match(calls[0][0], /configure-vst3-msvc\.cjs$/)
  assert.match(calls[1][0], /run-vst3-msvc\.cjs$/)
  assert.equal(calls[1][1], 'build')
  assert.match(calls[2][0], /run-vst3-msvc\.cjs$/)
  assert.equal(calls[2][1], 'stage')
  assert.match(calls[3][0], /run-vst3-msvc\.cjs$/)
  assert.equal(calls[3][1], 'test')
  assert.equal(stagedVst3Files(root, exists, () => true).complete, true)
})
