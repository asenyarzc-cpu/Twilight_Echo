# ASIO DSD 直通行业调研（2026-08-27）

状态：调研结论与对照分析；含已落地的兼容性修复记录（修复①② + §5.3 UTF-8 路径根因修复 + §5.6 第三轮四项修复）。
范围：Windows 原生 DSD ASIO 直通、DoP、各 DAC 品牌驱动生态、foobar2000 生态的稳定性实现方式。

## 1. 结论

1. **不存在"各品牌统一的 ASIO 直通标准"。** 全行业只有两个正式标准：ASIO DSD 扩展（原生 DSD 唯一通道）与
   dCS DoP open standard（通用兜底）。品牌覆盖面不是来自标准，而是来自驱动市场的垄断格局：Thesycon
   TUSBAudio OEM 驱动覆盖了绝大多数主流台机 DAC 品牌，全部实现同一套 ASIO DSD 扩展。
2. **Thesycon 的原生 DSD 接口没有公开文档。** XMOS 官方论坛上开发者询问接口规范，XMOS 员工的答复是
   "没有文档，参考 foobar2000 的配置方式"。行业事实标准 = 对齐 foobar2000 与 Thesycon 的组合行为。
3. **foobar2000 "什么设备都能放" ≠ 处处原生直通。** 它来自三层优雅降级（原生 DSD → DoP → DSD→PCM 转换）
   加上第三方 ASIO 驱动的独立进程隔离（驱动崩溃/挂死只杀宿主进程）。稳定性是架构隔离与多年渐进加固的结果，
   不是不会崩，而是崩了也无感。
4. **公开开源世界里原生 DSD ASIO 宿主实现几乎为零。** camillaDSP 的 ASIO 后端明确拒绝 DSD 采样类型
   （其原生 DSD 仅存在于 Linux ALSA）；PortAudio/JUCE 不做 DSD；JRiver/HQPlayer/Audirvana/Roon 全闭源；
   `foo_out_asio+dsd` 只发布二进制。本项目的 clean-room 实现属于极少数，没有现成参考可对齐，这正是
   品牌适配困难的根本原因。

## 2. 标准盘点

### 2.1 ASIO DSD 扩展（原生 DSD 的唯一正式通道）

Steinberg 在 ASIO 2.2（2005，与 Sony 合作）引入、ASIO SDK 2.3 完善的定义，位于官方开源镜像
[audiosdk/asio](https://github.com/audiosdk/asio) 的 `common/asio.h` 注释中。本项目
`docs/legal/asio-interoperability-spec.md` 契约修订 2 的实现与官方定义逐项吻合：

| 项                               | 官方值                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| set/get/can-do I/O format 选择器 | `0x23111961` / `0x23111983` / `0x23112004`（经 `future()` 槽）                                        |
| `AsioIoFormat` 请求块            | 512 字节，`formatType` 为 int32 于偏移 0；PCM=`0`，DSD=`1`                                            |
| DSD 采样类型                     | `ASIOSTDSDInt8LSB1=32`、`ASIOSTDSDInt8MSB1=33`、`ASIOSTDSDInt8NER8=40`（1-bit 数据，每字节 8 个样本） |
| 采样率                           | 直接使用 DSD 位速率（DSD64=2822400），走标准 `setSampleRate`                                          |
| 切换时机                         | 必须在 prepared state（`createBuffers` 之前）完成                                                     |

缓冲区语义的官方表述存在歧义空间："8 samples per byte" + 采样率=位速率意味着 `getBufferSize`
的计数单位可以解读为 1-bit 样本（字节数 = size/8），而主流厂商驱动按打包字节组（每单位 8 个 DSD bit）
报告。两种解读相差 8 倍，这是品牌间行为分裂的主要来源之一（见 §5 修复②）。

论坛流传的厂商私有 DSD 采样类型码（如 `0x81660000` 一说）在官方 SDK 与公开代码中均无法证实，
搜索引擎摘要中出现过幻觉输出，不应作为实现依据。真实设备上遇到的非 32/33/40 通道类型值，
应以 `TAE_ASIO_TRACE_PATH` 追踪日志中的原始 `sampleType` 数值为准。

### 2.2 DoP open standard v1.1

[dCS/DSD-Guide 发布的开放标准](https://dsd-guide.com/dop-open-standard)：24bit 载波，最高字节
marker 按 `0x05`/`0xFA` 逐样本交替，同一样本内各声道 marker 相同。DSD64 载波 176.4kHz（48k 族
192kHz），DSD128→352.8/384k，DSD256→705.6/768k。与平台/驱动无关，是所有设备的通用兜底。
本项目 `decoder/DopPackerUtils.h` 已按 v1.1 实现并带运行时 marker 校验。

### 2.3 法律层面动态

Steinberg 已将 ASIO SDK 在 GitHub 以双许可（专有许可 或 GPLv3）开源。闭源商业项目使用 SDK 仍需签署
Steinberg 专有协议，因此本项目的 clean-room 策略维持不变；公共 `asio.h` 现在可作为合法的规范对照
来源（ABI manifest 校验已在做）。

## 3. 驱动生态格局

| 驱动栈                          | 覆盖品牌                                                                                               | DSD 支持                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Thesycon TUSBAudio（OEM）       | Topping、SMSL（部分）、Gustard、iFi、Holo、Singxer、Soncoz、E1DA 等，Audirvana 论坛称"99% 的 DAC 厂商" | ASIO 2.3.1 合规，原生 DSD64–DSD1024（仅 ASIO），DoP 走 ASIO+WDM                                   |
| XMOS 公版驱动                   | 部分 XMOS 方案设备                                                                                     | 原生 DSD 最高 DSD1024（仅 ASIO）                                                                  |
| FiiO 自研（"FiiO ASIO Driver"） | FiiO M 系列（USB DAC 模式）等                                                                          | 原生 DSD64/128 已实测（§5.1）；错误码非标准（-1000），DSD 切换要求设备独占（§5.1 多客户端格式锁） |
| Amanero / M2Tech / 自研         | Denafrips 等、Creative（"Creative SBX AE DSD ASIO"）等少数派                                           | 行为不统一，是品牌差异的重灾区                                                                    |

Thesycon 驱动更新记录中明写 "ASIO DSD mode supported, tested with Foobar"——驱动厂拿 foobar2000
当兼容基准，双方互相收敛。**验证矩阵建议**：优先一台 Thesycon 系设备（覆盖面最广）+ 一台 XMOS
公版驱动设备 + 一台 Amanero 设备，配合 `pnpm run smoke:asio-native-dsd` 收集
`nativeDsdNegotiation` 结果与追踪日志做横向对比。

## 4. foobar2000 稳定性的实现方式

以下结论经 `foo_out_asio+dsd` 0.4.7 组件包、`foo_input_sacd` 2.0.25 源码发行包（SourceForge 发布包内含
完整 `src/`）与 4 年 changelog 核实：

1. **优雅降级链（核心）。** 原生 DSD ASIO → DoP（任何 ≥176.4k/24bit 输出，包括 WASAPI；2.0.0 起
   DoP 打包移入 DSP 链，彻底与输出后端无关）→ DSD Processor 降速率 → 内置 DSD→PCM 转换。永远有
   声音，但用户看到的"直通"在多数设备上实际是 DoP 或 PCM。
2. **第三方驱动进程隔离。** `foo_out_asio+dsd` 组件内含 `ASIOhost32.exe` / `ASIOhost64.exe` 独立进程，
   命名管道通信；驱动挂死超 10 秒自动 minidump 并放弃，foobar 本体无恙。这是"夸张稳定性"的最大来源。
3. **多年渐进加固。** changelog 证据：半满才开播（0.4.5）、整块缓冲读取（0.4.4）、`outputReady()`
   语义处理（0.3.9）、DSD/PCM 分离传输流（0.3.3）、DSD1024+ 整数溢出修复（0.4.7）、x86 溢出修复
   （0.4.1）等。
4. **格式切换过渡处理。** `foo_input_sacd` 的 `transition_dsp` 在 DSD↔PCM 切换前后插入带正确 marker
   相位的 DoP 静音（可配秒数），避免 DAC 失锁爆音；DSD 静音字节可配置（默认 0x69，与本项目一致）。
5. **核心输出架构。** 格式变化一律重开输出设备（从不原地切换）；组件严格隔离。

## 5. 本项目对照与修复记录

已达标（与公开领域任何参考相比都更严谨）：future() 扩展协商（含 format-first/rate-first 双顺序与
PCM 状态恢复）、双成功码容忍、全通道 DSD 类型统一性校验、DoP marker 运行时校验、DSD idle 字节
（0x69/位反转）、能力缓存与 verbatim 传递策略。

### 修复①（已落地）：DSD I/O 格式切换后重新查询缓冲区范围

`AsioDriverSession::open` 原先在 `configureNativeDsd` 之前用 PCM 模式的 `getBufferSize` 范围选定
缓冲大小。真实设备案例（Steinberg 论坛，Mytek Brooklyn）：切换 DSD 后 `ASIOCreateBuffers` 返回
`ASE_InvalidParameter`，因为部分驱动在 DSD 模式下合法缓冲范围发生变化。现在切换成功后重新查询并
重选；重查失败或范围非法时保留 PCM 模式值（保守兼容已验证品牌）。契约见
`docs/legal/asio-interoperability-spec.md` 修订 3；fake driver 新增 `DsdBufferSizeRange` 模式覆盖该
行为（`test:asio-cross-abi`）。

### 修复②（已落地）：DSD 缓冲单位/回调节奏诊断

DSD 模式下 `getBufferSize` 的计数单位存在两种解读（打包字节组 vs 1-bit 样本，相差 8 倍），二者在
真实驱动中并存。本项目按打包字节组模型写入（每帧 1 字节）。若驱动按 1-bit 样本计数，写入会 8 倍
溢出（Stack Overflow 上 Creative DSD ASIO 驱动的 heap corruption 即此症状）。现在渲染回调会以实测
回调间隔对照预测周期（两种解读相差恰为 8 倍，判定区间无重叠），连续命中 1-bit 样本节奏时置
`native_dsd_buffer_unit_mismatch` 并将运行时事实降级为 Mismatch——按本项目的直通纪律，宁可如实
报告失败也不继续可能越界的写入。该检测纯为诊断与如实报告，不做中途单位切换（无真机验证前风险
不可控）。

### 5.1 FiiO M Series 真机验证（2026-08-27）

首个真机原生 DSD 直通证据，设备为 FiiO M Series（USB DAC 模式，"FiiO ASIO Driver"）。证据
artifact：`output/audio-smoke-evidence/native-dsd.json`（协商追踪
`native-dsd-fiio-m-series-trace.log`），报告面 `Native DSD = pass`。结果（含复跑验证）：

- DSD64（2822400）与 DSD128（5644800）均 `nativeDsdRuntimeState=proven`、`outputPerfect=true`、
  零 underrun；协商顺序 `format-first-confirmed`；线格式 MSB1（type 33），首缓冲 idle 字节
  0x96（0x69 位反转）吻合；回调节奏为打包字节组模型（无 `native_dsd_buffer_unit_mismatch`），
  修复②的检测在真机上正确保持静默。
- **修复①在真机上直接生效**：该驱动的缓冲范围按模式与速率变化——PCM 64–16384、DSD64
  512–131072、DSD128 1024–262144。请求值 256 在 DSD 模式下低于最小值，重查逻辑正确钳位到
  512/1024 后 `createBuffers` 成功。若无重查，此设备会因缓冲范围差异在 createBuffers 处失败，
  进而被永久归类为"不支持原生 DSD"并静默降级 DoP——这正是"只有少数品牌能直通"的一类真实机制。
- **多客户端格式锁（已证实，曾误读为"冷热状态"）**：`CanDoIoFormat(DSD)` 返回成功但
  `SetIoFormat(DSD)` 被拒（非标准错误码 `-1000`）、`setSampleRate(DSD 速率)` 返回 `-995` 的组合，
  在这台设备上唯一已证实的原因是**另一个音频客户端持有设备**（多客户端 PCM/DoP 可共存，但格式
  切换要求独占）。当日完整时间线复盘：播放器实例占用→首次 smoke 被拒；实例关闭→连续三次原生
  直通成功；dev 测试期间另一路设备测试并发运行→dev 内原生被拒降级 DoP；dev 实例留存→后续
  smoke 全被拒；结束全部 Electron 进程后**第一次 format-first 尝试即成功**。曾据此误建
  "设备冷热状态"模型并实现预热重试（速率设置、400ms DoP 静音流两个版本均无效——与该模型
  矛盾的实测正是证伪点），已全部移除。当前处理：协商失败文本在 CanDo 成功但 Set 被拒时
  明确提示"设备可能被其他音频客户端占用"（契约修订 3 附注）。操作纪律：**对这类驱动一次只
  允许一个客户端使用 DAC**。

### 5.2 扩展证据面

同日以同一台设备补齐证据面，报告升至 **3/5**（`output/audio-smoke-evidence/`）：

- **ASIO PCM**（`asio-pcm.json`）：44.1/16、48/24、96/24、176.4/24 全部播放成功零 underrun；
  176.4k/24 bit-perfect（int24-in-32），其余以 int32 输出并带
  `integer_passthrough_unavailable` 明确 reason。
- **DoP DAC**（`dop-dac.json`）：DSD64→176.4k 载波、DSD128→352.8k 载波，`dsdMode=dop` +
  `outputPerfect=true`（int24-in-32）。请求 WASAPI Exclusive 时引擎因端点无 DSD 能力自动改道
  ASIO 承载 DoP（`dsdRouteOverrideActive` 路由），输出事实如实记录 `actualBackend=asio`。

### 5.3 dev 应用无法直通的根因：UTF-8 路径 × ANSI 代码页（已修复，2026-08-27）

dev 复测三次"无法直通、2822.4kHz 被降到 176.4kHz、提示 DoP 未能证明直通"。给 `AudioPipeline`
加上 env 门控的 `DSD route decision` 决策追踪（`TAE_ASIO_TRACE_PATH`）后，六次决策全部
`dsdRate=0`，而音量/速率/模式/路由全部正确——唯一阻断门是管线播放前的 DSD 探测（`DsdReader`
probe）根本没打开文件。

- **根因**：引擎自研文件读取全部用窄字符 `std::ifstream`，Windows 按 ANSI 代码页（本机
  936/GBK）解释字节；Node/Electron 传入的是 UTF-8。曲库中唯一 DSD 文件 `04.你的眼神.dff`
  的中文文件名字节在 GBK 下无法打开 → 探测失败 → 原生 DSD 与 DoP 双双跳过 → ffmpeg PCM 兜底。
  ffmpeg 内部自行做 UTF-8→宽字符转换，所以 PCM 能播、GetMetadata 也正常——"PCM 正常但
  直通全无"正是这类路径问题的指纹，也一度误导排查指向"DFF 解析缺陷"（对照实验证明 DFF
  chunk 解析本身正确，夹具与真实文件结构一致）。
- **机理实验**（CP936 实测）：同一中文路径文件，窄字符 `ifstream` open FAIL，
  `std::filesystem::path` open OK——`core/Utf8Path.h` 的 `utf8Path()` 即按此修复，
  `DsdReader`、`SacdIsoProbe`、`SacdIsoDemuxer`、`ConvolverProcessor`（IR 文件）、
  `Vst3Runtime`（状态文件与 `file_size`）全部改经 path 打开。回归测试
  `testDffReaderOpensNonAsciiUtf8Path`（中文文件名 DFF）入库。
- **端到端验证**（无需 DAC，板载 WASAPI）：真实 `04.你的眼神.dff` 决策行变为
  `dsdRate=64 probeError=`（空），DSF 对照一致。
- **reason 误归因顺带修复**：探测失败与"后端不能承载"（如 WASAPI 共享模式无法位精确传输）
  两种情况此前都会命中 `dop_passthrough_unproven` 文案（"DoP 未能证明直通"），把用户引向
  传输层而不是真正原因。新增 `dsd_probe_failed`、`dsd_backend_cannot_carry` 两个 reason
  code（登记三处），管线原因文本同步区分。
- 设备重连后复测预期：asio + FiiO 下决策行应出现 `canTryNativeDsd=1` 并进入原生直通
  （设备空闲态的无头真机测试已 100% 稳定，见 §5.1）。

### 5.4 开源 ASIO 主机稳定性对照（2026-08-27 补充调研）

逐一核对了 JUCE（`juce_ASIO_windows.cpp`）、PortAudio（`pa_asio.cpp`）、RtAudio（`__WINDOWS_ASIO__` 段）
与 Steinberg SDK 2.3.4 hostsample 的一手源码（缓存于 `%TEMP%\dsdres\`），与本项目
`AsioDriverSession` 对照：

**已对齐的稳定性模式**（无需改动）：

- 缓冲选择三分支（granularity==0 任意值 / >0 取整倍数 / -1 取 2 的幂最近邻，外加 preferred 出界
  钳制）与 RtAudio 规则一致，且比它多处理"preferred 谎报"。
- `kAsioResetRequest`/`kAsioResyncRequest`/`sampleRateDidChange` 全部只置事件标志，由控制线程在
  安全时点重建——SDK 原文明确禁止在 asioMessage 回调内卸载驱动；`kAsioOverload`/
  `kAsioLatenciesChanged` 仅记 xrun 不重建（JUCE 曾因这两者触发 500ms 重建造成自伤性断音）。
- `outputReady()` 探测 + 回调尾调用；DSD `future(kAsioSetIoFormat)` 先于 `createBuffers`、成功判
  `ASE_SUCCESS`（0x3F4847A0）双成功码——FiiO 真机已验证（§5.1）。
- DSD 切换后重查缓冲范围（修复①）本身就是 JUCE/PA "createBuffers 失败回退 preferred" 的前置版。

**与参考实现的差距（2026-08-27 第二轮：前四项已落地，全部有源码断言测试 + 28/28 门禁）**：

1. ~~`createBuffers` 失败后未用 preferred 值重试~~ **已落地**（JUCE L490-503 / PortAudio
   L2290-2314 / RtAudio L3841-3849 三家独立结论：谎报 min/preferred/max 的驱动必须留 preferred
   兜底，点名 Hoontech DSP24 与 Creative）。实现含 `IAsioHost::activeBufferSize()` 新接口，
   重试生效后 backend 的渲染 scratch、回调节奏与 `outputInfo_.bufferSizeFrames` 全部改按
   驱动实收尺寸（否则按旧尺寸分配就是越界隐患）。
2. ~~DoP 能力探测补 48k 族载波~~ **已落地**（探测循环从 3 个速率扩到 8 个，与
   `dopCarrierFormatForDsd` 的载波表完全对齐：176400/192000/352800/384000/705600/768000/
   1411200/1536000）。管线本就支持 48k 族源走 48k 族载波，此前只是能力展示层低报。
3. ~~JUCE 式 `setSampleRate` 后重查 `getChannels`~~ **已落地**（JUCE L458-460 原注释
   "a sample rate change affected the channel count"；重读失败不致命，只在成功且通道数
   缩到装不下请求时按 Format 拒绝）。
4. ~~"仅当速率不同才 setSampleRate"~~ **已落地**（PortAudio `ValidateAndSetSampleRate` /
   RtAudio 同款：先 `getSampleRate` 比对，已一致则跳过 can/set——冗余 setSampleRate 会打扰
   部分驱动，并在多客户端设备上重新触发独占格式仲裁，正是 §5.1 FiiO 格式锁的暴露面之一）。
5. 按驱动名 quirk 表（JUCE 对 Digidesign "动态改缓冲会崩"强制 preferred 的先例），以
   `TAE_ASIO_TRACE_PATH` 遥测积累数据。
6. ~~JUCE 初始化期"Cubase 舞步"~~ **已落地**（代码核对 2026-08-28，文档此前漏勾）：`createBuffers`
   失败 → preferred 重试失败后的最后兜底——dummy 2ch buffers → start → 80ms → stop → dispose →
   再试真实 createBuffers。仅失败路径触发，健康驱动不付 80ms；`danceInProgress` 标志保证 dummy
   回调既不进渲染管线也不触发 buffer-failure 事件。
7. JUCE 用 SEH 包 `CoCreateInstance` 防驱动加载期崩溃（我们由 utilityProcess 进程隔离承担
   同等职责，优先级降低）。
8. ~~DST 压缩 DFF~~ **已落地**（2026-08-27 第三轮）：`openDff` 接受 FRM8 `'DST '` form 与
   CMPR `"DST "` 标记，DST 声块内解析 FRTE 帧率 + DSTF 帧表（DSTC/DSTI 跳过），按帧经
   DSD-preserving provider 解出 DSD（MSB-first 交织，同 SACD 路径契约）；seek 按帧索引
   （1/75s 粒度）。管线播放前探测同样接有 provider——顺带修复了"探针无 provider 导致
   DST SACD 音轨永远进不了 DSD 路由"的潜在缺陷。真 dstdec 未压缩帧逐字节直通 + 帧表
   seek + 无 provider 拒绝三组测试入库；端到端合成 DST DFF 探测 `dsdRate=64`。

**DSDIFF 解析对照**：MPD / foo_input_sacd 交叉验证本项目 `openDff` 的字段语义全部正确（FS 为单个
u32BE、CHNL u16BE+通道 ID、奇数块补 pad、FRM8 size 覆盖全部子块、大端）。本项目 PCM 兜底对 .dff
走 FFmpeg 的 **IFF demuxer**（`libavformat/iff.c`，日志特征 `[iff @ ...]`；网络调研曾误报"FFmpeg
无 DFF 支持"，实为漏查该文件——`libavformat/dsfdec.c` 只是 DSF）。

**控制线程架构对照**（调研关键发现，本项目已达标）：ASIO 要求 init 所在线程持有 COM STA 且泵
消息——驱动用 sysRef 窗口 PostMessage 与自己通信，无消息泵则"init 成功但 start 挂死"（RME
Fireface UFX 实证）。本项目 `AsioControlThread` 完整实现最佳实践：`COINIT_APARTMENTTHREADED` +
隐藏 `HWND_MESSAGE` 窗口作 `init(sysRef)` + 循环内 Peek/Dispatch 泵 + ASIO 全生命周期钉在该
线程 + 卡死 3 秒超时泄漏策略——即调研报告归纳的"C++20 宿主最小纪律"全文。

### 5.5 商业播放器对照（2026-08-27 第二轮调研）

基于 foobar2000（官方 wiki/changelog/组件页）、foo_out_asio+dsd（29 个发布版逐版变更）、
HQPlayer（Miska 本人在 Audiophile Style/Roon 论坛的发言）、JRiver（官方 wiki 存档）、Audirvana
（官方社区支持帖）与 Thesycon TUSBAudio（官方能力页 + 流出 revision history）的公开资料交叉归纳：

**本项目已与行业收敛点对齐**：

- **格式变化 = 关闭-重开，绝不在 prepared 流上原地换格式**。没有任何一家公开文档声称对同一打开
  的 ASIO 流原地 setSampleRate 换 PCM↔DSD；SDK 注释明确 IoFormat 切换须在 createBuffers 之前。
  本项目每次播放新开会话、configureNativeDsd 在 createBuffers 前完成、恢复/重建走全量
  stop→close→open——与 foo 内置输出"重建输出链"、`kAsioResetRequest`→`ASIO_Exit/Init` 官方
  语义一致。foo_out_asio+dsd v0.3.3 的"DSD 与 PCM 分离传输流"是同一原则的另一形态。
- **utilityProcess 进程隔离 = foobar 的 ASIOhost 外置进程**。Peter Pawlowski 的架构答案就是
  "卡死驱动杀宿主进程重启"（2.2.4 起自动终止改为可选）；本项目引擎已跑在 utilityProcess，
  `audio-service-crash` 恢复链路等价。
- **DSD 静音字节/切换过渡**：sacd 插件 2.x 把"DSD silence byte and transition settings"做成
  可配置项、Audirvana 有官方 "Mute during sample rate change" + 切换附加延迟——行业确证切换点
  静音是标配。本项目首缓冲 idle 字节（FiiO 实测 0x96）已实现其核心，可配置化列入候选。
- **速率族纪律**：HQPlayer 默认"48k DSD 关、Adaptive 关、rate limit 锁 44.1k 族"（Miska：
  "大多数 DAC 不支持 48k 倍数的 DSD"）；Chord TT2 噪声案例最终靠切回 44.1k 族解决。本项目
  DoP 载波按源的速率族选择 + 探测双族（§5.4 已落地）与该纪律一致。
- **多客户端抢设备**：HQPlayer NAA 掉线主因是"第三方抢走设备拿不回来"——与本项目 §5.1 FiiO
  多客户端格式锁同构；行业答案（单客户端纪律 + 如实提示）与本项目当前处理一致。

**新识别的候选（按价值排序）**：

- **切换点可配置过渡**（Audirvana/sacd 2.x 先例）：把现有 DSD idle 字节与 DoP marker 相位基础
  设施暴露为设置项（静音字节数/过渡时长），覆盖"切换瞬间 plop"的用户反馈面。**未实施**（idle
  字节 0x69/0x96 与 marker 相位基础设施已就绪，仅差设置面暴露）。
- ~~**预填充启动**~~ **已覆盖**（代码核对 2026-08-28）：ASIO 后端 start 前 双缓冲组按 DSD idle
  字节/PCM 静音预填（native DSD 收敛到 §5.6 的探测单位），WASAPI 独占同样有预填充 + DoP 无
  SILENT 标记提交，管线另有 `waitForPreroll` 启动闸——与 foo_out_asio+dsd v0.4.5 "半满才开播"
  的核心等价；"可配置预填深度"仍属可选增强。
- ~~**xrun 风暴时自动加大驱动缓冲**~~ **已按 BufferFailure 形态落地**：`AsioBackend::recover`
  对缓冲几何类故障的每次重试按 ×4 阶梯放大缓冲并钳到 `maxBufferSize`（JRiver 自动阶梯）；
  Overload/LatenciesChanged 类 xrun 维持"只计数不重建"（§5.4 已论证重建是自伤）。
- **控制/渲染线程优先级**（Peter："hack ASIOhost 设实时优先级"）：Windows 下对 ASIO 控制线程
  尝试 `THREAD_PRIORITY_TIME_CRITICAL`（含降级容错），高负载场景减少断续。**未实施**；WASAPI
  侧渲染线程已用 MMCSS "Pro Audio"（`AvSetMmThreadCharacteristicsW`），ASIO 实时回调跑在驱动
  自有线程上，宿主侧可做的主要是控制线程优先级，收益有限。
- **应用级缓冲默认值审视**：foobar 默认 1s 应用缓冲叠加设备缓冲、JRiver 建议 device buffering
  ~500ms；对照本项目解码预读深度确认默认值在高负载下的余量。**未做**（评估类任务）。

### 5.6 第三轮修复（2026-08-28）：载波误判、单位自适应、rate-only 驱动、48k 族速率

本轮为独立代码审查（对照 §2.1 官方 asio.h 注释与 §5.4/§5.5 已收敛点）发现并落地的四项缺陷修复，
全部有源码断言/纯函数单测入库：

1. **DoP 载波形状误判破坏 24bit 高采样率 PCM（严重）。** `isDopCarrierFormat` 按"速率 + 24bit +
   int24/int24-in32"形状嗅探，把 176.4k/192k/352.8k/384k/705.6k/768k 的**普通 PCM**也判成 DoP
   载波。`renderTyped` 据此无条件调用 `finalizeDopCarrier`，把每个样本的最高字节覆写为 0x05/0xFA
   交替标记——24/192 FLAC 等 typed-passthrough 曲目直接变成超声噪声；停止/失配分支还会把"静音"
   写成标记字节（DAC 输出蜂鸣而非静音）。WASAPI 协商器同类误判还会把这类 PCM 标注为
   `dsd_dop` 传输并误报 `resampled`。**修复**：管线以自身 DSD 路由标志
   （`renderDopPathActive_` / `renderNativeDsdPathActive_` / `renderPcmToDsdPathActive_`）作为
   标记/空闲字节写入的唯一授权信号（`dsdTransportActive`）；普通 PCM 分支纠偏
   `dsdTransport`/`semanticSampleRate`/`resampled`/`dsd_dop` 标签。DoP 本身的协商端嗅探保持不变
   （管线只会为真实 DSD 源请求载波形状，协商结果不受影响）。
2. **修复②升级：从"检测后失败"到"保守探测 + 确认后自适应"。** 原实现连续 4 个回调命中
   1-bit 样本节奏才置 `native_dsd_buffer_unit_mismatch` 并降级 PCM——但此时预填充 + 4 个回调
   已按全尺寸写入，"不继续可能越界的写入"的纪律实际并未达成（Creative heap corruption 案例
   的写穿发生在检测之前）。**新实现**：Native DSD 的一切写入（预填充、typed 块、空闲填充）从
   `bufferSize/8` 打包字节组的保守探询单元起步——该单元对"打包字节组"与"1-bit 样本"两种计数
   都不会越界；节奏确认 ByteFrames 后扩展到全尺寸（主流 Thesycon 类驱动的代价是首 1-2 个回调
   的部分填充窗口，约 6-12ms），确认 BitSamples 后保持保守单元并把运行时事实备注为
   adapted（状态保持 Proven，管线不再降级 PCM）。deadline 账目在确认 BitSamples 后按实际
   单元计算，探测期沿用字节组口径（bit-sample 驱动实际间隔更短，不产生假 underrun）。
   纯函数状态机 `advanceDsdRenderUnitProbe` 入 `AsioRenderUtils.h` 并单测。
3. **rate-only 第三协商顺序。** Amanero 时代的 USB 驱动家族从未实现 IoFormat futures，仅凭
   语义 DSD 采样率切换通道类型；此前这类驱动在 format-first 与 rate-first 双双失败后被永久
   判为"不支持原生 DSD"。新增第三顺序：仅 `setSampleRate(DSD 速率)`，由 open() 既有的
   getChannelInfo DSD 类型校验做真实性证明（驱动不理会速率时在那里失败并恢复），失败文案
   三个顺序齐报。
4. **WASAPI 协商器补 48k 族原生 DSD 速率。** `dopCarrierRateForSource` 此前只认 44.1k 族原始
   DSD 速率（2822400/5644800/…），3072000/6144000（48k 族 DSD64/128）返回 0；管线虽预计算
   载波规避了主路径，但协商器独立收到原始速率时（含失败文案）会误报"无可用 DoP carrier"。
5. 顺带修复：`native_dsd_typed_callback_missing` 诊断在正常瞬态饥饿（typed 回调返回 0）时被
   永久置位——现在仅在 typed 路径结构性缺失（会话快照判定）时置位。
6. **WASAPI 独占 DoP 被"未能证明直通"误报（2026-08-28 真机诊断包定位，ONIX XI1 + DSD128
   DSF 案例根因）。** 诊断包证据：`dsd_route_engaged mode=dop rate=352800`、零 underrun、
   `firstBufferSummary` marker 全部有效（`startMarkerValid=true markerInvalid=0
channelMarkerMismatch=0`）——**直通实际已成功**，但评估层三处叠加把它判为
   `dop_passthrough_unproven` + RESAMPLED 徽章：(a) 协商器 `sameSourceFormat` 对一切
   DoP 载波形状的请求硬编码 `return false`，`resampled=true` 直接进入
   `dopPassthroughProven = … && !backendResampled`（`updatePerfectLocked`），让 WASAPI
   独占的 DoP **在任何设备上都不可能被判 output-perfect**；(b) 后端从未把首缓冲 marker
   实测回填 `dopRuntimeFacts`/`diagnostics.dopRuntimeEvidence`（UI 自己都写着"只是缺少
   证据"）；(c) `evaluatePerfect` 的 `result.resampled = backendResampled || …` 把错误
   标志放大成 RESAMPLED 徽章。**修复**：协商器按"接受的候选是否等于该源期望的载波
   （`dopCarrierRateForSource` 换算）+ int24 载波族"判定 resampled（原始 DSD 速率与载波
   形状两种请求形态都覆盖）；`dopRuntimeFacts()` 折叠首缓冲 marker 观察（有效 → Proven
   附证据文案，无效 → 降级 Mismatch，镜像 ASIO 后端的 marker 判定）；`outputInfo()`
   回填 `diagnostics.dopRuntimeEvidence`。修复后该案例六项条件全部满足，应报告
   `outputPerfect=true / sourceExact=true`。回归测试
   `testDopCarrierIsNotReportedAsResampled`（行为）与
   `testWasapiExclusiveDopRuntimeFactsFoldMarkerEvidence`（断言）入库。

### 后续候选（未实施）

（§5.4/§5.5 已给出按价值排序且经代码级/商业级对照的完整差距清单，此处保留原始条目）

- ~~DoP 能力探测补 48k 族载波~~（已于 §5.4 落地，探测集扩至 8 个双族载波）。
- DSD 降速率层（DSD512→256→…→64 再落 PCM），对应 foo DSD Processor 的角色，让更多设备停留在
  DSD 域。
- DSD↔PCM 切换点的"DoP 静音过渡带"（复用现有 marker 相位基础设施 `renderDopMarkerIndex_`；
  §5.5：Audirvana/sacd 2.x 已把同类机制做成官方配置项，行业确证）。
- 第三方 ASIO 驱动进程隔离（foo 的 ASIOhost 模式；本项目已有专用控制线程 + 卡死泄漏策略与
  utilityProcess 基建，是"无论什么设备都稳"的架构级答案）。
- 按驱动建立 quirk 表：以失败路径的原始 `sampleType`、DSD 模式缓冲范围、实测回调节奏三类遥测
  积累数据（`TAE_ASIO_TRACE_PATH` 追踪已具备）。

## 6. 参考来源

- [audiosdk/asio 官方 SDK 开源镜像](https://github.com/audiosdk/asio)（`common/asio.h` 的 DSD 扩展
  原始注释与双许可 LICENSE）
- [DoP open standard](https://dsd-guide.com/dop-open-standard)
- [Thesycon TUSBAudio USB Audio 2.0 Class Driver](https://www.thesycon.de/eng/usb_audiodriver.shtml)
- [Super Audio CD Decoder / foo_out_asio+dsd 发布页](https://sourceforge.net/projects/sacddecoder/files/foo_out_asio+dsd/)
  与 [foo_input_sacd](https://sourceforge.net/projects/sacddecoder/files/foo_input_sacd/)（源码发行包）
- [XMOS 论坛：Native DSD & Windows ASIO Driver interface](https://www.xcore.com/viewtopic.php?t=4953)
  （Thesycon DSD 接口无文档、"参考 foobar2000"的官方答复）
- [Steinberg 论坛：ASIO hostsample DSD mode problem](https://forums.steinberg.net/t/asio-sdk-hostsample-dsd-mode-problem/97092)
  （Mytek Brooklyn：DSD 切换后 createBuffers 失败的真实案例，修复①依据）
- [Stack Overflow：Creating an ASIO DSD Player](https://stackoverflow.com/questions/52774883/creating-an-asio-dsd-player)
  （Creative DSD ASIO 驱动：DSD 写入 heap corruption 的真实案例，修复②依据）
- [JRiver Wiki: DSD](https://wiki.jriver.com/index.php/DSD)、[iFi: DoP versus ASIO Native](https://downloads.ifi-audio.com/faqs/dop-versus-asio-native-what-are-the-differences-similarities/)
- [camillaDSP](https://github.com/HEnquist/camilladsp)（ASIO 后端拒绝 DSD 采样类型的反面例证）
- §5.4 DSDIFF/开源对照（2026-08-27，一手源码逐行核对，缓存 `%TEMP%\dsdres\`）：
  [MPD DsdiffDecoderPlugin.cxx](https://github.com/MusicPlayerDaemon/MPD/blob/master/src/decoder/plugins/DsdiffDecoderPlugin.cxx)、
  [foo_input_sacd sacd_dsdiff.cpp](https://github.com/ocean-feng/foobar_input_sacd/blob/master/src/foo_input_sacd/sacd_dsdiff.cpp)
  （唯一同时支持 DST 的主流开源 DFF 实现）、[cladst](https://github.com/KyokoMiki/cladst)（Rust DFF/DST）、
  [DSDIFF 1.5 官方规范扫描版](https://dsd-guide.com/sites/default/files/white-papers/DSDIFF_1.5_Spec.pdf)、
  [FlexASIO issue 区（多客户端/独占行为长尾知识库）](https://github.com/dechamps/FlexASIO)
- §5.4/§5.5 代码级源码快照（JUCE@7aae7d8 / PortAudio@a880212 / RtAudio@521fcab，行号定位见正文）：
  [juce_ASIO_windows.cpp](https://github.com/juce-framework/JUCE/blob/master/modules/juce_audio_devices/native/juce_ASIO_windows.cpp)、
  [pa_asio.cpp](https://github.com/PortAudio/portaudio/blob/master/src/hostapi/asio/pa_asio.cpp)、
  [RtAudio.cpp](https://github.com/thestk/RtAudio/blob/master/RtAudio.cpp)、
  [audiosdk/asio asio.h（DSD 扩展原始注释）](https://github.com/audiosdk/asio/blob/master/common/asio.h)
- §5.5 商业播放器对照（2026-08-27，全部官方/本人发言来源）：
  [foobar2000 Preferences:Output wiki](https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Preferences:Output)、
  [foo_out_asio 组件页](https://www.foobar2000.org/components/view/foo_out_asio)、
  [foo_out_asio+dsd readme（命名管道/分离传输流/半满预填充逐版变更）](https://master.dl.sourceforge.net/project/sacddecoder/foo_out_asio%2Bdsd/readme.txt?viasf=1)、
  [HQPlayer 桌面版](https://signalyst.com/hqplayer-desktop/)（Miska 关于 48k DSD/Adaptive 的论坛发言见 §5.5 内联）、
  [JRiver WASAPI Event Style wiki 存档](https://web.archive.org/web/2023/https://wiki.jriver.com/index.php/WASAPI_Event_Style)、
  [JRiver DSD wiki 存档（DoP Format 0xAA 兼容开关）](https://web.archive.org/web/2023/https://wiki.jriver.com/index.php/DSD)、
  [Audirvana "Mute during sample rate change" 支持帖](https://community.audirvana.com/t/two-loud-pops/47190)、
  [Thesycon TUSBAudio 能力页与 revision history](https://www.thesycon.de/eng/usb_audiodriver.shtml)。
- §5.4 代码级源码快照（JUCE@7aae7d8 / PortAudio@a880212 / RtAudio@521fcab，行号定位见正文；本地缓存 `%TEMP%\dsdres\`）：
  [juce_ASIO_windows.cpp](https://github.com/juce-framework/JUCE/blob/master/modules/juce_audio_devices/native/juce_ASIO_windows.cpp)、
  [pa_asio.cpp](https://github.com/PortAudio/portaudio/blob/master/src/hostapi/asio/pa_asio.cpp)、
  [RtAudio.cpp](https://github.com/thestk/RtAudio/blob/master/RtAudio.cpp)、
  [audiosdk/asio asio.h（DSD 扩展原始注释）](https://github.com/audiosdk/asio/blob/master/common/asio.h)。
