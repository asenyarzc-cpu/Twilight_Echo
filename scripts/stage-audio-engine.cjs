const { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { collectImportClosure } = require('./pe-imports.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const { createReleaseCapabilityStatus } = require('./verify-release-capability-consistency.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')

const root = join(__dirname, '..')
const outputDir = join(root, 'resources', 'audio-engine')
function optionValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return { provided: false, value: '' }
  const raw = process.argv[index + 1]
  return { provided: true, value: raw ? resolve(raw) : '' }
}
const buildDirOption = optionValue('--build-dir')
const runtimeDirOption = optionValue('--runtime-dir')
const selectedBuildDir = buildDirOption.value
if (
  (buildDirOption.provided && !selectedBuildDir) ||
  (runtimeDirOption.provided && !runtimeDirOption.value)
) {
  console.error(
    'Usage: node scripts/stage-audio-engine.cjs [--build-dir <path>] [--runtime-dir <toolchain bin>]'
  )
  process.exit(1)
}
const defaultMingwBuildDir = join(root, 'audio-engine', 'build', 'mingw-static')
const configuredMingwBuildDir = process.env.TAE_MINGW_BUILD_DIR
  ? resolve(process.env.TAE_MINGW_BUILD_DIR)
  : defaultMingwBuildDir
const buildDirs = selectedBuildDir
  ? [selectedBuildDir]
  : [
      configuredMingwBuildDir,
      defaultMingwBuildDir,
      join(root, 'audio-engine', 'build', 'windows-msvc'),
      join(root, 'audio-engine', 'build', 'default')
    ].filter((directory, index, directories) => directories.indexOf(directory) === index)
const nativeLibrary =
  process.platform === 'win32'
    ? 'twilight-audio-engine.dll'
    : process.platform === 'darwin'
      ? 'libtwilight-audio-engine.dylib'
      : 'libtwilight-audio-engine.so'
const runtimeFiles = [
  nativeLibrary,
  'twilight_audio_node.node',
  ...(process.platform === 'win32' ? ['twilight-asio-helper.exe'] : [])
]

function findBuildDir() {
  return buildDirs.find((dir) => runtimeFiles.every((file) => existsSync(join(dir, file))))
}

const buildDir = findBuildDir()
if (!buildDir) {
  if (selectedBuildDir) {
    console.error(
      `Selected audio-engine build directory does not contain runtime files: ${selectedBuildDir}`
    )
    process.exit(1)
  }
  console.error(
    `No audio-engine runtime files were found in:\n${buildDirs.join('\n')}\n` +
      'Run the matching audio-engine build first, or provide --build-dir for an explicitly selected build.'
  )
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })

function stageFile(source, file) {
  const target = join(outputDir, file)
  try {
    copyFileSync(source, target)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '未知'
    console.error(
      `暂存原生音频文件失败：${file}。请先关闭正在占用旧文件的播放器窗口或后台进程。错误码：${code}`
    )
    process.exit(1)
  }
  const sizeMiB = (statSync(target).size / 1024 / 1024).toFixed(1)
  console.log(`已暂存原生音频文件：${file}（${sizeMiB} MiB）`)
  return target
}

for (const file of runtimeFiles) {
  stageFile(join(buildDir, file), file)
}

/**
 * Directories that may hold the GNU toolchain runtime DLLs. The compiler
 * recorded in CMakeCache comes first because it is the toolchain that actually
 * produced the artifacts — an unrelated MinGW earlier on PATH ships a different
 * libstdc++ and the addon then fails to load with "The specified procedure could
 * not be found".
 */
function toolchainRuntimeDirs() {
  const candidates = []
  if (runtimeDirOption.value) candidates.push(runtimeDirOption.value)
  if (process.env.TAE_MINGW_RUNTIME_DIR) candidates.push(resolve(process.env.TAE_MINGW_RUNTIME_DIR))
  const cache = join(buildDir, 'CMakeCache.txt')
  if (existsSync(cache)) {
    const compiler = readFileSync(cache, 'utf8').match(/^CMAKE_CXX_COMPILER(?::[^=]*)?=(.+)$/m)?.[1]
    if (compiler) candidates.push(dirname(resolve(compiler.trim())))
  }
  for (const devkitRoot of [process.env.TAE_W64DEVKIT_ROOT, process.env.W64DEVKIT_ROOT]) {
    if (devkitRoot) candidates.push(join(resolve(devkitRoot), 'bin'))
  }
  candidates.push(buildDir)
  return candidates.filter((dir, index, dirs) => dirs.indexOf(dir) === index && existsSync(dir))
}

/**
 * The MinGW build links libstdc++/libgcc/mcfgthread dynamically (the "static" in
 * the windows-mingw-static preset is only the vcpkg triplet), so those DLLs have
 * to sit beside the addon or nothing can dlopen it. Deriving them from the import
 * table keeps staging correct when the toolchain changes its threading model.
 */
function stageWindowsRuntimeDependencies() {
  const searchDirs = toolchainRuntimeDirs()
  const closure = collectImportClosure(
    runtimeFiles.map((file) => join(outputDir, file)),
    (name) => {
      const staged = join(outputDir, name)
      if (existsSync(staged)) return staged
      for (const dir of searchDirs) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return stageFile(candidate, name)
      }
      return null
    }
  )
  if (closure.missing.length > 0) {
    console.error(
      [
        '暂存原生音频运行时依赖失败，以下 DLL 在工具链目录里找不到：',
        ...closure.missing.map((entry) => `  ${entry.name}`),
        '已查找：',
        ...searchDirs.map((dir) => `  ${dir}`),
        '设置 W64DEVKIT_ROOT 或 --runtime-dir 指向构建所用工具链的 bin 目录后重试。'
      ].join('\n')
    )
    process.exit(1)
  }
}

if (process.platform === 'win32') stageWindowsRuntimeDependencies()

const capabilityManifestPath = join(outputDir, 'audio-capabilities.json')
const binaryCapabilityManifest = createAudioCapabilityManifest({ artifactDir: outputDir })
const runtimeStatus = readStagedAudioRuntimeObservation({
  artifactDir: outputDir,
  manifest: binaryCapabilityManifest
})
const capabilityManifest = createAudioCapabilityManifest({ artifactDir: outputDir, runtimeStatus })
require('node:fs').writeFileSync(
  capabilityManifestPath,
  `${JSON.stringify(capabilityManifest, null, 2)}\n`
)
console.log(`已暂存原生音频能力清单：${capabilityManifestPath}`)
const releaseCapabilityStatusPath = join(outputDir, 'release-capability-status.json')
require('node:fs').writeFileSync(
  releaseCapabilityStatusPath,
  `${JSON.stringify(
    createReleaseCapabilityStatus({ nativeDir: outputDir, manifest: capabilityManifest }),
    null,
    2
  )}\n`
)
console.log(`已暂存发布能力状态：${releaseCapabilityStatusPath}`)
