const assert = require('node:assert/strict')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  MINGW_EXPECTED_CTESTS,
  findStaleCTestRegistrations,
  prepareMingwCmakeEnvironment,
  prepareMingwBuildLayout,
  resolveMingwBuildJobs,
  resolveMingwBuildLayout,
  validateMingwBuildCommands,
  validateMingwCTestRegistration,
  validateMingwNativeDependencyConfiguration,
  validateMingwToolchain
} = require('./audio-engine-toolchain.cjs')
const {
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcBuildDirectory
} = require('./asio-msvc-toolchain.cjs')
const { createMinimalPe } = require('./pe-fixture.cjs')

// stage-audio-engine.cjs requires these siblings, so a fixture copy needs all of
// them or the script dies with MODULE_NOT_FOUND before reaching its own checks.
const STAGING_SCRIPT_FILES = Object.freeze([
  'stage-audio-engine.cjs',
  'audio-engine-toolchain.cjs',
  'pe-imports.cjs'
])

function copyStagingScripts(fixtureScripts) {
  mkdirSync(fixtureScripts, { recursive: true })
  for (const file of STAGING_SCRIPT_FILES) {
    copyFileSync(join(__dirname, file), join(fixtureScripts, file))
  }
}

function nativeLibraryName() {
  return process.platform === 'win32'
    ? 'twilight-audio-engine.dll'
    : process.platform === 'darwin'
      ? 'libtwilight-audio-engine.dylib'
      : 'libtwilight-audio-engine.so'
}

/** Staging parses import tables on Windows, so fixtures must be real PE files. */
function writeRuntimeFixture(directory, file, options = {}) {
  writeFileSync(join(directory, file), createMinimalPe(options))
}

function createExistsSync(paths) {
  const existing = new Set(paths.map((entry) => entry.replaceAll('\\', '/').toLowerCase()))
  return (entry) => existing.has(String(entry).replaceAll('\\', '/').toLowerCase())
}

function createSpawnSync(results) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const result = results[command]
    return typeof result === 'function' ? result(command, args, options) : result
  }
  spawn.calls = calls
  return spawn
}

function createGnuPatchSpawnSync() {
  return createSpawnSync(
    new Proxy(
      {},
      {
        get: () => ({ status: 0, stdout: 'GNU patch 2.7.6', stderr: '' })
      }
    )
  )
}

test('prepares a deterministic MSVC and Ninja environment for the ASIO ABI fixture', () => {
  const installRoot = 'E:/tools/vs2022-buildtools'
  const msvcVersion = '14.44.35207'
  const sdkRoot = 'C:/Program Files (x86)/Windows Kits/10'
  const sdkVersion = '10.0.26100.0'
  const existing = [
    `${installRoot}/Common7/Tools/VsDevCmd.bat`,
    `${installRoot}/VC/Tools/MSVC`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/bin/Hostx64/x64/cl.exe`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/bin/Hostx64/x64/link.exe`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/include/cstddef`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/lib/x64/msvcrt.lib`,
    `${installRoot}/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe`,
    `${installRoot}/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe`,
    `${sdkRoot}/bin/${sdkVersion}/x64/rc.exe`,
    `${sdkRoot}/bin/${sdkVersion}/x64/mt.exe`,
    `${sdkRoot}/Include/${sdkVersion}/um/Windows.h`,
    `${sdkRoot}/Lib/${sdkVersion}/um/x64/kernel32.lib`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/include`,
    `${sdkRoot}/Include/${sdkVersion}/ucrt`,
    `${sdkRoot}/Include/${sdkVersion}/shared`,
    `${sdkRoot}/Include/${sdkVersion}/um`,
    `${sdkRoot}/Include/${sdkVersion}/winrt`,
    `${sdkRoot}/Include/${sdkVersion}/cppwinrt`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/lib/x64`,
    `${sdkRoot}/Lib/${sdkVersion}/ucrt/x64`,
    `${sdkRoot}/Lib/${sdkVersion}/um/x64`,
    `${sdkRoot}/UnionMetadata/${sdkVersion}`,
    `${sdkRoot}/References/${sdkVersion}`
  ]
  const result = prepareAsioMsvcNinjaToolchain({
    env: {
      TAE_ASIO_MSVC_INSTALL_ROOT: installRoot,
      'ProgramFiles(x86)': 'C:/Program Files (x86)',
      PATH: 'C:/Windows/System32'
    },
    exists: createExistsSync(existing),
    readDirectories: (path) => {
      if (String(path).replaceAll('\\', '/').endsWith('/VC/Tools/MSVC')) {
        return [{ name: msvcVersion, isDirectory: () => true }]
      }
      if (String(path).replaceAll('\\', '/').endsWith('/Windows Kits/10/Include')) {
        return [{ name: sdkVersion, isDirectory: () => true }]
      }
      return []
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.msvcVersion, msvcVersion)
  assert.equal(result.sdkVersion, sdkVersion)
  assert.match(result.environment.PATH, /Hostx64\\x64/)
  assert.match(result.environment.INCLUDE, /MSVC\\14\.44\.35207\\include/)
  assert.match(result.environment.LIB, /Windows Kits\\10\\Lib\\10\.0\.26100\.0\\um\\x64/)
  assert.match(result.cmakePath, /CMake\\bin\\cmake\.exe$/)
  assert.match(result.ninjaPath, /CMake\\Ninja\\ninja\.exe$/)
})

test('uses the MSVC Ninja build directory by default for ASIO ABI fixtures', () => {
  assert.match(
    resolveAsioMsvcBuildDirectory({}, 'C:/repo'),
    /audio-engine\\build\\asio-msvc-ninja-x64$/
  )
})

test('rejects a missing MinGW toolchain environment before CMake configures', () => {
  const result = validateMingwToolchain({
    env: {},
    existsSync: createExistsSync([])
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /VCPKG_ROOT/)
  assert.match(result.message, /W64DEVKIT_ROOT/)
})

test('accepts an installed toolchain and rejects CTest entries from a moved build directory', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const buildDir = 'C:/repo/audio-engine/build/mingw-static'
  const result = validateMingwToolchain({
    env: { VCPKG_ROOT: vcpkgRoot, W64DEVKIT_ROOT: devkitRoot },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`
    ])
  })

  assert.deepEqual(result, { ok: true, message: '' })
  assert.deepEqual(
    findStaleCTestRegistrations(
      'add_test([=[engine]=] "T:/audio-engine/build/mingw-static/twilight_audio_tests.exe")',
      buildDir
    ),
    ['T:/audio-engine/build/mingw-static/twilight_audio_tests.exe']
  )
})

function registeredCTestOutput(names = MINGW_EXPECTED_CTESTS) {
  return `${names.map((name, index) => `  Test #${index + 1}: ${name}`).join('\n')}\n\nTotal Tests: ${names.length}`
}

test('fails closed when a MinGW build has no CMake cache or CTest file', () => {
  const buildDir = 'C:/twilight-build/mingw-static'
  const missingCache = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([]),
    spawnSync: () => {
      throw new Error('ctest must not run without a cache')
    }
  })
  assert.equal(missingCache.ok, false)
  assert.match(missingCache.message, /CMakeCache\.txt/)

  const missingCTestFile = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`]),
    spawnSync: () => {
      throw new Error('ctest must not run without CTestTestfile.cmake')
    }
  })
  assert.equal(missingCTestFile.ok, false)
  assert.match(missingCTestFile.message, /CTestTestfile\.cmake/)
})

test('rejects zero or incomplete MinGW CTest discovery even when ctest exits zero', () => {
  const buildDir = 'C:/twilight-build/mingw-static'
  const base = {
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`, `${buildDir}/CTestTestfile.cmake`]),
    readFileSync: () => 'add_test(NAME local COMMAND "C:/twilight-build/mingw-static/local.exe")'
  }

  const zeroTests = validateMingwCTestRegistration({
    ...base,
    spawnSync: () => ({ status: 0, stdout: 'No tests were found!!!\nTotal Tests: 0', stderr: '' })
  })
  assert.equal(zeroTests.ok, false)
  assert.match(zeroTests.message, /zero tests/)

  const incomplete = validateMingwCTestRegistration({
    ...base,
    spawnSync: () => ({
      status: 0,
      stdout: registeredCTestOutput(MINGW_EXPECTED_CTESTS.slice(1)),
      stderr: ''
    })
  })
  assert.equal(incomplete.ok, false)
  assert.deepEqual(incomplete.missing, [MINGW_EXPECTED_CTESTS[0]])
})

test('accepts a configured MinGW build only when every native CTest is registered', () => {
  const buildDir = 'C:/twilight-build/mingw-static'
  const result = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`, `${buildDir}/CTestTestfile.cmake`]),
    readFileSync: () =>
      'add_test(NAME local COMMAND "C:/twilight-build/mingw-static/twilight_audio_tests.exe")',
    spawnSync: () => ({ status: 0, stdout: registeredCTestOutput(), stderr: '' })
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
  assert.deepEqual(result.missing, [])
})

test('fails closed when the MinGW cache was configured without vcpkg native dependencies', () => {
  const buildDir = 'C:/twilight-build/mingw-static'
  const cache = `${buildDir}/CMakeCache.txt`
  const result = validateMingwNativeDependencyConfiguration({
    buildDir,
    existsSync: createExistsSync([cache]),
    readFileSync: () =>
      [
        'VCPKG_TARGET_TRIPLET:UNINITIALIZED=x64-mingw-static',
        'TAE_BUILD_NAPI:BOOL=ON',
        'FFMPEG_FOUND:BOOL=FALSE',
        'EBUR128_INCLUDE_DIR:PATH=EBUR128_INCLUDE_DIR-NOTFOUND'
      ].join('\n')
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /VCPKG_INSTALLED_DIR/)
  assert.match(result.message, /FFMPEG_FOUND/)
  assert.match(result.message, /EBUR128_INCLUDE_DIR/)
})

test('accepts a MinGW cache only when vcpkg FFmpeg and libebur128 resolve from the selected build', () => {
  const buildDir = 'C:/twilight-build/mingw-static'
  const installRoot = `${buildDir}/vcpkg_installed`
  const tripletRoot = `${installRoot}/x64-mingw-static`
  const cache = `${buildDir}/CMakeCache.txt`
  const result = validateMingwNativeDependencyConfiguration({
    buildDir,
    existsSync: createExistsSync([
      cache,
      `${tripletRoot}/include/ebur128.h`,
      `${tripletRoot}/lib/libebur128.a`,
      `${tripletRoot}/include/libavformat/avformat.h`
    ]),
    readFileSync: () =>
      [
        `VCPKG_INSTALLED_DIR:PATH=${installRoot}`,
        'VCPKG_TARGET_TRIPLET:STRING=x64-mingw-static',
        'TAE_BUILD_NAPI:BOOL=ON',
        'FFMPEG_FOUND:BOOL=TRUE',
        `EBUR128_INCLUDE_DIR:PATH=${tripletRoot}/include`,
        `EBUR128_LIBRARY:FILEPATH=${tripletRoot}/lib/libebur128.a`,
        `FFMPEG_INCLUDE_DIRS:STRING=${tripletRoot}/include`
      ].join('\n')
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
})

test('prepares a MinGW environment with GNU patch before the w64devkit tools', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const programFiles = 'C:/Program Files'
  const gnuPatch = `${programFiles}/Git/usr/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createSpawnSync({
      'C:\\Program Files\\Git\\usr\\bin\\patch.exe': {
        status: 0,
        stdout: 'GNU patch 2.7.6',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, true)
  assert.match(
    result.environment.PATH,
    /^C:\\Program Files\\Git\\usr\\bin;C:\\tools\\w64devkit\\bin;/
  )
})

test('preserves a Windows Path environment value when building the MinGW PATH', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const programFiles = 'C:/Program Files'
  const gnuPatch = `${programFiles}/Git/usr/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      Path: 'C:/Windows/System32;C:/Windows'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.Path, undefined)
  assert.match(result.environment.PATH, /C:\/Windows\/System32;C:\/Windows$/)
})

test('rejects a TWILIGHT_GNU_PATCH override that is not GNU patch', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const busyboxPatch = `${devkitRoot}/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      TWILIGHT_GNU_PATCH: busyboxPatch,
      ProgramFiles: 'C:/Program Files',
      PATH: 'C:/Windows/System32'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      busyboxPatch,
      'C:/Program Files/Git/usr/bin/patch.exe'
    ]),
    spawnSync: createSpawnSync({
      'C:\\tools\\w64devkit\\bin\\patch.exe': {
        status: 0,
        stdout: 'BusyBox v1.36.1',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /TWILIGHT_GNU_PATCH/)
  assert.match(result.message, /Git for Windows/)
})

test('rejects an automatic Git patch path that does not identify as GNU patch', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const gnuPatch = 'C:/Program Files/Git/usr/bin/patch.exe'
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: 'C:/Program Files',
      PATH: 'C:/Windows/System32'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createSpawnSync({
      'C:\\Program Files\\Git\\usr\\bin\\patch.exe': {
        status: 0,
        stdout: 'patch 2.7.6',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /Git for Windows/)
  assert.match(result.message, /valid TWILIGHT_GNU_PATCH/)
})

test('rejects a w64devkit environment without a compatible GNU patch executable', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      PATH: 'C:/Windows/System32'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`
    ])
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /GNU patch/)
  assert.match(result.message, /TWILIGHT_GNU_PATCH/)
})

test('reports missing CMake and CTest before native configuration or test discovery', () => {
  const missingCmake = validateMingwBuildCommands({
    env: { PATH: 'C:/Windows/System32' },
    spawnSync: createSpawnSync({
      cmake: { error: new Error('spawn cmake ENOENT'), status: null, stdout: '', stderr: '' },
      ctest: { status: 0, stdout: 'ctest version 3.30.0', stderr: '' }
    })
  })
  assert.equal(missingCmake.ok, false)
  assert.match(missingCmake.message, /CMake.*cmake/i)
  assert.match(missingCmake.message, /PATH/)

  const missingCtest = validateMingwBuildCommands({
    env: { PATH: 'C:/Windows/System32' },
    spawnSync: createSpawnSync({
      cmake: { status: 0, stdout: 'cmake version 3.30.0', stderr: '' },
      ctest: { error: new Error('spawn ctest ENOENT'), status: null, stdout: '', stderr: '' }
    })
  })
  assert.equal(missingCtest.ok, false)
  assert.match(missingCtest.message, /CTest.*ctest/i)
  assert.match(missingCtest.message, /PATH/)
})

test('requires a no-whitespace MinGW build directory and derives its temporary directory', () => {
  const missingOverride = resolveMingwBuildLayout({
    root: 'C:/Project With Spaces/Twilight Echo',
    env: {}
  })
  assert.equal(missingOverride.ok, false)
  assert.match(missingOverride.message, /TAE_MINGW_BUILD_DIR/)

  const configured = resolveMingwBuildLayout({
    root: 'C:/Project With Spaces/Twilight Echo',
    env: { TAE_MINGW_BUILD_DIR: 'C:/twilight-build/mingw-static' }
  })
  assert.deepEqual(configured, {
    ok: true,
    buildDir: 'C:\\twilight-build\\mingw-static',
    tempDir: 'C:\\twilight-build\\mingw-static\\tmp'
  })
})

test('creates and validates the selected MinGW build layout before CMake runs', () => {
  const created = []
  const checked = []
  const result = prepareMingwBuildLayout({
    root: 'C:/Project With Spaces/Twilight Echo',
    env: { TAE_MINGW_BUILD_DIR: 'C:/twilight-build/mingw-static' },
    mkdirSync: (directory, options) => created.push({ directory, options }),
    accessSync: (directory, mode) => checked.push({ directory, mode }),
    constants: { W_OK: 2 }
  })

  assert.deepEqual(result, {
    ok: true,
    buildDir: 'C:\\twilight-build\\mingw-static',
    tempDir: 'C:\\twilight-build\\mingw-static\\tmp'
  })
  assert.deepEqual(created, [
    { directory: 'C:\\twilight-build\\mingw-static', options: { recursive: true } },
    { directory: 'C:\\twilight-build\\mingw-static\\tmp', options: { recursive: true } }
  ])
  assert.deepEqual(checked, [
    { directory: 'C:\\twilight-build\\mingw-static', mode: 2 },
    { directory: 'C:\\twilight-build\\mingw-static\\tmp', mode: 2 }
  ])
})

test('reports an actionable preflight error for an unwritable selected MinGW layout', () => {
  const result = prepareMingwBuildLayout({
    root: 'C:/Project With Spaces/Twilight Echo',
    env: { TAE_MINGW_BUILD_DIR: 'C:/twilight-build/mingw-static' },
    mkdirSync: () => {},
    accessSync: () => {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    },
    constants: { W_OK: 2 }
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /^MinGW audio toolchain preflight failed:/)
  assert.match(result.message, /C:\\twilight-build\\mingw-static/)
  assert.match(result.message, /writable/i)
  assert.doesNotMatch(result.message, /Error:/)
})

test('uses the selected build directory for the CMake temporary environment', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const programFiles = 'C:/Program Files'
  const result = prepareMingwCmakeEnvironment({
    buildDir: 'C:/twilight-build/mingw-static',
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.TEMP, 'C:\\twilight-build\\mingw-static\\tmp')
  assert.equal(result.environment.TMP, result.environment.TEMP)
  assert.equal(result.environment.TMPDIR, result.environment.TEMP)
})

test('enables MSYS .lnk symlinks without replacing unrelated MSYS flags', () => {
  const vcpkgRoot = 'C:/tools/vcpkg'
  const devkitRoot = 'C:/tools/w64devkit'
  const programFiles = 'C:/Program Files'
  const result = prepareMingwCmakeEnvironment({
    buildDir: 'C:/twilight-build/mingw-static',
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32',
      MSYS: 'noacl winsymlinks:lnk'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.MSYS, 'noacl winsymlinks:lnk')

  const withDuplicateLinkFallback = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32',
      MSYS: 'noacl winsymlinks:lnk winsymlinks:lnk'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withDuplicateLinkFallback.ok, true)
  assert.equal(withDuplicateLinkFallback.environment.MSYS, 'noacl winsymlinks:lnk')

  const withLaterConflictingLinkMode = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32',
      MSYS: 'noacl winsymlinks:lnk winsymlinks:native'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withLaterConflictingLinkMode.ok, true)
  assert.equal(
    withLaterConflictingLinkMode.environment.MSYS,
    'noacl winsymlinks:native winsymlinks:lnk'
  )

  const withoutLinkFallback = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: 'C:/Windows/System32',
      MSYS: 'noacl'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withoutLinkFallback.ok, true)
  assert.equal(withoutLinkFallback.environment.MSYS, 'noacl winsymlinks:lnk')
})

test('MinGW configure script performs the preflight before invoking CMake', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /findStaleCTestRegistrations/)
  assert.match(script, /prepareMingwCmakeEnvironment/)
  assert.match(script, /prepareMingwBuildLayout/)
  assert.match(script, /const toolchainEnvironment = resolveMingwEnvironment\(\)/)
  assert.match(
    script,
    /const buildLayout = prepareMingwBuildLayout\(\{ root, env: toolchainEnvironment \}\)/
  )
  assert.match(script, /const \{ buildDir \} = buildLayout/)
  assert.match(script, /'-B', buildDir/)
  assert.match(script, /const cmakeEnvironment = preflight\.environment/)
})

test('MinGW configure validates once and never retries a possibly active vcpkg configure', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /const status = runCmake\(\)/)
  assert.match(script, /if \(status !== 0\) process\.exit\(status\)/)
  assert.equal(script.match(/runCmake\(\)/g)?.length, 2)
  assert.doesNotMatch(script, /cleanFfmpegExtractTemps|vcpkgLogText/)
})

test('MinGW scripts preflight CMake and CTest with the prepared environment', () => {
  const configureScript = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')
  const runnerScript = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(configureScript, /validateMingwBuildCommands/)
  assert.match(configureScript, /validateMingwBuildCommands\(\{ env: cmakeEnvironment \}\)/)
  assert.match(configureScript, /validateMingwCTestRegistration/)
  assert.match(configureScript, /expectedTests: MINGW_EXPECTED_CTESTS/)
  assert.match(runnerScript, /validateMingwBuildCommands/)
  assert.match(runnerScript, /prepareMingwBuildLayout/)
  assert.match(runnerScript, /const toolchainEnvironment = resolveMingwEnvironment\(\)/)
  assert.match(
    runnerScript,
    /const layout = prepareMingwBuildLayout\(\{ root, env: toolchainEnvironment \}\)/
  )
  assert.match(
    runnerScript,
    /validateMingwBuildCommands\(\{\s*env: preflight\.environment,\s*commands: \['cmake', 'ctest'\]\s*\}\)/
  )
  assert.match(runnerScript, /validateMingwCTestRegistration/)
  assert.match(
    runnerScript,
    /if \(!ctestRegistration\.ok\)[\s\S]*process\.exit\(ctestRegistration\.status \|\| 1\)/
  )
})

test('MinGW staging rejects an explicitly selected build directory instead of using fallback artifacts', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-stage-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  const fixtureScripts = join(fixtureRoot, 'scripts')
  copyStagingScripts(fixtureScripts)

  const fallbackBuildDirs = [
    join(fixtureRoot, 'audio-engine', 'build', 'mingw-static'),
    join(fixtureRoot, 'audio-engine', 'build', 'windows-msvc'),
    join(fixtureRoot, 'audio-engine', 'build', 'default')
  ]
  const nativeLibrary = nativeLibraryName()
  for (const fallbackBuildDir of fallbackBuildDirs) {
    mkdirSync(fallbackBuildDir, { recursive: true })
    for (const file of [nativeLibrary, 'twilight_audio_node.node']) {
      writeRuntimeFixture(fallbackBuildDir, file, { trailer: 'fallback artifact' })
    }
  }

  const selectedBuildDir = join(fixtureRoot, 'selected-build')
  const result = spawnSync(
    process.execPath,
    [join(fixtureScripts, 'stage-audio-engine.cjs'), '--build-dir', selectedBuildDir],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, TAE_MINGW_BUILD_DIR: '' }
    }
  )

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /selected audio-engine build directory/i)
  assert.equal(existsSync(join(fixtureRoot, 'resources', 'audio-engine', nativeLibrary)), false)
})

for (const fallbackName of ['windows-msvc', 'default']) {
  test(`generic audio staging discovers ${fallbackName} runtime artifacts`, (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight audio stage-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const fixtureScripts = join(fixtureRoot, 'scripts')
    copyStagingScripts(fixtureScripts)

    const nativeLibrary = nativeLibraryName()
    const fallbackBuildDir = join(fixtureRoot, 'audio-engine', 'build', fallbackName)
    mkdirSync(fallbackBuildDir, { recursive: true })
    for (const file of [nativeLibrary, 'twilight_audio_node.node']) {
      writeRuntimeFixture(fallbackBuildDir, file, { trailer: `artifact from ${fallbackName}` })
    }

    const result = spawnSync(process.execPath, [join(fixtureScripts, 'stage-audio-engine.cjs')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, TAE_MINGW_BUILD_DIR: '' }
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(
      readFileSync(
        join(fixtureRoot, 'resources', 'audio-engine', nativeLibrary),
        'latin1'
      ).includes(`artifact from ${fallbackName}`),
      `staged ${nativeLibrary} did not come from the ${fallbackName} build directory`
    )
  })
}

// The MinGW build links libstdc++/libgcc/mcfgthread dynamically, so those DLLs
// must be staged beside the addon; without them dlopen fails on any machine that
// lacks that exact toolchain and the app can only report "未加载
// twilight_audio_node.node". Windows-only because the step parses PE imports.
const windowsStagingOnly = process.platform === 'win32' ? {} : { skip: 'Windows-only staging step' }

function stageRuntimeDependencyFixture(fixtureRoot, { provideRuntimeDll }) {
  const fixtureScripts = join(fixtureRoot, 'scripts')
  copyStagingScripts(fixtureScripts)

  const nativeLibrary = nativeLibraryName()
  const buildDir = join(fixtureRoot, 'audio-engine', 'build', 'default')
  mkdirSync(buildDir, { recursive: true })
  writeRuntimeFixture(buildDir, nativeLibrary, { imports: ['libstdc++-6.dll', 'KERNEL32.dll'] })
  writeRuntimeFixture(buildDir, 'twilight_audio_node.node', {
    imports: [nativeLibrary, 'libstdc++-6.dll']
  })

  const toolchainBin = join(fixtureRoot, 'toolchain', 'bin')
  mkdirSync(toolchainBin, { recursive: true })
  // Reachable only through libstdc++-6.dll, so staging has to walk the closure.
  writeRuntimeFixture(toolchainBin, 'libmcfgthread-2.dll')
  if (provideRuntimeDll) {
    writeRuntimeFixture(toolchainBin, 'libstdc++-6.dll', { imports: ['libmcfgthread-2.dll'] })
  }

  const result = spawnSync(
    process.execPath,
    [join(fixtureScripts, 'stage-audio-engine.cjs'), '--runtime-dir', toolchainBin],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TAE_MINGW_BUILD_DIR: '',
        TAE_MINGW_RUNTIME_DIR: '',
        W64DEVKIT_ROOT: '',
        TAE_W64DEVKIT_ROOT: ''
      }
    }
  )
  return { result, stagedDir: join(fixtureRoot, 'resources', 'audio-engine') }
}

test(
  'Windows staging copies the whole toolchain runtime import closure',
  windowsStagingOnly,
  (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-runtime-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const { result, stagedDir } = stageRuntimeDependencyFixture(fixtureRoot, {
      provideRuntimeDll: true
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    for (const file of ['libstdc++-6.dll', 'libmcfgthread-2.dll']) {
      assert.ok(existsSync(join(stagedDir, file)), `${file} was not staged beside the addon`)
    }
  }
)

test(
  'Windows staging fails loudly when a toolchain runtime DLL cannot be found',
  windowsStagingOnly,
  (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-runtime-missing-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const { result, stagedDir } = stageRuntimeDependencyFixture(fixtureRoot, {
      provideRuntimeDll: false
    })

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /libstdc\+\+-6\.dll/)
    assert.equal(existsSync(join(stagedDir, 'libstdc++-6.dll')), false)
  }
)

test('MinGW build runner stages from its selected external build directory', () => {
  const script = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(
    script,
    /\[resolve\(__dirname, 'stage-audio-engine\.cjs'\), '--build-dir', layout\.buildDir\]/
  )
})

test('MinGW build runner reuses the preflight environment for builds and tests', () => {
  const script = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /prepareMingwCmakeEnvironment/)
  assert.match(
    script,
    /const preflight = prepareMingwCmakeEnvironment\(\{\s*buildDir: layout\.buildDir,\s*env: toolchainEnvironment\s*\}\)/
  )
  assert.match(script, /if \(!preflight\.ok\) \{[\s\S]*console\.error\(preflight\.message\)/)
  assert.match(
    script,
    /action === 'build'[\s\S]*\['cmake', \['--build', layout\.buildDir, '--parallel', String\(buildJobs\)\]\]/
  )
  assert.match(
    script,
    /action === 'test'[\s\S]*\['ctest', \['--test-dir', layout\.buildDir, '--output-on-failure'\]\]/
  )
  assert.match(
    script,
    /spawnSync\(command\[0\], command\[1\], \{[\s\S]*env: preflight\.environment/
  )
})

test('MinGW configure resets a stale cache that lost vcpkg native dependencies', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /function cleanInvalidNativeDependencyConfiguration\(\)/)
  assert.match(script, /validateMingwNativeDependencyConfiguration\(\{ buildDir \}\)/)
  assert.match(script, /cleanInvalidNativeDependencyConfiguration\(\)\nconst status = runCmake\(\)/)
  assert.match(script, /if \(!verifyNativeDependencies\(\)\) process\.exit\(1\)/)
})

test('MinGW configure clears CTestTestfile.cmake with other stale configure state', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')
  const start = script.indexOf('function cleanCmakeConfigureState()')
  const end = script.indexOf('function cleanStaleCTestRegistration()')
  const cleanState = script.slice(start, end)

  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.match(cleanState, /const ctestFile = join\(buildDir, 'CTestTestfile\.cmake'\)/)
  assert.match(cleanState, /rmSync\(ctestFile, \{ force: true \}\)/)
})

test('MinGW CTest validation requires every native test registration, including the performance gate', () => {
  const cmakeLists = readFileSync(join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'), 'utf8')
  const registeredTests = [
    ...cmakeLists.matchAll(/add_test\(\s*NAME\s+(twilight_[a-z0-9_]+)/g)
  ].map((match) => match[1])

  assert.equal(MINGW_EXPECTED_CTESTS.length, 28)
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_audio_performance_gate'))
  assert.deepEqual([...MINGW_EXPECTED_CTESTS].sort(), registeredTests.sort())
})

test('every native test target keeps assert() live in Release builds', () => {
  const cmakeLists = readFileSync(join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'), 'utf8')

  const targetList = cmakeLists.match(/set\(TAE_TEST_TARGETS\s*([^)]*)\)/)
  assert.ok(targetList, 'audio-engine/CMakeLists.txt must declare TAE_TEST_TARGETS')
  const undebugTargets = new Set(targetList[1].split(/\s+/).filter(Boolean))

  // Release defines NDEBUG, which deletes assert() calls together with any side effects
  // inside the asserted expression. Every executable that asserts its expectations must
  // therefore opt out, or the suite silently degrades into a no-op that still reports pass.
  const ctestTargets = [
    ...cmakeLists.matchAll(
      /add_test\(\s*NAME\s+twilight_[a-z0-9_]+\s+COMMAND\s+(twilight_[a-z0-9_]+)/g
    )
  ].map((match) => match[1])

  assert.ok(ctestTargets.length >= 27)
  for (const target of ctestTargets) {
    assert.ok(undebugTargets.has(target), `${target} runs as a ctest but never clears NDEBUG`)
  }
  assert.ok(undebugTargets.has('twilight_audio_performance_gate'))
  assert.ok(undebugTargets.has('twilight_vst3_host_pressure_fixture'))

  assert.match(cmakeLists, /foreach\(tae_test_target IN LISTS TAE_TEST_TARGETS\)/)
  assert.match(cmakeLists, /target_compile_options\(\$\{tae_test_target\} PRIVATE \/UNDEBUG\)/)
  assert.match(cmakeLists, /target_compile_options\(\$\{tae_test_target\} PRIVATE -UNDEBUG\)/)
})

test('Windows release gate documents MinGW toolchain and no-whitespace build layout requirements', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs', 'windows-release-gate.md'), 'utf8')

  for (const requirement of [
    'VCPKG_ROOT',
    'W64DEVKIT_ROOT',
    'TWILIGHT_GNU_PATCH',
    'TAE_MINGW_BUILD_DIR'
  ]) {
    assert.match(guide, new RegExp(requirement))
  }
  assert.ok(
    guide.indexOf('pnpm run configure:audio-engine:mingw') <
      guide.indexOf('pnpm run build:audio-engine:mingw')
  )
  assert.ok(
    guide.indexOf('pnpm run build:audio-engine:mingw') <
      guide.indexOf('pnpm run test:audio-engine:mingw')
  )
})

test('caps MinGW compile parallelism by available memory rather than core count', () => {
  const gib = 1024 * 1024 * 1024

  // A high-core / low-memory host is what makes cc1plus die with
  // "out of memory allocating N bytes". 20 cores against 8 GiB must not
  // dispatch 20 concurrent -O3 compiles.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 8 * gib, cpuCount: 20 }), 7)

  // When memory is plentiful the core count is the limit.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 128 * gib, cpuCount: 8 }), 8)

  // Never drop below a single job, however constrained the host is.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 1 * gib, cpuCount: 16 }), 1)
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 0, cpuCount: 4 }), 4)

  // An explicit override wins over both heuristics.
  assert.equal(
    resolveMingwBuildJobs({
      env: { TAE_MINGW_BUILD_JOBS: '3' },
      totalMemoryBytes: 128 * gib,
      cpuCount: 32
    }),
    3
  )
  assert.equal(
    resolveMingwBuildJobs({
      env: { TAE_MINGW_BUILD_JOBS: 'not-a-number' },
      totalMemoryBytes: 8 * gib,
      cpuCount: 20
    }),
    7
  )
})
