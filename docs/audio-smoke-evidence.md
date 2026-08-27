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
pnpm run smoke:audio-evidence -- --input output/audio-smoke-evidence/wasapi-exclusive.json --input output/audio-smoke-evidence/asio-pcm.json
pnpm run smoke:audio-evidence -- --input-dir output/audio-smoke-evidence
```

发布前需要强制检查证据完整性时使用：

```bash
pnpm run smoke:audio-evidence -- --input-dir output/audio-smoke-evidence --require-complete
```

`--require-complete` 只作为 opt-in gate。没有对应硬件时不要把它加入默认 CI。

## Required Surfaces

完整证据（`coverage.complete`）需要覆盖 **5 个硬件 surface**：

| Surface          | Suggested command                                                                                                                                                                           | Required evidence                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| WASAPI Exclusive | `pnpm run smoke:wasapi -- --device "<wasapi-endpoint>" --buffer 256 --format-matrix --json > output/audio-smoke-evidence/wasapi-exclusive.json`                                             | `actualBackend=wasapi-exclusive`、exclusive=true、实际输出格式、每个 PCM probe 的 `outputPerfect` / `perfectReason` |
| ASIO             | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend asio --device "<asio-driver>" --json > output/audio-smoke-evidence/asio-pcm.json`                | `actualBackend=asio`、驱动/设备名、实际输出格式、明确 pass/fail reason                                              |
| DoP DAC          | `pnpm run smoke:audio-format-matrix -- --fixture-dir "<dsd-fixtures>" --playback --backend wasapi-exclusive --device "<dop-capable-dac>" --json > output/audio-smoke-evidence/dop-dac.json` | `dsdMode=dop`、carrier sample rate、实际输出格式；DAC 拒绝时必须有 fallback reason                                  |
| Native DSD       | `pnpm run smoke:asio-native-dsd -- --device "<native-dsd-asio-driver>" --fixture-dir "<dsd-fixtures>" --json > output/audio-smoke-evidence/native-dsd.json`                                 | 至少一个 DSD rate 达到 `nativeDsdRuntimeState=proven`，并记录驱动/设备和不支持 rate 的 fallback reason              |
| SACD ISO         | `pnpm run smoke:audio-format-matrix -- --manifest "<sacd-iso-matrix.json>" --playback --backend wasapi-exclusive --device "<dac>" --json > output/audio-smoke-evidence/sacd-iso.json`       | SACD ISO metadata、track/area、native/DoP/PCM runtime result；DST/provider 失败时必须有 reason                      |

## Optional Product Honesty Surfaces

以下 surface **始终出现在报告中**，无 artifact 时默认 `not-run`。它们**不参与** `coverage.complete`（仍只要求 5 个硬件 surface），用于 Stage 1–2 产品诚实路径的维护者证据。

| Surface       | Suggested checklist                                                                                                                                                         | Required evidence                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Loudnorm      | 无标签 FLAC → `volumeNormalization=loudnorm` → 首播 measuring/fallback + `perfectReasonCode=loudnorm_active`；再播 cached；记录 `output/audio-smoke-evidence/loudnorm.json` | `mode=loudnorm`（永不 Track 别名）、`loudnormActive`、状态 measuring\|cached\|fallback\|unavailable；无 ebur128 时不可假成功 |
| Gapless Album | 同格式专辑队列、gapless ON、crossfade OFF → 观察 `gaplessActive`/`preloadReady` 与无设备 reopen 的 promote；记录 `output/audio-smoke-evidence/gapless-album.json`           | 意图 ON；Active/Preload 可观测；Blocked 时 `gaplessBlockedReason` 为 `format_mismatch`/`crossfade`/`dsd_path` 等             |
| Unity Volume  | 默认音量 0.7 + exclusive bypass → `volume_not_unity` + Unity CTA；`setVolume(1)` 后在其它条件满足时恢复 perfect 路径；记录 `output/audio-smoke-evidence/unity-volume.json`  | 默认仍为 0.7；Unity 是用户动作；`volume_not_unity` reason 可证伪                                                             |

### 明确非声明（平台限制）

- **WASAPI / CoreAudio 无 native DSD**：Native DSD surface 仅适用于 ASIO（或其它显式 native 路径）；DoP 是 WASAPI exclusive 的合法 DSD 载体，不是 native DSD。
- Shared WASAPI **不得**宣称 bit-perfect。

## Evidence Rules

报告中的 `coverage.complete` 只有在每个 required surface 至少有一条 `pass` 记录且带有可追溯 artifact 时才为 `true`。

Artifact 规则：

- 本地 artifact 路径必须存在。
- `http://` 或 `https://` artifact URL 视为远端证据链接。
- 如果输入 JSON 是 entries 数组或已有 report entries，且单条 entry 没写 artifact，脚本会把输入 JSON 自身作为 fallback artifact。
- 没有 artifact 的 pass 不计入完整覆盖，会进入 `unbackedPassSurfaces`。
- 写了本地 artifact 但文件不存在的 pass 不计入完整覆盖，会进入 `missingArtifactSurfaces`。

状态含义：

- `pass`：该 surface 在真实设备上通过，并且 artifact 可追溯。
- `fail`：真实设备运行过，但结果失败；报告会保留失败原因，不能用作 complete。
- `skip`：因为硬件、驱动或平台条件缺失而跳过；不阻塞默认 CI，但不算 release 证据闭环。
- `not-run`：还没有记录该 surface 的真实设备证据。

## Report Contract

`audio-smoke-evidence.json` 的关键字段：

- `requiredSurfaces`：必须覆盖的 surface 列表。
- `artifactVerification.enabled`：CLI 生成报告时为 `true`，表示本地 artifact 会被校验存在。
- `coverage.complete`：是否 5 个 required surface 都已有可追溯 pass。
- `coverage.missingSurfaces` / `failedSurfaces` / `skippedSurfaces` / `unbackedPassSurfaces` / `missingArtifactSurfaces`：未闭环原因。
- `actionPlan`：针对未闭环 surface 的建议命令、目标 artifact 和所需证据。
- `surfaceRows`：最终 Markdown 表格的行数据，包括自动补出的 `not-run` surface。

维护原则：

- 不要手写通过行来冒充设备 smoke。
- 不要把无硬件环境的 skip 当作 pass。
- 不要把 `--require-complete` 加到默认 `test:no-real-device`。
- 新增真实设备脚本时，优先让它输出可被 `scripts/audio-smoke-evidence.cjs` 读取的 JSON summary。
