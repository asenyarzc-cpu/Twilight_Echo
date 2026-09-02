# Windows-first Release Gate

This checklist is the minimum gate before publishing a Windows build of Twilight Echo.

## Reproducible Dependency Install

The app repository uses only the `pnpm@11.7.0` version pinned in `package.json`. `pnpm-lock.yaml`
is the only dependency lockfile; do not run `npm install` or commit `package-lock.json`.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run verify:install-policy
pnpm run verify:ncm-patch
pnpm run test:production-audit
pnpm run audit:production -- --output output/release-evidence/production-dependency-audit.json
pnpm run test:release-artifacts
pnpm run verify:packaged-dependencies
```

The NCM API fix is declared under `patchedDependencies` in `pnpm-workspace.yaml`. The behavior-level
verification above must pass after every clean install so development, CI, and release packaging
use the same patched dependency tree.

## Production Dependency Audit

The release gate runs `pnpm audit --prod --json` through `pnpm run audit:production`. It rejects
every moderate, high, or critical production advisory and can persist the unmodified registry
response as release evidence with `--output <path>`. CI uploads that JSON response even when the
gate fails. Counts come from the report's filtered `advisories` map (the same map pnpm's own exit
code uses); `metadata.vulnerabilities` keeps the raw registry totals even for advisories excluded
by `auditConfig.ignoreGhsas`.

The current explicit floors are enforced through root `pnpm-workspace.yaml` `overrides`, not a
second npm lockfile:

- `form-data@4.0.6` fixes `GHSA-hmw2-7cc7-3qxx` / `CVE-2026-12143` (multipart CRLF injection).
- `qs@6.16.0` fixes the tracked `qs` moderate advisories, including `GHSA-q8mj-m7cp-5q26` / `CVE-2026-8723` (comma-array stringify DoS).
- Root `undici@^6.28.0` fixes `GHSA-p88m-4jfj-68fv` / `GHSA-vxpw-j846-p89q` (header injection and WebSocket DoS) plus `GHSA-8xcm-r25x-g524` / `GHSA-m8rv-5g2x-5cg5` / `GHSA-v3r7-h72x-cjcm` (retry desynchronization, blob body CRLF injection, cookie attribute injection).
- `postcss@8.5.26` fixes `GHSA-fxqj-rqcc-2cmp` (sourceMappingURL arbitrary `.map` read).
- `nanoid@3.3.18` fixes `GHSA-28wg-ghj8-5hjv` / `GHSA-2v37-7h3g-55p8` (infinite loop in generators, via vue → postcss).
- `ip-address@10.5.0` fixes `GHSA-mwp4-54f8-5fhr` / `GHSA-4xrf-jv44-h6hh` / `GHSA-22jq-vg5j-6vgg` (SSRF and trust-boundary bypass, via socks → pac-proxy-agent).

`extract-zip@2.0.1` has no patched upstream release (`GHSA-jmr9-qjv8-65gv`, symlink path
traversal). `patches/extract-zip@2.0.1.patch` refuses every symlink entry instead; theme archives,
plugin packages, and DSP profiles never ship symlinks. The advisory is registered under
`auditConfig.ignoreGhsas` and must be removed again once upstream publishes `>=2.0.2`.

Run the audit only after a clean frozen install. A stale hoisted `node_modules` directory is not
evidence that the lockfile, overrides, or NCM patch were applied.

The install-policy check also confirms that `discord-rpc`'s non-Electron
`register-scheme` fallback is absent. Discord presence uses IPC only; the app does
not currently register an OS default protocol client. Excluding that optional
native fallback prevents `electron-builder install-app-deps` from attempting an
unsupported rebuild.

All shipped fonts are preconverted `.woff2` assets. Dependency installation does not compile or
convert fonts; any future font regeneration tooling needs its own conversion smoke test before it
can enter the release dependency tree.

Packaged dependency verification parses every production `package.json` inside `app.asar` and
fails when Node's nested/root `node_modules` lookup cannot resolve a required dependency. This gate
prevents installers that build successfully but fail during main-process startup.

## Required Commands

Run the complete repository gate from the repository root:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test:production-audit
pnpm run audit:production -- --output output/release-evidence/production-dependency-audit.json
pnpm run test:plugins
pnpm run test:audio-manager
pnpm run test:radio-remote
pnpm run test:network-sources
pnpm run test:tag-duplicate-management
pnpm run test:duplicate-detection-benchmark
pnpm run benchmark:duplicate-detection:ci -- --output output/release-evidence/duplicate-detection-benchmark.json --manifest output/release-evidence/duplicate-detection-benchmark.manifest.json
pnpm run test:playback-routing
pnpm run test:playlist-lifecycle
pnpm run test:lyrics-management
pnpm run test:cue
pnpm run test:local-perf
pnpm run test:themes
pnpm run test:dsp-graph
pnpm run test:dsp-assets
pnpm run test:plugin-tooling
pnpm run test:audio-toolchain
pnpm run test:renderer-data-tooling
pnpm run test:sleep-timer
pnpm run test:cross-cutting-regressions
pnpm run test:app
pnpm run build
```

`test:audio-manager` covers realtime playback service behavior, the isolated offline-analysis pool,
its IPC wiring, BPM/loudness manager cancellation and cache-suppression behavior, and local-library
index planning/coordinator races (root drift, exclusion recheck, watcher coalescing, and scan controls).

`test:tag-duplicate-management` covers real tag write/rollback, authorized full-file SHA-256,
inspection-only duplicate results, success-only renderer cache updates, and the Vue dialog's keyboard
and tab semantics. `test:duplicate-detection-benchmark` verifies the committed 10k fixture, p95
contract, current source/runner/lockfile hashes, and evidence-manifest digest. The live benchmark is a
separate sequential command: it performs three unmeasured warmups and twenty measured runs for both
unique and collision-heavy 10k libraries, then fails against the declared p95 budgets. Do not run it
in parallel with other performance gates. All three commands are part of `test:no-real-device`.

`test:radio-remote` covers library watcher extension policy, radio playlist import and directory
fallback, podcast parsing/persistence, remote-control authentication, UPnP/Chromecast discovery and
control, media-token authorization, and renderer cover handles. `test:themes` validates the theme
token contract, archive preflight, scheduling, plugin runtime integration, and large-list switching.
`test:network-sources` covers network source profile persistence, path validation, directory
traversal, metadata/cache behavior, and the FTP/SFTP/SMB/WebDAV/NFS/DLNA adapter matrix.

`test:playlist-lifecycle` drives the production SongList lifecycle composable through a real
Electron/Vue/Pinia DOM. It covers all three export downloads, pre-read import limits, visible
import/cover feedback, rename/copy/reorder/batch move/unique relocation, and authoritative CAS
conflict recovery. `test:lyrics-management` covers import and save-dialog validation, strict
lyrics-encoding detection (UTF-8 BOM / UTF-8 / GBK / GB18030), atomic LRC replacement and backup
recovery, versioned CAS persistence, source-selection races, manual three-track projection, and the
real Electron/Vue lyrics-management UI. Both scripts are part of `test:no-real-device`; the Ubuntu
required job runs their Electron UI tests under an explicitly installed `xvfb`/`xauth` virtual display.

`test:cue` covers strict supported-encoding detection, size/path and single-source constraints,
incremental CUE dependency identity, persisted range validation, logical seek/queue preparation,
and is paired with the native CTest suite for segment promotion, ReplayGain isolation, and Native
DSD bit-frame timing.

`test:renderer-data-tooling` covers persistence-benchmark evidence contracts, packaged renderer font
assets, shared TypeScript boundaries, renderer size budgets, and visibility-animation scheduling.
`test:sleep-timer` covers shared state, main/renderer coordination, IPC and native boundaries,
fade completion, and mute/volume interactions. `test:cross-cutting-regressions` covers close-time
persistence, packaged font and visibility budgets, library-view preferences, and visibility polling.
All three scripts are part of `test:no-real-device` and are required release commands.

`test:app` covers the remaining executable application contracts: settings and navigation state,
OPRA/effective audio-processing normalization, renderer component source contracts, local search,
logical-track grouping, and audio smoke-evidence CLI behavior.

Local-library remove/trash semantics, exclusion recovery, queue cleanup, and restart behavior must
also satisfy [`docs/local-library-removal-policy.md`](local-library-removal-policy.md).

## Required GitHub Check

`.github/workflows/audio-engine.yml` runs for every push and pull request without path filters, so
changes under any `src/**` path execute the full repository gate and native audio matrix. Its final
`Required Quality Gate` job fails unless every required job succeeds.

Repository administrators must configure the `main` branch ruleset in GitHub to require the
`Required Quality Gate` status check, require the branch to be up to date before merging, and block
force pushes/deletions. This branch-protection setting is external repository state and cannot be
enabled by a committed workflow file. Audit the live setting with GitHub CLI:

```powershell
gh api repos/{owner}/{repo}/branches/main/protection
```

Do not mark this release gate complete until the API response lists `Required Quality Gate` under
`required_status_checks.contexts` (or an equivalent required-check ruleset is visible in GitHub).

## Native Audio Engine

Windows release builds must also verify the MinGW audio engine path:

```powershell
$env:VCPKG_ROOT = 'C:\path\to\vcpkg'
$env:W64DEVKIT_ROOT = 'C:\path\to\w64devkit'
$env:TWILIGHT_GNU_PATCH = 'C:\Program Files\Git\usr\bin\patch.exe'
```

`TWILIGHT_GNU_PATCH` must identify as GNU patch; Git for Windows provides a compatible executable.
When the repository path contains whitespace, set `TAE_MINGW_BUILD_DIR` to a writable path without
whitespace before configuring, for example:

```powershell
$env:TAE_MINGW_BUILD_DIR = 'D:\twilight-build\mingw-static'
```

```powershell
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
pnpm run test:audio-engine:mingw
```

The staged release must include the matching `twilight-audio-engine.dll` and
`twilight_audio_node.node` under packaged `resources/audio-engine`, plus the GNU toolchain runtime
DLLs both of them import. The `windows-mingw-static` preset is only statically linked with respect to
the vcpkg triplet — libstdc++, libgcc and mcfgthread stay dynamic — so a release without
`libstdc++-6.dll`, `libgcc_s_seh-1.dll` and `libmcfgthread-2.dll` beside the addon fails to `dlopen`
on any machine that does not already have that exact toolchain, and the app can only report
`未加载 twilight_audio_node.node`.

`pnpm run stage:audio-engine` copies them automatically: it reads the import tables of the staged
binaries and resolves each non-system dependency against the compiler recorded in the build
directory's `CMakeCache.txt`, then `W64DEVKIT_ROOT`/`TAE_W64DEVKIT_ROOT`. Use `--runtime-dir <bin>`
or `TAE_MINGW_RUNTIME_DIR` to point it elsewhere. Staging fails rather than shipping a partial set.
Take the DLLs from the toolchain that actually built the artifacts — an unrelated MinGW earlier on
`PATH` ships a different libstdc++ and produces `The specified procedure could not be found`.

The miniaudio `0.11.25` implementation is an opt-in, default-off Windows Shared/default PCM build
capability. MA-101 fixes the callback at Float32 and disables WASAPI `AUTOCONVERTPCM` so the
miniaudio converter and internal device state can report conversion facts without treating the
requested format as actual device state; device notifications are dispatched through a deferred
control event path. Its `outputInfo.providerImplementation` and `outputInfo.conversionInfo` fields are
diagnostic facts only; they do not add a public backend, prove runtime/device support, or change
Shared `outputPerfect=false` semantics. A capability manifest showing miniaudio compiled is not a
real-device or A/B validation result.

## Unsigned Release Artifact Gate

In-app updates on Windows download the latest GitHub Release installer (`*-setup.exe` preferred),
optionally verify SHA-256 from the release body or a companion checksum asset, then launch the
installer with `shell.openPath` and quit the app after an explicit confirm (exit, SmartScreen/UAC,
official project release). This is not `electron-updater`, not silent asar replacement, and not a
generic electron-builder `publish` URL. **Every Windows Release must publish SHA-256** (release body
line or `*.sha256` asset). Without a checksum the client still downloads but marks verification as
skipped and degrades the install CTA; if a checksum was known, install re-hashes before openPath.
Unsigned installers remain subject to SmartScreen.

A publishable Windows build is intentionally unsigned because this personal project does not carry
a commercial code-signing certificate. Code signing is not part of any release check and no signing
environment variable is required. `build:win`, `build:unpack`, and `gate:release:win` all keep
electron-builder signing disabled. They still strip only the copied package payload when W64DevKit
is configured, keeping the source runtime untouched.
Packaging delegates production dependency discovery to electron-builder and keeps only the
`zh-CN`, `zh-TW`, and `en-US` Electron locales instead of copying the full development tree.
`afterPack` writes the executable icon and version metadata directly. Run:

```powershell
pnpm run gate:release:win
```

`gate:release:win` runs `gate:release:preflight` and the cross-ABI ASIO gate before packaging. On
success it writes
`dist/<installer>-setup.exe.sha256`; upload that file alongside the installer and publish the same
SHA-256 in the GitHub Release body.

The gate checks every shipped DLL/EXE/NODE file under the packaged audio-engine directory for a
non-zero size and a size budget. It additionally checks each required self-built native runtime
binary for stripped PE debug/COFF metadata, and walks the import tables of those binaries to prove
every non-system dependency they need is present in the same directory (transitively — a DLL's own
imports are followed). Runtime dependencies supplied by the toolchain are verified for presence and
size only: they are not our build output, so they are neither stripped nor given a named budget.
The audio DLL and Node addon are always required. Windows packaging prepares the MSVC VST3 helper
pair before electron-builder runs; a package without both helpers is rejected and cannot advertise
VST3. Windows development and release packaging invoke GNU/LLVM `strip --strip-all` only on the
copied package payload at
`win-unpacked/resources/audio-engine`; they never alter `resources/audio-engine` in the source tree.
Set `W64DEVKIT_ROOT` or `TWILIGHT_RELEASE_STRIP` so the packaging wrapper can locate `strip.exe`.
The release gate deliberately fails when the strip tool is absent. GNU binutils >= 2.46
zeroes the COFF symbol count but leaves `PointerToSymbolTable` pointing past the stripped
image, so afterPack normalizes that header field to zero once the symbol table itself is
gone; the artifact verifier still requires both fields to read zero and fails on any
surviving symbol table. It does not create or simulate a
signature, and release notes must disclose that Windows may show SmartScreen warnings.
Current budgets are 192 MiB for the audio DLL, 16 MiB for the Node addon, 32 MiB for each VST3
helper executable, 64 MiB for any other shipped native DLL/EXE/NODE, and 384 MiB for the installer.
Microsoft VC runtimes are size-checked but are not stripped.

`pnpm run test:release-artifacts` validates this policy and its failure paths without needing a
packaged installer. A passing test is release-integrity evidence, not a platform trust endorsement.

`pnpm run prepare:vst3-msvc` is part of `gate:release:preflight`; it configures, builds, and
self-tests the Windows x64 MSVC helpers when they are not already staged, copies their VC runtime
dependencies, and refreshes the capability manifests. `pnpm run generate:release-capability-status` and
`pnpm run verify:release-capabilities` then reconcile `audio-capabilities.json`, the staged
DLL/node/helper hashes and PE imports, and the controlled product declaration in
`docs/release-capability-status.md`. The packaged release repeats that check. Missing core binaries,
an incomplete VST3 helper pair, missing dynamic imports, manifest/status drift, or a declaration that
overstates staged facts fails the gate; absent real devices remain `unverified` / `not-run`.

macOS CoreAudio and Linux ALSA package targets remain unverified. Their buildability is not a
release-readiness claim; keep their real-device smoke evidence separate from the Windows gate.

## Plugin Boundary

The app repository may bundle host/runtime code, built-in plugins, plugin API tooling, and the
static plugin index client. Third-party plugin `.tep` packages must not be committed under
`resources/plugin-index`; Bilibili and future third-party plugins are installed from the remote
`TWILIGHT_PLUGIN_INDEX_URL` index.

## Manual Smoke

Before release, start the packaged app and verify:

- local library browsing and playback still work;
- startup performs an incremental library reconciliation, while Settings -> General -> Library can
  explicitly start a full rescan and visibly pause, resume, or cancel it;
- local, playing, settings, plugin, equalizer, and streaming surfaces switch cleanly;
- disabling the built-in NCM provider does not affect local playback;
- installing a remote plugin shows the trust-based permissions warning;
- a failing plugin is marked failed and does not prevent app startup or playback.

The native CTest suite includes `twilight_audio_performance_gate`. It drives decoded WAV through the
production `AudioPipeline` with a controlled callback pump and emits schema-versioned JSON for steady
playback, gapless, crossfade, convolution, diagnostics, callback-deadline load, and process working-set
measurements. It is a deterministic software gate, not a hardware or system-CPU claim.

Real-device smoke checks for WASAPI Exclusive, ASIO, native DSD, SACD ISO, CoreAudio, and ALSA
remain opt-in and are not part of the default gate.

## ASIO Compatibility Gate

The Windows x64 ASIO compatibility backend is enabled by default and can be disabled with
`TWILIGHT_DISABLE_ASIO=1` for troubleshooting or rollback. Release verification must retain the
frozen ABI specification, MSVC fake-driver round trip, MinGW ABI checks, and the available hardware
evidence required by `docs/legal/asio-decision-record.md`. Real-device smoke remains opt-in and its
absence must be reported rather than represented as a pass. For this personal open-source project,
written legal advice and a formal clean-room signature are recommended records rather than hard
gates; commercialization or a hardware-partner release requires a fresh formal review. Release
sources and build commands must not reference an ASIO SDK directory, SDK headers, or SDK source
files.

`pnpm run verify:asio-sdk-free` and `pnpm run test:asio-cross-abi` are required implementation
evidence for this gate. They do not replace the frozen ABI contract or real-device evidence
requirements.

The cross-compiler command requires `TAE_ASIO_MSVC_INSTALL_ROOT` to point to a Visual Studio 2022
Build Tools installation and optionally accepts `TAE_ASIO_MSVC_BUILD_DIR`. It reuses
`TAE_VST3_MSVC_INSTALL_ROOT` when the ASIO-specific install-root variable is absent.

For a Windows WASAPI Exclusive performance soak, explicitly select a physical endpoint and retain the
JSON output as release evidence:

```powershell
pnpm run smoke:audio-performance -- --device "Desk DAC" --duration-seconds 300 --json
```

This command never runs in CI and must not be represented by the controlled-pump CTest result.

Product honesty surfaces (`Loudnorm`, `Gapless Album`, `Unity Volume`) are always listed by
`pnpm run smoke:audio-evidence` and default to `not-run` until a maintainer records evidence.
They do **not** gate `coverage.complete` (still 7/7 hardware surfaces). See
`docs/audio-smoke-evidence.md`.

Release candidates that only run `test:no-real-device` (or equivalent software gates) must keep
real-device smoke and product honesty surfaces as **`not-run`**. Controlled-pump CTest is not
hardware smoke and must not be substituted for WASAPI Exclusive / ASIO / DoP / Native DSD /
SACD ISO / CoreAudio Hog / ALSA `hw:` evidence.
