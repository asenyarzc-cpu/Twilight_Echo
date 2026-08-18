# Twilight Echo — 项目结构审查（2026-08-15）

> 审查基线：分支 `Pxasen` 工作区（含未提交的液态玻璃改动），包版本 1.1.4。
> 方法：四路并行深查（main 进程 / renderer / shared·preload·packages 契约层 / 构建·脚本·CI·测试体系），叠加仓库卫生、文档体系、audio-engine C++ 侧的人工核对。
> 定位：可执行改进清单，每项给出最优解法；完成后在"状态"列标记（未开始 → 进行中 → 已完成）。文内数字以本次扫描为准，随代码演进会过期，大版本时可按 `agent-architecture-guide.md` 第 14 节重跑核对。
> 优先级定义：P0 = 影响正确性 / CI / 安全，立即处理；P1 = 高价值结构改造，最优解明确；P2 = 一致性收敛，防漂移；P3 = 长期项，记录在案。

## 总评

项目结构基础远好于同规模 Electron 项目的常见水平：四层进程边界（renderer / preload / main / shared）全部机器强制（`scripts/architecture-boundaries.test.cjs`、`scripts/tsconfig-shared-boundary.test.cjs`、`src/preload/sandboxBoundary.test.ts`），文档体系遵守单一权威原则，五轮大文件拆分已落地，IPC 通道有双向一致性基线校验。

剩余问题不是"没有架构"，而是三类：

1. **契约层三向手工同步**（类型多处复制、通道字符串双份手写）；
2. **"拆了外壳、没拆内核"的半成品收敛**（usePlayerStore、theme.ts、IPC 注册编排）；
3. **各处小规模不一致的累积**（测试套件重复、孤儿脚本、CI 漂移、utils 平铺）。

## P0 — 立即处理

| #   | 问题                                       | 事实                                                                                                                                                                                                                                                                                                                                         | 最优解                                                                                                               | 状态   |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| 0-1 | 3 个测试文件未入库但已被 `test:*` 脚本引用 | `src/main/integrations/desktopLyrics.test.ts`、`src/renderer/src/utils/liquidGlassEnvironment.test.ts`、`src/shared/desktopLyricsFont.test.ts` 被 `test:app` / `test:themes` / `test:lyrics-management` 引用，但仍是未跟踪状态（液态玻璃 WIP 的一部分）                                                                                      | 随液态玻璃改动一并 `git add` 提交；漏掉则任何新克隆 / CI 直接失败                                                    | 已完成 |
| 0-2 | 依赖倒挂：security → library / cache       | `src/main/security/localPaths.ts:7-8` import `../cache/musicCacheLayout.ts` 与 `../library/libraryFiles.ts`；security 按架构应为叶子层                                                                                                                                                                                                       | 把 `SUPPORTED_EXTENSIONS`、缓存目录常量下沉到 `src/shared/`，security 恢复纯叶子                                     | 已完成 |
| 0-3 | 路径包含判断三处实现，其一为安全弱化版     | 正版 `security/pathGrants.ts:24` `isWithinRoot`（realpath 规范化）；`dsp/dspAssetLibrary.ts:398` 私有 `isPathInside()` 用裸 `resolve()` + 字符串 `startsWith`、硬编码分隔符、不处理 symlink；`plugins/providerDownloadManager.ts:356` 临时大小写比较                                                                                         | 全部收敛到 `isWithinRoot`                                                                                            | 已完成 |
| 0-4 | 非原子写盘                                 | `plugins/settingsStore.ts:77` 裸 `writeFile` 写 JSON；仓库自有 `persistence/jsonFile.ts:109` `writeJsonFileAtomic`                                                                                                                                                                                                                           | 换用 `writeJsonFileAtomic`，崩溃不再损坏插件设置                                                                     | 已完成 |
| 0-5 | 仓库卫生                                   | `eq-repro-tmp.mjs`（临时调试脚本）已提交；`.zcode/`（AI 会话计划）已提交且 `.gitignore` 漏列；根目录 `nul` 文件（Windows 保留名事故）；本地 ~2.8GB 构建产物（`dist/` 1.8G、`output/` 562M、`outputs/` 166M、`out/` 169M、`dist.pre-unpack-*` 104M）；27 个本地分支约 22 个已废弃（`ui-test*`、`test`、`redesign/*`、`feat/local-home-*` 等） | `git rm eq-repro-tmp.mjs`；`git rm -r --cached .zcode` 并补 `.gitignore`；`rm nul`；清理产物目录；合入后删除废弃分支 | 已完成 |

## P1 — 高价值结构改造

### 1-1 契约层三向手工同步（全项目最大结构债）

同一类型手工复制维护：`AudioProcessingSettings` 4 份（main / preload/types / index.d.ts / renderer）、`AppSettings` 3 份、`PlaybackInfo` 3 份、`TrackData` / BPM / 元数据类型 3 份；`src/preload/index.d.ts` 为 1958 行手写 `WindowAPI` 镜像；renderer `types/music.ts` 重复声明 shared 已有的 `LyricSource`，renderer `Track`（45 字段）与 preload `TrackData`（33 字段）已是漂移后超集。结构化类型意味着漏加一个字段只会静默收窄另一端。

最优路径（两步，不必一次到位）：

1. 把 `AppSettings`、`AudioProcessingSettings`、`PlaybackInfo`、`TrackData`、BPM/元数据类型迁入 `src/shared/`（音频两类的源头本就在 main），`preload/types.ts` 改为 re-export；
2. 长期把 `index.d.ts` 整体替换为 `typeof import('./index.ts').api` 的类型投影门面——1958 行手工维护归零，漂移在类型层面不可能发生。

参照样板：`shared/miniPlayer.ts`、`dspGraph.ts`、`liquidGlass.ts` 就是正确姿势（单一源头、处处 import）。

### 1-2 IPC 通道字符串无单一事实源

`'audioEngine:'` 字面量 main 73 处（`audio/engineIpc.ts`）+ preload 69 处（`preload/domains/audioEngineApi.ts`）；`'library:'` 21+16 处；31 个前缀全部双份手写。现有 `ipc-channel-consistency.test.cjs` 只能查"通道存在"，查不了载荷类型漂移与"两边同时改名漏一边"。

最优解：`src/shared/ipcChannels.ts` 常量表（或从单一 typed contract 对象派生两侧注册），顺带使 `docs/audit-evidence/ipc-channel-baseline.json` 基线机制冗余。

### 1-3 `usePlayerStore.ts`（147KB / 4304 行）拆分只完成外壳

`stores/player/` 九个控制器合计仅 61.6KB，store 本体与拆分前完全一样（147,301 B）。仍内联的部分：native-queue 同步（27 处引用）、`setupAudioEngineListeners()`（单函数约 270 行）、heartMode、abLoop、mediaSession、Discord、cast、BPM、crossfade——约占总行数 25%，且控制器模式已验证。

另有两个假拆分应删除：`stores/usePlaybackQueueStore.ts` 为 75 字节别名文件（`export { usePlayerStore as usePlaybackQueueStore }`）；`useAudioOutputDspStore.ts` / `useVisualizationStore.ts` 为纯转发门面，状态从未离开父 store。

最优解：按既有控制器模式抽 `mediaSession` / `discord` / `cast` / `heartMode` / `abLoop` / `bpm` / `setupAudioEngineListeners` 到 `stores/player/`；删除别名与假门面（调用点改回 usePlayerStore）。验收沿用 action-plan B2：store < 80KB、对外 action 与状态名不变。

### 1-4 main 根目录音频域文件归位

| 文件                                               | 现状                                                                                      | 归属                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/main/pluginHost.ts`（546 行）                 | 纯 plugins 沙箱宿主，只 import plugins/ 与 security/，未登记在 guide §3.1                 | `plugins/host.ts`（需同步 `electron.vite.config.ts` 入口与 `ipc/plugins.ts:51` fork 路径） |
| `src/main/audioEngineServiceClient.ts`（1160 行）  | 音频域 RPC client，仅 audioEngineManager 引用                                             | `audio/`                                                                                   |
| `src/main/audioAnalysisServiceClient.ts`（824 行） | BPM/响度 worker 池 client                                                                 | `audio/`（或新 `analysis/`）                                                               |
| `src/main/audioProcessingEffective.ts`（91 行）    | 被 audio/ 与 core/ 引用                                                                   | `audio/`                                                                                   |
| `src/main/sleepTimer.ts` + `sleepTimerCore.ts`     | 睡眠定时器散落三处（根目录、`ipc/sleepTimerIpc.ts`、`audio/sleepTimerNativeBoundary.ts`） | 收敛到一个域目录                                                                           |

附带收益：斩断 `core/settings.ts:8-18` → 根目录 `audioEngineManager.ts` 的值依赖链（core 被所有域引用，这条链把音频枢纽传播到全仓库）。长期可把 `audioEngineManager.ts` 也移入 `audio/manager.ts`，根目录只剩真正的进程入口。

### 1-5 `shared/theme.ts` 仍为上帝模块 + 类型环

数据拆分（`themePresets.ts` 58KB / `themeTokens.ts` 34KB）已完成，但 theme.ts（48KB / 1379 行）仍有约 130 个导出：schema 版本、12 个 `normalize*`、7 个 `resolve*`、对比度数学、CSS 变量发射、图标槽注册表；且 `themePresets.ts` / `themeTokens.ts` 反向从 theme.ts import 类型（运行时无环、模块图有环）。26 个文件依赖它。

最优拆法：`themeSchemas.ts`（类型 + 版本）→ `themeNormalize.ts` / `themeContrast.ts` / `themeCss.ts` / `themeIcons.ts`，`theme.ts` 降为纯 barrel，schema 类型下沉一层斩断环。按仓库既定规则小步提交，每步 `test:themes` 全绿。

### 1-6 renderer 测试文件游离于类型检查之外

`tsconfig.web.json` 显式 exclude `src/renderer/src/**/*.test.ts`，`tsconfig.node.json` 亦不含它们——131+ 个测试文件仅靠 `node --experimental-strip-types` 运行（擦除类型、不检查）。`scripts/*.ts`（两个 benchmark、`generate-plugin-theme-contract.ts`）同样不在任何 tsconfig。

最优解：新增 `tsconfig.test.json`（或取消 web 侧 exclude）纳入 typecheck。

## P2 — 一致性收敛

| #    | 问题                             | 事实                                                                                                                                                                                                                                                                                                                                                                                                           | 最优解                                                                                                                                                                                    | 状态   |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2-1  | IPC 注册编排分裂两处             | `ipc/data.ts` 仅聚 13 个 setup，`app/lifecycle.ts:318-339` 直呼另外 12+ 个                                                                                                                                                                                                                                                                                                                                     | 收敛为单一聚合入口，lifecycle 只调一个注册函数                                                                                                                                            | 未开始 |
| 2-2  | integrations 内联注册 IPC        | `desktopLyrics.ts` 9 个、`miniPlayer.ts` 8 个、`trayPlayer.ts` 4 个通道内联在窗口生命周期文件里；而同域的 `discord:*` 在 `ipc/discordIpc.ts`——自相矛盾                                                                                                                                                                                                                                                         | 三者抽 `integrations/*Ipc.ts` 或移入 `ipc/`                                                                                                                                               | 未开始 |
| 2-3  | 注入式 IPC 注册对审计不可见      | `ipc/sleepTimerIpc.ts:19-32` 经注入的 `SleepTimerIpcMain` 接口注册 4 通道，`ipcMain.` 文本扫描（含 architecture-boundaries）全部漏掉                                                                                                                                                                                                                                                                           | 边界测试补识别注入式注册                                                                                                                                                                  | 未开始 |
| 2-4  | app ↔ integrations 目录级环      | `app/window.ts:14` ↔ `integrations/shortcutsTray.ts:18`、`trayPlayer.ts:23`（`getAppIconPath`）                                                                                                                                                                                                                                                                                                                | 抽 `getAppIconPath` 到 core/ 或独立 paths 模块                                                                                                                                            | 未开始 |
| 2-5  | `audio/state.ts` 是第二编排者    | `audio/state.ts:18-27` import plugins/events、cache、integrations×4、library/watcher 共 7 域做设置 fan-out                                                                                                                                                                                                                                                                                                     | 这层"设置应用"扇出移到 app/ 层或独立 applier                                                                                                                                              | 未开始 |
| 2-6  | 测试套件重复执行                 | `test:network-sources`（16 文件）是 `test:radio-remote` 严格子集；`test:duplicate-detection` 被 3 个套件包含（`duplicateDetection.test.ts` 在聚合门里跑 3 次）；`test:cue` ↔ `test:audio-manager` 交叠 4 文件；`test:no-real-device` 末尾 `typecheck && build` 而 `build` 自身又以 typecheck 开头（typecheck 跑 2 次）                                                                                         | 删纯子集脚本、去重交叠、聚合链去重 typecheck                                                                                                                                              | 未开始 |
| 2-7  | 测试所有权清单需四处同步         | package.json / `audio-engine.yml` / `run-final-integrated-gate.ps1` / `docs/windows-release-gate.md` 各自维护清单，feature-test-gates 只强制其中 6 个套件；`test:queue-virtualization` 在聚合门但不在 CI；`test:app`（35 文件）非全量                                                                                                                                                                          | CI 直接跑 `test:no-real-device`（聚合只定义一次）；超大内联清单（`test:playback-routing` 2767 字符 / 51 文件等 6 个）改为按目录 glob 或生成的 manifest，feature-test-gates 改验 glob 覆盖 | 未开始 |
| 2-8  | CI 管线重复与误触发              | `audio-engine.yml` 的 `mac-release` job 与 `build-macos.yml` 近似重复（vcpkg vs brew 差异）；`build-macos.yml` 对个人分支 `Pxasen` 每次 push 打双架构包；文件名 `audio-engine.yml` 与 `name: CI` 不符；Linux 原生构建在两个 workflow 里用两套工具链（vcpkg vs apt/cmake）                                                                                                                                      | 合并 macOS 管线、移除个人分支触发、改名 `ci.yml`、统一 Linux 工具链                                                                                                                       | 未开始 |
| 2-9  | 孤儿脚本                         | `configure-smtc-msvc.cjs`、`run-smtc-msvc.cjs`、`smtc-msvc-toolchain.cjs`、`smtc-native-selftest.cjs`、`stage-smtc-msvc.cjs`、`generate-smtc-icons.mjs`（合计 ~16.5K）互相引用但无任何外部调用；运行时 SMTC 已走 W3C Media Session + 已提交的 `build/smtc/*.ico`                                                                                                                                               | 删除；若 MSVC 路线仍计划保留则接入 package.json 并登记文档                                                                                                                                | 未开始 |
| 2-10 | utils/ 平铺 + 纯度违规           | 133 个文件零子目录（lyric* 11、player*/playback* 13、playlist* 5、library* 5、liquidGlass* 3、native* 3、unified* 3）；9 个文件碰 DOM/window（`autoHideScrollbars.ts` 16 处、`animationFrameFallback.ts`、`lyricViewportController.ts`、`useSmoothedValue.ts` 等）违反"utils 纯逻辑"规则；`composables/` 仅 3 文件而 29 个 composable 散在 7 处                                                                | 按簇建子目录；DOM 类迁 composables/；定 composable 归属规则                                                                                                                               | 未开始 |
| 2-11 | 大内联样式块未走已验证的外置模式 | `StreamingHome.vue` 38KB（占文件 69%）、`PlayingMusic.vue` 32KB、`LoginPage.vue` 24KB、`StreamingLibrary.vue` 22KB、`StreamingDiscovery.vue` 21KB、`DspRackPage.vue` 20KB、`ParametricEqWorkspace.vue` 19KB；`SettingsPage.vue` 在外置 CSS 之外还留 16KB 内联；`StreamingPage.vue` 外置 CSS 之外残留第二个内联块                                                                                               | 按 `song-list/SongList.css` 既有模式外置                                                                                                                                                  | 未开始 |
| 2-12 | renderer 引 shared 无别名        | 98 个文件用相对路径（最深 5 级：`StepWelcome.vue:4` 的 `'../../../../../shared/theme.ts'`）                                                                                                                                                                                                                                                                                                                    | tsconfig.web + vite 加 `@shared` 别名                                                                                                                                                     | 未开始 |
| 2-13 | preload 两套订阅模式 + 手写样板  | inline `on` + 返回 unsubscribe（9 处）与模块级 `Set<Callback>` 并存；`audioEngineApi.ts` 手写 12 个 Set（53-64 行），`index.ts` 另 5 个；正确的工厂 `createSleepTimerEventBridge` 仓库已有且只用了一次；213 个 invoke 全是单行箭头包装                                                                                                                                                                         | 泛化 `createChannelBridge(channel)` + typed `invoke` 工厂，可删 ~150 行样板并统一模式                                                                                                     | 未开始 |
| 2-14 | sandboxBoundary 覆盖不全         | `src/preload/sandboxBoundary.test.ts` 只扫 `index.ts`；11 个 `domains/*.ts` 同在沙箱 preload 里构建却不在扫描范围（域文件 import `node:crypto` 不会被发现）                                                                                                                                                                                                                                                    | 扫描范围改 `src/preload/**`（排除测试）                                                                                                                                                   | 未开始 |
| 2-15 | plugin-api 契约被手工复制        | `src/main/plugins/types.ts`（549 行）手拷包契约：`TwilightPluginManifest` 与 `packages/plugin-api/src/index.ts` 逐字节相同、`TWILIGHT_PLUGIN_API_VERSION` 双份，仅 `managerContract.test.ts` 正则抽查守护                                                                                                                                                                                                      | main 直接 `import type` 工作区包 + 全量等价性测试                                                                                                                                         | 未开始 |
| 2-16 | 小重复                           | `utils/playerTime.ts` `formatTime()` 与 `components/song-list/formatDuration.ts` 同算法双实现；搜索逻辑散布 5 处（`localLibrarySearch.ts`、`unifiedMusicSearch.ts`、`app/useUnifiedMusicSearch.ts`、`streaming-page/localStreamingSearch.ts`、`song-list/useSongListSearch.ts`）；`components/audioTempoEstimator.ts`（纯 DSP 估计器）、`audioVisualizerFormatting.ts` 放错层                                  | 合并 / 归位 utils                                                                                                                                                                         | 未开始 |
| 2-17 | 大文件热点仍在（拆除中期项）     | `plugins/manager.ts` 68KB/1829 行、`audio/playbackController.ts` 56KB、`audioEngineManager.ts` 49KB、`audio/engineIpc.ts` 48KB（57 个 handler）、`audio/audioEngineHelpers.ts` 46KB、`plugins/indexService.ts` 41KB；renderer 侧 `StreamingPage.vue` 112KB（脚本 2718 行 / 236 个顶层定义）、`SongList.vue` 93KB（模板仍 1164 行）、`PlayerBar.vue` 66KB、`LoginPage.vue` 64KB                                 | 沿用既有拆分模式：manager.ts 按 install/update 事务 vs 运行时管理 vs provider 接线（`updateTransaction.ts`、`operationQueue.ts` 已是现成缝）；engineIpc 随 1-2 通道常量化一并收敛         | 未开始 |
| 2-18 | 组件顶层散件                     | `LiquidGlassDefs.vue`（31KB）、`LyricsAppearanceCustomizer.vue`（39KB）、`PluginSettingsPanel.vue`、`NcmCloudPanel.vue`、`LocalLibraryTagManager.vue`、`PlayingMusicTimeChip.vue`、`PlayingLyricWords.vue`、`AnimatedInput.vue`、`EditableRangeValue.vue`、`CoverImg.vue`、`AppNoticeHost.vue`、`ImportDialog.vue` 直搁 components/ 顶层；`LocalDashboard.css`（64KB）与 `theme-color-allowlist.json` 也在顶层 | 按域归入子目录                                                                                                                                                                            | 未开始 |

## P3 — 长期项

| #   | 事项         | 事实                                                                                                                                                                                               | 建议                                                                        | 状态   |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| 3-1 | C++ 侧热点   | `audio-engine/core/AudioPipeline.cpp` 187KB、`core/TwilightAudioEngine.cpp` 105KB                                                                                                                  | 下次动 audio pipeline 时优先拆；登记 `agent-architecture-guide.md` 第 12 节 | 未开始 |
| 3-2 | git 体积     | `resources/` 416 个字体文件 9.3MB（约 tracked 体积 10%），有意为之的 woff2 子集                                                                                                                    | 克隆变慢再考虑 LFS；个人项目暂不必要                                        | 未开始 |
| 3-3 | 文档治理     | `volume-restore-handoff-2026-08-09.md`、`audit-security-ui-ux-2026-08-01.md`、`architecture-maintainability-action-plan.md`（五轮改造已全部完成，仅存历史）按本仓库文档规则属"会话交接 / 临时计划" | 归档或删除并同步 `docs/README.md` 索引                                      | 未开始 |
| 3-4 | 构建配置小修 | `electron.vite.config.ts` 的 `publicDir: resolve('resources')` 为 cwd 相对（main 入口用 `__dirname` 相对）；renderer 构建先全量复制 455 个资源再剥离字体                                           | 改 `resolve(__dirname, 'resources')`；过滤式复制替代复制后剥离              | 未开始 |
| 3-5 | 本地工作区   | `output/`、`outputs/`、`out/` 三个输出目录名并存（均 ignored）；`audio-engine/build/` 464MB                                                                                                        | 清理并统一输出目录命名                                                      | 未开始 |

## 建议执行顺序

1. **P0 全部**（半天内可清完；0-1 随液态玻璃提交一并解决）。
2. **1-1 / 1-2（契约层 + 通道常量）**——两者都是"建立单一事实源"，是防止未来漂移的地基，其余改造均受益。
3. **1-4 → 1-3 → 1-5（归位 / usePlayerStore / theme.ts）**——沿用既定"先 UI 后 store 最后 shared 热契约"顺序。
4. **1-6 + P2 按表顺序**，多数可拆独立小 PR。
5. **P3 登记入 `agent-architecture-guide.md` 第 12 节风险清单。**

注：P2 中 2-1、2-2、2-6、2-7、2-13 先行打包成一个"一致性清理" PR 收益最大——它们本身工作量小，且会让后续每项改造的验证成本（测试时长、审计面）直接下降。

## 执行记录

- 2026-08-15：本文档由四路并行扫描 + 人工核对生成，全部条目初始为"未开始"。
- 2026-08-15（同日）：P0 五项全部完成——0-1 三个测试文件随液态玻璃提交入库；0-2 新增 `shared/audioFormats.ts` / `shared/musicCacheLayout.ts` 并让 security / library / cache / renderer 全部改为引用单一事实源（renderer 死拷贝一并消除）；0-3 DSP 资料库与下载目录统一到 `isCanonicalPathInside` / `lexicalPathKey`；0-4 插件设置换 `writeJsonFileAtomic`；0-5 删除 `eq-repro-tmp.mjs`、untrack `.zcode/` 并补 ignore、删除 `nul`（大产物目录与废弃分支未动，见 P3-5）。验证：typecheck、lint、`test:plugins` / `test:dsp-assets` / `test:audio-manager` / `test:app` / `test:cue` 全绿。
- 2026-08-15（同日，P1 第一批）：
  - **P1-1 已完成**：新增 `shared/audioEngineTypes.ts`（音频契约全集 + PlayMode 统一为含 `'heart'` 的 5 值超集，修复 main 4 值 / renderer 5 值的既有漂移）、`shared/appSettings.ts`、`shared/track.ts`；preload/types.ts 与 index.d.ts 各删除 69 个重复声明、renderer types 删 46+7 个，全部改为 re-export shared；`VolumeNormalizationMode` / `DsdOutputMode` / `LoudnormStatus` 三份重复收敛。源码契约测试改为断言 shared 单一事实源。typecheck + `test:app` / `test:audio-manager` / `test:plugins` / `test:playback-routing` 全绿。
  - **P1-2 已完成**：新增 `shared/ipcChannels.ts`（audioEngine 69 + library 17 通道常量）；engineIpc / audioEngineApi / libraryIpc / libraryApi 共 179 处字面量改常量引用；`ipc-channel-report.cjs` 增加 `IPC.*` 常量解析，一致性门禁与基线继续有效。
  - **P1-6 进行中（成本已探明）**：试验性取消 `tsconfig.web.json` 对 `src/renderer/src/**/*.test.ts` 的排除后，131 个测试文件暴露 **105 处存量类型错误**（mock 签名 `Promise<number>` vs `Promise<void>` 为主），集中在 `usePlaybackSessionPersistence.test.ts`(25)、`unifiedRecentTracks.test.ts`(10)、`localMusicPerf.test.ts`(8) 等。启用前需先做一轮测试文件类型清理，再移除 exclude。
  - **P1-5 暂缓（阻塞）**：`shared/theme.ts` 正被并行的液态玻璃施工修改（未提交），拆分必然冲突，待其落定后执行。
  - **P1-4 部分暂缓**：`audioEngineServiceClient.ts` 正被并行音频施工修改，该文件搬家待其落定；其余归位项待做。
