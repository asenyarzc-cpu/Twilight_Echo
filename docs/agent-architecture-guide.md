# Twilight Echo 架构与 AI 代理维护指南

> 面向后续 AI 代理（Qoder / Claude / Codex 等）的架构地图与高内聚、低耦合维护手册。
> 调查日期：2026-08-13，基于当前工作区（分支 `Pxasen`，`TwilightEcho@1.1.4` 包版本）。

## 0. 文档体系与优先级

本仓库已有较完整的文档体系。代理开工前按以下顺序阅读，**权威文档之间如有冲突，以更靠前的为准，并把冲突记录给用户**：

| 优先级 | 文档                                                                      | 作用                                              |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| 1      | `AGENTS.md`                                                               | 硬性边界、命令、验证矩阵。违反即错，不可协商      |
| 2      | `docs/twilight-echo-plugin-spec.md` / `docs/twilight-echo-plugin-plan.md` | 插件系统唯一权威契约                              |
| 3      | `docs/DEVELOPER_README.md`                                                | 运行架构、关键数据流、性能约束                    |
| 4      | `docs/agent-architecture-guide.md`（本文）                                | 模块地图、依赖方向、内聚/耦合执行规则、代理工作流 |
| 5      | `docs/architecture-maintainability-action-plan.md`                        | Agent 执行的阶段性改造路线与验收指标              |
| 5      | `docs/windows-release-gate.md`                                            | Windows 发布门禁（发布前必读）                    |
| 6      | `docs/README.md`                                                          | 文档索引；新增/删除文档时必须同步维护             |

维护规则（来自 `docs/README.md`）：

- 同一主题只保留一份权威文档；被替换的草稿、路线图、重复指南应删除。
- 临时实施计划放 Issue / PR，不落库；完成后的事实由代码、测试和权威文档承载。
- 新增文档必须在 `docs/README.md` 登记索引。
- `CLAUDE.md` 已收敛为指针：只保留权威来源清单和少量工作规则，事实源在 `AGENTS.md` 与 `docs/`。

## 1. 项目现状调查（2026-08-13）

### 1.1 定位与技术栈

Twilight Echo 是一款桌面 HiFi 音乐播放器：Electron + Vue 3 + TypeScript + C++20 原生音频引擎。本地库、NCM 云音乐、插件系统、网络音源（SMB/FTP/WebDAV/DLNA/NFS）、电台/播客、遥控（DLNA/Chromecast）、DSP 机架、主题系统一应俱全。

| 层         | 技术                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| 打包/构建  | electron-vite 5、electron-builder 26、pnpm@11.7.0（唯一）、Node 22            |
| 运行时     | Electron ^43、Vue ^3.5、Pinia 3、TypeScript ^5.9                              |
| 音频元数据 | music-metadata、node-taglib-sharp                                             |
| 网络       | undici、basic-ftp、qrcode、discord-rpc（仅 IPC，无协议客户端）                |
| 原生       | C++20 + CMake + Node-API + FFmpeg；WASAPI/CoreAudio/ALSA/ASIO 输出后端        |
| 测试       | Node 内置 `node --test`（无 Jest/Vitest），TS 用 `--experimental-strip-types` |

### 1.2 规模统计（src 与工程目录）

| 指标                      | 数值                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `.ts` 文件                | 624（生产 369、测试 255）                                                                                                                 |
| `.vue` 组件               | 80                                                                                                                                        |
| main 进程源文件（含测试） | 269（生产 166、测试 103；20 个目录）                                                                                                      |
| renderer 源文件（含测试） | 276（生产 146、测试 130；stores 45、utils 131、components 顶层 34 + 子目录 41）                                                           |
| `src/shared` 契约文件     | 61                                                                                                                                        |
| `src/preload`             | 18                                                                                                                                        |
| `scripts/` 工具脚本       | 70（`cjs` 64、`ts` 5、`mjs` 1）                                                                                                           |
| IPC 通道                  | `ipcMain.handle` 220 + `ipcMain.on` 17，31 个 main 域；preload 对应 invoke 220、send 9、事件监听 39；renderer 唯一 `domain.action` 188 个 |
| preload `window.api` 域   | renderer 实际使用 28 个                                                                                                                   |
| 测试脚本（`test:*`）      | 29 个                                                                                                                                     |
| 代码卫生                  | `src` 下 0 个 TODO/FIXME/HACK                                                                                                             |

### 1.3 活跃度与仓库卫生

- git 提交量：2026-05 约 48、06 约 86、07 约 137、08 至今约 133——非常活跃，变更频繁。
- 提交规范为 conventional commits（`feat/fix/chore/style/merge`），新增提交请沿用。
- 分支管理是当前主要卫生问题：本地 20+ 个历史特性分支（`feat/local-home-*`、`redesign/*` 等）大多已合入或废弃，活跃分支是 `Pxasen`、`main`，远端还有 `1.0.6`、`1.0.6-0810`、`1.1.4`。做新功能前先确认基线分支。
- CI 只有 3 个工作流（`audio-engine.yml`、`build-linux.yml`、`build-macos.yml`）；Windows 发布 gate 在本机跑，不在 CI。
- `.qoder/repowiki` 是 Qoder 的知识库壳子（3 个 module yaml），内容为空；`.workbuddy` 只有构建验证日志；这些不是权威事实源。

### 1.4 已发现的文档过期点

代理修改文档或升级依赖时，顺手核对：

- `docs/DEVELOPER_README.md` 写 Electron `^39.2.6`，`package.json` 实际是 `^43.0.0`。
- `package.json` version 已同步至 `1.1.4`，与 `v1.1.4` tag 基线一致。
- `CLAUDE.md` 已瘦身为指针，不再与 `AGENTS.md` 重复命令表格与长规则。

## 2. 分层架构与依赖方向（高内聚低耦合的核心）

### 2.1 进程模型

```text
┌─────────────────────────────────────────────────────────────┐
│ renderer（Vue 3，src/renderer）＋ mini-player ＋ tray-player │
│ 唯一入口：window.api（preload contextBridge）                │
└──────────────────────────┬──────────────────────────────────┘
                           │ 类型化调用（无 Electron/Node API）
┌──────────────────────────▼──────────────────────────────────┐
│ preload（src/preload/index.ts）＝唯一桥，禁止绕行            │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC
┌──────────────────────────▼──────────────────────────────────┐
│ main 进程：index → app/lifecycle                            │
│ 窗口/IPC/设置/本地库/插件管理/集成/音频编排                 │
└───────┬──────────────┬───────────────┬──────────────────────┘
        │              │               │
        ▼              ▼               ▼
 audioEngineService  audioAnalysisService  libraryScanService（utilityProcess）
        │              │                       │
        └──────┬───────┘                       │
               ▼                               ▼
   twilight_audio_node.node → twilight-audio-engine.dll（C++20）
    FFmpeg → DSP → WASAPI/CoreAudio/ALSA/ASIO

  pluginHost（utilityProcess）＝插件唯一运行环境，只暴露版本化 twilight API
```

五个 main 构建入口（`electron.vite.config.ts`）：`index`、`pluginHost`、`audioEngineService`、`audioAnalysisService`、`libraryScanService`。

### 2.2 依赖方向规则（可 import 谁）

| 模块                  | 允许依赖                                                | 禁止依赖                           |
| --------------------- | ------------------------------------------------------- | ---------------------------------- |
| `src/main`            | `src/shared`、Node/Electron、`packages/plugin-api` 类型 | renderer 代码、`src/preload`       |
| `src/preload`         | `src/shared`、`electron` 的 `ipcRenderer`               | main 内部实现、renderer            |
| `src/renderer`        | `@renderer/*`、`src/shared`、`window.api`               | Electron、Node、main、preload 实现 |
| `src/shared`          | 仅纯 TS（可被 node 与 web 双端编译）                    | main/preload/renderer 任何代码     |
| 插件（pluginHost 内） | 版本化 `twilight` API                                   | Electron、Node 内置、宿主内部模块  |
| `audio-engine/`       | 自身 C++ 依赖                                           | JS/TS 代码（经 N-API 与 IPC 沟通） |

强制校验：`scripts/tsconfig-shared-boundary.test.cjs`（shared 边界）、`src/preload/sandboxBoundary.test.ts`（preload 边界）、`test:plugins`（插件安全边界）。

### 2.3 内聚标准（本仓库的"高内聚"定义）

- **目录即模块**：一个功能的所有实现、IPC 注册、测试尽量收敛在同一目录（如 `src/main/library/`、`src/main/plugins/`）。
- **模块公共面 = 导出函数/类型**：模块间只通过明确导出的 API 协作；不跨目录访问私有状态。
- **IPC 域 = 模块的对外契约**：每个 main 模块负责自己的通道前缀（如 `audioEngine:*`、`library:*`），新增通道时按域归位。
- **纯逻辑进 utils/shared**：无副作用、可单测的逻辑放 `utils`（renderer）或 `shared`（跨端），组件只做编排。

## 3. main 进程模块地图

### 3.1 顶层编排

| 文件                               | 职责                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| `src/main/index.ts`                | 入口，转发到 lifecycle；IME 后端自重启判断               |
| `src/main/app/lifecycle.ts`        | 窗口、单实例、IPC 注册、集成启动、NCM bootstrap          |
| `src/main/imeBackend.ts`           | Linux Wayland/X11 输入法后端决策                         |
| `src/main/audioEngineManager.ts`   | 播放编排中枢：服务启停、崩溃恢复、输出路由恢复、DSP 恢复 |
| `src/main/audioEngineService.ts`   | 可重启原生引擎子进程入口                                 |
| `src/main/audioAnalysisService.ts` | 离线 BPM/响度 worker 池入口（与实时播放 RPC 隔离）       |
| `src/main/opraCatalog.ts`          | OPRA 目录                                                |

### 3.2 功能目录

| 目录            | 职责                                         | 关键文件                                                                                                                             | 对外 IPC 域                                                         |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `app/`          | 生命周期、窗口、更新                         | `lifecycle.ts`、`window.ts`、`appUpdateService.ts`                                                                                   | `app:*`、`window:*`                                                 |
| `core/`         | 设置、运行时、快捷键类型                     | `settings.ts`、`types.ts`（PLAYER_SHORTCUTS）、`runtime.ts`                                                                          | `settings:*`                                                        |
| `ipc/`          | IPC 通道注册                                 | `data.ts`（按域聚合入口）、`persistenceIpc.ts`、`libraryIpc.ts`、`plugins.ts`、`themes.ts`、`fonts.ts`、`opra.ts`                    | `data:*`、`plugins:*`、`themes:*`、`fonts:*`                        |
| `audio/`        | 引擎 IPC、播放控制、DSP 编排、输出路由、响度 | `engineIpc.ts`、`playbackController.ts`、`audioEngineHelpers.ts`、`outputRouter.ts`、`dspOrchestrator.ts`、`loudness*`               | `audioEngine:*`、`loudnessAnalysis:*`                               |
| `bpm/`          | BPM 离线分析管理                             | `bpmAnalysisManager.ts`、`pcmBpmAnalyzer.ts`                                                                                         | `bpmAnalysis:*`                                                     |
| `library/`      | 本地库扫描、索引、CUE、查重、标签写入        | `libraryIndexCoordinator.ts`、`libraryScanService.ts`、`scanPlanner.ts`、`watcher.ts`、`duplicateDetection.ts`、`tagWriteService.ts` | `library:*`、`fs:*`                                                 |
| `plugins/`      | 插件管理器、索引、信任、RPC                  | `manager.ts`、`manifest.ts`、`indexService.ts`、`indexTrust.ts`、`rpcCoordinator.ts`                                                 | `plugins:*`、`providers:*`、`providerDownloads:*`                   |
| `security/`     | 安全边界与授权                               | `ipcValidation.ts`、`localPaths.ts`、`pathGrants.ts`、`remoteMediaGrants.ts`、`jsonSafety.ts`                                        | 无独立域（被所有 IPC 依赖）                                         |
| `integrations/` | 桌面歌词、迷你播放器、托盘、Discord、SMTC    | `desktopLyrics.ts`、`miniPlayer.ts`、`shortcutsTray.ts`、`smtc.ts`                                                                   | `desktopLyrics:*`、`miniPlayer:*`、`trayPlayer:*`、`discord:*`      |
| `lyrics/`       | 歌词导入/保存/在线搜索                       | `importLyrics.ts`、`saveLyrics.ts`                                                                                                   | `lyrics:*`                                                          |
| `ncm/`          | NCM API 封装与云传输                         | `api.ts`、`cloudTransfer.ts`                                                                                                         | `ncm:*`、`ncmCloud:*`                                               |
| `network/`      | 网络音源管理                                 | `sourcesManager.ts`、`networkIpc.ts`；`adapters/`（smb/ftp/webdav/dlna/nfs/sftp）                                                    | `networkSources:*`                                                  |
| `persistence/`  | JSON/版本化数据存储                          | `jsonFile.ts`、`versionedDataStore.ts`、`settingsFile.ts`                                                                            | 无独立域（被 `data:*` 使用）                                        |
| `radio/`        | 电台/播客                                    | `radioBrowserClient.ts`、`radioMediaService.ts`、`rssParser.ts`                                                                      | `radio:*`、`podcast:*`                                              |
| `remote/`       | 遥控与投屏（DLNA/Chromecast）                | `httpServer.ts`、`ssdp.ts`、`didl.ts`、`auth.ts`                                                                                     | `remote:*`                                                          |
| `themes/`       | 主题归档与库                                 | `themeArchiveValidation.ts`、`themeLibraryRepository.ts`                                                                             | `themes:*`（配合 shared/theme.ts、themeTokens.ts、themePresets.ts） |
| `cache/`        | 缓存布局                                     | `musicCacheLayout.ts`、`ncmCache.ts`                                                                                                 | `cover:*`（封面缓存）                                               |
| `dsp/`          | DSP 资产/修正曲线/VST3 目录                  | `dspAssetLibrary.ts`、`correctionProfile.ts`、`vst3Catalog.ts`                                                                       | 并入 `audioEngine:*`                                                |

### 3.3 main 侧的耦合纪律

- **IPC 注册只发生在 `src/main/ipc/`、`audio/engineIpc.ts`、`ncm/api.ts` 等归属文件**；功能模块内部不要散落 `ipcMain.handle`，否则通道无法审计。
- `audioEngineManager` 是播放侧唯一编排者；服务进程、崩溃恢复、路由恢复的顺序（`output-backend → output-device → output-config`）都在这里，不要绕过。
- 离线分析（BPM/响度）永远走 `audioAnalysisService`，**禁止**把全文件分析塞进实时播放 RPC 路径。
- 主进程加载路径禁止全量解析 metadata / base64 编码封面；这些只允许在显式后台重扫里做。

## 4. renderer 模块地图

### 4.1 导航与 shell

- **无 vue-router**：页面切换是 `src/renderer/src/app/useAppNavigation.ts` 中的状态导航（一组 boolean ref + computed 可见性），加"页面"= 加一个状态位 + 对应组件挂载点，不是注册路由。
- `App.vue` 是 shell，组合页面、侧边菜单、PlayerBar、主题窗口继承。

### 4.2 stores（状态归属）

| store                                       | 拥有状态                                           | 要点                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usePlayerStore.ts`（约 154KB，最大 store） | 播放队列、当前曲目、播放状态、音频输出、会话恢复   | 播放 tick/统计用 `shallowRef` + `triggerRef`；不要整表复制；纯逻辑已抽到 `utils/playerTime.ts`、`playerAudioSettings.ts`、`playerQueueUtils.ts`、`playerConstants.ts` 及既有 `utils/player*`；队列/会话/歌词/播放时钟/播放历史/音频输出/心动模式控制器在 `stores/player/` |
| `useMusicStore.ts`（约 72KB）               | 本地曲库、艺术家/专辑/文件夹派生、歌单、收藏       | 非响应式 `trackById`/`trackByPath` 索引；只能走 store 替换路径，否则缓存不失效；数据助手在 `stores/library/musicStoreData.ts`                                                                                                                                             |
| `useSettingsStore.ts`                       | 设置快照                                           | 与 main `core/settings.ts` 对应                                                                                                                                                                                                                                           |
| `useProviderStore.ts`                       | 插件 provider 注册与健康度                         |                                                                                                                                                                                                                                                                           |
| `useNcmStore.ts`                            | NCM 登录/云盘                                      |                                                                                                                                                                                                                                                                           |
| `useListeningStatsStore.ts`                 | 播放统计、最近播放、排行榜                         | 有界 top-N 收集，不整表重建                                                                                                                                                                                                                                               |
| `useThemeStore.ts`                          | 主题                                               | 与 shared/theme.ts、themeTokens.ts、themePresets.ts、main/themes 协同                                                                                                                                                                                                     |
| 其余                                        | 播客、电台、歌词、睡眠定时、书签、播放队列持久化等 | 见 `src/renderer/src/stores/`                                                                                                                                                                                                                                             |

### 4.3 providers 与 extensions

- `providers/mediaProvider.ts`：统一 provider 抽象；track ID 前缀（`ncm:`、`local:`）贯穿队列/库/会话。跨来源合并一律复用 `utils/logicalTrackModel.ts`。
- `extensions/`：插件在 renderer 的运行时（主题运行时、侧栏 UI 贡献注册）。主题只执行 CSS 变量/样式表，不执行脚本。

### 4.4 components（页面即组件）

顶层组件即页面：`LocalDashboard`、`SongList`（虚拟滚动）、`PlayingMusic`、`StreamingPage`、`RadioPodcastPage`、`NetworkSourcesPage`、`LoginPage`、`SettingsPage`、`ThemeStudioPage`、`EqualizerPage`、`DspRackPage`、`PluginPage`、`SideMenu`、`TitleBar` 等。子目录按领域聚合：`player-bar/`、`song-list/`、`streaming-page/`、`settings-page/`、`onboarding/`、`equalizer/`、`dsp-rack/`、`theme-studio/`、`network-sources/`、`icons/`。`SettingsPage`、`DspRackPage`、`EqualizerPage` 现在是编排入口，各分区/领域面板收敛到对应子目录；`ThemeStudioPage` 的编辑逻辑在 `theme-studio/useThemeStudioEditor.ts`，`HiFiSidebar` 的样式外置到 `player-bar/HiFiSidebar.css`。

### 4.5 独立窗口

- `mini-player/`、`tray-player/`、`desktop-lyrics/`：独立 BrowserWindow，共用同一份 renderer bundle，靠 `?window=<kind>` 查询参数在 `main.ts` 里分发根组件；各自只拿到对应 preload 域（`miniPlayer`/`trayPlayer`/`desktopLyrics`），不直接访问主窗口 DOM。
- 桌面歌词 v3（main 侧 `integrations/desktopLyrics.ts`）缓存版本化 `session + clock` 快照并负责窗口、锁定穿透、跨屏约束和单次崩溃恢复。主 renderer 的 `app/useDesktopLyricsPublisher.ts` 只复用播放器已解析的权威歌词与时钟，播放中最多 4 次/秒发布 clock；卫星窗口在本地用 `requestAnimationFrame` 外推进度，不解析 LRC/YRC/TTML，也不逐帧触发 Vue 状态更新。`sessionId + sequence + epoch` 用于拒绝旧曲目、乱序和 seek 前消息。
- `src/shared/desktopLyrics.ts` 是桌面歌词唯一跨进程契约；preload 按文档类型暴露互斥的 host/window 最小 API。窗口先 `bootstrap()` 应用设置、session 和 clock，再发送 `ready` 显示，避免初次闪烁和事件竞态。

### 4.6 utils（纯逻辑层）

`src/renderer/src/utils/` 131 个文件（67 个非测试）是 renderer 的纯逻辑层：播放路由、逻辑曲目、歌词时间线、主题性能、流媒体搜索、书签、播放器纯函数（`playerTime.ts`、`playerAudioSettings.ts`、`playerQueueUtils.ts`、`playerConstants.ts`、`playerPlaybackInfo.ts`、`playerSessionTrack.ts`、`playerTrackUtils.ts`）、DSP/均衡器逻辑（`dspNodeParams.ts`、`equalizerPageLogic.ts`）等。规则：

- utils 不依赖 `window.api`、不操作 DOM；有这些需求的放组件/composable。
- 热路径（搜索、统计、播放 tick）遵循性能红线：Map/Set 索引、二分查找、页面级物化，见 AGENTS.md 的 Renderer 性能约束。
- 新增跨来源合并逻辑必须复用 `logicalTrackModel` / `unified*` 助手，不重新实现。

## 5. shared 契约层（`src/shared/`）

双端共享的类型与纯逻辑都放这里（61 个文件），包括：`theme.ts`（约 48KB）、`themeCatalog.ts`（396 B，re-export barrel）、`themeTokens.ts`（约 34KB）、`themePresets.ts`（约 58KB，主题目录数据）、`dspGraph.ts`、`cue.ts`、`miniPlayer.ts`、`lyricsAppearance.ts`、`sleepTimer.ts`、`remoteControl.ts`、`audioProcessingOptions.ts`、`versionedPersistence.ts` 等。

纪律：

- IPC 载荷类型、跨进程共享的纯算法（CUE 解析、DSP 图校验、歌词编码）放 shared。
- shared 禁止 import main/preload/renderer；只允许纯 TS。`scripts/tsconfig-shared-boundary.test.cjs` 强制校验。
- 不要在 main 和 renderer 各复制一份类型——类型漂移是这类仓库最常见的耦合事故。

## 6. preload 与 IPC 契约

### 6.1 preload 唯一桥

`src/preload/index.ts` 通过 `contextBridge.exposeInMainWorld('api', ...)` 暴露 `window.api`；主窗口 28 个实际使用域，独立窗口按 `desktop-lyrics` / `mini-player` / `tray-player` 暴露最小子集。域实现已拆到 `src/preload/domains/`（`audioEngineApi.ts`、`dataApi.ts`、`settingsApi.ts`、`themesApi.ts`、`pluginsApi.ts`、`systemApi.ts` 等），`index.ts` 负责汇总与独立窗口分支；另有 `sleepTimerEvents.ts`、`closePersistence.ts`。类型定义在 `src/preload/types.ts` + `index.d.ts`。

事件模式：preload 维护回调 Set（如 `audioEngineReadyCallbacks`），`onXxx(cb)` 返回 unsubscribe 函数；renderer 用完必须清理，防止泄漏。

### 6.2 新增一个 IPC 通道的七步流程

1. main 侧在归属文件注册 `ipcMain.handle('域:动作', ...)`（域见第 3 节表）。
2. 载荷类型放进 `src/shared/`（跨端契约）或 `src/main/audio/audioEngineTypes.ts` 等归属类型文件。
3. preload `index.ts` 增加调用：`invoke('域:动作', ...)`。
4. `src/preload/types.ts` 与 `index.d.ts` 同步类型。
5. renderer 通过 `window.api.<域>.<动作>` 使用；**不允许**直接 `ipcRenderer`。
6. 需要校验的入参走 `src/main/security/ipcValidation.ts`；涉及路径/URL/授权的走 `pathGrants.ts` / `remoteMediaGrants.ts` / `externalUrl.ts`。
7. 补测试：main handler 单测 + preload 边界测试（参照 `sandboxBoundary.test.ts`），并登记进对应 `test:*` 脚本（`scripts/feature-test-gates.test.cjs` 会强制）。

## 7. 插件系统边界（摘要）

权威契约在 `docs/twilight-echo-plugin-spec.md` 与 `docs/twilight-echo-plugin-plan.md`，改插件行为前必须完整阅读。摘要：

- 插件只运行在 `pluginHost`（utilityProcess），通过版本化 `twilight` API 访问宿主能力；禁止 import Electron / Node / 宿主内部。
- **第三方插件源码不得写入本仓库**。外部插件仓：https://github.com/asenyarzc-cpu/Twilight-Echo-plugins/（本地 `D:\Twilight-Echo-plugins`）。布局：`plugins/<name>/` → pack 到 `packages/` → 索引进 `plugins.json`。app 索引顺序：`TWILIGHT_PLUGIN_INDEX_URL` → 缓存 → `resources/plugin-index/plugins.json`。
- 内置例外仅 `resources/plugins/ncm-provider`（`com.twilightecho.provider.ncm`），不是第三方先例。
- 主题插件只允许 CSS 变量/样式表；结构化主题运行时在 `src/shared/theme.ts`，归档校验/库在 `src/main/themes/`。
- DSP 原生插件走 C ABI（spec 第 5 节），实时安全铁律是审核硬性项；宿主侧有 ABI 校验与隔离（`audio-engine` 内 tests/plugins）。

## 8. 关键数据流

### 8.1 播放链路

```text
Renderer（usePlayerStore）→ window.api.audioEngine → main IPC
→ audioEngineManager → audioEngineService（或 TWILIGHT_AUDIO_SERVICE=0 进程内）
→ twilight_audio_node.node → twilight-audio-engine.dll → FFmpeg → DSP → 输出后端
```

- DSD/passthrough 绕过 DSP；DSP 超时/失败自动绕过。
- 崩溃恢复不自动续播：UI 必须等结构化 ready 事件 + 手动恢复。输出路由恢复顺序：`output-backend → output-device → output-config`（逐个 ACK）；DSP 恢复顺序：`SetDspPluginChain → ApplyDspState → LoadQueue`。

### 8.2 本地库扫描

`libraryScanService`（独立 utilityProcess）枚举 + 解析 metadata/封面 → `libraryIndexCoordinator` 持久化 `path + size + mtime` 快速索引 → 启动只做增量核对；全量 metadata/封面重扫必须由用户显式触发（进度/暂停/取消）。提交前重查 revision、授权 roots、exclusions，drift 则丢弃重规划。renderer 先加载已保存曲库让 UI 可用，后台再合并增量。

### 8.3 离线分析

BPM/响度只走 `audioAnalysisService` 的有界优先级队列（aging 防饥饿、deadline、满时高优先级驱逐）。取消发生在 cache commit 期间要按精确值条件回滚，且不得广播 completed。

### 8.4 状态归属速查

- 播放会话：renderer `usePlayerStore`（`usePlaybackSessionPersistence` 落盘）。
- 本地库：renderer `useMusicStore` ↔ main `library/`。
- 设置：renderer `useSettingsStore` ↔ main `core/settings.ts`（`settings:get/update`）。
- 迷你播放器/托盘/桌面歌词：main 拥有窗口，通过各自 IPC 域广播快照。
- 主题：main `themes/` + shared `theme.ts` / `themeTokens.ts` / `themePresets.ts` + renderer `useThemeStore`。

## 9. 高内聚、低耦合执行清单（本仓库的落地标准）

### 9.1 新代码放哪（决策表）

| 要写的东西              | 位置                                                        |
| ----------------------- | ----------------------------------------------------------- |
| 跨进程类型 / 双端纯算法 | `src/shared/`                                               |
| 主进程业务 + 其 IPC     | 对应 `src/main/<域>/`，IPC 注册归位到该域文件               |
| 原生引擎能力            | `audio-engine/`（C++），JS 侧只经 `audioEngineManager`/服务 |
| renderer 纯函数逻辑     | `src/renderer/src/utils/`                                   |
| 组件内编排状态          | 组件自身或对应 store                                        |
| 跨组件共享状态          | `src/renderer/src/stores/`                                  |
| 插件能力                | 外部插件仓；宿主侧只加通用 host/API/UI                      |

### 9.2 文件拆分红线

当前最大的维护热点（超过 ~80KB 应视为拆分候选，改动前先评估）：

| 文件                                                     | 大小     | 建议                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/StreamingPage.vue`                           | 约 112KB | 大型编排页面；已拆出 `ProviderSidebar`、`NcmPlaylistDialogs`、`ProviderDownloadsPanel`、`StreamingContextMenu`、`streamingDownloads.ts`、`streaming-page/streamingPageModel.ts`、`StreamingContentHeader`、`StreamingSearchControls`、`StreamingPlaceholder`，继续按子页/逻辑拆                                                                                         |
| `stores/usePlayerStore.ts`                               | 约 154KB | 最大 store；纯逻辑已抽到 `utils/playerTime.ts`、`playerAudioSettings.ts`、`playerQueueUtils.ts`、`playerConstants.ts` 及既有 `utils/player*`；Round 3/4/5 已抽队列/会话/歌词/播放时钟/播放历史控制器到 `stores/player/`，Round 6 已抽音频输出/音频处理控制器 `audioOutputController.ts`，Round 7 已抽心动模式控制器 `heartModeController.ts`，继续按统计域拆 composable |
| `shared/themePresets.ts`                                 | 约 58KB  | 主题目录预设数据（2026-08-13 从 `themeCatalog.ts` 拆出），继续按数据域收敛                                                                                                                                                                                                                                                                                              |
| `shared/themeTokens.ts`                                  | 约 34KB  | 主题 token 定义（2026-08-13 从 `themeCatalog.ts` 拆出）                                                                                                                                                                                                                                                                                                                 |
| `components/player-bar/HiFiSidebar.vue`                  | 约 67KB  | 样式已抽到 `HiFiSidebar.css`（约 30KB），组件继续按功能区块拆                                                                                                                                                                                                                                                                                                           |
| `components/SongList.vue`                                | 约 93KB  | 已虚拟化，逻辑再抽 utils                                                                                                                                                                                                                                                                                                                                                |
| `components/ThemeStudioPage.vue`                         | 约 51KB  | 编辑逻辑已抽到 `theme-studio/useThemeStudioEditor.ts`（约 47KB），页面为编排入口                                                                                                                                                                                                                                                                                        |
| `stores/useMusicStore.ts`                                | 约 72KB  | 数据助手已抽到 `stores/library/musicStoreData.ts`（约 11KB），继续按库操作领域拆                                                                                                                                                                                                                                                                                        |
| `components/settings-page/AppearanceSettingsSection.vue` | 约 13KB  | 已拆为 `ThemeControlsSettings`、`BackgroundEditorSettings`、`LyricsStyleSettings`、`PlayerBarSettings`、`LiquidGlassSettings`、`CardAppearanceSettings`，当前为编排入口                                                                                                                                                                                                 |
| `main/plugins/manager.ts`                                | 约 68KB  | provider 路由/幂等/安全助手已迁到插件域模块，后续继续按子域收敛                                                                                                                                                                                                                                                                                                         |
| `components/SettingsPage.vue`                            | 约 62KB  | 已拆为 13 个 `settings-page/` 分区组件，当前为编排入口                                                                                                                                                                                                                                                                                                                  |
| `components/EqualizerPage.vue`                           | 约 54KB  | 已拆出 `equalizer/` 面板与频率响应组件，当前为编排入口                                                                                                                                                                                                                                                                                                                  |
| `shared/theme.ts`                                        | 约 48KB  | 主题目录已迁至 `themeCatalog.ts`（再导出 `themeTokens.ts` / `themePresets.ts`），保留结构化运行时；双端依赖广，谨慎改                                                                                                                                                                                                                                                   |

红线建议：单个 `.vue` 超过 ~150KB、单个 `.ts` 超过 ~100KB 时，新改动先拆分再动手；`utils` 里超过 ~300 行的文件按主题继续拆分。拆分原则：**内聚不变量在同一文件，跨主题再拆**。

### 9.3 依赖方向检查清单（改动前自问）

- 这个 import 的方向符合 2.2 表吗？
- renderer 是否直接用了 Electron/Node/`ipcRenderer`？（不允许）
- 是否复制了 shared 已有的类型？（应 import）
- 是否绕过 preload 直接访问 main？（不允许）
- 插件代码是否碰了 Electron/Node？（不允许）
- 是否引入了新的手动 chunk 且与 `vendor-vue`/`vendor-music-metadata`/`vendor-qrcode` 重复？（不允许）
- 是否把离线分析放进了实时播放 RPC 队列？（不允许）

### 9.4 store 变更纪律

- 只通过 store 的替换路径改曲库数组，保证 `trackById`/`trackByPath` 与身份缓存失效。
- 派生集合（artists/albums/folders）用 coalesced rebuild，不逐次重建。
- 播放 tick 写统计用 `shallowRef` + `triggerRef`，不复制整张历史表。
- store composable 被多组件调用时，模块级初始化不得每次重建大索引。
- 启动期跨 store 副作用由入口层注入 refs，不要在 store 内动态 import 已被静态引用的热 store。

### 9.5 事件/回调生命周期

- preload 的 `onXxx` 一律返回 unsubscribe；组件 `onUnmounted` 清理。
- main 侧定时器、watcher、服务进程句柄要有显式销毁路径（参考 `closePersistence` 的关窗持久化纪律）。
- 避免事件在 renderer 侧聚合造成重复订阅（HMR 场景有专门测试：`playerStoreHmr.test.ts`）。

### 9.6 可读性与一致性

- Prettier：单引号、无分号、`printWidth: 100`、无 trailing comma；改完跑 `pnpm run format`。
- ESLint flat config；Vue SFC 必须 `<script lang="ts">`；未使用变量/参数以 `_` 前缀。
- TS strict；允许 `.ts` 后缀 import。
- renderer import 用 `@renderer/*`，不用深层相对路径。
- **不加注释除非任务要求**；0 TODO/FIXME 纪律保持住。
- 新代码（尤其纯逻辑）必须 co-located 测试：`*.test.ts`，并挂进归属 `test:*` 脚本（feature-test-gates 强制）。

## 10. 测试与验证

### 10.1 测试规范

- 只用 `node --test`；TS 测试用 `node --experimental-strip-types --test`。
- 测试与被测文件同目录（co-located），命名 `*.test.ts` / `*.test.cjs` / `*.test.mjs`。
- 每个 co-located 测试必须被某个 `test:*` 脚本覆盖（`scripts/feature-test-gates.test.cjs` 强制）。
- 单文件：`node --experimental-strip-types --test path/to/file.test.ts`。

### 10.2 按改动面积选验证（最小有用集）

| 改动                          | 至少跑                                         |
| ----------------------------- | ---------------------------------------------- |
| 搜索/收藏/逻辑曲目/迷你播放器 | `test:playback-routing`                        |
| 本地库列表/性能/歌单 UI       | `test:local-perf`                              |
| 插件/安全/provider 路由       | `test:plugins`                                 |
| 音频 IPC、BPM/响度、扫描协调  | `test:audio-manager`                           |
| 歌词                          | `test:lyrics-management`                       |
| 歌单导入导出/CAS              | `test:playlist-lifecycle`                      |
| CUE/扫描规划                  | `test:cue`                                     |
| DSP 图/处理选项               | `test:dsp-graph`（+ `test:dsp-assets`）        |
| 主题                          | `test:themes`                                  |
| 网络音源                      | `test:network-sources`                         |
| 电台/播客/遥控                | `test:radio-remote`                            |
| 跨 main↔preload↔renderer 类型 | `pnpm run typecheck`                           |
| 发布打包/asar/strip           | `test:release-artifacts`、`audit:production`   |
| 发布前全量                    | `pnpm run test:no-real-device`（本机 Windows） |

## 11. Agent 标准工作流

1. **读边界**：`AGENTS.md` → 本文第 2/3/4/5 节定位模块与依赖方向 → 涉及插件读 spec/plan，涉及发布读 release gate。
2. **确认基线**：当前分支是 `Pxasen`；新功能确认目标分支（默认 `main`），不要在过期特性分支上开发。
3. **小步实现**：遵守第 9 节清单；大文件先拆分再改；保持行为不变优先。
4. **验证**：按 10.2 选最小测试集，全绿后再跑 `pnpm run typecheck`；发布级改动跑 `test:no-real-device`。
5. **格式化**：`pnpm run format`、`pnpm run lint`。
6. **提交**：conventional commits（`feat/fix/chore/style`），提交信息中文或英文均可，但保持已有风格一致。
7. **文档同步**：改了行为就同步 `docs/` 权威文档；新增通道/模块/配置必须登记索引；删文档要清理 `docs/README.md`。

## 12. 维护热点与风险清单

| 风险           | 现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 处置建议                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 巨型组件/store | StreamingPage 约 112KB、usePlayerStore 约 154KB 等；SettingsPage/DspRack/Equalizer/theme/plugin manager 已拆；Round 2 完成 player store 纯函数、ThemeStudio、HiFi、streaming model、playback controller 抽取，Round 3 完成 usePlayerStore 队列/会话/歌词、StreamingPage 头部/搜索/占位、AppearanceSettingsSection 区块拆分，Round 4 完成播放时钟控制器抽取，Round 5 完成播放历史控制器抽取，Round 6 完成音频输出/音频处理控制器（`audioOutputController.ts`）抽取，Round 7 完成心动模式控制器（`heartModeController.ts`）抽取 | 9.2 拆分红线，大改前先拆                                                                           |
| 分支膨胀       | 本地 20+ 历史分支                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 合入后删除；发布以 tag/远端 release 分支为准                                                       |
| 文档重复/过期  | CLAUDE.md 已收敛为指针；DEVELOPER_README 的 Electron 版本曾过期；package.json 版本号需随发版核对                                                                                                                                                                                                                                                                                                                                                                                                                              | 保持单一权威原则；升级依赖/发版时顺手同步                                                          |
| 原生工具链复杂 | MinGW 主路径、MSVC VST3/SMTC/ASIO 分路径、clean-room ASIO                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 改动 `audio-engine/output/` 时按 AGENTS.md 的 Windows 工具链要求验证；macOS/Linux 后端未发布级验证 |
| 发布安全门禁   | 依赖闭包、strip、大小预算、品牌、SHA-256 全部失败关闭                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 发布只走 `gate:release:win`，别绕行                                                                |
| 性能红线       | 大曲库 + 高频播放 tick                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 见 AGENTS.md Renderer 性能约束，改动热路径必跑 `test:local-perf` / `test:playback-routing`         |

## 13. 陷阱速查（硬性禁令）

- 只用 pnpm@11.7.0 + `--frozen-lockfile`；不产生 `package-lock.json`；装依赖后跑 `verify:install-policy` 与 `verify:ncm-patch`。
- 不写第三方插件源码进仓库；插件只能跑在 pluginHost。
- 不把全文件 BPM/响度分析放进实时播放 RPC 路径。
- 不 reintroduce 字体转换器；字体必须是已提交的 `.woff2`。
- 更新机制：GitHub Release installer 下载 → 可选 SHA-256 校验 → `shell.openPath` 启动后退出；**不是** `electron-updater` / 静默 asar 替换。
- 不注册 OS 默认协议客户端；`second-instance` 只恢复/聚焦窗口。
- renderer 不碰 Electron/Node；preload 是唯一桥。
- 平台行为：WASAPI/CoreAudio 无 native DSD；ALSA `hw:` 可 native DSD；Shared Mode 走系统混音器是预期行为。
- 真实设备 smoke（ASIO/WASAPI Exclusive/native DSD/SACD ISO/CoreAudio/ALSA `hw:`）是 opt-in，不是默认 gate。

## 14. 本文档的维护

- 本文档是"活地图"：每次新增/移动/删除模块、改变依赖方向、新增 IPC 域、拆分大文件，都应在本次改动中同步更新对应章节。
- 每季度（或大版本发布时）可重新跑一次第 1 节式的规模统计核对数字。
- 本文档与 `AGENTS.md`、`DEVELOPER_README.md` 冲突时，以更高优先级文档为准，并把冲突报给用户处理。
