const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  NATIVE_RUNTIME_FILES,
  clearPeDebugDirectory,
  clearPeSymbolTablePointer,
  executableCandidates,
  stripNativeArtifacts
} = require('./release-artifact-strip.cjs')

function makePeWithDebugDirectory() {
  const buffer = Buffer.alloc(0x400, 0)
  const peOffset = 0x80
  const coffOffset = peOffset + 4
  const optionalOffset = coffOffset + 20
  const sectionOffset = optionalOffset + 0xf0
  const debugEntryOffset = optionalOffset + 112 + 6 * 8
  const debugOffset = 0x200
  const debugDataOffset = 0x240
  buffer.write('MZ')
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.write('PE\0\0', peOffset)
  buffer.writeUInt16LE(1, coffOffset + 2)
  buffer.writeUInt16LE(0xf0, coffOffset + 16)
  buffer.writeUInt16LE(0x20b, optionalOffset)
  buffer.writeUInt32LE(0x1000, debugEntryOffset)
  buffer.writeUInt32LE(28, debugEntryOffset + 4)
  buffer.write('.rdata', sectionOffset)
  buffer.writeUInt32LE(0x200, sectionOffset + 8)
  buffer.writeUInt32LE(0x1000, sectionOffset + 12)
  buffer.writeUInt32LE(0x200, sectionOffset + 16)
  buffer.writeUInt32LE(debugOffset, sectionOffset + 20)
  buffer.writeUInt32LE(16, debugOffset + 16)
  buffer.writeUInt32LE(0x1040, debugOffset + 20)
  buffer.writeUInt32LE(debugDataOffset, debugOffset + 24)
  buffer.fill(0x5a, debugDataOffset, debugDataOffset + 16)
  return { buffer, debugDataOffset, debugEntryOffset, debugOffset }
}

test('release strip uses an explicit protected-environment tool before PATH', () => {
  assert.equal(
    executableCandidates({
      TWILIGHT_RELEASE_STRIP: 'C:/signing/strip.exe',
      TAE_W64DEVKIT_ROOT: 'C:/w64'
    })[0],
    'C:/signing/strip.exe'
  )
})

test('release strip only processes the packaged runtime copy and fails closed', () => {
  const calls = []
  const cleared = []
  const symbolCleared = []
  const packagedDir = path.resolve('C:/release/win-unpacked/resources/audio-engine')
  const result = stripNativeArtifacts(packagedDir, {
    stripCommand: 'C:/tools/strip.exe',
    exists: (filePath) => filePath.startsWith(packagedDir),
    run: (command, args) => {
      calls.push({ command, args })
      return { status: 0 }
    },
    copy: () => {},
    remove: () => {},
    clearDebugDirectory: (filePath) => cleared.push(filePath),
    clearSymbolTablePointer: (filePath) => symbolCleared.push(filePath)
  })
  assert.equal(result.stripped.length, NATIVE_RUNTIME_FILES.length)
  assert.deepEqual(result.missing, [])
  assert.equal(calls.length, NATIVE_RUNTIME_FILES.length)
  assert.equal(cleared.length, NATIVE_RUNTIME_FILES.length)
  assert.equal(symbolCleared.length, NATIVE_RUNTIME_FILES.length)
  assert.ok(calls.every((call) => call.args[0] === '--strip-all'))
  assert.ok(calls.every((call) => call.args[1].startsWith(packagedDir)))
  assert.throws(
    () =>
      stripNativeArtifacts(packagedDir, {
        stripCommand: 'strip',
        exists: () => false,
        run: () => ({ status: 0 })
      }),
    /Missing packaged native runtime binary/
  )
})

test('release strip rejects a package without the VST3 helper pair', () => {
  const packagedDir = path.resolve('C:/release/no-vst3/resources/audio-engine')
  const exists = (filePath) =>
    NATIVE_RUNTIME_FILES.slice(0, 4).some((name) => filePath === path.join(packagedDir, name))
  assert.throws(
    () =>
      stripNativeArtifacts(packagedDir, {
        stripCommand: 'C:/tools/strip.exe',
        exists,
        run: () => ({ status: 0 }),
        copy: () => {},
        remove: () => {},
        clearDebugDirectory: () => {},
        clearPeDebugDirectory: () => {}
      }),
    /Missing packaged native runtime binary.*twilight-vst3-host\.exe/
  )
})

test('release strip clears PE debug directory records and referenced data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-clear-pe-debug-'))
  try {
    const filePath = path.join(directory, 'runtime.exe')
    const fixture = makePeWithDebugDirectory()
    fs.writeFileSync(filePath, fixture.buffer)
    assert.equal(clearPeDebugDirectory(filePath), true)
    const result = fs.readFileSync(filePath)
    assert.equal(result.readUInt32LE(fixture.debugEntryOffset), 0)
    assert.equal(result.readUInt32LE(fixture.debugEntryOffset + 4), 0)
    assert.ok(
      result.subarray(fixture.debugOffset, fixture.debugOffset + 28).every((value) => value === 0)
    )
    assert.ok(
      result
        .subarray(fixture.debugDataOffset, fixture.debugDataOffset + 16)
        .every((value) => value === 0)
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('release strip normalizes the COFF symbol pointer only when the table is gone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-clear-pe-symbols-'))
  const peOffset = 0x80
  const coffOffset = peOffset + 4
  try {
    const strippedPath = path.join(directory, 'stripped.dll')
    const stripped = makePeWithDebugDirectory()
    stripped.buffer.writeUInt32LE(0x400, coffOffset + 8)
    fs.writeFileSync(strippedPath, stripped.buffer)
    assert.equal(clearPeSymbolTablePointer(strippedPath), true)
    const cleared = fs.readFileSync(strippedPath)
    assert.equal(cleared.readUInt32LE(coffOffset + 8), 0)
    assert.equal(cleared.readUInt32LE(coffOffset + 12), 0)

    // A symbol table that survived strip keeps its count and must stay
    // detectable by verify-release-artifacts.
    const unstrippedPath = path.join(directory, 'unstripped.dll')
    const unstripped = makePeWithDebugDirectory()
    unstripped.buffer.writeUInt32LE(0x400, coffOffset + 8)
    unstripped.buffer.writeUInt32LE(12, coffOffset + 12)
    fs.writeFileSync(unstrippedPath, unstripped.buffer)
    assert.equal(clearPeSymbolTablePointer(unstrippedPath), false)
    const kept = fs.readFileSync(unstrippedPath)
    assert.equal(kept.readUInt32LE(coffOffset + 8), 0x400)
    assert.equal(kept.readUInt32LE(coffOffset + 12), 12)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('release strip retries transient file locks and still fails closed', () => {
  const attemptsByFile = new Map()
  stripNativeArtifacts('C:/release', {
    stripCommand: 'strip',
    exists: () => true,
    wait: () => {},
    copy: () => {},
    remove: () => {},
    run: (_, [, filePath]) => {
      const attempts = (attemptsByFile.get(filePath) || 0) + 1
      attemptsByFile.set(filePath, attempts)
      return { status: attempts < 3 ? 1 : 0 }
    },
    clearDebugDirectory: () => {},
    clearSymbolTablePointer: () => {}
  })
  assert.ok(attemptsByFile.size >= 3)
  assert.deepEqual(new Set(attemptsByFile.values()), new Set([3]))

  let attempts = 0
  assert.throws(
    () =>
      stripNativeArtifacts('C:/release', {
        stripCommand: 'strip',
        exists: () => true,
        wait: () => {},
        copy: () => {},
        remove: () => {},
        run: () => {
          attempts += 1
          return { status: 1, stderr: 'bad binary' }
        }
      }),
    /Failed to strip/
  )
  assert.equal(attempts, 3)
})
