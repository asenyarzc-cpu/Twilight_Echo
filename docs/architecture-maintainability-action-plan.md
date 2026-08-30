# Twilight Echo — 高内聚、低耦合与可维护性提升执行方案

> 定位：基于 2026-08-13 当前工作区（分支 Pxasen，Twilight Echo 1.1.4）实际代码扫描，给出针对性的架构可维护性改造路线。
> 本文档不推翻现有架构，而是把已经存在的规则补强为“机器可强制”的落地清单。

## 执行状态（2026-08-13）

以下改造已经落地，下方原始路线图保留作为历史路线与后续继续执行的参考：

- A1/A2 边界与 IPC 通道清单已落地：`scripts/architecture-boundaries.test.cjs`、`scripts/ipc-channel-report.cjs` 存在并纳入仓库校验体系。
- `SettingsPage.vue` 已拆为 `components/settings-page/` 的 13 个分区组件，当前约 62KB，作为页面编排入口。
- `DspRackPage.vue` / `EqualizerPage.vue` 已抽领域子组件：`components/dsp-rack/`（DspScenePane、DspGraphCanvas、DspNodeEditor）、`components/equalizer/`（OpraEqPanel、FrequencyResponseChart、FrequencyResponseToolbar、GraphicEqPanel），并抽出 `utils/dspNodeParams.ts`、`utils/equalizerPageLogic.ts`。
- `StreamingPage.vue` 已拆出：`streaming-page/ProviderSidebar.vue`、`NcmPlaylistDialogs.vue`、`ProviderDownloadsPanel.vue`、`StreamingContextMenu.vue`、`streamingDownloads.ts`、`streaming-page/streamingPageModel.ts`、`StreamingContentHeader.vue/.css`、`StreamingSearchControls.vue/.css`、`StreamingPlaceholder.vue/.css`；页面约 112KB，继续列为拆分候选。
- `usePlayerStore.ts` 约 147KB，纯函数已抽到 `utils/playerTime.ts`、`playerAudioSettings.ts`、`playerQueueUtils.ts`、`playerConstants.ts` 及既有 `utils/player*`；Round 3/4/5 已把队列、会话、歌词、播放时钟、播放历史控制器抽到 `stores/player/`（新增 `playbackHistoryController.ts`，约 6KB）；仍列为最大 store 候选。
- `shared/theme.ts` 主题目录已迁到 `shared/themeCatalog.ts`（re-export barrel），数据拆为 `themeTokens.ts`（约 34KB）与 `themePresets.ts`（约 58KB），`theme.ts` 降到约 48KB。
- `src/main/plugins/manager.ts` 已把 provider 路由/幂等/安全助手迁回插件域模块，当前约 68KB。
- preload 已按域拆分到 `src/preload/domains/`，`src/main/ipc/data.ts` 已收敛为按域聚合入口，不再承担 52KB 级持久化注册。

### Round 2（2026-08-13）

- `shared/themeCatalog.ts` 已拆为 `shared/themeTokens.ts`（约 34KB）与 `shared/themePresets.ts`（约 58KB），`themeCatalog.ts` 降为 re-export barrel（396 B）。
- `useMusicStore.ts` 数据助手已抽到 `stores/library/musicStoreData.ts`（约 11KB），store 降至约 72KB；`usePlayerStore.ts` 纯函数已抽到 `utils/playerTime.ts` / `playerAudioSettings.ts` / `playerQueueUtils.ts` / `playerConstants.ts`，store 降至约 179KB。
- `ThemeStudioPage.vue` 编辑逻辑已抽到 `theme-studio/useThemeStudioEditor.ts`（约 47KB），页面降至约 51KB；`HiFiSidebar.vue` 样式外置到 `player-bar/HiFiSidebar.css`（约 30KB），组件降至约 67KB；`StreamingPage.vue` 抽出 `streaming-page/streamingPageModel.ts`（约 2KB），页面降至约 120KB。
- `playbackController.ts` 的常量/控制助手已迁到 `audio/audioEngineHelpers.ts`（约 45KB），控制器降至约 56KB。
- 验证：`test:themes` 153 pass、`test:playback-routing` 397 pass、`test:audio-manager` 268 pass、`test:app` 257 pass、`test:local-perf` 145 pass / 2 skip、`test:playlist-lifecycle` 17 pass；typecheck、lint、feature gates 通过。

### Round 3（2026-08-13）

- `usePlayerStore.ts` 已把队列、会话、歌词三组控制器抽到 `stores/player/`：`playbackQueueController.ts`（约 10KB）、`playbackSessionController.ts`（约 8KB）、`lyricsLoaderController.ts`（约 16KB）；store 降至约 155KB，对外导出与行为不变。
- `StreamingPage.vue` 已把内容头、搜索控件、占位状态拆为 `streaming-page/StreamingContentHeader.vue/.css`、`StreamingSearchControls.vue/.css`、`StreamingPlaceholder.vue/.css`，页面约 120KB 降至约 112KB。
- `AppearanceSettingsSection.vue` 已按区块拆为 `settings-page/ThemeControlsSettings.vue`、`BackgroundEditorSettings.vue`、`PlayerBarSettings.vue`、`LiquidGlassSettings.vue`、`CardAppearanceSettings.vue`；组件约 74KB 降至约 13KB，当前为编排入口。
- 源码契约测试已同步新归属：`usePlayerStore.test.ts`、`useSettingsStore.test.ts`、`scopedGlobalSelectors.test.ts`、`themeColorAudit.test.ts`、`autoHideScrollbars.test.ts`、`themeTokenization.test.ts`。
- 验证：`test:app` 257 pass、`test:themes` 153 pass、`test:playback-routing` 397 pass、`test:cross-cutting-regressions` 23 pass、typecheck 通过。

### Round 4（2026-08-13）

- `usePlayerStore.ts` 已把播放时钟、原生暂停补偿、pending pause 确认与 resync 状态抽到 `stores/player/playbackClockController.ts`（约 8KB），store 降至约 150KB，对外导出与行为不变。
- 源码契约测试已同步新归属：`usePlayerStore.test.ts` 的播放时钟契约改读 `playbackClockController.ts`。
- 验证：`test:app` 257 pass、`test:themes` 153 pass、`test:playback-routing` 397 pass、`test:cross-cutting-regressions` 23 pass、typecheck 通过。

### Round 5（2026-08-13）

- `usePlayerStore.ts` 已把恢复书签、手动书签、播客进度节流/强制回写抽到 `stores/player/playbackHistoryController.ts`（约 6KB），store 降至约 147KB；播客倍速策略仍由 store 保持，公共 API 和播放加载顺序不变。
- 控制器通过注入的书签/podcast 服务工作，持有独立 `resumeOffer` ref，并提供 `dispose()` 与异步 generation guard，避免 HMR/runtime 替换后的过期回调写入状态。
- 新增 `playbackHistoryController.test.ts` 并纳入 `test:playback-routing`；源码契约测试同步确认控制器归属和 store façade API。
- 验证：聚焦控制器/store 测试 71 pass、`test:playback-routing` 403 pass、typecheck 通过。

## 1. 现状：已经做得不错的方面

### 1.1 进程边界清晰

- renderer / preload / main / shared 四层有明确职责。
- `src/main` 按 18 个领域目录收敛：app、audio、bpm、cache、core、dsp、integrations、ipc、library、lyrics、ncm、network、persistence、plugins、radio、remote、security、themes。
- 五个 main 构建入口已经具体化：index、pluginHost、audioEngineService、audioAnalysisService、libraryScanService。
- 插件强制跑在 pluginHost，是少见的严格边界，不是嘴上说说。

### 1.2 shared 契约层有效

- `src/shared/` 61 个文件承担双端类型与纯算法。
- 已有 `scripts/tsconfig-shared-boundary.test.cjs` 强制 shared 不依赖 main/preload/renderer。
- 已有 preload 边界测试 `src/preload/sandboxBoundary.test.ts`。
- 这比大多数 Electron 项目“两端各维护一份类型”强很多。

### 1.3 已有架构文档和执行清单

- `docs/agent-architecture-guide.md` 已经识别出大文件热点、依赖方向规则、IPC 新通道流程、store 变更纪律、测试选择矩阵。
- `docs/windows-release-gate.md` 已规定发布门禁。
- 这说明团队已经有“不是靠感觉，而是靠文档和门禁”的意图。

## 2. 实际扫描数据（2026-08-13 工作区）

### 2.1 规模

| 指标                | 数值                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| .ts 文件            | 624（生产 369、测试 255）                                              |
| .vue 组件           | 80                                                                     |
| renderer utils 文件 | 131（67 个非测试）                                                     |
| window.api 基       | 28（主窗口实际使用）                                                   |
| IPC 相关调用点      | main `handle` 220 + `on` 17；preload invoke 220 + send 9 + 事件监听 39 |
| docs 文件           | 34                                                                     |

### 2.2 组件大小热点（按字节）

| 文件                                                                    | 大小   | 建议                                                                                                                                   |
| ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| src/renderer/src/components/StreamingPage.vue                           | 112 KB | 仍是大型编排页面；已拆头部/搜索/占位子组件，继续按子页面/逻辑拆                                                                        |
| src/renderer/src/components/player-bar/HiFiSidebar.vue                  | 67 KB  | 样式已抽到 HiFiSidebar.css（30 KB），继续按功能区块拆                                                                                  |
| src/renderer/src/components/SongList.vue                                | 93 KB  | 继续抽纯逻辑到 utils                                                                                                                   |
| src/renderer/src/components/ThemeStudioPage.vue                         | 51 KB  | 编辑逻辑已抽到 theme-studio/useThemeStudioEditor.ts（47 KB），当前为编排入口                                                           |
| src/renderer/src/components/settings-page/AppearanceSettingsSection.vue | 13 KB  | 已拆为 ThemeControlsSettings、BackgroundEditorSettings、PlayerBarSettings、LiquidGlassSettings、CardAppearanceSettings，当前为编排入口 |
| src/renderer/src/components/SettingsPage.vue                            | 62 KB  | 已拆为 13 个分区组件，当前为编排入口                                                                                                   |
| src/renderer/src/components/EqualizerPage.vue                           | 54 KB  | 已拆出 equalizer 领域组件，当前为编排入口                                                                                              |
| src/renderer/src/components/DspRackPage.vue                             | 39 KB  | 已拆出 dsp-rack 领域组件，当前为编排入口                                                                                               |

### 2.3 非测试 TS 文件大小热点

| 文件                                      | 大小   | 建议                                                                                |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| src/renderer/src/stores/usePlayerStore.ts | 147 KB | 继续按输出/统计拆 composable；队列/会话/歌词/播放时钟/播放历史已抽到 stores/player/ |
| src/shared/themePresets.ts                | 58 KB  | 主题目录预设数据，后续继续按数据域收敛                                              |
| src/renderer/src/stores/useMusicStore.ts  | 72 KB  | 数据助手已抽到 library/musicStoreData.ts（11 KB），继续按库操作领域拆               |
| src/main/plugins/manager.ts               | 68 KB  | provider 路由/幂等/安全助手已迁到插件域模块，继续按子域拆                           |
| src/shared/theme.ts                       | 48 KB  | 保留结构化运行时，谨慎改                                                            |
| src/shared/themeTokens.ts                 | 34 KB  | 主题 token 定义，后续继续按数据域收敛                                               |
| src/main/audio/playbackController.ts      | 56 KB  | 控制步进/状态助手已抽到 audioEngineHelpers.ts（45 KB），继续按职责收敛              |
| src/main/audioEngineManager.ts            | 49 KB  | 保持编排核心，拆分回调到 helpers                                                    |
| src/preload/index.ts                      | 7 KB   | 已按域拆到 src/preload/domains/，index 只汇总暴露                                   |

## 3. 目标分解：高内聚 + 低耦合 + 可维护性 + 可读性

这里给一个可执行的判断框架。

### 3.1 高内聚：一个目录/文件只做一类事

落地判断标准：

- `src/main/<domain>/` 下所有文件属于同一个业务域，IPC 注册也归位到该域。
- `src/renderer/src/stores/` 一个 store 只拥有一个明确状态域。
- `src/renderer/src/utils/` 只放纯逻辑，不放操作 DOM / 触达 window.api 的代码。
- 组件文件超过 ~150 KB 或 600 行时应先拆，不先把新功能塞进去。
- 工具类 TS 超过 ~100 KB 或 400 行时应先拆，不直接把逻辑往里堆。

### 3.2 低耦合：依赖方向必须单向

强制规则（已有部分，要补强）：

| 模块         | 允许依赖                             | 禁止依赖                           |
| ------------ | ------------------------------------ | ---------------------------------- |
| src/shared   | 纯 TS / 依赖更浅的 shared 文件       | main / preload / renderer          |
| src/preload  | src/shared、ipcRenderer              | main 内部实现、renderer            |
| src/renderer | @renderer/\*、src/shared、window.api | Electron、Node、main、preload 实现 |
| src/main     | src/shared、Node/Electron            | renderer、preload                  |
| plugin 代码  | 版本化 twilight API                  | Electron、Node 内置、宿主内部      |

### 3.3 可维护性：改一处不惊动十处

- IPC 通道新增必须有七步流程（文档已有）：main 归域注册 → shared 类型 → preload 暴露 → preload 类型同步 → renderer 通过 window.api 调用 → 参数走 security 校验 → 补单测 + 挂进 test:\* 脚本。
- store 变更必须通过 store 的“替换路径”，确保身份缓存失效，不直接 mutation。
- 新增跨源合并逻辑必须复用 `logicalTrackModel` / unified helpers，不重新发明。
- 新大列表必须虚拟化，不得在热路径用全库 find/map/filter。

### 3.4 可读性：让新队友 10 分钟内找到改动的落点

- 命名按“先域后用途”：`settings-*.vue`、`queue-*.ts`。
- IPC 全局走 `window.api.<域>.<动作>`。
- 目录结构即文档：新代码放哪里，读目录名就基本能判断。
- 文档单一权威：同一个事实只保留一份。

## 4. 具体改造路线：分四个阶段

### 阶段 A：把架构规则机器化（优先，改动小、收益大）

目标：把文档里的“建议”变成 CI/ESLint 红黄线。

#### A1 补齐 ESLint 边界规则（已完成）

在 `eslint.config.mjs` 中新增 no-restricted-imports / no-restricted-globals 段落：

1. renderer 禁 Electron/Node：所有 `src/renderer/src/**` 禁止 require(\"electron\")、import ... from \"electron\"、node:\*。
2. utils 禁 DOM/IPC：`src/renderer/src/utils/**` 禁止使用 window、document、window.api、ipcRenderer。
3. main 禁 renderer：`src/main/**` 禁止 import `@renderer` 或相对路径进入 renderer。
4. preload 禁 main：`src/preload/**` 禁止 import `src/main/**`。

执行方式：新增一个独立的 `scripts/architecture-boundaries.test.cjs`，用 import 扫描和 AST 正则双保险。挂进 `test:app` 或新增 `test:architecture`。

#### A2 生成 IPC 通道清单并纳入 CI（已完成）

- 写一个扫描脚本 `scripts/ipc-channel-report.cjs`：枚举 main 侧 `ipcMain.handle/on`，renderer 侧 `window.api.*`，preload 暴露的 API，生成三张表。
- 在 CI 或 `verify` 阶段对比上次生成的基线：新增通道必须同时出现在 preload 暴露和 main 注册两处，否则失败。
- 这能直接消灭“Renderer 调了个不存在的通道”这类问题。

#### A3 把 Windows 发布 gate 至少抽出入 CI 可跑的静态部分

- `gate:release:win` 在本机跑没问题，但依赖闭包、strip 策略、渲染预算这些检查最好能在 CI 的 Windows runner 也触发。
- 如果暂时无法完整迁移，先把 `verify-production-dependency-audit`、`verify-renderer-budgets`、`test:release-artifacts` 加进 PR 必跑集合。

### 阶段 B：拆分巨型文件（次优先，收益大但需要按序）

原则：**先拆纯 UI，再拆 store，最后动 shared 热契约。**

#### B1 先拆 SettingsPage.vue（已完成主体）

- 已按 `settings-page/` 目录拆成 13 个分区组件，`SettingsPage.vue` 当前约 62KB，作为页面级编排入口。
- 后续持续按验收目标收敛：每个子组件尽量 < 60KB，`SettingsPage.vue` 从当前约 62KB 继续降低；UI 行为无变化。

#### B2 再拆 usePlayerStore.ts（部分完成，Round 3/4/5 已抽控制器）

- 已把纯函数抽到 `utils/playerTime.ts`、`utils/playerAudioSettings.ts`、`utils/playerQueueUtils.ts`、`utils/playerConstants.ts` 及既有 `utils/playerPlaybackInfo.ts`、`playerSessionTrack.ts`、`playerTrackUtils.ts`；文件降至约 147KB。
- Round 3/4/5 已按域抽 composable：`stores/player/playbackQueueController.ts`、`playbackSessionController.ts`、`lyricsLoaderController.ts`、`playbackClockController.ts`、`playbackHistoryController.ts`；不一次性重写 store 对外 API。
- 继续拆输出、统计等域；验收：文件降到 < 80 KB；对外 action 和状态名不变；现有 `usePlayerStore.test.ts` 全通过。

#### B3 再拆 StreamingPage.vue / DspRackPage.vue / EqualizerPage.vue（部分完成，Round 3 已拆头部/搜索/占位）

- StreamingPage（112 KB）：继续按 `streaming-home`、`streaming-library`、`streaming-discovery`、`streaming-search` 拆子组件；已新增 `ProviderSidebar.vue`、`NcmPlaylistDialogs.vue`、`ProviderDownloadsPanel.vue`、`StreamingContextMenu.vue`、`streamingDownloads.ts`、`streamingPageModel.ts`、`StreamingContentHeader.vue/.css`、`StreamingSearchControls.vue/.css`、`StreamingPlaceholder.vue/.css`。
- DspRackPage / EqualizerPage 已抽到 `dsp-rack/`、`equalizer/` 子目录，当前均为编排入口。

#### B4 最后拆 shared/theme.ts 与 main/plugins/manager.ts（部分完成，Round 2 已拆主题目录数据）

- 主题目录已从 `shared/theme.ts` 迁到 `shared/themeCatalog.ts`，Round 2 再拆为 `shared/themeTokens.ts`（约 34KB）与 `shared/themePresets.ts`（约 58KB），`themeCatalog.ts` 降为 re-export barrel，`theme.ts` 约 48KB；继续收敛 archive validation、repository、runtime。
- `main/plugins/manager.ts`（约 68KB）已把 provider 路由/幂等/安全助手迁回插件域模块，继续按 manifest 解析、索引、生命周期、rpc 协调收敛。

### 阶段 C：收敛 IPC 与 preload（可维护性核心）

- preload 已按域拆到 `src/preload/domains/`，`index.ts` 只负责汇总暴露与独立窗口分支。
- `src/main/ipc/data.ts` 已收敛为按域聚合入口，持久化注册在 `persistenceIpc.ts` 等归属文件。
- 建立通道登记表（阶段 A2 的产物），把 150+ 个唯一通道逐步收敛到可审阅状态。
- 新通道一律先写 preload 封装，不允许 renderer 直接 send。

### 阶段 D：文档与事实源治理（长期习惯）

1. `CLAUDE.md` 收敛为指针：只保留指到 AGENTS.md / docs 的入口，删掉与 AGENTS 重复的命令表格。
2. 修正 `DEVELOPER_README.md` 过期的 Electron 版本（当前实际上是 Electron ^43，文档还写着 ^39）。
3. 同步 `package.json` 版本与 git 历史（已完成：当前 Pxasen 已含 1.1.4 提交与 `v1.1.4` tag，版本号已对齐到 1.1.4）。
4. 改动行为时同步 `docs/` 权威文档，新模块/通道必须登记进 `docs/README.md` 索引。
5. 每个季度重新跑一次规模统计（大小热点、IPC 通道数、分支数），把结果更新到 `agent-architecture-guide.md` 第 1 节。

## 5. 质量门禁检查表

### 每次改动前自问

- [ ] 这个 import 的方向符合 3.2 表吗？
- [ ] 如果新增了 IPC 通道，走完七步流程了吗？
- [ ] 改的是大文件吗？如果是，是否先拆分再做？
- [ ] renderer 是否直接用了 Electron/Node/ipcRenderer？
- [ ] 是否复制了 shared 已有的类型？
- [ ] 是否改动了 store 的索引/缓存而没有走替换路径？
- [ ] 是否把离线分析塞进了实时播放 RPC？
- [ ] 是否加了注释但任务没要求？（仓库风格不允许随意加注释）

### 合并前必须跑

| 改动类型                      | 最小验证                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| 搜索/收藏/逻辑曲目/迷你播放器 | pnpm run test:playback-routing                              |
| 本地库列表/性能/歌单 UI       | pnpm run test:local-perf                                    |
| 插件/安全/provider 路由       | pnpm run test:plugins                                       |
| 音频 IPC、BPM/响度、扫描      | pnpm run test:audio-manager                                 |
| 歌词                          | pnpm run test:lyrics-management                             |
| 歌单导入导出/CAS              | pnpm run test:playlist-lifecycle                            |
| CUE                           | pnpm run test:cue                                           |
| DSP                           | pnpm run test:dsp-graph（+ dsp-assets）                     |
| 主题                          | pnpm run test:themes                                        |
| 网络音源                      | pnpm run test:network-sources                               |
| 电台/播客/遥控                | pnpm run test:radio-remote                                  |
| 跨 main/preload/renderer 类型 | pnpm run typecheck                                          |
| 发布打包/asar/strip           | pnpm run test:release-artifacts + pnpm run audit:production |

## 6. 优先级总结（按投入产出比排序）

1. **把边界规则变成 CI/ESLint 红黄线**：成本最低，收益最大，能阻止结构倒退。
2. **拆掉 SettingsPage.vue 和 usePlayerStore.ts**：可读性提升最明显，是当前最大的两个痛点。
3. **IPC 通道清单化 + preload 按域拆分**：降低跨进程耦合的“地面面积”。
4. **清理重复/过期文档**：让新代理和新队友不会踩进没同步的文档。
5. **Windows 发布 gate 逐步 CI 化**：让“发布前才知道坏了”变成“合入前就知道会坏”。

## 7. 可度量的验收指标

半年内目标：

- renderer 组件最大文件 < 150 KB（从拆分前的 276 KB 降下来）。
- 非测试单一 .ts 最大文件 < 120 KB（usePlayerStore 目标 < 80 KB）。
- IPC 通道数量从 150+ 到不再增长，且每个新增通道在 CI 里被清单校验。
- renderer 对 Electron/Node 的直达 import 为 0。
- utils 对 window.api / DOM 的调用为 0。
- 人工 review 关注点从“边界对不对”转移到“业务实现对不对”。

## 8. 附：执行时的雷区

- 拆分 usePlayerStore 不要先改对外 API：先抽内部 composable，最后再收敛入口。
- 拆分 shared/theme.ts 会波及双端和多个 store：必须小步提交，每个 PR 保持 typecheck + themes 测试全绿。
- 新增 ESLint 规则会造成一批存量告警：可以先设为 warning 过渡，但不能无限期 warning。
- 文档治理要一次性清场，否则持续保留两份会继续漂移。
- 不要在拆分大文件的同时夹带行为重构，这一阶段只做移动拆解，不影响 UI/行为。

_本文档由 Codex 基于当前工作区扫描生成，建议输出到项目 `docs/architecture-maintainability-action-plan.md` 或按需引用。_
