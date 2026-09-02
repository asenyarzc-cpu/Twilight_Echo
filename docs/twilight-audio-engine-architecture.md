# Twilight Audio Engine 架构状态

## 当前阶段

当前仓库不再按旧阶段从零推进。代码已经包含 C ABI、Node-API、FFmpeg decode、AudioPipeline、DSP、Metadata、Queue、WASAPI Shared/Exclusive、ASIO 可选接入、CoreAudio/ALSA 源码后端和 Electron 集成。当前补完重点是事实层验证、公共契约稳定和 fallback 收口。

当前 MinGW 验证流程：

```powershell
$env:TAE_MINGW_BUILD_DIR = 'D:\\path-without-spaces\\mingw-static'
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
ctest --test-dir $env:TAE_MINGW_BUILD_DIR -N
pnpm run test:audio-engine:mingw
pnpm run typecheck
pnpm run build
```

`TAE_MINGW_BUILD_DIR` 必须指向当前有效、可写且不含空格的外部构建目录。CTest 注册数量和测试结果必须在该目录完成重新配置、重新构建后生成；不得复用已移动目录的注册表或引用固定的历史测试数量。`pnpm run test:audio-engine:mingw` 是 native 闭环验证入口。`pnpm run test:no-real-device` 串联 MinGW configure/build、native CTest、Electron manager 测试、typecheck 和前端 build；真实设备 smoke 继续 opt-in，不进入默认门禁。

## 边界

- C ABI 是稳定边界；新增查询继续使用 buffer/required-size 模式。
- Node-API 是薄桥接，只转发 C ABI、抛出 native 错误、返回 JSON。
- `outputInfo` 是 canonical playback 状态；顶层 `PlaybackInfo` 字段只做兼容镜像，包括 `isDsd`、`dsdMode`、`dsdRate`。
- Native queue 负责 EOF auto-next、gapless preload 和 crossfade overlap mixing；Electron 只同步 `PlaybackInfo` 并发送用户操作。`crossfadeSeconds` 由 native 状态上报并使 `outputPerfect=false`，Renderer 不再在 native 播放时用自己的 crossfade 定时器驱动下一首。
- Electron 默认走 native engine；HTMLAudio 只允许通过 `TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK=1` 显式开启。
- WASAPI Shared 使用系统默认设备时，如果 endpoint 在枚举与 `IAudioClient` 激活之间失效，会重新枚举并激活一次；显式设备选择失败仍直接上报，不静默改路由。
- Electron audio service crash 后先把 native playback 标记为 stopped；service ready 后只恢复后端、设备、输出配置、原生 DSP 插件链、统一 DSP state 和队列，不自动续播，避免在崩溃恢复时产生非用户触发的播放。用户触发的输出后端、设备、独占模式和输出配置变更由 `audioEngineManager` 的输出路由事务执行：切换前重新验证目标设备，旧 route 在 commit 前保持为应用层权威 snapshot；事务按 prepare → validate → mute → open target → backend/device/config → verify target ready → commit → unmute 推进；native backend/device setter 只暂存 topology，由 config setter 一次提交并重开 stream，target ACK 必须匹配 backend、catalog 设备身份、state 和 source；失败时按 `output-backend -> output-device -> output-config` 回滚旧 route，旧设备不可恢复时 safe-stop 且不自动重播。恢复顺序固定为 `SetDspPluginChain -> ApplyDspState(revision, payload) -> LoadQueue`；EQ/ReplayGain/crossfeed/convolver/balance/output stage 不再并行调用 legacy setter 覆盖统一事务。
- `ApplyDspState` 先在 control thread 上编译隔离的 active/preload 候选，全部成功且 retired-generation 容量可用后才提交配置、graph JSON、gapless/preload 状态和 RT graph 所有权。render callback 通过 epoch ACK 切换 graph，control thread 只回收已 ACK 且不再被 current/preload 引用的代际，最多保留 8 代。`GetDspGraphStatus.revision` 是 UI pending/applied/failed 的外部 revision ACK；generic playback config revision 只作为其它控制共享的单调计数。
- BPM/loudness 完整文件解码运行在独立 `audioAnalysisService` utility-process pool，绝不进入播放 `audioEngineService` 的 RPC 队列。主进程 analysis client 负责有界优先级队列、aging、等待 deadline、高优先级 admission、并发上限、独立 watchdog 与取消；取消或超时只替换对应 analysis worker，不重启或阻塞播放 service。cache commit 与取消并发时使用 generation 屏障和精确值条件删除，避免取消结果落缓存或删除后继写入。
- ASIO 兼容层不携带 SDK，只在 Windows x64 构建中编译并默认枚举已安装驱动；排障或紧急回退可通过 `TWILIGHT_DISABLE_ASIO=1` 显式禁用。
- miniaudio 0.11.25 已作为默认关闭的 Windows Shared/default PCM provider PoC 编译依赖接入；它不改变当前公开 backend id、默认路由或 WASAPI Exclusive/ASIO/DSD 特殊路径。
- 真实设备 smoke 是 opt-in：没有目标平台工具链或真实设备时跳过，不阻塞默认 CI。

## sourceExact / outputPerfect 策略

当前公共契约使用双状态：`sourceExact` 表示源文件级精确，`outputPerfect` 表示 decoded PCM 到后端实际输出期间没有额外处理或格式损伤。后端只上报实际输出格式和能力，最终状态由统一 evaluator 计算。

`outputPerfect=true` 要求 backend capability、decoded PCM 与实际输出的采样率/位深/声道/sample format 完全匹配、无 resample、无 DSP/音量/routing 改变，并且本次播放 `pcmPassthrough=true`。`pcmPassthrough` 由 `AudioPipeline` 用 FFmpeg decoded PCM 与后端 actual output 事实比较得出；后端只上报事实。`sourceExact=true` 还要求源为无损且源格式与输出格式完全一致；MP3/AAC/OGG 等有损源可达成 `outputPerfect=true`，但不会达成 `sourceExact=true`。

当前 WASAPI Exclusive / ASIO 在严格 bypass 条件下可以走 typed PCM passthrough：FFmpeg decode 输出、`AudioBuffer`、后端 typed render 共享同一个实际 PCM 格式，Int16/Int24/Int32/Float32 均可参与 `pcmPassthrough` 判定。无损整数 PCM 源如果因源格式与设备实际格式不一致、DSP/音量/routing 处理或其它 fallback 进入 Float32 管线，再由后端重新打包为整数输出，必须报告 `outputPerfect=false`、`pcmPassthrough=false` 和具体 `perfectReasonCode`，不得误报 bit-perfect。

## 可视化 tap

FFT tap 已扩展为只读 visualization tap，监听最终 PCM 渲染缓冲，不影响音频输出。C ABI / Node-API 通过 `GetVisualizationData` 返回 spectrum、waveform、peak、RMS、momentary LUFS 估算、固定滚动窗口 spectrogram、decoupled 示波器时域采样（`oscilloscopePoints` 0-4096，默认 1024，独立于 `fftResolution`）、可选预聚合 `visualizerBars`、sampleRate、active、`tapStatus` 和 `reason`。`spectrumPoints` 支持 8-4096，播放页可请求 4096 个线性 FFT bins 并在 UI 侧做 log-Hz 映射；高频全屏可视化可把 `spectrogramFrames` / `oscilloscopePoints` 设为 0 关闭未使用 payload。无播放采样或 tap 禁用时返回 inactive 空闲态；播放中 native tap 不可用时 main 可返回显式标记的 `synthetic-fallback` 兼容数据，Renderer 必须把它当诊断 fallback 或空闲态处理，不能展示为真实 native 采样成功。

Phase 6B 的后端判定边界：

- WASAPI Shared 是系统混音路径，始终以明确 reason 报告 `outputPerfect=false`；即使后续由 miniaudio PoC 承接 Shared/default device I/O，也不得因 provider 初始化成功推断 bit-perfect。
- WASAPI Exclusive 和 ASIO 必须先真实上报 actual sample rate、bit depth、channel、sample format，再由 evaluator 判定；format negotiation 或 exclusive/driver open 失败要给具体 reason。
- CoreAudio 默认路径继续 `outputPerfect=false`；Hog/Exclusive 未实现并验证前不进入 true 判定。
- ALSA `default` / `plughw:` 默认可能经过插件转换，继续 `outputPerfect=false`；只有显式 `hw:` 且 actual format 完全匹配时才允许进入 true 判定。

## DSP 策略

DSP 默认 bypass。ReplayGain、Loudnorm、EQ、FIR Convolver、Crossfeed、Crossfade 和软件音量只有在显式配置或用户操作后才影响状态；任一会改变样本或播放连续性的处理启用时，最终 `outputPerfect=false`。

### 音量标准化模式

- `track` / `album`：仅消费源标签（ReplayGain 或 R128）。
- `loudnorm`：独立 EBU R128 模式，**禁止**静默映射为 Track。离线测量 integrated LUFS + true peak（`TAE_AnalyzeLoudness` / libebur128），Electron 缓存对齐 BPM；默认目标 −23 LUFS、ceiling −1 dBTP。缓存命中施加测量增益，无缓存首播 fallback 并后台测量，状态 measuring/cached/fallback/unavailable；无 ebur128 时 unavailable+fallback。始终上报 `loudnorm_active`。

### Stage-1 HiFi 契约（已落地）

Stage 1 要求 UI 与引擎对声明可证伪、可操作：

1. **共享选项源**：Settings 与 HiFi 控制台必须从 `src/shared/audioProcessingOptions.ts` 读取 `VOLUME_NORMALIZATION_OPTIONS` / `DSD_OUTPUT_MODE_OPTIONS`，两边都暴露完整 `off|track|album|loudnorm` 与 `auto|pcm|dop|native`。**禁止**再写「forbid loudnorm」或在一侧静默去掉 loudnorm。
2. **双 DSP 路径**：经典 `audioProcessing` / `createLegacyDspGraph` 与 DspScene graph 共用同一 `ReplayGainProcessor`；loudnorm 参数 `targetLufs` / `truePeakCeilingDb` 必须在两条入口一致。
3. **软件音量**：默认 **0.7**（保护听感）；bit-perfect 需要用户显式 **Unity = 1.0**。`volume_not_unity` 时 UI 提供 Unity CTA，禁止静默把默认改成 1.0。
4. **独立 perfect reason**：`loudnorm_active` 与 `replaygain_active` / `volume_not_unity` 不得互相冒充。
5. **Gapless 运行态诚实**：意图开关（`audioProcessing.gapless`）与运行态分离。`PlaybackInfo` 上报 `gaplessActive` / `preloadReady` / `gaplessBlockedReason`（`disabled` | `dsd_path` | `typed_passthrough` | `crossfade` | `format_mismatch`，空串表示路径未阻塞）。EOF auto-next 与手动 `next()` 均优先 `skipToPreloaded`（不 reopen 设备）；失败再 `playQueueItem`。crossfade 关闭 true gapless。HiFi 展示 Active / Preload / Blocked 芯片。

共享文案常量：`HIFI_STATUS_COPY` / `gaplessRuntimeStatusCopy`（Unity / loudnorm / gapless 运行态）。

### Stage-2 输出采样率锁（HiFi outputStage）

- 采样率锁 / resampler / dither 只存在于 **DSP graph `outputStage`**（`targetSampleRate: 'device' | number`、`resamplerQuality`、`dither`、`safetyClamp`），**不**平行发明 `OutputConfig` 字段。
- HiFi 控制台「输出」页通过薄封装 `AudioEngineManager.setOutputStage(partial)` 改 default scene 的 `graph.outputStage` 并 `SetDspGraph`；DspRack 可继续编辑任意 scene 的同结构字段。
- `setAudioProcessing` / `persistAudioProcessingState` 重写 legacy graph 时必须 **保留** default scene 的既有 `outputStage`，避免经典处理设置抹掉采样率锁。
- 非 `device` 锁或非 native SRC / 非 off dither ⇒ 强制处理 ⇒ `outputPerfect=false`；UI 展示 target vs actual（`outputInfo.actualSampleRate`）。

### Stage-2 平衡/相位与库标签

- HiFi DSP 页暴露 `DspStereoImageConfig`：`balance` / `width` / mid-side / invert L|R / swap / mono；写入 default graph 的 stereoField + channelStrip polarity（`setStereoImage`），**不**平行发明第二套 OutputConfig。
- `createLegacyDspGraph` / `setAudioProcessing` 必须保留已有 `stereoImage`（与 `outputStage` 同级），避免经典处理重写抹掉 Rack/HiFi 立体声图像。
- 任一非默认立体声图像（balance≠0、width≠1、极性/互换/单声道）⇒ 处理启用 ⇒ `outputPerfect=false`；DSD 路径下与 EQ/RG 一样触发 PCM fallback。
- 本地库扫描（`scan.extractReplayGainTags`）持久化 ReplayGain track/album gain+peak 与 R128 track/album gain（Q7.8 启发式）；经 `prepareNativeQueue` / `AudioEngineQueueItem` / 原生 `QueueItem` 注入播放链路，覆盖 decode 缺标签场景；`track`/`album` 冷启动与 session restore 保留字段；`loudnorm` **永不**用库标签冒充测量。
- Loudnorm UI 状态：`prepareLoudnormForPlay` 发 `loudnorm-status`（measuring|cached|fallback|unavailable|idle），经 engineIpc → preload `onLoudnormStatus` → player store → HiFi 与 Settings 展示 `loudnormStatusCopy`。`setAudioProcessing` / `setReplayGainMode` 离开 loudnorm 立刻 cancel+idle；播放中切入 loudnorm 对当前 source 重新 prepare。`setReplayGainMode` 委托 `setAudioProcessing` 防双路径漂移。测量注入经 `LoadQueue` + `refreshQueueReplayGainTags` 叠到活跃/预加载流。destroy / 清缓存会 cancel 并重准备；异步回调在 stale 时丢弃。

## DSD 策略

Metadata 会识别 DSD 相关字段并报告 DSD64/128/256/512 级别。Renderer 展示优先消费 `outputInfo.isDsd` / `dsdMode` / `dsdRate` 表示当前 runtime 传输状态，顶层字段只做兼容镜像；当 DoP 运行时回退到 PCM 时，canonical mirror 必须清成 `isDsd=false`、`dsdMode='pcm'`、`dsdRate=0`，而源侧 DSD 标签可继续由文件元数据提供。

- DoP carrier：允许 DSF/DFF DSD64/128/256/512 在后端、设备、声道数和实际 PCM carrier 格式满足条件时进入 `dsdMode=dop`，遵循 dCS DoP open standard v1.1（24-bit、`0x05`/`0xFA` marker 交替）；carrier 速率 DSD64=176.4k、DSD128=352.8k、DSD256=705.6k（44.1k）/768k（48k）、DSD512=1411.2k（44.1k）/1536k（48k），上限从 DSD128 提升到 DSD512，运行时由设备 carrier-rate 能力门控（ASIO `dopCarrierSampleRates` 或 WASAPI/CoreAudio Exclusive `IsFormatSupported` 探测）。UI 展示 `DoP carrier`，不把它写成 PCM fallback。
- PCM fallback：DoP 条件不满足（含设备不支持 DSD256/512 carrier 速率），或软件音量、ReplayGain、Loudnorm、EQ、Convolver、Crossfeed、Crossfade 等处理启用时，实际链路回到 DSD 源 -> decoded PCM -> 后端 PCM 输出；UI 需要明确展示 fallback。
- DSD 域降速：`DsdDownrateProcessor` 在 decode/control 侧以固定 63-tap FIR 做低通，按 x2/x4/x8 抽取，再以有界一阶误差反馈重调制为 1-bit DSD。它支持 DSD512/256/128→256/128/64、44.1/48 kHz 家族、MSB/LSB 输入输出、跨任意 chunk 保持状态，并在 reset/seek 时清空 FIR/抽取/量化状态；process 不分配。`dsdRatePolicy=downrate` 在 source rate 的 Native/DoP 失败后按同 family 的低倍率候选重试，穷尽后 PCM fallback；`exact` 不允许 fallback，默认 `pcm-fallback` 保持兼容。输出报告 `actualDsdRate` 与 `dsdConversion`，降倍率标记 `dsd_downrated`、`sourceExact=false`、`resampled=true` 和 `outputPerfect=false`。真实 DAC 的高倍率与 48 kHz-family 验收仍是 REVIEW。
- Native DSD：支持 ASIO 与 ALSA `hw:`（`SND_PCM_FORMAT_DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送，rate = DSD bit-clock / phys_width，静音字节 `0x69`，格式顺序 U8→U32_LE→U16_LE，`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 开打开时 Candidate、首次成功 `writei` 后 Proven）。运行态证明为 `proven` 时可直接输出 DSD bitstream，否则回退 DoP 或 PCM。WASAPI 与 CoreAudio 没有 native DSD 通道（平台限制），走 DoP 或 PCM。
- SACD ISO：支持未压缩 DSD area 的曲目切片播放；DST 压缩曲目通过 DSD-preserving provider（vendored FFmpeg dstdec 算术核心，LGPL-2.1+，输出原始 DSD 字节）解出 DSD 后进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链。provider 默认可用；不可用时报告 `dst_dsd_provider_unavailable`，失败时报 `dst_dsd_provider_failed`，禁止把 FFmpeg PCM DST decode 包装成 Native DSD/DoP 成功。

## 已闭环

- SACD DST：通过 DSD-preserving provider（vendored FFmpeg dstdec，LGPL-2.1+，输出原始 DSD 字节）解出 DSD，进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链；provider 默认可用，`sacdIsoDst=true`、`sacdIsoDstMode="native"`、`sacdIsoDstDsdProvider=true`，DST 曲目 `playable=true`、`outputModes=["native","dop","pcm"]`。
- DoP DSD256/512：carrier 上限从 DSD128 提升到 DSD512，遵循 dCS DoP open standard v1.1，运行时由设备 carrier-rate 能力门控。
- ALSA native DSD：`hw:` 设备通过 `DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送 DSD，`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 开打开时 Candidate、首次成功 `writei` 后 Proven。
- 示波器视图：`GetVisualizationData` 新增 decoupled `oscilloscope` 时域采样（`oscilloscopePoints` 0-4096，默认 1024；0 表示关闭该 payload），独立于 `fftResolution`；PlayerBar 提供独立示波器子面板（canvas polyline、零交叉触发、`transition:none`）。`tapStatus/reason` 区分 stopped、disabled、no samples、native unavailable 与 synthetic fallback。
- Gapless 专业化：EOF auto-next 与手动 `next()` 均优先 `skipToPreloaded`（不 reopen 设备）；`PlaybackInfo` 上报 `gaplessActive` / `preloadReady` / `gaplessBlockedReason`（含 preload 失败 sticky `format_mismatch`）；HiFi 区分意图 ON 与 Active/Preload/Blocked。
- HiFi 输出采样率锁：控制台暴露 graph `outputStage`（target rate / SRC / dither）；`setOutputStage` 薄封装 + classic processing 保留锁。
- HiFi 平衡/相位：`DspStereoImageConfig`（balance/width/mid/side/invert L/R/swap/mono）写入 default graph 的 stereoField + channelStrip polarity；`setStereoImage` 薄封装；`setAudioProcessing` / `createLegacyDspGraph` 保留 `stereoImage`，避免经典设置抹掉 Rack 参数；任一非默认立体声图像 ⇒ `outputPerfect=false`。
- 库扫描 RG/R128：`scan.extractReplayGainTags` 持久化 `replayGainTrack/AlbumGainDb`、peaks 与 `r128Track/AlbumGainDb`（Q7.8 启发式 `|x|>64 → /256`）；track/album 冷启动可读标签；loudnorm 仍走离线测量缓存，不读库标签冒充测量。
- Loudnorm 硬化：隔离 analysis pool 默认并发 1、队列有界且 loudnorm 请求使用高优先级；identity 命中跳过重测、`cancel` 会终止对应 worker 且不写缓存、缓存上限 512（按 `analyzedAt` 淘汰）、Settings 可清空 Loudnorm 分析缓存。
- 产品诚实 smoke surfaces：`Loudnorm` / `Gapless Album` / `Unity Volume` 始终出现在 evidence 报告（默认 `not-run`），**不**计入 7 项硬件 `coverage.complete` 门禁。
- CoreAudio Hog Mode 加固：预检现有 hog owner、安装 device-lost listener、跟踪 IOProc underrun 诊断；ICoreAudioHost / MockCoreAudioHost seam 使 CoreAudio 后端逻辑可在 Windows 单元测试。
- ALSA 后端 seam：IAlsaHost / MockAlsaHost 使 ALSA 后端逻辑可在 Windows 单元测试（此前只能靠真实 Linux 硬件验证）。

## 平台限制（非代码缺口）

- WASAPI native DSD：Windows WASAPI 没有 UAC2 native DSD 通道；DoP 可在 WASAPI Exclusive 工作，native DSD 不行。
- CoreAudio native DSD：macOS CoreAudio 没有 DSD 通道；DoP 可在 CoreAudio Exclusive（Hog）工作，native DSD 不行。
- 真实设备 smoke（WASAPI Exclusive / ASIO PCM / DoP DAC / Native DSD / SACD ISO / CoreAudio Hog / ALSA `hw:`）通过 `TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1` 开启，opt-in，不进入默认 CI 门禁，不伪造结果；`pnpm run smoke:audio-evidence -- --input <evidence-envelope.json>` 或 `--input-dir <dir>` 将多台机器/多设备结果沉淀为可读 Markdown/JSON，并把缺失 surfaces 显示为 `not-run`。每个 `real-device` pass 必须提供固定采集元数据、存在的本地 artifact 和匹配 SHA-256；mock/未知来源不计入 complete。产品诚实 surfaces（Loudnorm / Gapless Album / Unity Volume）始终列出且不阻塞硬件 complete；发布前可手动加 `--require-complete` 做 opt-in 证据完整性检查。

## 后续顺序

1. 继续收口 ASIO、CoreAudio、ALSA 的 actual format、failure reason 与 opt-in smoke；WASAPI Exclusive 已增加真实设备多格式矩阵 smoke，并有 audio smoke evidence 报告工具沉淀结果。
2. 扩充真实音频 fixture 样本集；当前默认门禁覆盖 generated WAV/DSF，`TAE_AUDIO_FIXTURE_MANIFEST` 可指向外部 JSON 矩阵，`TAE_AUDIO_FIXTURES_DIR` 继续作为 MP3/FLAC/M4A/OGG/AAC/DSF/DFF 等外部小样本目录扫描 fallback。
3. 在 macOS/Linux 工具链与真实设备 smoke 通过后补平台产物路径和打包检查；WASAPI / CoreAudio 的 native DSD 属平台限制，不作为待补代码项。
