# Twilight Audio Engine API 说明

本文记录当前 `PlaybackInfo`、`OutputInfo`、Capabilities、`sourceExact` / `outputPerfect` 与 Recovery diagnostics 的对外语义。

## PlaybackInfo 与 OutputInfo

`TAE_GetPlaybackInfo()` 返回 JSON。`outputInfo` 是 canonical 字段，顶层的 `actualBackend`、`actualSampleRate`、`latencyMs`、`sourceExact`、`outputPerfect`、`perfectReason` 等字段只做镜像，值从 `outputInfo` 派生。

关键字段：

- `outputInfo.backend`：用户选择的后端，例如 `wasapi`、`wasapi-exclusive`、`asio`、`coreaudio`、`alsa`。
- `outputInfo.actualBackend`：实际运行后端，应该与后端实现和 fallback 状态一致。
- `outputInfo.deviceName` / `actualDeviceName`：请求设备名与实际设备名。`auto` 会解析为平台默认输出设备。
- `outputInfo.outputSampleRate` / `outputBitDepth`：引擎向解码与渲染管线公开的输出格式。
- `outputInfo.actualSampleRate` / `actualBitDepth` / `actualChannels`：后端协商后的实际输出参数。
- `outputInfo.actualOutputFormat`：后端样本格式，例如 `float32`、`S16_LE`、`S24_3LE`。
- `decodedSampleRate` / `decodedBitDepth` / `decodedChannels` / `decodedSampleFormat`：FFmpeg 解码后送入 AudioPipeline 的 PCM 工作格式，供 UI 展示输出链路并参与 passthrough 事实核对。
- `outputInfo.bufferSizeFrames`：后端缓冲区帧数。
- `outputInfo.latencyMs`：估算总延迟，等价于或接近 `latencyInfo.totalLatencyMs`。
- `outputInfo.latencyInfo.bufferLatencyMs`：周期/缓冲带来的渲染延迟估算。
- `outputInfo.latencyInfo.outputLatencyMs`：设备/驱动报告的额外输出延迟估算。
- `outputInfo.supportsOutputPerfect`：后端是否声明当前路径具备独占或直连输出前提能力。
- `outputInfo.sourceExact`：源文件级精确状态。只有无损/整数 PCM 源格式与输出格式可证明完全保持时才为 `true`；MP3/AAC/OGG 等有损格式默认 `false`。
- `outputInfo.outputPerfect`：解码后 PCM 到后端实际输出之间没有额外处理、重采样、音量、DSP、破坏性 routing 或 sample format 损伤时为 `true`。
- `outputInfo.pcmPassthrough`：本次播放 decoded PCM 与后端实际 PCM 格式完全一致且没有后端 resample 时为 `true`；由 `AudioPipeline` 比较 decoded PCM 与 backend actual output 后写入，不由后端自行声明。
- `outputInfo.resampled`：后端或统一评估发现采样率、位深、声道数或 sample format 发生转换。
- `outputInfo.perfectReason`：`sourceExact` 或 `outputPerfect` 未达成时的 canonical 原因。
- `outputInfo.isDsd` / `dsdMode` / `dsdRate`：DSD 状态 canonical 字段。顶层 `PlaybackInfo.isDsd`、`dsdMode`、`dsdRate` 只做镜像；Renderer 应优先读取 `outputInfo` 表示当前 runtime 传输状态。若 DoP 在运行时回退到 PCM，canonical 状态必须同步为 `isDsd=false`、`dsdMode='pcm'`、`dsdRate=0`，UI 可另外基于源文件元数据保留 `DSF/DFF DSD64 -> PCM fallback ...` 的源侧说明。
- `crossfadeActive` / `crossfadeSeconds`：播放连续性处理状态。当前 native 会对预加载下一首做 overlap mixing，并参与 bit-perfect 判定；启用 crossfade 时必须报告 `outputPerfect=false`。
- `gaplessActive`：gapless 意图开启、无 crossfade、且当前存在预加载流时为 `true`（表示 gapless 路径在跑，不等于已 promote）。
- `preloadReady`：下一首预解码流已 `readyForRender`，可被 `skipToPreloaded` 或 render-path promote 消耗。
- `gaplessBlockedReason`：gapless 路径阻塞原因；空串表示未阻塞。取值：`disabled`（意图关或内部门控）、`dsd_path`（DoP/Native DSD）、`typed_passthrough`（typed PCM passthrough 关闭 preload）、`crossfade`（交叉淡入关闭 true gapless）、`format_mismatch`（相邻曲目无法在当前输出格式下 promote）。EOF auto-next 与手动 `next()` 均优先 `skipToPreloaded`，失败才走完整 `playQueueItem`/`stop()`。

## Visualization API

`TAE_GetVisualizationData(engine, options_json, buffer, buffer_size, required_size)` 是只读 tap 查询接口，使用与其他 JSON 查询相同的 buffer/required-size 模式。它监听最终送往后端前的 PCM 渲染缓冲，不改变音频输出；旧的 `TAE_GetSpectrumData()` 保留为兼容入口。

`options_json` 支持：

- `spectrumPoints`：8-4096，默认 64。高保真播放页可请求 4096 个线性 FFT bins，并在 UI 侧按参考可视化实现做 log-Hz 映射与插值。
- `waveformPoints`：16-512，默认 128。
- `spectrogramFrames`：0-96，默认 48；native 侧保留固定滚动窗口，不无限增长；传 0 表示本次查询不返回 spectrogram payload，适合全屏可视化高频轮询。
- `oscilloscopePoints`：0-4096，默认 1024；请求的时域示波器样本数，独立于 `fftResolution` 与 `waveformPoints`，由专门的 decoupled tap 返回；传 0 表示本次查询不返回 oscilloscope payload。
- `visualizerBarCount`：0-256，默认 0；main 进程可为全屏可视化预聚合 log-Hz 频谱柱，减少 renderer 与 iframe 间传输。

返回 JSON 固定包含：

- `spectrum: number[]`
- `waveform: number[]`
- `peakDb: number`
- `rmsDb: number`
- `lufsMomentary: number | null`
- `spectrogram: number[][]`
- `oscilloscope: number[]`
- `visualizerBars?: number[]`
- `sampleRate: number`
- `active: boolean`
- `tapStatus: "active" | "stopped" | "disabled" | "no-samples" | "native-unavailable" | "synthetic-fallback"`
- `reason: string`

`oscilloscope` 是与 `waveform` 解耦的独立时域采样数组，长度由 `oscilloscopePoints` 决定，不随 `fftResolution` 或 `waveformPoints` 变化；返回 N 个 signed time-domain 样本，供 UI 做稳定波形触发与绘制。PlayerBar 在 `oscilloscope` 基础上提供独立的示波器子面板（canvas polyline、客户端零交叉触发、`transition:none`、渐变描边 `#2563eb`→`#14b8a6`），与频谱面板互不影响。

当没有播放采样或 FFT tap 禁用时，`active=false`，`spectrum` / `waveform` / `oscilloscope` 返回请求长度的零数组，`spectrogram=[]`，`lufsMomentary=null`，并通过 `tapStatus` / `reason` 区分 `stopped`、`disabled`、`no-samples`、`native-unavailable`。main 进程在播放中遇到旧 native binding 或 native tap 无采样时允许返回 `tapStatus="synthetic-fallback"` 的兼容数据；UI 必须把它识别为诊断 fallback，不能标成真实 native 采样成功。当前 LUFS 为基于当前 PCM 块 RMS 的 momentary 估算，用于播放器可视化，不作为合规响度计量。

## Capabilities 与错误 JSON

`TAE_GetEngineCapabilities()` 使用 C ABI 的 buffer/required-size 模式返回 JSON。稳定字段包括：

- `defaultBackend`：当前平台默认 backend id。
- `pcmPassthrough`：当前构建具备 per-playback PCM passthrough 判定能力；实际状态以 `outputInfo.pcmPassthrough` 为准。
- `outputPerfectRequiresPcmPassthrough`：`outputPerfect` 是否要求 PCM passthrough；当前为 `true`。
- `htmlAudioFallbackDefault`：Electron 是否默认允许 HTMLAudio 兜底；现阶段为 `false`。
- `backends` / `backendCapabilities`：后端能力列表，两个字段保持兼容。
- `features`：FFmpeg、WASAPI、ASIO、CoreAudio、ALSA、Native DSD、DoP、SACD ISO 能力布尔值。
- `dsd`：DSD 能力模型。DSF/DFF 与 SACD ISO 未压缩 DSD area 可进入 Native DSD / DoP / PCM fallback 决策链；DST 压缩曲目（SACD ISO DST area 与 DSDIFF `'DST '` form/CMPR `"DST "`，含 DSTF 帧表 + FRTE 帧率，seek 按帧索引）通过 DSD-preserving provider（vendored dstdec 算术核心，LGPL-2.1+，输出原始 DSD 字节而非 PCM）解出 DSD 后，同样进入该决策链。管线播放前探测同样接有 provider，DST 源的 `dsdProbe` 不会因缺解码器而失败。provider 默认可用，此时 `sacdIsoDst=true`、`sacdIsoDstMode="native"`、`sacdIsoDstDsdProvider=true`；provider 不可用时退回 `sacdIsoDst=false`、`sacdIsoDstMode=unavailable`、`sacdIsoDstReasonCode=dst_dsd_provider_unavailable`。

`TAE_GetLastError()` 同样使用 buffer/required-size 模式，返回 `hasError`、`code`、`message`、`backend`、`context`、`recoverable`。

## 引擎诊断事件日志

`TAE_GetDiagnosticLog(engine, since_sequence, max_entries, buffer, buffer_size, required_size, next_sequence)`
返回引擎侧进程级环形日志（512 条封顶）中 `sequence > since_sequence` 的条目，按时间升序的 JSON 数组；
`next_sequence` 回传下次轮询的游标，保证增量拉取不重不漏。N-API 导出名 `GetDiagnosticLog(sinceSequence, maxEntries)`。
每条形如：

```json
{
  "sequence": 4,
  "timestamp": "2026-08-27T10:51:56.695Z",
  "level": "warning",
  "event": "dsd_pcm_fallback",
  "message": "Current output backend cannot carry DSD or DoP",
  "details": { "backend": "wasapi", "dsdRate": 64 }
}
```

埋点事件（只对 DSF/DFF/SACD ISO 源记录，普通 PCM 不产生噪音）：

- `dsd_route_decision`（info/warning）：管线路由决策快照（backend/mode/速率/各 canTry 门/dsdRate/probeError）。
- `dsd_probe_failed`（error）：播放前 DSD 探测打开源失败（如路径不可读）。
- `dsd_pcm_fallback`（warning）：DSD→PCM 降级及其具体原因文本。
- `dsd_route_engaged`（info）：Native DSD / DoP / PCM→DSD 路由成功建立。

main 进程（`engineIpc.ts`）在播放状态变化、引擎错误与诊断导出时按游标增量拉取，并入
`audio-diagnostics.jsonl`（`details.source: "engine"`）；导出报告的"事件时间线"分节据此渲染
警告/错误 + 路由决策（`selectTimelineEvents`，上限 40 条）。

## 双状态判定规则

最终 `outputPerfect=true` 必须同时满足：

- 后端当前路径声明 `supportsOutputPerfect=true`。
- decoded PCM 与实际输出格式的采样率、有效 PCM 位深、声道数和 sample format 完全匹配。
- 当前 PCM 路径已验证样本级 passthrough，即 `outputInfo.pcmPassthrough=true`；Float32 -> Int24、Int24 -> Float32、Int24 -> Int24-in32 等 sample format 或容器变化都不算 passthrough。
- 后端没有报告 `resampled=true`。
- 音量为 1.0。
- ReplayGain、Loudnorm、EQ、Convolver、Crossfeed、Crossfade 均未启用。
- 声道 routing 不改变声道语义。

`volumeNormalization` / ReplayGain 模式：

| 模式       | 含义                                                | perfect reason      |
| ---------- | --------------------------------------------------- | ------------------- |
| `off`      | 不归一                                              | —                   |
| `track`    | ReplayGain Track 或 R128 track 标签                 | `replaygain_active` |
| `album`    | ReplayGain Album 或 R128 album 标签                 | `replaygain_active` |
| `loudnorm` | EBU R128 Loudnorm（独立模式，**不得**映射为 Track） | `loudnorm_active`   |

`loudnorm` 使用离线 EBU R128 测量（`TAE_AnalyzeLoudness` / libebur128 integrated + true peak），缓存键对齐 BPM（path|size|mtime|algo|target|ceiling）。完整解码只在独立 `audioAnalysisService` utility process 中执行，不得通过播放 `audioEngineService` RPC。analysis pool 有独立 watchdog、优先级、并发/队列上限和取消；worker 超时/退出不会重启播放 service。C ABI 的 size probe 会在线程局部保存一次分析结果，紧随其后的 buffer read 只复制 JSON；`TAE_GetAnalysisExecutionCount("bpm"|"loudness")` 可验证 probe/read 没有重复解码。默认目标 **−23.0 LUFS**、True Peak 上限 **−1.0 dBTP**，再叠加 `replayGainPreamp`。缓存命中时增益为 `(targetLufs - measuredIntegratedLufs) + preamp`，超 ceiling 再衰减；无缓存时首播使用 `replayGainFallback` + preamp 并后台测量，状态为 measuring/cached/fallback/unavailable。无 libebur128 时报告 unavailable 并用 fallback，禁止假成功。始终报告 `loudnormActive` / `loudnorm_active`。

**Stage-1 UI 契约：** Renderer Settings 与 HiFi 控制台必须从 `src/shared/audioProcessingOptions.ts` 暴露完整 `volumeNormalization` / `dsdOutputMode` 选项集（含 `loudnorm`）。软件音量默认 **0.7**；bit-perfect 需用户显式 Unity（1.0），`perfectReasonCode=volume_not_unity` 时提供 CTA。禁止静默把默认音量改成 1.0，禁止在任一 UI 路径「forbid loudnorm」。

**Stage-2 输出采样率锁：** 采样率锁 / resampler / dither 仅通过 DSP graph `outputStage` 配置（`AudioEngineManager.setOutputStage` / HiFi 输出页 / DspRack）。非 `device` 目标采样率或启用 SRC/dither 会使 `outputPerfect=false`。`setAudioProcessing` 重写 legacy graph 时保留既有 `outputStage`。

### 原生音频能力清单

`resources/audio-engine/audio-capabilities.json` 由 `pnpm run stage:audio-engine` 生成；开发环境可单独运行 `pnpm run generate:audio-capability-manifest`。`artifactDirectory` 固定为逻辑根 `.`，全部 artifact 路径相对此根，绝不写入构建机绝对路径。清单只检查实际暂存的原生二进制与其导入表，记录 SWR、CPU PCM→DSD、miniaudio PoC、CUDA 和其它 GPU backend 的编译事实；CUDA 与其它 GPU 导入检查覆盖每个成功解析的 native artifact，主引擎专属的 PCM/SWR 判断仍只读取引擎二进制。

每项 native artifact 都包含 `importInspection`。解析失败时状态是 `unavailable`（例如非 PE），而非空导入表等同于“不存在 GPU”；此时 `cuda.compiled` 为 `null`，相关 `importInspectionComplete=false`，必须先修复检查或取得可解析产物才能声明未编译。完整检查中没有对应产物证据时，能力才为 `false` 或空数组，不能由设置项、UI 文案或二进制中的一般性字符串推断。

`release-capability-status.json` 是与 manifest 配套的发行声明，受控项为 ASIO、VST3、SoXR、ebur128、CUDA 与 Native DSD provider。每项同时保留 `buildStatus`、`runtimeStatus` 和 `deviceVerification`，以及每个维度的 `evidence.state`、`reason`、`provenance`；值只能是 `available`、`experimental`、`unverified`、`not-built` 或 `unsupported`。运行观察仅接受 `audio-engine-runtime-observation` 且其 artifact hash 必须逐一匹配 manifest。没有真实设备证据必须是 `unverified`，而不是把缺设备变成构建错误或由设备名猜测为可用。

SoXR 不是独立链接的宿主 backend，而是 FFmpeg 的构建可选 resampler engine。清单把它标记为 `ffmpeg-runtime-probe`：只有播放期 `DspOutputStageStatus.resamplerEngine` 与 `resamplerFallback` 才能报告实际 engine 和回退。没有 runtime observation 只表示“未观察”，不表示 SoXR 已可用，也不把它伪装为编译保证。

miniaudio 目前仅是 `TAE_ENABLE_MINIAUDIO=OFF` 默认关闭的 Windows Shared/default PCM provider PoC 编译依赖。Manifest 中的 `capabilities.miniaudio.compiled=true` 只说明 staged 主引擎包含该 PoC 代码与 WASAPI backend 编译标记；`runtimeStatus` 和 `deviceStatus` 在真实运行与设备 A/B 证据前保持 `unverified`，也不改变公开 backend id 或默认输出选择。

当前批准的产品术语是“PCM SRC”和“实验性 PCM→DSD64/128/256（CPU）”。CUDA SDM 与完整高品质 SDM 在 AP-409 完成并拥有数值、性能及真机证据前不得作为支持能力发布。

**Stage-2 平衡/相位与库标签：** HiFi 通过 `AudioEngineManager.setStereoImage` 写入 default graph 的 stereoField + channelStrip polarity（`DspStereoImageConfig`：balance/width/mid-side/invert/swap/mono）。`createLegacyDspGraph` / `setAudioProcessing` 必须保留既有 `stereoImage`。任一非默认立体声图像 ⇒ `outputPerfect=false`。本地库扫描持久化 ReplayGain/R128 标签，经 `NativeQueueLoadItem` / `AudioEngineQueueItem` / 原生 `QueueItem` 注入 `ReplayGainInfo`（覆盖 decode 缺标签）；session restore 保留字段；`loudnorm` 仍只消费离线测量缓存。

**Loudnorm 状态与硬化：** `prepareLoudnormForPlay` 推送 `loudnorm-status`（measuring|cached|fallback|unavailable|idle）到 renderer HiFi 与 Settings；`setAudioProcessing` / `setReplayGainMode` 离开 loudnorm 时立刻 `cancel` 并发 `idle`，播放中切入 loudnorm 时对当前 `source` 重新 prepare。`setReplayGainMode` 必须走 `setAudioProcessing`，保证 default-scene graph 与 `SetReplayGainMode` 双路径一致。测量完成后 `LoadQueue` 注入 `measuredIntegratedLufs` / `measuredTruePeakDb`，`AudioPipeline::refreshQueueReplayGainTags` 把测量叠到当前/预加载流的 `ReplayGainInfo`（不 reopen 设备），本曲即可从 Fallback 切到测量增益。异步测量回调在 destroy / 离模式 / 换曲后丢弃。隔离 analysis pool 默认并发 1、队列有界，loudnorm 高优先级；identity 命中跳过重测、切曲/关模式 `cancel` 后不写缓存、缓存上限 512、Settings 清空缓存会 `notifyLoudnessCacheCleared` 重准备当前曲。

`sourceExact=true` 额外要求源格式无损，并且源格式与实际输出格式完全一致。有损格式可以达成 `outputPerfect=true`，但 `sourceExact=false`，原因会显示为 `Source is lossy; decoded PCM path is output perfect`。

各后端只声明能力和实际格式；`TwilightAudioEngine` 与 `AudioPipeline` 不按 backend id 硬编码最终状态。WASAPI Exclusive / ASIO 当前可以在处理链完全 bypass、音量为 1.0、routing 保持语义且 decoded PCM 与后端实际格式完全一致时走 typed PCM passthrough；Int16/Int24/Int32/Float32 都由 `PcmBlock`、typed `AudioBuffer` 和后端 typed render 承载。整数 PCM 源如果因为格式不匹配或处理链要求被转换到 Float32，再由后端重新打包为整数输出，仍必须报告 `outputPerfect=false`、`pcmPassthrough=false` 和具体原因，例如 `integer_passthrough_unavailable` 或 `pcm_converted`。

## DSD / DoP / SACD 语义

- DoP carrier：DSF/DFF DSD64/128/256/512 在后端、设备、声道数和实际 PCM carrier 格式满足条件时可进入 `dsdMode=dop`，遵循 dCS DoP open standard v1.1（24-bit、`0x05`/`0xFA` marker 交替）。carrier 采样率：DSD64=176.4kHz、DSD128=352.8kHz、DSD256=705.6kHz（44.1k family）/768kHz（48k family）、DSD512=1411.2kHz（44.1k family）/1536kHz（48k family）。carrier 上限从 DSD128 提升到 DSD512，但运行时仍由设备 carrier-rate 能力决定：ASIO 读取 `dopCarrierSampleRates`，WASAPI Exclusive / CoreAudio Exclusive 通过 `IsFormatSupported` 运行时探测。UI 展示为 DSD 源到 `DoP carrier` 再到后端实际输出；它不同于 PCM fallback，因为 carrier 保留 DSD bitstream。
- PCM fallback：DoP carrier 条件不满足（包括设备不支持 DSD256/512 carrier 速率），或软件音量、ReplayGain、EQ、Convolver、Crossfeed、Crossfade 等处理启用时，必须走 PCM fallback。UI 展示为 DSD 源到 PCM 工作格式再到后端实际 PCM 格式，不把它标为 Native DSD 或 DoP。
- DSD downrate：`dsdRatePolicy` 可选 `pcm-fallback`（默认）、`exact`、`downrate`。`downrate` 在 source rate 的 Native/DoP 候选被拒绝后，按同 family 的 DSD256/128/64 依次重试；全部失败才 PCM fallback。`DsdDownrateProcessor` 在 DSD 域内以 63-tap FIR、幂二抽取和有界一阶误差反馈 1-bit 重调制完成 x2/x4/x8 转换，configure 后 process 不分配，seek/reopen 时 reset。输出诊断报告 `actualDsdRate`、`dsdConversion`（`exact|downrate|pcm-fallback`）及 `dsdConversionReason`；降倍率始终 `sourceExact=false`、`resampled=true`、`outputPerfect=false`，并使用 `dsd_downrated` reason code。真实 DAC 的 DSD256/512 和 48 kHz-family 降倍率验收仍待证据，不得据此宣称真机资格已完成。
- Native DSD：指后端和设备直接接收 DSD bitstream。当前支持 ASIO 与 Linux ALSA `hw:` 设备（通过 `SND_PCM_FORMAT_DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送 DSD，rate = DSD bit-clock / phys_width：DSD64→U8@352.8k、DSD128→U8@705.6k、DSD256→U16_LE@705.6k、DSD512→U32_LE@705.6k，静音字节 `0x69`，格式选择顺序按 MPD 约定 U8→U32_LE→U16_LE），`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 在打开时为 Candidate、首次成功 `writei` 后为 Proven。只有运行态证明为 `proven` 才能声明 native。WASAPI 与 CoreAudio 没有 native DSD 通道（WASAPI 无 UAC2 native DSD path、CoreAudio 无 DSD path），属平台限制而非代码缺口；这两个后端走 DoP（Exclusive / Hog）或 PCM fallback。
- SACD ISO：支持未压缩 DSD area 的曲目切片播放；`?area=stereo|multichannel&track=N` 可选择具体 program/track。DST 压缩曲目通过 DSD-preserving provider（vendored FFmpeg dstdec 算术核心，LGPL-2.1+，输出原始 DSD 字节而非 PCM）解出 DSD 后，进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链。provider 默认可用；provider 失败时报 `dst_dsd_provider_failed`，provider 不可用时退回 `dst_dsd_provider_unavailable`，禁止把 FFmpeg PCM DST decode 包装成 Native DSD/DoP 成功。

`GetMetadata()` 对 SACD ISO 返回 `isoTracks[]`。每个 track 带有 `playable`、`reasonCode` 和 `outputModes`：未压缩 DSD track 为 `playable=true` 且 `outputModes=["native","dop","pcm"]`；DST track 在 provider 可用时（默认）同样为 `playable=true`、`codec=dst`、`outputModes=["native","dop","pcm"]`，仅当 provider 不可用时才退回 `playable=false`、`reasonCode=dst_dsd_provider_unavailable`、`outputModes=[]`。

Phase 6B 的后端规则：

- WASAPI Shared 永远不进入 `outputPerfect=true`，原因应说明系统 shared mixer。
- WASAPI Exclusive 只有独占打开成功、实际 PCM 格式完整上报且与 decoded PCM 完全匹配时，才允许进入 evaluator 判定；协商失败要区分 sample rate、bit depth、channel、sample format 或 exclusive open。
- ASIO 只有驱动成功加载、buffer 创建成功、实际 sample format/采样率/声道/位深完整上报且与 decoded PCM 匹配时，才允许进入 evaluator 判定。
- CoreAudio shared 路径继续 `outputPerfect=false`；`coreaudio-exclusive` 后端在 Hog Mode 获取成功、采样率匹配且整数 PCM 直通时进入 evaluator 判定。
- ALSA `default` / `plughw:` 默认可能经过插件转换，继续 `outputPerfect=false`；只有显式 `hw:` 且实际格式完全匹配时才允许进入 evaluator 判定。

## Render Performance Metrics

`outputInfo.renderPerformance` is a lock-free snapshot maintained by the native render path:

- `callbackCount`: number of PCM or typed render callbacks observed since the pipeline opened.
- `totalCallbackNanoseconds` / `meanCallbackNanoseconds` / `peakCallbackNanoseconds`: callback execution time totals and latency summary.
- `totalDeadlineNanoseconds`: sum of audio-buffer deadlines derived from callback frame count and sample rate.
- `deadlineMissCount`: callbacks whose measured execution time exceeded that deadline.
- `callbackDeadlineLoadPercent`: `totalCallbackNanoseconds / totalDeadlineNanoseconds * 100`.

These fields measure native callback deadline load. They are not a claim about process CPU, system CPU,
or real-device scheduling. The deterministic `twilight_audio_performance_gate` CTest emits the same
metrics with decoded WAV, gapless/crossfade, convolution, controlled VST3-host pressure on Windows,
diagnostic deltas, and working-set snapshots. A physical WASAPI Exclusive soak is opt-in through
`pnpm run smoke:audio-performance -- --device "<endpoint>" --duration-seconds 300 --json`; keep that
JSON separately as real-device evidence and do not substitute the controlled-pump result.

## Recovery Diagnostics

`outputInfo.diagnostics` 记录当前 session 与 lifetime 的恢复信息：

- `sessionUnderrunCount` / `lifetimeUnderrunCount`：本次打开或进程生命周期内的 underrun/xrun 次数。
- `sessionBufferDropCount` / `lifetimeBufferDropCount`：缓冲提交失败或丢弃次数。
- `sessionRecoveryCount` / `lifetimeRecoveryCount`：恢复成功次数。
- `driverRestartCount`：驱动重启或重置事件计数。
- `deviceLostCount`：设备丢失事件计数。
- `lastError`：最近一次后端错误或恢复原因。

ASIO 保留冷却与恢复诊断策略。ALSA 提供基础 xrun 恢复：`snd_pcm_prepare()` / `snd_pcm_resume()` 成功后更新 underrun 与 recovery 计数。

Electron IPC 会在 audio service crash 时同时发送结构化 `audioEngine:service-crash { reason }` 与兼容错误文案。Renderer 恢复提示应优先订阅结构化事件；service ready 后只恢复配置、队列和状态，不自动续播，由用户通过提示按钮手动继续。输出路由恢复必须按 `output-backend -> output-device -> output-config` 顺序等待 RPC ACK，避免设备或 buffer 配置套到旧后端。native 侧把 backend/device 视为待提交 topology，只有随后的 output-config 才一次性重开当前 stream；禁止 backend/device 各自用半套 route 连续重启。用户触发的输出后端、设备、独占模式和输出配置切换使用同一可回滚事务：先枚举/验证目标，事务静音后按 backend/device/config 应用目标并等待 ACK，commit 后才恢复原软件音量；目标打开、ready ACK、service generation 或配置 revision 竞争失败时回滚旧 backend/device/config，旧设备也不可用时执行 safe-stop 并保持无自动重播。DSP 恢复顺序固定为 `SetDspPluginChain -> ApplyDspState(revision, payload) -> LoadQueue`；统一 payload 同时携带 processing、scene 和完整 graph，service 对 processing 字段合并、对 graph 采用最新完整 snapshot，并把同一批次等待者统一解析到最终 ACK。native 只有在 isolated active/preload 候选全部成功且 RT retirement window 未满时才提交；失败保持旧配置和旧 applied revision。`GetDspGraphStatus.revision` 是 Renderer pending/applied/failed 的权威 ACK。`audioEngine:service-ready` 会携带 `{ manualResumeRequired, outputRouteSynced, restoreErrors }`，只有输出后端、设备和输出配置恢复成功时 UI 才应展示“继续播放”动作；失败时提示用户重新选择输出设备。

## 设备能力与刷新事件

`AudioDeviceOption` 可携带 `dopSupportState` 与 `nativeDsdSupportState`，取值为：

- `verified`：设备枚举或驱动事实已明确提供能力，例如 ASIO 枚举到 carrier/native DSD 格式。
- `runtime-probed`：枚举阶段不能静态证明，但播放打开时可通过后端格式探测确认，例如 WASAPI/CoreAudio DoP carrier 或 ALSA `hw:` native DSD。
- `unsupported`：平台或路径不支持，例如 WASAPI/CoreAudio native DSD。
- `unknown`：当前枚举信息不足，UI 应避免展示为已支持或不支持。

main 进程会在输出后端、设备、独占模式、audio service recovery、native 输出诊断变化时清空设备能力缓存，并向 renderer 发送 `audioEngine:device-options-changed`。Windows 主窗口监听 `WM_DEVICECHANGE`，经过短 debounce 后触发 `platform-device-change:wm-devicechange` 刷新，用于更快捕捉常见 USB DAC/ASIO 设备插拔。Linux 监听 `/dev/snd`，当 ALSA `hw:` 设备节点变化时触发 `platform-device-change:alsa-dev-snd` 刷新；如果该目录暂不存在、watcher 创建失败或关闭，会保留轮询兜底并低频重试 watcher。CoreAudio shared/exclusive 后端在打开设备后监听设备在线状态和 HAL 设备列表变化，用于触发播放路径的 device-lost/recovery；manager 保留 5s 低频设备选项轮询作为兜底。这不是高级多设备同步的完整替代。

## 后端支持矩阵

| 后端                      | 平台        | 当前状态                                                               | outputPerfect 能力                                                                                                                                                                   |
| ------------------------- | ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WASAPI shared             | Windows     | 已接入并通过 MinGW 测试矩阵                                            | `supportsOutputPerfect=false`，经过系统混音                                                                                                                                          |
| WASAPI exclusive          | Windows     | 已接入格式协商和 smoke 覆盖                                            | 独占成功且 actual PCM format 与 decoded PCM 完全匹配后进入 evaluator                                                                                                                 |
| ASIO                      | Windows x64 | 独立 SDK-free 兼容层；默认枚举已安装驱动，可显式禁用                   | mock 覆盖 Int16/Int24/Int24-in32/Int32/Float32；真实设备 smoke opt-in                                                                                                                |
| CoreAudio shared          | macOS       | 源码后端存在，需 macOS 工具链验证                                      | `supportsOutputPerfect=false`，经过系统混音                                                                                                                                          |
| CoreAudio exclusive (Hog) | macOS       | 已实现 Hog Mode + 采样率匹配 + 整数 PCM 直通，需 macOS 工具链/设备验证 | Hog 获取成功且 actual PCM format 与 decoded PCM 完全匹配后进入 evaluator                                                                                                             |
| ALSA                      | Linux       | 源码后端存在，需 Linux 工具链/设备验证                                 | `default`/`plughw:` 默认 false；仅显式 `hw:` 且格式完全匹配时可为 true。`hw:` 支持 native DSD 直送（`DSD_U8`/`DSD_U16_LE`/`DSD_U32_LE`），`backendCanAttemptNativeDsd("alsa")==true` |

## 当前非闭环范围

当前不包含高级多设备同步；Windows 已接入 `WM_DEVICECHANGE` 事件刷新，Linux 已接入 ALSA `/dev/snd` 节点 watcher，CoreAudio 播放后端已接入设备失效监听，但 macOS 枚举级复杂热插拔同步仍待真实设备验证和补充。所有平台仍保留轻量设备选项轮询和 recovery-triggered 能力刷新。SACD DST 已通过 DSD-preserving provider 闭环（provider 默认可用）。Native DSD 支持 ASIO 与 ALSA `hw:`；WASAPI 与 CoreAudio 没有 native DSD 通道，属平台限制而非代码缺口，这两个后端走 DoP 或 PCM fallback。ASIO 兼容层不携带 SDK，且仅在 Windows x64 构建中编译；默认枚举并可激活已安装驱动，设置 `TWILIGHT_DISABLE_ASIO=1` 可显式禁用。真实设备 smoke（WASAPI Exclusive / ASIO PCM / DoP DAC / Native DSD / SACD ISO / CoreAudio Hog / ALSA `hw:`）通过 `TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1` 开启，opt-in，不进入默认 CI 门禁，不伪造结果；没有对应设备时必须跳过并保持默认验证通过。`pnpm run smoke:audio-evidence -- --input <evidence-envelope.json>` 或 `--input-dir <dir>` 可把多台机器/多设备的 opt-in 结果沉淀为 Markdown/JSON 报告，并显式列出未覆盖的 required surfaces。报告 JSON 包含 `coverage.complete`、缺失/失败 surface 列表和未闭环 surface 的 `actionPlan`；只有带固定采集元数据、存在本地 artifact 与匹配 SHA-256 的 `real-device` pass 计入 complete，mock/未知来源不计入。发布前可手动加 `--require-complete` 让证据不完整时退出非 0。证据库采集与判定细节见 [Audio Smoke Evidence](./audio-smoke-evidence.md)。
