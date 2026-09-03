const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' })
}

function runCommand(command, args) {
  execFileSync(command, args, { stdio: 'pipe' })
}

function parseOtoolDependencies(output) {
  const lines = String(output).split(/\r?\n/)
  const dependencies = lines
    .slice(1)
    .map((line) => line.trim().match(/^(.*?) \(compatibility version/)?.[1])
    .filter(Boolean)
  return lines[0]?.trim().endsWith('.dylib:') ? dependencies.slice(1) : dependencies
}

function parseOtoolRpaths(output) {
  const lines = String(output).split(/\r?\n/)
  const rpaths = []
  let readingRpath = false
  for (const line of lines) {
    if (/^\s*cmd LC_RPATH\s*$/.test(line)) {
      readingRpath = true
      continue
    }
    if (!readingRpath) continue
    const value = line.match(/^\s*path (.*?) \(offset \d+\)\s*$/)?.[1]
    if (value) {
      rpaths.push(value)
      readingRpath = false
    }
  }
  return rpaths
}

function inspectDependencies(filePath, output = commandOutput) {
  return parseOtoolDependencies(output('otool', ['-L', filePath]))
}

function inspectRpaths(filePath, output = commandOutput) {
  return parseOtoolRpaths(output('otool', ['-l', filePath]))
}

function isSystemDependency(loadPath) {
  return loadPath.startsWith('/System/Library/') || loadPath.startsWith('/usr/lib/')
}

function expandLoaderPath(value, sourceFile) {
  if (value === '@loader_path') return path.dirname(sourceFile)
  if (value.startsWith('@loader_path/')) {
    return path.resolve(path.dirname(sourceFile), value.slice('@loader_path/'.length))
  }
  return value
}

function resolveDependencySource(loadPath, sourceFile, rpaths, exists = fs.existsSync) {
  const candidates = []
  if (path.isAbsolute(loadPath)) candidates.push(loadPath)
  else if (loadPath.startsWith('@loader_path/'))
    candidates.push(expandLoaderPath(loadPath, sourceFile))
  else if (loadPath.startsWith('@rpath/')) {
    const suffix = loadPath.slice('@rpath/'.length)
    for (const rpath of rpaths) {
      const expanded = expandLoaderPath(rpath, sourceFile)
      if (path.isAbsolute(expanded)) candidates.push(path.join(expanded, suffix))
    }
  }
  const resolved = candidates.find((candidate) => exists(candidate))
  if (!resolved) {
    throw new Error(
      `Unable to resolve non-system Mach-O dependency ${loadPath} imported by ${sourceFile}`
    )
  }
  return resolved
}

function validateBundledMacOSRuntime(
  binaries,
  {
    inspectDependencies: dependencies = inspectDependencies,
    inspectRpaths: rpaths = inspectRpaths,
    exists = fs.existsSync
  } = {}
) {
  const bundledDependencies = new Set()
  for (const binary of binaries) {
    for (const loadPath of dependencies(binary)) {
      if (isSystemDependency(loadPath)) continue
      if (!loadPath.startsWith('@loader_path/')) {
        throw new Error(`Found non-portable Mach-O dependency in ${binary}: ${loadPath}`)
      }
      const target = path.resolve(path.dirname(binary), loadPath.slice('@loader_path/'.length))
      if (!exists(target)) {
        throw new Error(`Found missing bundled Mach-O dependency in ${binary}: ${loadPath}`)
      }
      bundledDependencies.add(target)
    }
    for (const rpath of rpaths(binary)) {
      if (rpath !== '@loader_path' && !rpath.startsWith('@loader_path/')) {
        throw new Error(`Found non-portable Mach-O rpath in ${binary}: ${rpath}`)
      }
    }
  }
  return { binaries: binaries.length, bundledDependencies: bundledDependencies.size }
}

function bundleMacOSRuntimeDependencies(
  entryFiles,
  outputDir,
  {
    inspectDependencies: dependencies = inspectDependencies,
    inspectRpaths: rpaths = inspectRpaths,
    exists = fs.existsSync,
    realpath = fs.realpathSync,
    copy = fs.copyFileSync,
    run = runCommand
  } = {}
) {
  assert.ok(entryFiles.length > 0, 'At least one macOS runtime entry file is required')
  const entryTargets = new Set(entryFiles.map((filePath) => path.resolve(filePath)))
  const targetByBasename = new Map()
  const sourceByTarget = new Map()
  const queue = []
  for (const filePath of entryFiles) {
    const target = path.resolve(filePath)
    assert.ok(exists(target), `Missing macOS runtime entry file: ${target}`)
    const basename = path.basename(target)
    targetByBasename.set(basename, target)
    sourceByTarget.set(target, target)
    queue.push(target)
  }

  const inspected = new Set()
  const changes = new Map()
  while (queue.length > 0) {
    const target = queue.shift()
    if (inspected.has(target)) continue
    inspected.add(target)
    const source = sourceByTarget.get(target) ?? target
    const sourceRpaths = rpaths(target)
    for (const loadPath of dependencies(target)) {
      if (isSystemDependency(loadPath)) continue
      const basename = path.basename(loadPath)
      assert.ok(basename && basename !== '.', `Invalid Mach-O dependency in ${target}: ${loadPath}`)
      let dependencyTarget = targetByBasename.get(basename)
      if (!dependencyTarget) {
        const dependencySource = realpath(
          resolveDependencySource(loadPath, source, sourceRpaths, exists)
        )
        dependencyTarget = path.join(outputDir, basename)
        const existingSource = sourceByTarget.get(dependencyTarget)
        if (existingSource && realpath(existingSource) !== dependencySource) {
          throw new Error(`Mach-O dependency basename collision for ${basename}`)
        }
        copy(dependencySource, dependencyTarget)
        targetByBasename.set(basename, dependencyTarget)
        sourceByTarget.set(dependencyTarget, dependencySource)
        queue.push(dependencyTarget)
      } else if (!entryTargets.has(dependencyTarget)) {
        const dependencySource = realpath(
          resolveDependencySource(loadPath, source, sourceRpaths, exists)
        )
        const existingSource = realpath(sourceByTarget.get(dependencyTarget) ?? dependencyTarget)
        if (existingSource !== dependencySource) {
          throw new Error(`Mach-O dependency basename collision for ${basename}`)
        }
      }
      const replacement = `@loader_path/${basename}`
      if (loadPath !== replacement) {
        const fileChanges = changes.get(target) ?? []
        fileChanges.push([loadPath, replacement])
        changes.set(target, fileChanges)
      }
    }
  }

  const binaries = [...inspected]
  for (const binary of binaries) {
    for (const [from, to] of changes.get(binary) ?? []) {
      run('install_name_tool', ['-change', from, to, binary])
    }
    if (binary.endsWith('.dylib')) {
      run('install_name_tool', ['-id', `@loader_path/${path.basename(binary)}`, binary])
    }
    for (const rpath of rpaths(binary)) {
      if (rpath !== '@loader_path' && !rpath.startsWith('@loader_path/')) {
        run('install_name_tool', ['-delete_rpath', rpath, binary])
      }
    }
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', binary])
  }

  const verification = validateBundledMacOSRuntime(binaries)
  return {
    files: binaries.sort(),
    copiedDependencies: binaries.filter((file) => !entryTargets.has(file)).length,
    verification
  }
}

function runtimeBinaries(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:dylib|node)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort()
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--runtime-dir' || !argv[1]) {
    throw new Error('Usage: node scripts/macos-audio-runtime.cjs --runtime-dir <directory>')
  }
  const directory = path.resolve(argv[1])
  assert.ok(fs.existsSync(directory), `macOS runtime directory does not exist: ${directory}`)
  const result = validateBundledMacOSRuntime(runtimeBinaries(directory))
  console.log(
    `macOS audio runtime verified: ${result.binaries} Mach-O files, ` +
      `${result.bundledDependencies} bundled dependency edges`
  )
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = {
  bundleMacOSRuntimeDependencies,
  inspectDependencies,
  inspectRpaths,
  isSystemDependency,
  parseOtoolDependencies,
  parseOtoolRpaths,
  resolveDependencySource,
  runtimeBinaries,
  validateBundledMacOSRuntime
}
