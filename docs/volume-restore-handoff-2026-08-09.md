# 音量重启恢复问题 — 交接文档（2026-08-09）

> 状态：**已解决**（用户确认“现在修好了”）。本文档保留完整排查过程、证据与修复清单，供后续回归/评审参考。
> 最终结论：问题由两个独立缺陷叠加导致——(1) 渲染层防抖持久化在隐藏主窗口（小窗模式）下被 Chromium 定时器节流，音量从未写盘；(2) 启动恢复路径在路由恢复失败时会跳过音量恢复，且 setVolume 去重守卫吞掉后续推送。均已修复并验证；另加播放后重发音量兜底。

## 1. 用户报告的症状

- 用户原话（时间顺序）：
  - “音量记忆有了，但是他的响度每次之后还是不会变”
  - 确认选项 2：“重启后音量值是被记住了，但实际声音大小没按记住的音量变化（滑块显示对了，听感不对）”
  - 确认选项 1：“滑块显示保存值，但声音接近满音量/默认音量”
  - “我现在是 12 的音量，重启之后还是会变到 100 的那种音量，但是渲染出来的的确是上次退出前的音量”
  - “音量重启 dev 后还是最大”
  - 最后一次测试结果：“测试 1 通过，测试 2 不通过”（测试 1 = 实时拖音量，0 应静音、50% 明显更响；测试 2 = 设置音量 → 退出 → 重开验证）

## 2. 运行环境

- 分支：`1.0.6`（本地工作区，未提交改动）
- 运行方式：`pnpm dev`（electron-vite 开发模式，Electron 43）
- 原生音频引擎：
  - dev 用 `resources/audio-engine/twilight_audio_node.node` + `twilight-audio-engine.dll`（**8/5 构建，debug，DLL 134MB**）
  - 打包版用 `dist/win-unpacked/resources/audio-engine/`（8/8 构建，release，DLL 25MB）
- 引擎架构：原生 addon 跑在独立音频服务进程（`audioEngineService.js`，utility process）里，主进程通过 RPC 转发；`SetVolume` 是 fire-and-forget + 合并
- 输出：WASAPI 共享（float32/48kHz），`directMode: true`，EQ parametric 开启
- 关键文件：
  - 设置：`%APPDATA%\TwilightEcho\settings.json`
  - 音频诊断：`%APPDATA%\TwilightEcho\logs\audio\audio-diagnostics.jsonl`（+ `.previous.jsonl` 轮转）
  - 调试日志（本次新增）：`%TEMP%\twilight-native.log`

## 3. 已确认的事实（附证据）

### 3.1 原生引擎音量增益本身正常（探针实测）

- 用探针脚本直接加载原生 addon（Electron 主进程），播放测试 WAV，读回**音量施加之后**的 RMS：
  - 默认配置：vol=1.0 → RMS -11.66dB；vol=0.04 → RMS -39.62dB（差 -27.96dB = 理论值）
  - 用户完整 DSP 配置（EQ parametric + directMode 等）：vol=1.0 → -10.64dB；vol=0.04 → -38.56dB（差 -27.9dB）
- 结论：原生管线 `AudioPipeline::render` 的 `applyVolumeToRenderedFrames`（`audio-engine/core/AudioPipeline.cpp:4234-4236`）工作正常，**与源格式、EQ、directMode 无关**。

### 3.2 实时拖动音量正常（测试 1 通过）

- 诊断日志里用户拖动时引擎持续收到 `volume-changed`（0 → 0.04 → 0.08 → …），引擎 `playback-state` 同步变化。
- 用户确认：拖到 0 静音、拖到 50% 更响。

### 3.3 音量持久化已修复并验证（主进程侧）

- **旧根因（已修复）**：音量写盘依赖渲染层 `createDebouncedVolumePersistence`（280ms `setTimeout`）。主窗口在**小窗模式下被隐藏**，Chromium 对隐藏窗口的定时器节流/挂起，导致防抖回调**从不执行**。
- 证据：`%TEMP%\twilight-native.log` 里 `[DEBUG-vol2] schedule val=...` 出现、但 `persist ...` 从未出现；settings.json 长期停留在 0.04，而实时音量是 0.12。
- **修复**：在 `src/main/audio/engineIpc.ts` 的 `audioEngine:setVolume` IPC 处理器中直接落盘（350ms 主进程防抖 + `app.on('before-quit')` flush）。主进程不受窗口隐藏节流影响。
- **验证（最新）**：settings.json 已正确写入 0.16（16:18:02），此前永远 0.04。

### 3.4 重启恢复已修复并验证（引擎侧）

- **旧根因（已修复）**：
  1. `restoreAudioServiceReadyState` 在输出路由恢复失败时提前 return，**跳过音量恢复**；新起的音频服务进程原生音量是 1.0（满音量）。
  2. `PlaybackController.setVolume` 的去重守卫 `if (Object.is(normalized, this.playbackInfo.volume)) return` 会把“值相同”的推送全部吞掉，导致原生引擎永远收不到保存值（管理器已显示 0.04，实际满音量）。
- **修复**：
  - `src/main/audioEngineManager.ts`：`restoreAudioServiceReadyState` 即使路由恢复失败也执行播放状态恢复（音量/倍速/队列）；新增 `nativeVolumeSynced` 标记，只有带确认的恢复步骤成功才置位，服务崩溃时重置。
  - `src/main/audio/playbackController.ts`：`setVolume` 在原生音量未确认同步时仍下发（去重仅在已同步时生效）。
  - 新增 2 个回归测试（`src/main/audioEngineManager.test.ts`）：路由失败仍应用音量；未确认同步时 setVolume 必须下发。测试先红后绿，全套 132/132 通过，`typecheck:node` 通过。
- **验证（最新）**：诊断日志显示两次重启：
  - 08:16:54 会话：`playback-state vol=0.16`（设置里是 0.16）✓
  - 08:17:37 会话：`playback-state vol=0.15`（设置里是 0.15）✓
  - 两次渲染层也推送了相同值（`volume-changed`）。

### 3.5 新增“播放后重发音量”兜底（2026-08-09 补充）

- 与倍速同款逻辑（`PlaybackController.play` 已有“播放后同步倍速”）：原生 `GetPlaybackInfo`
  可能回传 1.0（若启动时 SetVolume 在服务引擎创建前丢失），合并播放信息时**保留应用层音量**，
  并在播放成功后**无条件重发 `SetVolume(playbackInfo.volume)`**，确保原生引擎不可能停在满音量。
- 文件：`src/main/audio/playbackController.ts`（play 内 merge 保留 volume + 播放后 reassert）。
- 新增回归测试：`play preserves saved volume and reasserts SetVolume on native`
  （模拟原生 Play 后 volume 回退为 1，断言管理器仍持 0.42 且原生被重设为 0.42）。
- 全套测试 133/133 通过，`typecheck:node` 通过。

### 3.6 最新实测轨迹（2026-08-09 16:18-16:31，用户测试后）

- settings.json 已正确保存用户最后一次拖动的值（0.16 → 0.04），证明主进程侧持久化持续生效。
- 当前会话（08:17:37 起）全程 `playback-state vol=0.04`，无任何跳回 1.0 的异常。
- 用户完成测试 1（实时拖动：0=静音、50% 更响）并确认通过。

## 4. 当前未决矛盾（下一步重点）

**用户报告“重启后实际声音最大”，但日志显示引擎以保存值（0.15/0.16）恢复并播放；且实时拖动（测试 1）通过。**

这意味着按代码与日志，重启后听感应为保存值，与用户报告矛盾。需要在新会话里明确：

1. **用户“测试 2 不通过”的确切表现**：重启后滑块显示什么？实际声音是“接近满音量”还是“偏小但不对”？是否与日志里的 0.15/0.16 一致？（日志显示两次重启均正确恢复，需确认用户看到/听到的与此是否一致）
2. 用户听到的声音是否真的来自该引擎实例：
   - 是否存在第二个 Twilight Echo / 旧打包实例同时发声（已查过进程，当时没有）；
   - 输出设备是否为系统默认（`device: auto`），与用户实际听音设备是否一致；
   - Windows 音量混音器里该应用会话音量是否异常。
3. 是否有其他播放路径（渲染层 HTMLAudio 兜底）与原生引擎同时播放。

建议下一步：

- 让用户用**最新代码**完整重跑测试 2（确认加载的是本次修复：settings.json 能更新到目标值），并记录：滑块显示值、实际听感、日志（diagnostics + `%TEMP%\twilight-native.log`）。
- 若仍为“引擎 0.15、听感最大”，请用户检查系统音量混音器与默认输出设备，或换打包版（release 引擎）对比。
- 排查时保留 `[DEBUG-vol2]` 标签日志（见 §6）。

## 5. 工作区未提交改动清单（10 个文件）

### A. 音量问题（本交接主题）

| 文件                                        | 改动                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/audio/engineIpc.ts`               | **主进程侧音量持久化**（setVolume IPC 落盘 + before-quit flush）；含注释说明隐藏窗口定时器节流                                                                                 |
| `src/main/audio/playbackController.ts`      | setVolume 去重守卫改为“已同步才去重”；新增 host 接口 `isNativeVolumeSynced / markNativeVolumeSynced / canVerifyNativeVolume`；play 合并时保留应用层音量 + 播放后重发 SetVolume |
| `src/main/audioEngineManager.ts`            | 服务就绪恢复不再跳过音量/倍速/队列；`nativeVolumeSynced` 标记；崩溃重置                                                                                                        |
| `src/main/audioEngineManager.test.ts`       | 新增 2 个回归测试（先红后绿验证过）                                                                                                                                            |
| `src/renderer/src/stores/usePlayerStore.ts` | 曾加 `[DEBUG-vol2]` 日志，已移除（无净改动）                                                                                                                                   |
| `src/main/audio/state.ts`                   | 曾加 `[DEBUG-vol2]` 日志，已移除（无净改动）                                                                                                                                   |

### B. 小窗圆角（独立问题，与音量无关）

| 文件                                             | 改动                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/main/integrations/miniPlayer.ts`            | 窗口 shape 半径改为 CSS 圆角 -2（OS 阶梯藏在透明边缘外，可见圆角交给 CSS 抗锯齿） |
| `src/renderer/src/mini-player/MiniPlayer.css`    | 移除 `clip-path`，保留 `border-radius` + `overflow: hidden`                       |
| `src/main/integrations/miniPlayerWindow.test.ts` | 新增 shape 严格位于 CSS 圆角外侧的断言                                            |
| `src/renderer/src/mini-player/styles.test.ts`    | 同步断言                                                                          |

## 6. 调试日志（已清理）

- 排查期使用的 `[DEBUG-vol2]` 日志已全部移除（`src/renderer/src/stores/usePlayerStore.ts`、`src/main/audio/state.ts`），代码中已无残留；`%TEMP%\twilight-native.log` 为历史痕迹。
- 音量相关诊断原本就在 `audio-diagnostics.jsonl`（`volume-changed`、`playback-state.controls.volume`、`audio-service-ready.restoreErrors`）。

## 7. 验证与复现步骤

```text
1. 完全退出 dev（终端 Ctrl+C）。
2. pnpm dev。
3. 把音量拖到目标值（如 15%），等 2 秒。
4. 检查 %APPDATA%\TwilightEcho\settings.json 的 softwareVolume 是否更新（本次修复后应更新）。
5. 正常退出应用，重新打开。
6. 检查：滑块显示值、实际听感、audio-diagnostics.jsonl 新会话的 playback-state vol、%TEMP%\twilight-native.log。
```

## 8. 相关代码位置速查

- 渲染层音量流：`src/renderer/src/stores/usePlayerStore.ts`（`volume` ref、`watch(volume)`、`watch(appSettings.softwareVolume)`、`persistSoftwareVolume`）
- 渲染层设置加载：`src/renderer/src/stores/useSettingsStore.ts`（`loadSettings` / `applySnapshot` / `updateSettings`）
- 主进程引擎管理器：`src/main/audioEngineManager.ts`（`start()`、`restoreAudioServiceReadyState`、`restoreAudioServicePlaybackState`、`nativeVolumeSynced`）
- 播放控制器：`src/main/audio/playbackController.ts`（`setVolume` 去重守卫）
- 引擎 IPC：`src/main/audio/engineIpc.ts`（`audioEngine:setVolume` + 主进程持久化）
- 音频服务 RPC 客户端：`src/main/audioEngineServiceClient.ts`（`coalescedFireAndForget('SetVolume')`、`call()` 超时/重启）
- 服务进程：`src/main/audioEngineService.ts`（薄转发）
- 原生管线：`audio-engine/core/AudioPipeline.cpp:4234-4236`（音量施加）、`TwilightAudioEngine.cpp:871-893`（setVolume）
