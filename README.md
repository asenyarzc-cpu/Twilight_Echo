# Twilight Echo

> Twilight Echo 是一款现代的音乐播放器，有现代的UI和流媒体播放，本地播放功能。

## 功能特性

- **本地音乐库管理**
  - 按歌曲、艺术家、专辑进行浏览
  - 持久化保存已扫描的音乐库与文件夹记录
- **网易云音乐流媒体模式**
  - 支持二维码登录网易云音乐
  - 支持读取登录状态与个人资料
  - 支持推荐歌曲、推荐歌单、私人漫游、私人雷达
  - 支持查看我喜欢的音乐与个人歌单
  - 支持在线搜索歌曲与收藏/取消收藏
- 良好的音频输出能力
  - 采用mpv作为播放引擎
  - 拥有WASAPI独占输出，确保音频流以原始采样率和位深（如 96kHz/24bit）传输，不经过系统的重采样算法，从而避免了数字转换带来的失真和底噪。
  - 自动切换比特率

## 技术栈

- Electron
- Vue 3
- TypeScript
- Vite / electron-vite
- PrimeVue
- mpv
- `@neteasecloudmusicapienhanced/api`
- `music-metadata`

## 支持的音频格式

项目当前在主进程中支持主流的音频格式，包括：

> .mp3 .flac .wav .aac .ogg .wma .m4a .aiff / .aif .opus .webm .alac .ape .wv .dsf .dff

## 项目结构

```text
src/
├─ main/         Electron 主进程，负责窗口、文件扫描、mpv、NCM API
├─ preload/      预加载层，向渲染进程暴露 IPC API
└─ renderer/     Vue 前端界面
   └─ src/
      ├─ components/
      ├─ stores/
      ├─ types/
      └─ utils/
```

## 开发前准备

请先确保你的环境中具备：

- Node.js 18+
- npm 或 pnpm

推荐直接使用项目现有锁文件对应的包管理器安装依赖。

### 关于 mpv

项目播放能力依赖 mpv：

- 开发环境下，代码会优先尝试直接调用系统中的 `mpv`
- 打包时，项目会尝试将 `resources/mpv.zip` 解压到 `resources/mpv/` 后随应用分发

如果你是在本地开发并遇到无法播放的问题，通常需要：

1. 在系统中安装 `mpv`
2. 或者确保项目打包资源中的 mpv 可用

## 安装依赖

如果你使用 pnpm：

```bash
pnpm install
```

如果你使用 npm：

```bash
npm install
```

## 启动开发环境

```bash
pnpm dev
```

或：

```bash
npm run dev
```

启动后会打开 Electron 桌面窗口。

## 代码检查与格式化

### Type Check

```bash
npm run typecheck
```

### Lint

```bash
npm run lint
```

### Format

```bash
npm run format
```

## 构建应用

### 通用构建

```bash
npm run build
```

### 平台打包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

### 额外说明

- 打包配置位于 `electron-builder.yml`
- 打包前会执行 `scripts/extract-mpv.cjs`
- 打包后会执行 `scripts/copy-node-modules.cjs`

## 使用说明

### 1. 导入本地音乐

启动应用后，可以选择音乐文件夹进行扫描。程序会：

- 递归查找支持的音频文件
- 自动提取元数据
- 尝试读取封面与歌词
- 将扫描结果保存到本地用户数据目录

### 2. 使用流媒体模式

进入流媒体页面后，可以通过二维码登录网易云音乐。登录后可使用：

- 首页推荐
- 在线搜索
- 我喜欢的音乐
- 个人歌单
- 推荐歌单

### 3. 播放控制

播放器支持：

- 播放 / 暂停
- 上一首 / 下一首
- 调整播放进度
- 音量控制
- 播放模式切换
- 独占模式切换

## 数据存储

应用会将部分数据保存在 Electron 用户目录中，包括：

- 本地音乐库数据
- 已扫描文件夹记录
- 网易云登录 Cookie

## 已知注意事项

- 网易云相关能力依赖本地启动的增强 API 服务
- 开发环境下若系统中没有 `mpv`，播放功能可能不可用
- Windows 独占模式开启后，其他应用可能无法同时输出音频
- 部分打包流程依赖 `resources/mpv.zip` 是否存在
