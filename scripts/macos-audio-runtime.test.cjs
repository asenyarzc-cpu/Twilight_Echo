const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  isSystemDependency,
  parseOtoolDependencies,
  parseOtoolRpaths,
  validateBundledMacOSRuntime
} = require('./macos-audio-runtime.cjs')

test('parses otool dependency and rpath output without treating the Mach-O identity as a load', () => {
  assert.deepEqual(
    parseOtoolDependencies(
      `sample.dylib:\n\t@rpath/sample.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib (compatibility version 63.0.0, current version 63.1.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`
    ),
    ['/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib', '/usr/lib/libSystem.B.dylib']
  )
  assert.deepEqual(
    parseOtoolDependencies(
      `sample.node:\n\t@loader_path/libtwilight-audio-engine.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`
    ),
    ['@loader_path/libtwilight-audio-engine.dylib', '/usr/lib/libSystem.B.dylib']
  )
  assert.deepEqual(
    parseOtoolRpaths(
      `Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path @loader_path (offset 12)\nLoad command 2\n          cmd LC_RPATH\n      cmdsize 88\n         path /private/tmp/audio-engine/build/default (offset 12)\n`
    ),
    ['@loader_path', '/private/tmp/audio-engine/build/default']
  )
})

test('recognizes only Apple platform locations as system dependencies', () => {
  assert.equal(isSystemDependency('/System/Library/Frameworks/CoreAudio.framework/CoreAudio'), true)
  assert.equal(isSystemDependency('/usr/lib/libSystem.B.dylib'), true)
  assert.equal(isSystemDependency('/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib'), false)
  assert.equal(isSystemDependency('@loader_path/libavcodec.63.dylib'), false)
})

test('packaged macOS runtime rejects absolute third-party loads and missing loader-path siblings', () => {
  const runtimeDir = path.resolve('/tmp/twilight-macos-runtime-fixture')
  const engine = path.join(runtimeDir, 'libtwilight-audio-engine.dylib')
  const node = path.join(runtimeDir, 'twilight_audio_node.node')
  assert.throws(
    () =>
      validateBundledMacOSRuntime([engine, node], {
        inspectDependencies: (file) =>
          file === engine
            ? ['/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib']
            : ['@loader_path/libtwilight-audio-engine.dylib'],
        inspectRpaths: () => [],
        exists: () => true
      }),
    /non-portable Mach-O dependency/
  )
  assert.throws(
    () =>
      validateBundledMacOSRuntime([engine, node], {
        inspectDependencies: () => ['@loader_path/libmissing.dylib'],
        inspectRpaths: () => [],
        exists: () => false
      }),
    /missing bundled Mach-O dependency/
  )
})

test('packaged macOS runtime accepts loader-relative dependencies with no build-machine rpaths', () => {
  const runtimeDir = path.resolve('/tmp/twilight-macos-runtime-fixture')
  const engine = path.join(runtimeDir, 'libtwilight-audio-engine.dylib')
  const node = path.join(runtimeDir, 'twilight_audio_node.node')
  const dependency = path.join(runtimeDir, 'libavcodec.63.dylib')
  const result = validateBundledMacOSRuntime([engine, node, dependency], {
    inspectDependencies: (file) =>
      file === node
        ? ['@loader_path/libtwilight-audio-engine.dylib', '/usr/lib/libSystem.B.dylib']
        : file === engine
          ? ['@loader_path/libavcodec.63.dylib']
          : ['/usr/lib/libSystem.B.dylib'],
    inspectRpaths: () => ['@loader_path'],
    exists: () => true
  })
  assert.deepEqual(result, { binaries: 3, bundledDependencies: 2 })
})

test('Node-API uses the native loader-relative rpath on macOS', () => {
  const cmake = fs.readFileSync(
    path.join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'),
    'utf8'
  )
  assert.match(cmake, /if\(APPLE\)\s+set\(TAE_NAPI_RPATH "@loader_path"\)/)
  assert.match(cmake, /BUILD_RPATH "\$\{TAE_NAPI_RPATH\}"/)
  assert.match(cmake, /INSTALL_RPATH "\$\{TAE_NAPI_RPATH\}"/)
})
