# Phase 6C/6D Windows HiFi Smoke Checklist

## Purpose

Use this checklist to validate the Windows output chain after Phase 6C changes and the Phase 6D no-real-device DSD/DoP carrier gate. The real Windows hardware smoke run is opt-in, but Phase 6C/6D release readiness is not considered complete until the automated no-real-device gate passes and one real Windows machine has been checked against the non-deferred hardware items in this list.

For every scenario below, record and compare:

- Native `GetPlaybackInfo()`
- `SettingsPage` output status area
- `PlayerBar` more panel
- Native `GetEngineCapabilities()` once at app start

The three views must agree on:

- `actualBackend`
- `accessMode`
- `devicePathKind`
- `deviceName` / `actualDeviceName`
- `bufferSizeFrames`
- `latencyInfo.bufferLatencyMs`
- `latencyInfo.outputLatencyMs`
- `latencyInfo.totalLatencyMs`
- `diagnostics`
- `perfectReasonCode`

For top-level playback fields and nested `outputInfo`, confirm these mirrors match exactly:

- `actualBackend`
- `actualOutputFormat`
- `actualSampleRate`
- `actualBitDepth`
- `actualChannels`
- `bufferSizeFrames`
- `latencyFrames`
- `latencyMs`
- `latencyInfo`
- `channelRoutingMode`
- `supportsOutputPerfect`
- `sourceExact`
- `diagnostics`
- `deviceRecovered`
- `recoveryCount`
- `outputSampleRate`
- `outputBitDepth`
- `outputPerfect`
- `pcmPassthrough`
- `perfectReason`
- `perfectReasonCode`

## Phase 6D No-Real-Device DSD/DoP Gate

Run the automated mock backend gate before any real hardware smoke. This gate must not require a real DAC, ASIO driver, WASAPI exclusive device, or SACD image.

1. Mock DSF and DFF DSD64/128 DoP carrier scenarios.
   Expected:
   - DSF DSD64 enters the DoP carrier path when backend/device carrier capability and actual PCM carrier format match.
   - DFF DSD64 enters the DoP carrier path under the same carrier conditions.
   - DSF DSD128 enters the DoP carrier path when a valid DSD128 carrier rate/format is available.
   - DFF DSD128 enters the DoP carrier path under the same carrier conditions.
   - Runtime facts prove the carrier by matching candidate and actual PCM carrier format.
   - `outputInfo.isDsd=true`, `dsdMode=dop`, and the top-level mirrors match.
   - `perfectReasonCode` is empty only for the proven carrier path; unproven or mismatched carriers must report a concrete non-perfect reason.
2. Mock DSD256/512 fallback scenarios.
   Expected:
   - DSF DSD256 falls back to PCM.
   - DFF DSD256 falls back to PCM.
   - DSF DSD512 falls back to PCM.
   - DFF DSD512 falls back to PCM.
   - Fallback clears runtime DSD transport state to `outputInfo.isDsd=false`, `dsdMode=pcm`, `dsdRate=0`.
   - UI-facing playback info still allows source metadata to describe the file as DSD256/512, but the runtime transport must not be labeled DoP or Native DSD.
   - `perfectReasonCode` identifies high-rate DSD PCM fallback or another explicit PCM fallback reason.
3. Mock processing fallback scenarios while a DSD64/128 source would otherwise be DoP-capable.
   Expected:
   - Software volume changes force PCM fallback.
   - ReplayGain or volume normalization forces PCM fallback.
   - EQ forces PCM fallback.
   - Convolver forces PCM fallback.
   - Crossfeed forces PCM fallback.
   - Crossfade forces PCM fallback.
   - Routing modes that change channel semantics force PCM fallback.
   - Fallback updates `dspActive`, processing flags, `channelRoutingMode`, `outputPerfect=false`, and `perfectReasonCode` immediately.
4. Native DSD and SACD ISO use the Phase 6D/6E automated fixture gate.
   Expected:
   - ASIO mock Native DSD reports `dsdMode=native` only when runtime facts are `proven`.
   - Native DSD mismatch falls back to DoP when possible, then PCM.
   - SACD ISO fixture metadata returns real `isoTracks`; uncompressed DSD tracks are playable with `outputModes=["native","dop","pcm"]`.
   - DST tracks with the built-in DSD-preserving provider (default): `playable=true`, `codec=dst`, same `outputModes`.
   - DST without provider / provider failure: `playable=false` plus `reasonCode=dst_dsd_provider_unavailable` or `dst_dsd_provider_failed`.
   - `GetEngineCapabilities()` default build: SACD ISO support for uncompressed DSD, `sacdIsoDst=true`, `sacdIsoDstMode=native`, `sacdIsoDstDsdProvider=true`. Report unavailable only when the provider is missing.
5. Real WASAPI/ASIO DoP smoke is deferred.
   Expected:
   - Do not block Phase 6D on a real DoP DAC or ASIO driver.
   - Track real WASAPI Exclusive DoP and real ASIO DoP as follow-up opt-in hardware smoke.
   - The release note for Phase 6D must distinguish automated mock carrier validation from deferred real-device DoP validation.

## Shared / Exclusive

1. Start playback on `WASAPI Shared`.
   Expected:
   - `actualBackend=wasapi`
   - `accessMode=shared`
   - `perfectReasonCode=shared_mixer`
   - latency and buffer fields are non-zero
2. Toggle to `WASAPI Exclusive` during playback.
   Expected:
   - UI refreshes without restarting the app
   - `actualBackend=wasapi-exclusive`
   - `accessMode=exclusive`
   - `devicePathKind=default`
   - `Buffer Size` shows the actual applied value, not the requested preset
   - `perfectReasonCode` clears unless the actual format changes or DSD DoP status explains it
3. Toggle back to `WASAPI Shared`.
   Expected:
   - no stale `wasapi-exclusive` values remain
   - `shared_mixer` reason returns
   - previous exclusive buffer and latency values are replaced by shared-mode actuals

## Buffer Size / Routing

1. In exclusive mode, test:
   - `Auto`
   - `64`
   - `128`
   - `256`
   - `512`
   - `1024`
   - `2048`
2. After each change, confirm:
   - `bufferSizeFrames` matches the actual applied backend value
   - the displayed buffer is not assumed to equal the requested preset when the backend rounds, clamps, or chooses `Auto`
   - `Latency Buffer / Driver / Total` updates immediately
   - `latencyMs` equals `latencyInfo.totalLatencyMs`
3. Change routing mode through:
   - `auto`
   - `stereo`
   - `stereo-to-5.1`
   - `stereo-to-7.1`
   - `mono-to-stereo`
   - `mono-to-multichannel`
4. Confirm routing changes:
   - update `channelRoutingMode` immediately
   - set a non-perfect reason when semantics change
   - set `perfectReasonCode=routing_changes_semantics` for semantic routing modes

## Device Switch

1. Switch from default output to another Windows device during playback.
2. Switch back to default.
3. Confirm after each switch:
   - `deviceName` and `actualDeviceName` update immediately
   - no stale backend, path kind, or latency values remain
   - playback does not hang or go silent without reporting an error
   - top-level mirrors and nested `outputInfo` stay aligned after the switch

## ASIO

1. If an ASIO driver is available, start playback on `ASIO`.
2. Confirm:
   - `actualBackend=asio`
   - `accessMode=exclusive`
   - `devicePathKind=asio`
   - `bufferSizeFrames` and `latencyInfo` are non-zero
   - ASIO device capability fields are populated when the driver exposes them:
     `minBufferSize`, `maxBufferSize`, `granularity`, `preferredBufferSize`,
     `supportsDop`, `supportsNativeDsd`, `supportedDsdRates`, `capabilityVersion`
3. Change ASIO buffer size and verify the displayed value is the actual applied value.
   Confirm rounded or clamped values are shown when the requested size is unsupported.
4. If the driver or device can be interrupted safely, verify that:
   - `Driver Restart`
   - `Device Lost`
   - `Buffer Drop`
   - `Recovery Count`
     update in both UI surfaces and native playback info.
5. Switch from ASIO back to `WASAPI Shared`.
   Expected:
   - `actualBackend=wasapi`
   - `accessMode=shared`
   - `devicePathKind=default`
   - ASIO device name, ASIO path kind, ASIO buffer size, and ASIO diagnostics do not leak into the shared output status unless a new native diagnostic event reports them.

## Capabilities

1. Capture `GetEngineCapabilities()` from the same build used for smoke.
2. Confirm:
   - `pcmPassthrough=true`
   - `outputPerfectRequiresPcmPassthrough=true`
   - `htmlAudioFallbackDefault=false`
   - `dsdModes` includes `pcm`, `dop`, `native`, and `unsupported`
   - Native DSD reflects ASIO runtime capability honestly; SACD ISO is true for uncompressed DSD area playback; default build reports `sacdIsoDst=true` / `sacdIsoDstMode=native` / `sacdIsoDstDsdProvider=true` (unavailable only when provider missing)
   - `devicePathKinds` includes `default`, `hw`, `plughw`, `hal`, and `asio`
   - `output.accessModes` includes `shared`, `exclusive`, `hog`, `direct`, and `plugin`
   - `backendCapabilities` includes `wasapi`, `wasapi-exclusive`, and `asio`
   - `wasapi-exclusive` reports `supportsExclusive=true`, `supportsOutputPerfect=true`, `accessMode=exclusive`, `devicePathKind=default`
   - `asio` reports `supportsExclusive=true`, `accessMode=exclusive`, `devicePathKind=asio`, and an `unavailableReason` if no ASIO driver is present

## Product Honesty Surfaces (opt-in evidence)

These map to `pnpm run smoke:audio-evidence` optional surfaces and default to `not-run`.

### Loudnorm

1. Use an untagged FLAC (no ReplayGain tags).
2. Set volume normalization to `loudnorm`.
3. Confirm first play reports measuring/fallback (not Track alias), `perfectReasonCode=loudnorm_active`.
4. Replay and confirm cache hit / cached status when analysis completes.
5. Without libebur128 builds, confirm unavailable + fallback (no fake success).

### Gapless Album

1. Queue a same-format album; gapless ON; crossfade OFF.
2. Confirm `gaplessActive` / `preloadReady` and seamless promote without full device reopen when formats match.
3. Confirm blocked reasons (`format_mismatch`, `crossfade`, `dsd_path`, …) when applicable.

### Unity Volume

1. Default volume remains `0.7` after install / reset.
2. Exclusive bypass / bit-perfect path with non-unity volume shows `volume_not_unity` + Unity CTA.
3. Unity sets volume to `1.0` as an explicit user action (never silent default change).

## Pass Criteria

- Settings changes update the UI without needing app restart or manual refresh.
- UI and native playback info stay aligned after every scenario.
- `Buffer Size` shows the actual applied backend value.
- `Latency` shows `Buffer / Driver / Total`.
- `Diagnostics` show real counters and do not report fake recovery success.
- No backend/access mode/path kind/device values leak across mode or device switches.
- Capabilities describe the compiled build and runtime ASIO availability honestly.
- Phase 6D mock DSF/DFF DSD64/128 DoP carrier cases pass without real hardware.
- Phase 6D mock DSD256/512 and processing fallback cases report PCM fallback honestly.
- Native DSD ASIO mock, SACD ISO uncompressed fixture playback, and PCM fallback cases pass; real Native DSD DAC and real WASAPI/ASIO DoP smoke remain opt-in.
- External release evidence can be produced with `pnpm run smoke:audio-format-matrix -- --manifest "<matrix.json>" --json`; add `--playback --backend wasapi-exclusive --device "<device>"` for WASAPI hardware PCM/DoP evidence or `--backend asio` for ASIO Native DSD evidence.
- Product honesty surfaces (`Loudnorm` / `Gapless Album` / `Unity Volume`) appear in smoke evidence reports; without artifacts they stay `not-run` and do not gate hardware `coverage.complete`.
