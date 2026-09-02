# Windows VST3 Helper Toolchain

Twilight Echo builds its VST3 scanner and isolated VST3 host separately from the MinGW audio
engine. This is required because Windows VST3 modules use the MSVC C++ ABI.

The helper build needs these user environment variables:

```powershell
$env:TAE_VST3_SDK_ROOT
$env:TAE_VST3_MSVC_INSTALL_ROOT
$env:TAE_VST3_MSVC_BUILD_DIR
```

The supported SDK is Steinberg VST3 SDK `v3.8.0_build_66` at commit
`9fad9770f2ae8542ab1a548a68c1ad1ac690abe0`. The build uses Visual Studio 2022
Build Tools with the C++ x64 workload. Do not add the SDK to the MinGW vcpkg manifest.

```powershell
pnpm run configure:vst3-msvc
pnpm run build:vst3-msvc
pnpm run test:vst3-msvc
pnpm run smoke:vst3-msvc
pnpm run stage:vst3-msvc
```

For a Windows package, use the single preparation command instead. It configures, builds, and
self-tests the helpers when needed, stages the helpers and VC runtime DLLs, and refreshes the
release capability manifests:

```powershell
pnpm run prepare:vst3-msvc
```

`stage:vst3-msvc` copies `twilight-vst3-scanner.exe`, `twilight-vst3-host.exe`, and the
matching Microsoft VC runtime DLLs into `resources/audio-engine` for packaging.

The scanner is the only component allowed to load a discovered `.vst3` module during
cataloging. The Node addon launches it as a bounded child process with an 8 second timeout,
separate stdout/stderr drains, and a bounded response. A scanner crash, hang, or malformed
module is reported to the catalog without loading the Electron main process.

`twilight-vst3-host.exe` is the isolated real-time host used by VST3 graph nodes. The native
engine supplies fixed-size float blocks through shared memory; the host owns module loading,
format negotiation, state restore, `IAudioProcessor::process`, and its own process lifetime.
It accepts Mono, Stereo, 5.1, and 7.1 single-main-bus effects only. The graph reports a bypass
reason instead of passing arbitrary module or state paths to the helper.

After an audio-service crash, every active VST3 catalog entry is quarantined and stays bypassed.
The DSP Rack re-scans and restores each module individually; clearing one entry never re-enables
other VST3 nodes from that crash.

`smoke:vst3-msvc` validates both managed raw component state and a standard `.vstpreset` against
the fixed-SDK ADelay fixture. It never stores that fixture in this repository. The normal fixture
location is a sibling `sdk-fixture` build next to `TAE_VST3_MSVC_BUILD_DIR`; set
`TAE_VST3_FIXTURE_PATH` when it lives elsewhere.

The MinGW native runtime suite also builds a test-only `twilight-vst3-host.exe` alongside
`twilight_runtime_queue_reroute_tests`. It implements the production shared-memory bridge protocol,
echoes audio blocks, and is used by the 1000 graph-update stress test to assert bounded Windows
working set and bounded helper-process count. It deliberately does not load a VST3 module, so it
proves bridge process lifecycle and cleanup only. Real module loading, component state, and preset
compatibility remain covered exclusively by the opt-in MSVC SDK ADelay fixture through
`pnpm run smoke:vst3-msvc`.
