const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  REQUIRED_NATIVE_BINARIES,
  assertBudget,
  listNativeBinaries,
  listRuntimeDependencies,
  listShippedBinaries,
  parseArgs,
  readPeHeader
} = require('./verify-release-artifacts.cjs')
const { createMinimalPe } = require('./pe-fixture.cjs')

test('release artifact arguments require a native directory and installer target', () => {
  assert.throws(() => parseArgs([]), /--native-dir is required/)
  assert.throws(() => parseArgs(['--native-dir', 'native']), /--installer or --artifact-dir/)
  assert.deepEqual(parseArgs(['--native-dir', 'native', '--artifact-dir', 'dist']), {
    nativeDir: 'native',
    artifactDir: 'dist',
    installer: ''
  })
})

test('PE inspection finds stripped and retained debug metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-pe-'))
  try {
    const clean = path.join(dir, 'clean.dll')
    const debug = path.join(dir, 'debug.dll')
    fs.writeFileSync(clean, createMinimalPe())
    fs.writeFileSync(debug, createMinimalPe({ debugDirectoryRva: 1, debugDirectorySize: 28 }))
    assert.equal(readPeHeader(clean).symbolCount, 0)
    assert.throws(
      () => require('./verify-release-artifacts.cjs').assertStrippedPe(debug),
      /debug directory/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('size checks reject unsafe release inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-'))
  try {
    const file = path.join(dir, 'item.exe')
    fs.writeFileSync(file, Buffer.alloc(11))
    assert.equal(assertBudget(file, 11), 11)
    assert.throws(() => assertBudget(file, 10), /budget/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('all shipped native DLL/EXE/NODE files receive a size budget while strip checks remain product-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-shipped-binaries-'))
  try {
    fs.writeFileSync(path.join(dir, 'twilight-audio-engine.dll'), createMinimalPe())
    fs.writeFileSync(path.join(dir, 'msvcp140.dll'), Buffer.alloc(32))
    fs.writeFileSync(path.join(dir, 'notice.txt'), 'not a binary')
    assert.deepEqual(
      listShippedBinaries(dir)
        .map((filePath) => path.basename(filePath))
        .sort(),
      ['msvcp140.dll', 'twilight-audio-engine.dll']
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('release verification requires every imported runtime dependency beside the binaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-runtime-closure-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'twilight-audio-engine.dll'),
      createMinimalPe({ imports: ['libstdc++-6.dll', 'KERNEL32.dll'] })
    )
    fs.writeFileSync(
      path.join(dir, 'twilight_audio_node.node'),
      createMinimalPe({ imports: ['twilight-audio-engine.dll', 'libstdc++-6.dll'] })
    )
    fs.writeFileSync(
      path.join(dir, 'twilight-asio-helper.exe'),
      createMinimalPe({ imports: ['libstdc++-6.dll'] })
    )
    const entries = listNativeBinaries(dir)
    assert.throws(
      () => listRuntimeDependencies(dir, entries),
      /Missing runtime dependency beside the native binaries: libstdc\+\+-6\.dll/
    )

    // A dependency's own imports are followed too, so a transitively missing DLL
    // cannot pass by staging only the directly imported one.
    fs.writeFileSync(
      path.join(dir, 'libstdc++-6.dll'),
      createMinimalPe({ imports: ['libmcfgthread-2.dll'] })
    )
    assert.throws(() => listRuntimeDependencies(dir, entries), /libmcfgthread-2\.dll/)

    fs.writeFileSync(path.join(dir, 'libmcfgthread-2.dll'), createMinimalPe())
    assert.deepEqual(
      listRuntimeDependencies(dir, entries)
        .map((filePath) => path.basename(filePath))
        .sort(),
      ['libmcfgthread-2.dll', 'libstdc++-6.dll'],
      'system imports must not be demanded, and product binaries are not their own dependency'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('native binary verification requires the core runtime and verifies optional VST3 helpers when staged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-native-binaries-'))
  try {
    for (const name of REQUIRED_NATIVE_BINARIES) {
      fs.writeFileSync(path.join(dir, name), createMinimalPe())
    }
    assert.deepEqual(
      listNativeBinaries(dir)
        .map((filePath) => path.basename(filePath))
        .sort(),
      [...REQUIRED_NATIVE_BINARIES].sort()
    )
    fs.writeFileSync(path.join(dir, 'twilight-vst3-host.exe'), createMinimalPe())
    fs.writeFileSync(path.join(dir, 'twilight-vst3-scanner.exe'), createMinimalPe())
    assert.equal(listNativeBinaries(dir).length, REQUIRED_NATIVE_BINARIES.length + 2)
    fs.rmSync(path.join(dir, 'twilight-audio-engine.dll'))
    assert.throws(() => listNativeBinaries(dir), /Missing required native binary/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
