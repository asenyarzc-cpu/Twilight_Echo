# Twilight Echo

Twilight Echo 是一个基于 [`Electron`](package.json)、[`Vue 3`](package.json) 与 [`TypeScript`](package.json) 构建的桌面音乐播放器，支持本地音频扫描、封面与歌词读取、基于 [`mpv`](src/main/mpvManager.ts:42) 的音频播放，以及网易云音乐登录与歌单加载能力。

项目当前采用 [`electron-vite`](package.json:15) 作为开发与构建基础，界面位于 [`src/renderer`](src/renderer)，桌面端主进程逻辑位于 [`src/main`](src/main)，预加载桥接位于 [`src/preload`](src/preload)。

## 功能特性

- 本地音乐库扫描：递归扫描目录中的常见音频格式，支持从文件元数据中读取歌曲信息，相关逻辑见 [`scanDirectory()`](src/main/index.ts:160)
- 多格式音频支持：包括 `mp3`、`flac`、`wav`、`aac`、`ogg`、`m4a`、`opus`、`ape`、`dsf` 等，格式列表定义于 [`SUPPORTED_EXTENSIONS`](src/main/index.ts:11)
- 封面与歌词读取：优先读取嵌入式封面，缺失时回退到同目录封面文件；支持读取同名 `lrc` 歌词，相关实现见 [`findCoverInDir()`](src/main/index.ts:27) 与 [`findLyricsInDir()`](src/main/index.ts:46)
- 高质量播放内核：通过 [`MpvManager`](src/main/mpvManager.ts:42) 管理 `mpv` 进程，使用 `WASAPI` 输出并支持独占模式
- 桌面播放器交互：包含标题栏、侧边菜单、歌曲列表、播放控制栏与沉浸式播放页，入口见 [`App.vue`](src/renderer/src/App.vue:1)
- 网易云音乐集成：支持登录状态检查、获取用户信息、加载“喜欢的音乐”和用户歌单，核心状态管理见 [`useNcmStore()`](src/renderer/src/stores/useNcmStore.ts:162)
- 本地与在线场景切换：应用支持在本地音乐浏览与流媒体页面之间切换，界面状态由 [`App.vue`](src/renderer/src/App.vue:15) 管理

## 技术栈

### 桌面端

- [`Electron`](package.json:50)
- [`electron-vite`](package.json:52)
- [`electron-builder`](package.json:51)

### 前端界面

- [`Vue 3`](package.json:58)
- [`TypeScript`](package.json:56)
- [`PrimeVue`](package.json:42)
- [`primeicons`](package.json:41)

### 音频与媒体处理

- [`music-metadata`](package.json:36)：读取本地音频元数据
- 自定义 [`MpvManager`](src/main/mpvManager.ts:42)：负责 `mpv` 播放进程与 IPC 控制

### 在线音乐能力

- [`@neteasecloudmusicapienhanced/api`](package.json:27)：提供网易云音乐 API 能力
- 项目对该依赖应用了补丁，定义见 [`patches/@neteasecloudmusicapienhanced__api@4.32.0.patch`](patches/@neteasecloudmusicapienhanced__api@4.32.0.patch)

## 项目结构

```text
.
├─ build/                      # 打包图标与平台相关资源
├─ patches/                    # pnpm patchedDependencies 补丁
├─ resources/                  # 字体、图标与 mpv 相关资源
├─ scripts/                    # 打包前后脚本
├─ src/
│  ├─ main/                    # Electron 主进程
│  ├─ preload/                 # 预加载脚本与桥接 API
│  └─ renderer/                # Vue 渲染进程应用
├─ electron-builder.yml        # 打包配置
├─ electron.vite.config.ts     # Electron + Vite 配置
└─ package.json                # 依赖与脚本定义
```

## 运行环境要求

建议使用以下环境：

- Node.js 20+
- [`pnpm`](package.json) 9+
- Windows 10/11（当前实现对 `mpv` 的 `WASAPI` 输出支持更完整，见 [`MpvManager.start()`](src/main/mpvManager.ts:95)）

## 安装依赖

```bash
pnpm install
```

安装完成后会触发 [`postinstall`](package.json:17)，执行 `electron-builder install-app-deps` 以补齐 Electron 相关依赖。

## 开发启动

```bash
pnpm dev
```

该命令会启动 [`electron-vite`](package.json:15) 开发环境，包括：

- Electron 主进程
- 渲染进程热更新服务
- 预加载脚本编译

## 常用脚本

在 [`package.json`](package.json:8) 中定义了以下脚本：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发环境 |
| `pnpm start` | 预览构建结果 |
| `pnpm lint` | 执行 ESLint 检查 |
| `pnpm format` | 使用 Prettier 格式化项目 |
| `pnpm typecheck` | 执行主进程与渲染进程类型检查 |
| `pnpm build` | 类型检查后执行完整构建 |
| `pnpm build:unpack` | 构建未打包目录版本 |
| `pnpm build:win` | 打包 Windows 安装包 |
| `pnpm build:mac` | 打包 macOS 版本 |
| `pnpm build:linux` | 打包 Linux 版本 |

## 打包说明

项目使用 [`electron-builder.yml`](electron-builder.yml) 进行打包配置。

### Windows

```bash
pnpm build:win
```

### macOS

```bash
pnpm build:mac
```

### Linux

```bash
pnpm build:linux
```

默认配置中：

- 打包前会执行 [`scripts/extract-mpv.cjs`](scripts/extract-mpv.cjs)
- 打包后会执行 [`scripts/copy-node-modules.cjs`](scripts/copy-node-modules.cjs)
- 产物名称与平台配置定义在 [`electron-builder.yml`](electron-builder.yml:1)

## 本地音乐功能说明

Twilight Echo 的本地音乐能力主要由主进程负责：

1. 递归遍历用户选择的目录
2. 根据 [`SUPPORTED_EXTENSIONS`](src/main/index.ts:11) 过滤支持的音频文件
3. 使用 [`parseTrack()`](src/main/index.ts:104) 读取元数据
4. 自动补充：
   - 歌手 / 标题回退解析
   - 专辑名默认值
   - 内嵌或目录封面
   - 同名歌词文件

如果文件名采用 `歌手 - 标题` 形式，应用会在元数据缺失时使用 [`getNameFromFile()`](src/main/index.ts:57) 进行回退解析。

## 网易云音乐功能说明

在线音乐相关能力集中在 [`useNcmStore()`](src/renderer/src/stores/useNcmStore.ts:162)，主要包括：

- 检查登录状态 [`checkLogin()`](src/renderer/src/stores/useNcmStore.ts:172)
- 获取用户信息与签名
- 拉取用户歌单 [`fetchUserLibrary()`](src/renderer/src/stores/useNcmStore.ts:227)
- 缓存歌单歌曲与播放链接
- 管理退出登录后的状态重置

应用在启动时会于 [`onMounted()`](src/renderer/src/App.vue:136) 中调用本地音乐加载与登录状态检查。

## mpv 相关说明

项目使用外部 `mpv` 作为音频播放引擎，而不是直接依赖浏览器音频能力。核心特点如下：

- 通过命名管道进行 JSON IPC 通信，连接逻辑见 [`connectToPipe()`](src/main/mpvManager.ts:156)
- 默认启用 `WASAPI` 音频输出，参数配置见 [`MpvManager.start()`](src/main/mpvManager.ts:95)
- 可根据配置启用独占模式以减少系统混音干预
- 打包时会将 `mpv` 资源带入安装产物，配置见 [`extraResources`](electron-builder.yml:19)

如果本地环境没有找到内置 `mpv`，程序会尝试直接调用系统中的 `mpv` 可执行文件，逻辑见 [`findMpv()`](src/main/mpvManager.ts:29)。

## 推荐开发工具

- [VS Code](https://code.visualstudio.com/)
- ESLint 插件
- Prettier 插件
- Volar 插件

## 代码质量

提交前建议至少执行以下命令：

```bash
pnpm lint
pnpm typecheck
```

如需统一格式，可执行：

```bash
pnpm format
```

## 已知注意事项

- `Windows` 平台体验可能优于其他平台，因为当前播放链路显式使用了 `WASAPI`，见 [`--ao=wasapi`](src/main/mpvManager.ts:102)
- 在线音乐能力依赖网易云接口可用性与本地 Cookie 状态
- 打包配置中的发布地址仍为示例地址，见 [`publish.url`](electron-builder.yml:52)

