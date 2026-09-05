# Audio Smoke Evidence

本文记录真实设备 smoke 证据库的采集和判定规则。它是 release 前的人工/设备验证入口，不进入默认 CI，也不能用 mock 或无硬件测试伪造通过。

生成汇总报告：

```bash
pnpm run smoke:audio-evidence
```

默认输出：

- `output/audio-smoke-evidence/audio-smoke-evidence.md`
- `output/audio-smoke-evidence/audio-smoke-evidence.json`

把多台机器或多个设备的 smoke JSON 合并进报告：

```bash
pnpm run smoke:audio-evidence -- --input evidence/envelopes/wasapi-exclusive.json --input evidence/envelopes/asio-pcm.json
pnpm run smoke:audio-evidence -- --input-dir evidence/envelopes
```

发布前需要强制检查证据完整性时使用：

```bash
pnpm run smoke:audio-evidence -- --input-dir evidence/envelopes --require-complete
```

`--require-complete` 只作为 opt-in gate。没有对应硬件时不要把它加入默认 CI。

## Windows Shared PCM A/B Artifact

`pnpm run smoke:miniaudio-ab` 在两个独立的 Node 子进程中，对同一个 Windows Shared
WASAPI case 分别设置 `TWILIGHT_AUDIO_PCM_PROVIDER=legacy` 与 `miniaudio`。它只向子进程
传递 selector，不会修改用户的全局设置。每一侧都必须回传同一个 public backend、endpoint
stable-ID hash、backend 实际打开 endpoint ID 的 hash 和 test-input hash；成功 case 的实际 ID hash
必须等于受控 endpoint hash。runner 会拒绝 provider、hash、负的 open/close duration 或受控
backend/device 参数被调用方改写的结果，并输出逐字段 diff。

case 的 `platformStableDeviceId` 是显式 endpoint ID；它只在子进程环境中使用，产物只保存
`platformStableDeviceIdHash` 和每侧的 `actualDeviceIdHash`，不保存 raw device ID。`formatMatrixArgs` 必须指向**恰好一个** fixture，且不得含
`--backend`、`--device`、`--json` 或 `--worker`，这些参数由 A/B adapter 固定为同一 Shared
WASAPI backend 与 stable device：

```json
{
  "schemaVersion": 1,
  "id": "shared-wasapi-pcm-48k",
  "publicBackend": "wasapi",
  "platformStableDeviceId": "{0.0.0.00000000}.{endpoint-id}",
  "testInput": {
    "formatMatrixArgs": ["--manifest", "artifacts/one-pcm-fixture.json", "--duration-ms", "1200"],
    "requestedFormat": { "sampleFormat": "float32", "sampleRate": 48000, "channels": 2 }
  }
}
```

运行并写入一个可单独校验 SHA-256 的 artifact：

```bash
pnpm run smoke:miniaudio-ab -- --case artifacts/shared-wasapi-pcm-48k.json --output artifacts/shared-wasapi-pcm-48k-ab.json
```

产物固定标记 `evidenceKind=software-only`，即使 probe 实际运行了本机 endpoint，也**不能**
计入本页的 `coverage.complete` 或替代 MA-105 真机证据。`audio-smoke-evidence` 会把
`software-only` 与 mock 一样归为 `not-real-device`。`--fixture-probe` 是 node:test 的内部
故障 fixture，不得用于采集。

以下命令仅供受控设备会话使用，默认测试不会执行或等待它们：

```bash
# case 的 durationMs=15000；60 次 legacy→miniaudio 切换合计至少约 30 分钟。
pnpm run smoke:miniaudio-ab -- --case artifacts/shared-wasapi-switch-30m.json --iterations 60 --output artifacts/shared-wasapi-switch-30m.json

# case 的 durationMs=14400000；legacy 与 miniaudio 各持续 4 小时，合计约 8 小时。
pnpm run smoke:miniaudio-ab -- --case artifacts/shared-wasapi-soak-8h.json --output artifacts/shared-wasapi-soak-8h.json
```

runner 会从 case 的 `--duration-ms` 推导子进程超时并加入启动/退出余量，因此长测不会被默认的短探针超时提前终止。

## Required Surfaces

完整证据（`coverage.complete`）需要覆盖 **7 个硬件 surface**。每条真实设备 `pass`
必须是 `evidenceKind=real-device`；仓库 fixture 或 mock 只能验证 runner 逻辑，绝不计入硬件覆盖。

| Surface          | Suggested command                                                                                                                                                                 | Required evidence                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| WASAPI Exclusive | `pnpm run smoke:wasapi -- --device "<wasapi-endpoint>" --buffer 256 --format-matrix --json > artifacts/wasapi-exclusive-raw.json`                                                 | `actualBackend=wasapi-exclusive`、exclusive=true、实际输出格式、每个 PCM probe 的 `outputPerfect` / `perfectReason`            |
| ASIO PCM         | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend asio --device "<asio-driver>" --json > artifacts/asio-pcm-raw.json`                    | `actualBackend=asio`、驱动/设备名、实际输出格式、明确 pass/fail reason                                                         |
| DoP DAC          | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<dsd-fixtures>" --playback --backend wasapi-exclusive --device "<dop-capable-dac>" --json > artifacts/dop-dac-raw.json`     | `dsdMode=dop`、carrier sample rate、实际输出格式；DAC 拒绝时必须有 fallback reason                                             |
| Native DSD       | `pnpm run smoke:asio-native-dsd -- --device "<native-dsd-asio-driver>" --fixture-dir "<dsd-fixtures>" --json > artifacts/native-dsd-raw.json`                                     | 至少一个 DSD rate 达到 `nativeDsdRuntimeState=proven`，并记录驱动/设备和不支持 rate 的 fallback reason                         |
| SACD ISO         | `pnpm run smoke:audio-format-matrix -- --manifest "<sacd-iso-matrix.json>" --playback --backend wasapi-exclusive --device "<dac>" --json > artifacts/sacd-iso-raw.json`           | SACD ISO metadata、track/area、native/DoP/PCM runtime result；DST/provider 失败时必须有 reason                                 |
| CoreAudio Hog    | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend coreaudio-exclusive --device "<hog-device>" --json > artifacts/coreaudio-hog-raw.json` | `actualBackend=coreaudio-exclusive`、`accessMode=hog`、实际 PCM 输出格式与明确 pass/fail reason；CoreAudio 不可记录 Native DSD |
| ALSA `hw:`       | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-or-dsd-fixtures>" --playback --backend alsa --device "hw:<card>,<device>" --json > artifacts/alsa-hw-raw.json`         | `actualBackend=alsa`、`devicePathKind=hw`、实际输出格式；尝试 Native DSD 时记录 runtime facts                                  |

## Optional Product Honesty Surfaces

以下 surface **始终出现在报告中**，无 artifact 时默认 `not-run`。它们**不参与** `coverage.complete`（仍只要求 7 个硬件 surface），用于 Stage 1–2 产品诚实路径的维护者证据。

| Surface       | Suggested checklist                                                                                                                                                         | Required evidence                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Loudnorm      | 无标签 FLAC → `volumeNormalization=loudnorm` → 首播 measuring/fallback + `perfectReasonCode=loudnorm_active`；再播 cached；记录 `output/audio-smoke-evidence/loudnorm.json` | `mode=loudnorm`（永不 Track 别名）、`loudnormActive`、状态 measuring\|cached\|fallback\|unavailable；无 ebur128 时不可假成功 |
| Gapless Album | 同格式专辑队列、gapless ON、crossfade OFF → 观察 `gaplessActive`/`preloadReady` 与无设备 reopen 的 promote；记录 `output/audio-smoke-evidence/gapless-album.json`           | 意图 ON；Active/Preload 可观测；Blocked 时 `gaplessBlockedReason` 为 `format_mismatch`/`crossfade`/`dsd_path` 等             |
| Unity Volume  | 默认音量 0.7 + exclusive bypass → `volume_not_unity` + Unity CTA；`setVolume(1)` 后在其它条件满足时恢复 perfect 路径；记录 `output/audio-smoke-evidence/unity-volume.json`  | 默认仍为 0.7；Unity 是用户动作；`volume_not_unity` reason 可证伪                                                             |

### 明确非声明（平台限制）

- **WASAPI / CoreAudio 无 native DSD**：Native DSD surface 仅适用于 ASIO（或其它显式 native 路径）；DoP 是 WASAPI exclusive 的合法 DSD 载体，不是 native DSD。
- Shared WASAPI **不得**宣称 bit-perfect。

## Evidence Rules

报告中的 `coverage.complete` 只有在每个 required surface 至少有一条带完整采集元数据、可校验 artifact 的 `real-device` `pass` 时才为 `true`。

Artifact 规则：

- 本地 `artifact` 路径必须存在，且 SHA-256 必须等于 `artifactSha256`；远端 URL 无法在本地校验，不能计入 complete。
- 每个真实设备 `pass` 固定记录 `surface`、`device`、`driver`、`format`、`bufferFrames`、`playbackDurationSeconds`、`expectedState`、`artifact`、`artifactSha256`、`capturedAt`（ISO 8601）和 `inputCommand`。
- 先将真实 runner 的 JSON 输出保存为独立 raw artifact，再把其路径和 SHA-256 写入 evidence envelope；不要将 envelope 自身作为需要自校验的 artifact。
- `evidenceKind=mock` 和未声明 kind 的旧格式都不会计入 hardware coverage，并会在 action plan 中显示为 `not-real-device`。
- 缺字段、文件不存在、SHA-256 无效或不匹配会显示 `invalid-artifact`，不会计入 complete。

状态含义：

- `pass`：该 surface 在真实设备上通过，并且 artifact 可追溯。
- `fail`：真实设备运行过，但结果失败；报告会保留失败原因，不能用作 complete。
- `skip`：因为硬件、驱动或平台条件缺失而跳过；不阻塞默认 CI，但不算 release 证据闭环。
- `not-run`：还没有记录该 surface 的真实设备证据。
- `invalid-artifact`：记录宣称通过，但 artifact 或必需采集元数据无效。

## Evidence Envelope Schema

将 raw runner JSON 与 evidence envelope 分开保存。`smoke:audio-evidence --input` 只接收 envelope，不能直接把 raw summary 当作 `real-device` complete 证据；使用对象可同时记录稳态场景。

```json
{
  "entries": [
    {
      "surface": "WASAPI Exclusive",
      "status": "pass",
      "evidenceKind": "real-device",
      "device": "USB DAC endpoint",
      "driver": "Vendor USB Audio 3.2.1",
      "format": "int24-in32/192000Hz/2ch",
      "bufferFrames": 256,
      "playbackDurationSeconds": 1800,
      "expectedState": "actualBackend=wasapi-exclusive; exclusive=true; outputPerfect=true",
      "artifact": "artifacts/wasapi-exclusive-raw.json",
      "artifactSha256": "<64 lowercase hex characters>",
      "capturedAt": "2026-08-31T12:00:00.000Z",
      "inputCommand": "pnpm run smoke:wasapi -- --device \"USB DAC endpoint\" --buffer 256 --format-matrix --json > artifacts/wasapi-exclusive-raw.json"
    }
  ],
  "operationalResults": []
}
```

PowerShell 采集 SHA-256：

```powershell
(Get-FileHash -Algorithm SHA256 artifacts/wasapi-exclusive-raw.json).Hash.ToLowerInvariant()
```

下面命令使用仓库 fixture 自测 parser；fixture 是 `mock`，所以报告仍显示 0 个硬件 surface 通过：

```bash
pnpm run smoke:audio-evidence -- --input-dir scripts/fixtures/audio-smoke-evidence
```

## Operational Scenario Schema

下面五项始终出现在报告 `operationalScenarioRows` 中，缺记录为 `not-run`，当前不参与 `coverage.complete`。`pass` 仍必须是 `evidenceKind=real-device`，包含 surface、设备、驱动、格式、缓冲、时长、期望/观察状态、artifact/SHA-256、采集时间和输入命令；否则显示 `not-real-device` 或 `invalid-artifact`。少于规定的 30 分钟或 2 小时会显示 `insufficient-duration`。每项还记录 `switchCount`、`underrunCount`、`deviceLostCount`、`recoveryCount`、`notes`。

| `scenario`               | 最短播放时长 | 结果要求                                                                           |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------- |
| `track-switch-loop-30m`  | 1800 秒      | 记录切歌次数；不得有未报告的中断、掉设备、underrun 或静默 fallback。               |
| `soak-2h`                | 7200 秒      | 记录持续播放、underrun、掉设备与恢复计数；所有恢复或失败必须可观察。               |
| `sleep-wake`             | 不适用       | 记录睡眠/唤醒时间与恢复或停止的结构化状态；禁止静默换后端/格式。                   |
| `hotplug`                | 不适用       | 记录拔插/设备丢失与恢复或失败；禁止静默换后端/格式。                               |
| `explicit-disappearance` | 不适用       | 记录显式 endpoint 消失后的 fail-closed 与显式重开；受控 hide/show 不等同物理拔插。 |

## Report Contract

`audio-smoke-evidence.json` 的关键字段：

- `requiredSurfaces`：必须覆盖的 surface 列表。
- `artifactVerification.enabled`：CLI 生成报告时为 `true`，表示本地 artifact 会被校验存在。
- `coverage.complete`：是否 7 个 required surface 都已有可校验的 real-device pass。
- `coverage.missingSurfaces` / `failedSurfaces` / `skippedSurfaces` / `unbackedPassSurfaces` / `missingArtifactSurfaces` / `nonHardwareEvidenceSurfaces`：未闭环原因。
- `actionPlan`：针对未闭环 surface 的建议命令、目标 artifact 和所需证据。
- `surfaceRows`：最终 Markdown 表格的行数据，包括自动补出的 `not-run` surface。
- `operationalScenarioSchema` / `operationalScenarioRows`：30 分钟切歌、2 小时 soak、休眠唤醒和热插拔的固定结果契约及记录。

维护原则：

- 不要手写通过行来冒充设备 smoke。
- 不要把无硬件环境的 skip 当作 pass。
- 不要把 `--require-complete` 加到默认 `test:no-real-device`。
- 新增真实设备脚本时，优先让它输出可被 `scripts/audio-smoke-evidence.cjs` 读取的 JSON summary。
