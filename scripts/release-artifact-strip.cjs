const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const NATIVE_RUNTIME_FILES = Object.freeze([
  'twilight-audio-engine.dll',
  'twilight_audio_node.node',
  'twilight_smtc_node.node',
  'twilight-asio-helper.exe',
  'twilight-vst3-host.exe',
  'twilight-vst3-scanner.exe'
])

// The core playback runtime and isolated VST3 helper pair are required in a
// Windows package. Packaging prepares the pair before electron-builder runs and
// strips every shipped product binary from the copied package payload.
const REQUIRED_NATIVE_RUNTIME_FILES = Object.freeze([...NATIVE_RUNTIME_FILES])

function executableCandidates(environment = process.env) {
  const candidates = []
  if (environment.TWILIGHT_RELEASE_STRIP) candidates.push(environment.TWILIGHT_RELEASE_STRIP)
  for (const root of [environment.TAE_W64DEVKIT_ROOT, environment.W64DEVKIT_ROOT]) {
    if (root)
      candidates.push(path.join(root, 'bin', process.platform === 'win32' ? 'strip.exe' : 'strip'))
  }
  candidates.push(process.platform === 'win32' ? 'strip.exe' : 'strip')
  return candidates
}

function resolveStripCommand(environment = process.env, exists = fs.existsSync) {
  for (const candidate of executableCandidates(environment)) {
    if (path.isAbsolute(candidate) && exists(candidate)) return candidate
    if (!path.isAbsolute(candidate)) return candidate
  }
  throw new Error(
    'No release strip tool was found; set TWILIGHT_RELEASE_STRIP to a GNU/LLVM strip executable'
  )
}

function peLayout(buffer) {
  assert.ok(
    buffer.length >= 0x40 && buffer.toString('ascii', 0, 2) === 'MZ',
    'Invalid PE DOS header'
  )
  const peOffset = buffer.readUInt32LE(0x3c)
  assert.ok(
    peOffset + 24 <= buffer.length && buffer.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0',
    'Invalid PE signature'
  )
  const coffOffset = peOffset + 4
  const sectionCount = buffer.readUInt16LE(coffOffset + 2)
  const optionalHeaderSize = buffer.readUInt16LE(coffOffset + 16)
  const optionalOffset = coffOffset + 20
  const magic = buffer.readUInt16LE(optionalOffset)
  const dataDirectoryOffset = optionalOffset + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0)
  assert.ok(dataDirectoryOffset > optionalOffset, 'Unsupported PE optional header')
  const debugEntryOffset = dataDirectoryOffset + 6 * 8
  const sectionTableOffset = optionalOffset + optionalHeaderSize
  assert.ok(debugEntryOffset + 8 <= sectionTableOffset, 'Invalid PE data directory')
  assert.ok(sectionTableOffset + sectionCount * 40 <= buffer.length, 'Invalid PE section table')
  return { coffOffset, debugEntryOffset, sectionCount, sectionTableOffset }
}

function peRvaToOffset(buffer, rva, layout) {
  for (let index = 0; index < layout.sectionCount; index += 1) {
    const sectionOffset = layout.sectionTableOffset + index * 40
    const virtualSize = buffer.readUInt32LE(sectionOffset + 8)
    const virtualAddress = buffer.readUInt32LE(sectionOffset + 12)
    const rawSize = buffer.readUInt32LE(sectionOffset + 16)
    const rawOffset = buffer.readUInt32LE(sectionOffset + 20)
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      const fileOffset = rawOffset + rva - virtualAddress
      return fileOffset < buffer.length ? fileOffset : null
    }
  }
  return null
}

function clearPeDebugDirectory(filePath, dependencies = {}) {
  const read = dependencies.read || fs.readFileSync
  const write = dependencies.write || fs.writeFileSync
  const buffer = Buffer.from(read(filePath))
  const layout = peLayout(buffer)
  const debugRva = buffer.readUInt32LE(layout.debugEntryOffset)
  const debugSize = buffer.readUInt32LE(layout.debugEntryOffset + 4)
  if (debugRva === 0 || debugSize === 0) return false

  const debugOffset = peRvaToOffset(buffer, debugRva, layout)
  assert.ok(
    debugOffset !== null && debugOffset + debugSize <= buffer.length,
    'Invalid PE debug directory range'
  )
  const entryCount = Math.floor(debugSize / 28)
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = debugOffset + index * 28
    const dataSize = buffer.readUInt32LE(entryOffset + 16)
    const dataRva = buffer.readUInt32LE(entryOffset + 20)
    const rawDataOffset = buffer.readUInt32LE(entryOffset + 24)
    const dataOffset = rawDataOffset || peRvaToOffset(buffer, dataRva, layout)
    if (dataSize > 0 && dataOffset !== null) {
      assert.ok(dataOffset + dataSize <= buffer.length, 'Invalid PE debug data range')
      buffer.fill(0, dataOffset, dataOffset + dataSize)
    }
  }
  buffer.fill(0, debugOffset, debugOffset + debugSize)
  buffer.writeUInt32LE(0, layout.debugEntryOffset)
  buffer.writeUInt32LE(0, layout.debugEntryOffset + 4)
  write(filePath, buffer)
  return true
}

// GNU binutils >= 2.46 zeroes the COFF symbol count but leaves
// PointerToSymbolTable pointing past the stripped image. The release artifact
// contract requires both header fields to read zero, so normalize the pointer
// once strip removed the table itself; a table that is still present keeps a
// non-zero count and still fails verify-release-artifacts.
function clearPeSymbolTablePointer(filePath, dependencies = {}) {
  const read = dependencies.read || fs.readFileSync
  const write = dependencies.write || fs.writeFileSync
  const buffer = Buffer.from(read(filePath))
  const layout = peLayout(buffer)
  if (buffer.readUInt32LE(layout.coffOffset + 12) !== 0) return false
  if (buffer.readUInt32LE(layout.coffOffset + 8) === 0) return false
  buffer.writeUInt32LE(0, layout.coffOffset + 8)
  write(filePath, buffer)
  return true
}

function waitForRetry(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function stripNativeFile(filePath, dependencies = {}) {
  const exists = dependencies.exists || fs.existsSync
  const run = dependencies.run || spawnSync
  const wait = dependencies.wait || waitForRetry
  const clearDebugDirectory = dependencies.clearDebugDirectory || clearPeDebugDirectory
  const clearSymbolTablePointer = dependencies.clearSymbolTablePointer || clearPeSymbolTablePointer
  const stripCommand =
    dependencies.stripCommand || resolveStripCommand(dependencies.environment, exists)
  let result
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = run(stripCommand, ['--strip-all', filePath], {
      encoding: 'utf8',
      windowsHide: true
    })
    if ((result.status ?? 1) === 0) break
    if (attempt < 3) wait(250)
  }
  if ((result?.status ?? 1) !== 0) {
    throw new Error(
      [`Failed to strip ${filePath}`, result?.stdout, result?.stderr].filter(Boolean).join('\n')
    )
  }
  clearDebugDirectory(filePath)
  clearSymbolTablePointer(filePath)
}

function stripNativeArtifacts(nativeDir, dependencies = {}) {
  const exists = dependencies.exists || fs.existsSync
  const wait = dependencies.wait || waitForRetry
  const copy = dependencies.copy || fs.copyFileSync
  const remove = dependencies.remove || fs.rmSync
  const stripped = []
  const missing = []
  for (const name of REQUIRED_NATIVE_RUNTIME_FILES) {
    const filePath = path.join(nativeDir, name)
    assert.ok(exists(filePath), `Missing packaged native runtime binary: ${filePath}`)
  }
  for (const name of NATIVE_RUNTIME_FILES) {
    const filePath = path.join(nativeDir, name)
    if (!exists(filePath)) {
      missing.push(filePath)
      continue
    }
    const temporaryPath = `${filePath}.strip-${process.pid}`
    copy(filePath, temporaryPath)
    try {
      stripNativeFile(temporaryPath, dependencies)
      let copied = false
      let copyError
      for (let attempt = 1; attempt <= 60; attempt += 1) {
        try {
          copy(temporaryPath, filePath)
          copied = true
          break
        } catch (error) {
          copyError = error
          if (attempt < 60) wait(500)
        }
      }
      if (!copied) throw copyError
      stripped.push(filePath)
    } finally {
      remove(temporaryPath, { force: true })
    }
  }
  return { stripped, missing }
}

module.exports = {
  NATIVE_RUNTIME_FILES,
  REQUIRED_NATIVE_RUNTIME_FILES,
  clearPeDebugDirectory,
  clearPeSymbolTablePointer,
  executableCandidates,
  resolveStripCommand,
  stripNativeArtifacts,
  stripNativeFile,
  waitForRetry
}
