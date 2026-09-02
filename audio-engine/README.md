# Twilight Audio Engine

Twilight Echo 的 C++20 原生音频引擎，通过稳定 C ABI 和 Node-API 桥接给 Electron 使用。API 字段、outputPerfect 判定和 Recovery diagnostics 见 [docs/audio-engine-api.md](../docs/audio-engine-api.md)，阶段与架构约束见 [docs/twilight-audio-engine-architecture.md](../docs/twilight-audio-engine-architecture.md)。

## 当前状态

当前仓库已经包含：

- C ABI：`TAE_Play`、队列、DSP 配置、设备/后端枚举、`TAE_GetPlaybackInfo`、`TAE_GetVisualizationData`、`TAE_GetEngineCapabilities`、`TAE_GetLastError`。
- Node-API：薄桥接到 C ABI，返回 JSON，不承载播放策略。
- 解码与管线：FFmpeg 解码、Float32 内部渲染、环形缓冲、gapless preload、只读 visualization tap（含 decoupled 示波器时域采样）。
- DSD-preserving DST provider：vendored FFmpeg dstdec 算术核心（LGPL-2.1+，attribution 保留，未 relicense 为 Apache），输出原始 DSD 字节而非 PCM，接入 SACD ISO demuxer，使 DST 压缩曲目进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链。
- Queue：native 侧负责队列索引、upcoming track、EOF auto-next、gapless 预加载和 crossfade overlap mixing。
- 后端：WASAPI Shared/Exclusive、Windows x64 独立 ASIO 兼容层、CoreAudio/ALSA 源码后端；ASIO 默认枚举已安装驱动，可用 `TWILIGHT_DISABLE_ASIO=1` 显式禁用；ALSA `hw:` 支持 native DSD 直送（`DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE`），`backendCanAttemptNativeDsd("alsa")==true`；ICoreAudioHost / IAlsaHost seam + Mock 使 CoreAudio / ALSA 后端逻辑可在 Windows 单元测试。
- DSP：ReplayGain、Parametric EQ、FIR Convolver、Crossfeed、FFT Spectrum / Waveform / Peak / LUFS / Spectrogram / 示波器采样。
- Metadata：container、channel layout、channel count、DSD64/128/256/512 识别字段、ReplayGain/R128 字段。

Windows MinGW 验证命令：

- `pnpm run configure:audio-engine:mingw`
- `pnpm run build:audio-engine:mingw`
- `ctest --test-dir $env:TAE_MINGW_BUILD_DIR -N`
- `pnpm run test:audio-engine:mingw`
- `pnpm run typecheck`
- `pnpm run build`

无真实设备默认门禁：

```bash
pnpm run test:no-real-device
```

该脚本会串联 MinGW configure/build、native CTest、Electron manager 测试、typecheck 和前端 build。ASIO 驱动、真实 WASAPI Exclusive DAC、Native DSD、SACD ISO 播放和真实 DoP DAC smoke 都不进入默认门禁，通过 `TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1` 开启，不伪造结果。

## 构建目标

- `twilight_audio_engine`：共享 C 接口动态库，Windows 输出名为 `twilight-audio-engine.dll`。
- `twilight_audio_node`：Node-API 桥接模块，MinGW preset 默认启用。
- `twilight_audio_tests` 和相关单元测试：C ABI、DSP、metadata、bit-perfect evaluator、queue、backend factory、platform backend smoke、ASIO mock、CoreAudio mock、ALSA mock、output backend。

## Windows MinGW

推荐入口：

```powershell
$env:VCPKG_ROOT = 'C:\path\to\vcpkg'
$env:W64DEVKIT_ROOT = 'C:\path\to\w64devkit'
$env:TWILIGHT_GNU_PATCH = 'C:\Program Files\Git\usr\bin\patch.exe'
# 仓库路径含空白时必须设置；该目录必须可写且完整路径不含空白。
$env:TAE_MINGW_BUILD_DIR = 'C:\twilight-build\mingw-static'
pnpm run test:audio-toolchain
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
pnpm run test:audio-engine:mingw
ctest --test-dir $env:TAE_MINGW_BUILD_DIR -N
```

`configure:audio-engine:mingw` 由 `scripts/configure-audio-engine-mingw.cjs` 包装 CMake preset，处理两件事：

- 如果 vcpkg/FFmpeg 解压或 rename 遇到 `Access is denied` / `拒绝访问`，清理 `buildtrees/ffmpeg/src/*.tmp` 后重试 configure。
- configure 前验证 `VCPKG_ROOT`、`W64DEVKIT_ROOT`、x86_64 MinGW 编译器、Ninja 和 GNU `patch`；Git for Windows 的 `patch.exe` 会优先于 w64devkit 的 BusyBox 版本。未安装 Git 时设置 `TWILIGHT_GNU_PATCH`。
- 当仓库路径包含空白时，必须设置 `TAE_MINGW_BUILD_DIR` 到一个可写且完整路径不含空白的外部目录。配置、构建、CTest 和暂存都使用该目录，临时目录为 `$env:TAE_MINGW_BUILD_DIR\tmp`。
- 发现 CTest 注册仍指向移动前的构建目录，或 configure 后目标缺失时，会清理 CMake 配置缓存并重试。

生成并暂存的运行文件：

```text
$env:TAE_MINGW_BUILD_DIR/twilight-audio-engine.dll
$env:TAE_MINGW_BUILD_DIR/twilight_audio_node.node
resources/audio-engine/twilight-audio-engine.dll
resources/audio-engine/twilight_audio_node.node
resources/audio-engine/libstdc++-6.dll
resources/audio-engine/libgcc_s_seh-1.dll
resources/audio-engine/libmcfgthread-2.dll
```

`windows-mingw-static` 的 static 只针对 vcpkg triplet，libstdc++ / libgcc / mcfgthread 仍是动态链接，所以那三个运行时 DLL 必须和 `.node` 放在同一目录，否则任何没有装同款工具链的机器都会 dlopen 失败（表现为「未加载 twilight_audio_node.node」）。`stage:audio-engine` 会解析产物的 import table 自动补齐它们，来源优先取构建目录 `CMakeCache.txt` 里记录的编译器所在目录（必须与产物同源：PATH 上另一套 MinGW 的 libstdc++ 会导致 `The specified procedure could not be found`），其次是 `W64DEVKIT_ROOT`；也可用 `--runtime-dir` 或 `TAE_MINGW_RUNTIME_DIR` 指定。缺任何一个都会直接失败而不是暂存出一份不完整的运行时。

## 接口语义

`outputInfo` 是播放状态的 canonical 字段。顶层 `PlaybackInfo.actualBackend`、`actualSampleRate`、`latencyMs`、`sourceExact`、`outputPerfect`、`perfectReason`、`isDsd`、`dsdMode`、`dsdRate` 等字段只做镜像。

`sourceExact=true` 表示源文件级精确；`outputPerfect=true` 表示 decoded PCM 到设备实际输出之间没有额外处理或格式损伤。有损格式可达成 `outputPerfect=true`，但 `sourceExact=false`。`pcmPassthrough` 由 decoded PCM 与后端 actual output 精确比较；整数 PCM 源如果被转换到 Float32 管线再打包为整数输出，不能标记为 `outputPerfect=true`。

WASAPI Exclusive / ASIO 已具备 typed PCM passthrough 分支：当无 DSP、音量为 1.0、routing 不改变语义，且源 PCM 格式与后端实际输出格式完全一致时，FFmpeg decode、AudioBuffer 和后端 typed render 会按 Int16/Int24/Int32/Float32 直通，允许 `pcmPassthrough=true` / `outputPerfect=true`。如果源格式和设备实际格式不一致，或处理链需要 Float32，则继续报告 `integer_passthrough_unavailable` 或 `pcm_converted`，避免误报 bit-perfect。

`TAE_GetVisualizationData` / Node-API `GetVisualizationData` 返回只读可视化数据：`spectrum`、`waveform`、`peakDb`、`rmsDb`、`lufsMomentary`、`spectrogram`、`oscilloscope`、可选 `visualizerBars`、`sampleRate`、`active`、`tapStatus`、`reason`。`spectrumPoints` 支持 8-4096；播放页全屏可视化默认请求 4096 个频谱点，并在 UI 侧预聚合成 130 根 log-Hz 频谱柱后发送给 iframe。可视化采样器默认使用 8192 FFT，对齐 WebAudio `AnalyserNode` 参考页的 4096-bin 频谱；高频轮询时通过关闭 unused `spectrogram` / `oscilloscope` payload 和 iframe bars 模式避免阻塞渲染。`oscilloscope` 是与 `waveform` 解耦的独立时域采样数组，长度由 `oscilloscopePoints`（0-4096，默认 1024；0 表示不返回该 payload）决定，独立于 `fftResolution`，供 UI 做稳定波形触发与绘制。无播放采样时返回 inactive 空闲态；播放中 native tap 不可用时 main 可返回显式 `synthetic-fallback` 诊断 fallback；旧的 `TAE_GetSpectrumData` 保留兼容。

Phase 6B 中，后端只上报事实：WASAPI Shared 始终按系统混音路径报告 false；WASAPI Exclusive/ASIO 只有实际格式完整上报并与 decoded PCM 完全匹配时才进入 evaluator；CoreAudio 默认路径在 Hog/Exclusive 未验证前继续 false；ALSA `default` / `plughw:` 默认 false，只有显式 `hw:` 且格式匹配才可能 true。

`TAE_GetEngineCapabilities` 暴露 `backends` / `backendCapabilities`、`pcmPassthrough`、`outputPerfectRequiresPcmPassthrough`、`htmlAudioFallbackDefault` 和 DSD 能力模型（`sacdIsoDst`、`sacdIsoDstMode`、`sacdIsoDstDsdProvider`，provider 默认可用时分别为 `true` / `"native"` / `true`）。`TAE_GetLastError` 使用 buffer/required-size 模式返回稳定 JSON。

## Electron 集成

Electron 默认走 native engine。`src/main/audioEngineManager.ts` 会从开发构建目录、`resources/audio-engine` 和 packaged resources 查找 `twilight_audio_node.node`。

HTMLAudio 不再静默兜底；只有设置环境变量时才允许临时 Renderer 播放通道：

```powershell
$env:TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK="1"
```

未启用该变量时，native 播放失败会向 Renderer 返回明确错误原因。

## 当前非闭环范围

- ASIO 兼容层不携带 SDK，只在 Windows x64 构建中编译并默认启用；设置 `TWILIGHT_DISABLE_ASIO=1` 可停止枚举和激活驱动。
- 真实设备 smoke 是 opt-in；没有目标平台工具链或对应设备时跳过，不阻塞默认 CI。
- Crossfade 已进入 native float 渲染路径，能对预加载下一首做 overlap mixing，并在启用时稳定报告 `outputPerfect=false` / `perfectReasonCode=crossfade_active`。
- DSF/DFF DSD64/128/256/512 可进入 DoP carrier path（遵循 dCS DoP open standard v1.1，carrier 上限 DSD512，运行时由设备 carrier-rate 能力门控：ASIO `dopCarrierSampleRates` 或 WASAPI/CoreAudio Exclusive `IsFormatSupported` 探测），并在 UI 中展示 DSD 源到 `DoP carrier` 再到后端实际输出；DoP 是用 PCM carrier 承载 DSD bitstream，不等同于把 DSD 转成 PCM。
- DoP 条件不满足（含设备不支持 DSD256/512 carrier 速率），或软件音量、ReplayGain、EQ、Convolver、Crossfeed、Crossfade 等处理启用时走 PCM fallback，并在 UI 中展示 DSD 源到 PCM 输出链路。运行时若从 DoP 回退到 PCM，canonical `outputInfo.isDsd/dsdMode/dsdRate` 会清成当前 PCM 状态，顶层 `PlaybackInfo` 只做同值镜像。
- Native DSD 支持 ASIO 与 ALSA `hw:`（`DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送，rate = DSD bit-clock / phys_width，静音字节 `0x69`，格式顺序 U8→U32_LE→U16_LE，`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 开打开时 Candidate、首次成功 `writei` 后 Proven）；只有运行态 facts 证明为 `proven` 时才声明 `dsdMode=native`、`sourceExact=true` 和 `outputPerfect=true`，否则按 DoP、PCM 顺序回退。WASAPI 与 CoreAudio 没有 native DSD 通道（平台限制），走 DoP 或 PCM。
- SACD ISO 支持未压缩 DSD area 的曲目切片播放，并进入与 DSF/DFF 相同的 Native DSD -> DoP -> PCM 决策链；DST 压缩曲目通过 DSD-preserving provider（vendored FFmpeg dstdec，LGPL-2.1+，attribution 保留、未 relicense 为 Apache，输出原始 DSD 字节而非 PCM）解出 DSD 后进入同一决策链，provider 默认可用。provider 不可用时返回 `dst_dsd_provider_unavailable`，失败时返回 `dst_dsd_provider_failed`，不把 FFmpeg PCM DST decode 伪装成 Native DSD/DoP。
- Metadata 默认测试覆盖空 source、缺失文件 shape、generated DSF DSD64/128/256 和 SACD ISO `isoTracks`。FFmpeg decoder 默认测试通过生成 WAV/DSF fixture 覆盖 PCM/DSD shape；如设置 `TAE_AUDIO_FIXTURE_MANIFEST`，会读取外部 JSON 矩阵；如设置 `TAE_AUDIO_FIXTURES_DIR`，会额外扫描 MP3/FLAC/M4A/OGG/AAC 等真实小样本做 opt-in 解码 smoke，真实样本不作为默认门禁依赖。
- 外部格式矩阵 runner：`pnpm run smoke:audio-format-matrix -- --manifest "<matrix.json>" --json` 默认执行 metadata/assertion；加 `--playback --backend wasapi-exclusive --device "<device>"`、`--backend asio` 或 macOS Hog 的 `--backend coreaudio-exclusive` 可生成真实硬件 playback raw artifact。
- WASAPI 真实设备 smoke 可用 `pnpm run smoke:wasapi -- --device "M30" --buffer 256 --expect-bit-perfect --format-matrix` 跑多格式矩阵；矩阵只要求实际匹配格式 bit-perfect，不支持或被协商到其它格式的样本必须给出明确 non-perfect reason。
- 真实设备 smoke 结果可用 `pnpm run smoke:audio-evidence -- --input <evidence-envelope.json>` 或 `--input-dir <dir>` 汇总到 `output/audio-smoke-evidence/audio-smoke-evidence.md` 与 `.json`；报告固定列出 WASAPI Exclusive、ASIO PCM、DoP DAC、Native DSD、SACD ISO、CoreAudio Hog、ALSA `hw:`，未覆盖项显示为 `not-run`，JSON 写入 `coverage` 摘要和未闭环 surface 的 `actionPlan`。`coverage.complete` 只接受带固定采集字段、存在本地 artifact 与匹配 SHA-256 的 `real-device` pass；mock 与未知来源只验证逻辑，绝不计入硬件覆盖。发布前可手动加 `--require-complete`，证据不完整时退出非 0；该检查不进入默认 CI。
- macOS/Linux 后端需要对应平台工具链和真实设备 smoke 后才能声明发布级能力；CoreAudio / ALSA 后端逻辑已通过 ICoreAudioHost / IAlsaHost + Mock 在 Windows 单元测试覆盖，真实硬件 smoke 保持 opt-in（`TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1`），不伪造结果。
