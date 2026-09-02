const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { collectImportClosure } = require('./pe-imports.cjs')

const MIB = 1024 * 1024
const DEFAULT_BUDGETS = Object.freeze({
  'twilight-audio-engine.dll': 192 * MIB,
  'twilight_audio_node.node': 16 * MIB,
  'twilight-asio-helper.exe': 32 * MIB,
  'twilight-vst3-host.exe': 32 * MIB,
  'twilight-vst3-scanner.exe': 32 * MIB,
  installer: 384 * MIB
})
const DEFAULT_SHIPPED_BINARY_BUDGET = 64 * MIB

// Core playback files are required while capability-manifest generation may
// still describe an unbuilt VST3 pair. Windows release verification uses the
// stricter REQUIRED_RELEASE_NATIVE_BINARIES list below.
const REQUIRED_NATIVE_BINARIES = Object.freeze([
  'twilight-audio-engine.dll',
  'twilight_audio_node.node',
  'twilight-asio-helper.exe'
])
const REQUIRED_RELEASE_NATIVE_BINARIES = Object.freeze([
  ...REQUIRED_NATIVE_BINARIES,
  'twilight-vst3-host.exe',
  'twilight-vst3-scanner.exe'
])
const PE_MACHINE_AMD64 = 0x8664

function parseArgs(argv) {
  const options = {
    nativeDir: '',
    artifactDir: '',
    installer: ''
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!['--native-dir', '--artifact-dir', '--installer'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`)
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path or value`)
    if (arg === '--native-dir') options.nativeDir = value
    if (arg === '--artifact-dir') options.artifactDir = value
    if (arg === '--installer') options.installer = value
  }
  if (!options.nativeDir) throw new Error('--native-dir is required')
  if (!options.installer && !options.artifactDir) {
    throw new Error(
      'Provide --installer or --artifact-dir so the installer size budget can be checked'
    )
  }
  return options
}

function readPeHeader(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} is not a PE binary`)
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (
    peOffset + 24 > buffer.length ||
    buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`${filePath} has an invalid PE header`)
  }
  const coffOffset = peOffset + 4
  const optionalSize = buffer.readUInt16LE(coffOffset + 16)
  const optionalOffset = coffOffset + 20
  if (optionalOffset + optionalSize > buffer.length || optionalSize < 96) {
    throw new Error(`${filePath} has a truncated PE optional header`)
  }
  const optionalMagic = buffer.readUInt16LE(optionalOffset)
  const dataDirectoryOffset = optionalMagic === 0x20b ? optionalOffset + 112 : optionalOffset + 96
  if (
    ![0x10b, 0x20b].includes(optionalMagic) ||
    dataDirectoryOffset + 8 * 7 > optionalOffset + optionalSize
  ) {
    throw new Error(`${filePath} has an unsupported PE optional header`)
  }
  const sectionCount = buffer.readUInt16LE(coffOffset + 2)
  const symbolTableOffset = buffer.readUInt32LE(coffOffset + 8)
  const symbolCount = buffer.readUInt32LE(coffOffset + 12)
  const debugDirectoryRva = buffer.readUInt32LE(dataDirectoryOffset + 8 * 6)
  const debugDirectorySize = buffer.readUInt32LE(dataDirectoryOffset + 8 * 6 + 4)
  const sectionTableOffset = optionalOffset + optionalSize
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40
    if (offset + 40 > buffer.length) throw new Error(`${filePath} has a truncated PE section table`)
    sections.push(buffer.toString('ascii', offset, offset + 8).replace(/\0+$/, ''))
  }
  const machine = buffer.readUInt16LE(coffOffset)
  return {
    machine,
    symbolTableOffset,
    symbolCount,
    debugDirectoryRva,
    debugDirectorySize,
    sections
  }
}

function assertX64Pe(filePath) {
  const pe = readPeHeader(filePath)
  assert.equal(
    pe.machine,
    PE_MACHINE_AMD64,
    `${path.basename(filePath)} is not a Windows x64 PE binary`
  )
}

function assertStrippedPe(filePath) {
  const pe = readPeHeader(filePath)
  assert.equal(pe.symbolTableOffset, 0, `${path.basename(filePath)} retains a COFF symbol table`)
  assert.equal(pe.symbolCount, 0, `${path.basename(filePath)} retains COFF symbols`)
  assert.equal(pe.debugDirectoryRva, 0, `${path.basename(filePath)} retains a PE debug directory`)
  assert.equal(pe.debugDirectorySize, 0, `${path.basename(filePath)} retains PE debug data`)
  assert.equal(
    pe.sections.some((section) => /^\.debug/i.test(section)),
    false,
    `${path.basename(filePath)} retains a debug section`
  )
}

function assertBudget(filePath, maxBytes, label = path.basename(filePath)) {
  const size = fs.statSync(filePath).size
  assert.ok(size > 0, `${label} is empty`)
  assert.ok(size <= maxBytes, `${label} is ${size} bytes; budget is ${maxBytes} bytes`)
  return size
}

function listNativeBinaries(nativeDir) {
  const optional = ['twilight-vst3-host.exe', 'twilight-vst3-scanner.exe'].filter((name) =>
    fs.existsSync(path.resolve(nativeDir, name))
  )
  return [...REQUIRED_NATIVE_BINARIES, ...optional].map((name) => {
    const filePath = path.resolve(nativeDir, name)
    assert.ok(fs.existsSync(filePath), `Missing required native binary: ${filePath}`)
    return filePath
  })
}

function listReleaseNativeBinaries(nativeDir) {
  return REQUIRED_RELEASE_NATIVE_BINARIES.map((name) => {
    const filePath = path.resolve(nativeDir, name)
    assert.ok(fs.existsSync(filePath), `Missing required release native binary: ${filePath}`)
    return filePath
  })
}

function listShippedBinaries(nativeDir) {
  const binaries = fs
    .readdirSync(nativeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(dll|exe|node)$/i.test(entry.name))
    .map((entry) => path.join(nativeDir, entry.name))
  assert.ok(binaries.length > 0, `No shipped DLL/EXE/NODE binaries found in ${nativeDir}`)
  return binaries
}

/**
 * Every non-system DLL the shipped binaries import has to sit beside them. The
 * MinGW build links libstdc++/libgcc/mcfgthread dynamically (the "static" in the
 * windows-mingw-static preset is only the vcpkg triplet), and a release that
 * omits them dlopen-fails on any machine without that exact toolchain installed
 * — reported to the user as an opaque "未加载 twilight_audio_node.node".
 *
 * These runtime dependencies are checked for presence only: they are toolchain
 * output rather than our own build product, so they are not stripped and must
 * stay out of DEFAULT_BUDGETS (a name listed there joins listNativeBinaries'
 * optional set, and assertStrippedPe would then fail over the COFF symbol tables
 * that libstdc++-6.dll and libgcc_s_seh-1.dll ship with). listShippedBinaries
 * still holds them to the per-file size budget.
 */
function listRuntimeDependencies(nativeDir, entryFiles) {
  const closure = collectImportClosure(entryFiles, (name) => {
    const candidate = path.resolve(nativeDir, name)
    return fs.existsSync(candidate) ? candidate : null
  })
  for (const entry of closure.missing) {
    const importers = entry.importers.map((importer) => path.basename(importer)).join(', ')
    assert.fail(
      `Missing runtime dependency beside the native binaries: ${entry.name} (imported by ${importers}) in ${nativeDir}`
    )
  }
  return closure.dependencies
    .map((dependency) => dependency.path)
    .filter((dependencyPath) => !entryFiles.includes(dependencyPath))
}

function findInstaller(options) {
  if (options.installer) {
    const installer = path.resolve(options.installer)
    assert.ok(fs.existsSync(installer), `Installer does not exist: ${installer}`)
    return installer
  }
  const artifactDir = path.resolve(options.artifactDir)
  assert.ok(fs.existsSync(artifactDir), `Artifact directory does not exist: ${artifactDir}`)
  const installers = fs
    .readdirSync(artifactDir)
    .filter((name) => /-setup\.exe$/i.test(name))
    .map((name) => path.join(artifactDir, name))
  assert.equal(installers.length, 1, `Expected exactly one NSIS installer in ${artifactDir}`)
  return installers[0]
}

function verifyReleaseArtifacts(options) {
  const nativeBinaries = listReleaseNativeBinaries(options.nativeDir)
  const shippedBinaries = listShippedBinaries(options.nativeDir)
  for (const filePath of shippedBinaries) assertX64Pe(filePath)
  const runtimeDependencies = listRuntimeDependencies(options.nativeDir, nativeBinaries)
  const installer = findInstaller(options)
  const sizes = {}
  for (const filePath of shippedBinaries) {
    const name = path.basename(filePath)
    sizes[name] = assertBudget(filePath, DEFAULT_BUDGETS[name] || DEFAULT_SHIPPED_BINARY_BUDGET)
  }
  for (const filePath of nativeBinaries) {
    assertStrippedPe(filePath)
  }
  sizes.installer = assertBudget(installer, DEFAULT_BUDGETS.installer, 'NSIS installer')
  return { nativeBinaries, shippedBinaries, runtimeDependencies, installer, sizes }
}

function main() {
  const result = verifyReleaseArtifacts(parseArgs(process.argv.slice(2)))
  console.log(
    `Release artifacts verified: ${result.nativeBinaries.length} native binaries, ${result.runtimeDependencies.length} runtime dependencies, installer=${result.installer}`
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
  DEFAULT_BUDGETS,
  DEFAULT_SHIPPED_BINARY_BUDGET,
  PE_MACHINE_AMD64,
  REQUIRED_NATIVE_BINARIES,
  REQUIRED_RELEASE_NATIVE_BINARIES,
  assertBudget,
  assertStrippedPe,
  assertX64Pe,
  findInstaller,
  listNativeBinaries,
  listReleaseNativeBinaries,
  listRuntimeDependencies,
  listShippedBinaries,
  parseArgs,
  readPeHeader,
  verifyReleaseArtifacts
}
