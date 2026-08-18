# Twilight Echo 技术文档

本文档面向 Twilight Echo 维护者，说明仓库结构、运行架构、关键数据流、性能约束和验证命令。插件系统的权威契约以 [twilight-echo-plugin-spec.md](./twilight-echo-plugin-spec.md) 与 [twilight-echo-plugin-plan.md](./twilight-echo-plugin-plan.md) 为准；本文只描述 app 仓库如何接入和承载插件能力。

## 技术栈

Twilight Echo 是 Electron + Vue 3 + TypeScript 应用，使用 electron-vite 构建，electron-builder 打包。当前包信息为 `TwilightEcho@1.1.4`，许可证为 Apache-2.0。

核心依赖：

- Electron `^43.0.0`
- Vue `^3.5.25`
- TypeScript `^5.9.3`
- electron-vite `^5.0.0`
- `music-metadata`
- `@neteasecloudmusicapienhanced/api`
- PrimeIcons

原生音频引擎使用 C++20、CMake、FFmpeg、Node-API，并通过平台后端输出到 WASAPI、CoreAudio、ALSA 或 ASIO。Windows MinGW 是当前验证最完整的原生构建路径。

## 仓库结构

```text
.
├── src/
│   ├── main/                 Electron 主进程：窗口、IPC、设置、本地库、插件管理、音频引擎
│   ├── preload/              contextBridge 安全 API
│   └── renderer/             Vue 3 renderer
├── audio-engine/             C++20 原生音频引擎与 Node-API addon
├── resources/
│   ├── audio-engine/         打包时加载的原生二进制
│   ├── plugins/ncm-provider/ 内置 NCM provider 插件
│   └── plugin-index/         离线插件索引
├── packages/
│   ├── plugin-api/           `@twilight-echo/plugin-api` typings
│   └── create-twilight-plugin/ 插件脚手架与 pack 工具
├── scripts/                  构建、staging、smoke、发布辅助脚本
└── docs/                     技术文档、插件规范、发布 gate
```

第三方插件源码不属于 app 仓库。第三方插件应放在外部仓库 `Twilight-Echo-plugins`，app 只消费 `TWILIGHT_PLUGIN_INDEX_URL` 或内置静态索引。`resources/plugins/ncm-provider` 是唯一内置 provider 例外。

## 运行架构

Electron main 侧有五个构建入口，均在 `electron.vite.config.ts` 中声明：

- `index` -> `src/main/index.ts` -> `src/main/app/lifecycle.ts`
- `pluginHost` -> `src/main/pluginHost.ts`
- `audioEngineService` -> `src/main/audioEngineService.ts`
- `audioAnalysisService` -> `src/main/audioAnalysisService.ts`
- `libraryScanService` -> `src/main/library/libraryScanService.ts`

`audioAnalysisService` 使用独立 `utilityProcess` worker pool 执行 BPM/loudness 完整文件解码。其有界优先级队列使用 aging 防止低优先级任务饥饿，并为等待任务设置 deadline；队列满时更高有效优先级可驱逐最差等待项。并发上限、取消、watchdog 和 worker 重启均与实时 `audioEngineService` 隔离，离线分析不得进入播放 RPC 队列。BPM/loudness manager 在 cache commit 期间收到取消时会按精确值条件回滚，且不得广播 completed 事件。

`libraryScanService` 在独立 `utilityProcess` 中执行目录枚举、`music-metadata` 解析和封面落盘。主进程的 `libraryIndexCoordinator` 持久化 `path + size + mtime` 快速索引：启动只解析新增、变化或索引缺失的文件；文件 watcher 事件按 canonical path 合并后进入串行队列；完整 metadata/封面重扫只能由用户在设置页显式启动，并支持进度、暂停、继续和取消。扫描提交前必须重查曲库 revision、授权 roots 与 exclusions；发生 drift 时丢弃旧结果并重规划，禁止把已移除目录或 TE-0.4 排除项重新写回。

主进程负责窗口生命周期、单实例锁、IPC 注册、设置持久化、本地库扫描、桌面歌词、快捷键托盘、Discord RPC、NCM API 启动和音频引擎编排。

preload 位于 `src/preload/index.ts`，通过 `contextBridge` 暴露受控 API。renderer 不直接访问 Electron、Node 或主进程内部模块。

renderer 位于 `src/renderer/src/`，入口是 `main.ts` 与 `App.vue`。主要状态分布：

- `stores/usePlayerStore.ts`：播放队列、当前曲目、播放状态、音频输出、可视化轮询、播放会话恢复。
- `stores/useMusicStore.ts`：本地曲库、艺术家/专辑/文件夹派生集合、歌单、收藏、曲库修复与元数据补全。
- `stores/useProviderStore.ts`：插件 provider 注册状态、能力与健康度。
- `providers/mediaProvider.ts`：统一 provider 抽象。
- `utils/logicalTrackModel.ts`：跨来源曲目的逻辑合并和优先级排序。

## 音频链路

常规播放链路：

```text
Renderer -> preload API -> main IPC -> audioEngineManager
  -> audioEngineService 或进程内 fallback
  -> twilight_audio_node.node
  -> twilight-audio-engine.dll
  -> FFmpeg decode -> DSP chain -> platform output
```

`TWILIGHT_AUDIO_SERVICE=0` 仅用于开发调试，会让主进程直接加载引擎。生产路径应使用可重启的音频服务进程，避免 native 崩溃拖垮 app。

DSD / passthrough 路径会绕过不安全的 DSP。WASAPI 与 CoreAudio 没有平台级 native DSD 通道，DSD 通过 DoP 或 PCM fallback；ALSA `hw:` 可支持 native DSD。macOS 和 Linux 音频后端仍未完成发布级验证。

## 本地库与搜索数据流

本地曲库加载时先把已保存曲目放入 renderer，使界面尽快可用；`libraryScanService` 随后用快速索引做启动增量核对，provider 元数据补全也在后台进行。后台结果按 track id/path 合并，避免覆盖用户在加载期间新增、删除或排除的曲目。主进程加载路径不得遍历解析全库 metadata、转换 base64 封面或逐项修复封面；这些工作只允许在显式后台重扫中执行。

`useMusicStore` 维护两个非响应式索引：

- `trackById`：按 track id 定位曲目。
- `trackByPath`：按文件路径定位曲目，供文件 watcher 的增量 add/remove 使用。

派生集合 `artists`、`albums`、`folders` 使用 `shallowRef`，并通过 coalesced rebuild 合并多次变更。不要在高频操作中逐次重建完整派生集合；批量导入、删除、修复后应调度一次 rebuild。跨来源歌单解析依赖按曲库 revision 缓存的 local logical map；收藏按钮状态依赖歌单 identity cache。修改曲库数组时必须走 store 内部的曲库替换路径，确保这些缓存能正确失效。

统一搜索会把本地结果和插件 provider 结果合并为逻辑曲目。`buildLogicalTracks` 使用逻辑 key 索引候选组，避免大结果集下按组线性扫描。新增搜索、最近播放或收藏逻辑时，应复用 `logicalTrackModel`，不要重新实现跨来源合并规则。

最近播放、排行和 Dashboard 推荐需要把历史统计解析回可播放的本地变体时，使用 `createUnifiedRecentTrackResolver(localTracks)` 在一次计算中复用本地 id/logical 索引。不要在每条统计上单独调用会重建整库索引的解析流程。

Streaming 页的本地歌曲、歌单、歌手搜索逻辑放在 `components/streaming-page/localStreamingSearch.ts`。该工具扫描完整集合以保留分页总数，但只 materialize 当前页结果；不要在 SFC 内重新写 `filter().map().slice()` 的全量中间数组链。

## Renderer 性能约束

本项目的卡顿风险主要来自大曲库和高频播放状态更新。维护时遵守以下规则：

- 大列表只渲染可见区域。`SongList` 表格走虚拟滚动，网格视图走 idle/timer 分批渲染。
- 大型数组更新使用 `shallowRef` + 新数组替换，避免深层响应式追踪整首曲目对象。
- 曲库艺术家、专辑、文件夹等派生集合在分组入库时同步维护封面等摘要元数据，不要生成每个分组后再扫描组内曲目。
- 高频查找使用 `Map` / `Set` 索引，不在事件处理、watcher、播放 tick 中反复 `find`、`includes` 或全量 `map/filter`。
- 单曲 metadata、BPM 等回写路径使用 `trackIndexById` 定位数组槽位，不要对整张曲库 `findIndex`。
- 最近播放、排行榜和 Dashboard 榜单等只需要前 N 项的选择器使用 store 内的有界 top-N 收集，避免在 SFC 内为整张历史表创建 `entries/filter/sort/slice/map` 中间链。
- 播放 tick 会写入的统计状态使用 `shallowRef` 加显式 `triggerRef` 提交，更新单条统计时不要复制整张历史表。
- 搜索热路径避免为每首歌创建临时字段数组，优先短路判断，并尽量只保留当前页需要渲染的结果。
- store composable 可以被多个组件调用；模块级初始化不能在每次调用时全量重建曲库索引。
- 启动期跨 store 副作用优先由入口层注入所需 refs，不要在 store 内动态 import 已经被主界面静态引用的热 store；否则既形成隐式反向依赖，也无法带来实际 chunk 拆分。
- 播放进度、频谱和桌面歌词同步要节流，避免把 native polling 变成 renderer 重渲染风暴。
- 正在播放页按播放时间定位歌词时使用二分查找，不在每个播放 tick 从歌词首行线性扫描。
- 封面主题色提取使用小型 LRU/promise 缓存；切歌时必须防止旧封面异步结果覆盖当前曲目颜色。
- provider 或文件系统慢操作必须后台化，不能阻塞首屏曲库渲染。

## 插件边界

插件运行在 `utilityProcess`，入口为 `src/main/pluginHost.ts`。插件只能通过版本化 `twilight` API 访问宿主能力，不得直接 import Electron、Node 内置模块或 app 内部实现。

app 仓库允许包含：

- 插件 host/runtime 代码。
- 插件 API typings 与脚手架。
- 内置 NCM provider。
- 宿主验证所需的内置示例或静态索引客户端。

app 仓库不允许包含第三方插件源码、第三方插件测试、第三方 `.tep` 包或插件专属 README。需要新增第三方能力时，app 侧只实现通用 host/API/UI 能力，具体 provider 逻辑放到外部插件仓库。

## 常用命令

安装依赖：

```bash
corepack enable
pnpm install --frozen-lockfile
```

主仓库只使用 `pnpm@11.7.0` 和 `pnpm-lock.yaml`。不要运行 `npm install`，也不要提交
`package-lock.json`；内置 NCM API 的修补由 `pnpm-workspace.yaml` 的
`patchedDependencies` 在安装时应用。

`discord-rpc` 的 `register-scheme` 仅是 Electron 不可用时的 optional fallback，且上游把它
指向 exotic Git dependency。主应用通过 Discord IPC 上报播放状态，**当前不注册** OS 默认
协议客户端（无 `setAsDefaultProtocolClient`）。因此 workspace 通过
`ignoredOptionalDependencies` 只排除这个 fallback，并保持 `blockExoticSubdeps: true`。
`pnpm run verify:install-policy` 会确认该包未安装且 `discord-rpc` 在普通 Node.js 环境安全降级。

第二实例（`second-instance`）仅恢复/聚焦主窗口或迷你播放器，**不**解析 `commandLine` /
自定义 URL 深链。在产品明确实现协议客户端之前，argv 交接为 N/A。

仓库内字体均为已转换并提交的 `.woff2` 资源，构建和打包不执行字体转换。不要为了安装时
生成字体重新引入 native converter；若未来需要重建字体资产，必须提供独立、可验证的
转换脚本和跨平台 fallback。

开发运行：

```bash
pnpm run dev
```

### Linux 输入法（fcitx5/ibus）说明

KDE Plasma Wayland 会话下，KWin 只有在 `kwinrc` 的 `[Wayland]` 组配置了
`InputMethod`（KDE 系统设置 → 虚拟键盘）时，才会向 Wayland 客户端暴露
`zwp_input_method` 协议 —— 这是 Wayland 原生 text-input 通道的前提。未配置时，
Chromium/Electron 在 Wayland 下无法通过 text-input 使用 fcitx5/ibus。

处理方式（见 `src/main/imeBackend.ts` 与 `src/main/app/lifecycle.ts`）：

- 检测到「Linux + Wayland + KWin/Plasma + 未配置输入法」时，应用以真实启动参数
  `--ozone-platform=x11` 运行（X11/XWayland 后端），fcitx5 通过
  `GTK_IM_MODULE`/XIM 链路工作，与 VS Code 等 Electron 应用一致。
- 为什么必须用真实参数：Chromium 的 ozone 平台在 Electron 二进制启动阶段确定，
  早于任何主进程 JS。环境变量（`OZONE_PLATFORM` 等）对 Electron 无效；
  `app.commandLine.appendSwitch()` 只影响子进程（renderer/GPU），无法改变
  browser 进程自身。
- 开发/预览模式（`pnpm run dev` / `pnpm run start`）由
  `scripts/run-electron-vite.cjs` 在启动时透传参数（electron-vite 的 `--` 透传
  机制）；打包后的生产模式由 `src/main/index.ts` 的 `relaunchWithX11BackendIfNeeded()`
  自重启并携带参数。
- KWin 已配置输入法时，遵循 fcitx-im 官方建议使用 text-input-v1（KWin 对
  text-input-v3 存在协议理解差异）；GNOME/Sway 等仅支持 v3 的 compositor 保持 v3。

渲染层 IME 注意事项（`src/renderer/src/components/AnimatedInput.vue`）：

- 自定义输入框不得在 IME composition 期间丢弃 `input` 事件：X11/XIM 路径下
  commit 文本的 `input` 事件可能与 `compositionend` 时序不一致，只依赖
  `compositionend` + `setTimeout(0)` 兜底会丢失已提交的中文。
- 不要对需要中文输入的输入框使用 `type="search"`（Chromium 对 search 框有独立
  IME/清除按钮处理，提交时序与 `type="text"` 不同），统一用 `type="text"`。

类型检查与构建：

```bash
pnpm run typecheck
pnpm run build
```

Lint 与格式化：

```bash
pnpm run lint
pnpm run format
```

应用测试：

```bash
pnpm run test:plugins
pnpm run test:audio-manager
pnpm run test:playback-routing
pnpm run test:local-perf
pnpm run test:plugin-tooling
pnpm run test:app
```

单个 TS 测试文件：

```bash
node --experimental-strip-types --test src/renderer/src/utils/logicalTrackModel.test.ts
```

Windows MinGW 原生音频引擎：

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

配置脚本会在调用 CMake 前验证 vcpkg、MinGW 编译器、Ninja 和 GNU `patch`，并清理指向已移动构建目录的 CTest 注册。Git for Windows 的 `patch.exe` 必须优先于 w64devkit 的 BusyBox 版本；未安装 Git 时设置 `TWILIGHT_GNU_PATCH`。当仓库路径包含空白时，必须设置 `TAE_MINGW_BUILD_DIR` 到一个可写且完整路径不含空白的外部目录；配置、构建、CTest、暂存和临时目录 `$env:TAE_MINGW_BUILD_DIR\tmp` 都使用它。不要把本机工具链路径写入 CMake preset。

无真实设备发布前 gate：

```bash
pnpm run test:no-real-device
```

## 变更验证建议

按改动范围选择最小但足够的验证：

- renderer 搜索、最近播放、收藏、逻辑曲目：`pnpm run test:playback-routing`
- 本地曲库性能、列表、收藏按钮：`pnpm run test:local-perf`
- 插件 manifest、依赖、索引、provider routing：`pnpm run test:plugins`
- 音频引擎 IPC、播放/分析 service client、BPM/loudness manager：`pnpm run test:audio-manager`
- 其余可执行应用契约（设置、导航、OPRA、逻辑曲目和音频证据 CLI）：`pnpm run test:app`
- 跨 main/preload/renderer 类型变更：`pnpm run typecheck`
- 发布前：按 [windows-release-gate.md](./windows-release-gate.md) 执行完整 gate

真实设备 smoke 不属于默认 gate。ASIO、WASAPI Exclusive、native DSD、SACD ISO、CoreAudio、ALSA `hw:` 等验证需要明确设备与曲目样本。

## 代码风格

Prettier 配置：单引号、无分号、`printWidth: 100`、无 trailing comma。ESLint 使用 flat config，Vue SFC 必须使用 `<script lang="ts">`。

测试使用 Node 内置 `node --test`，TS 测试通过 `--experimental-strip-types` 运行。新增测试应与被测文件 co-locate，命名为 `*.test.ts`、`*.test.mjs` 或 `*.test.cjs`。

renderer import 使用 `@renderer/*` alias 或已有局部模式，避免跨层深度相对路径。主进程、preload、renderer 的类型边界要显式维护，不要让 renderer 直接依赖 main 内部实现。
