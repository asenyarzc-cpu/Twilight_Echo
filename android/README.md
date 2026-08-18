# Twilight Echo — Android 音乐播放器

Twilight Echo 是一个基于 Flutter 构建的 Android 音乐播放器，支持自定义音乐源、在线/本地播放、歌词同步、下载管理及可定制的 Material 3 主题。

> 本模块作为 **Twilight Echo** 项目的子项目维护，包名为 `com.twilight.echo`，GitHub 仓库为 `asenyarzc-cpu/Twilight_Echo`。

---

## 功能概览

| 模块 | 说明 |
|------|------|
| **自定义源** | 导入、启用/禁用、管理第三方音乐源，支持动态解析 |
| **音乐检索** | 关键词搜索、来源筛选、结果分页 |
| **下载管理** | 队列调度、实时进度、历史记录、失败重试 |
| **本地歌曲库** | 目录扫描、标签读取、排序、批量操作 |
| **播放器** | 在线/本地播放、后台播放、媒体通知、耳机按键 |
| **歌词同步** | 逐句/逐字歌词、翻译、卡拉 OK 高亮 |
| **歌单管理** | 在线歌单导入、本地收藏、跨源合并 |
| **主题外观** | 浅色/深色/跟随系统、动态取色、自定义主题色 |
| **调试工具** | 应用内日志、网络设置、性能监控 |

---

## 目录结构

```
├── android/                  # Android 原生工程
│   ├── app/src/main/kotlin/com/twilight_echo/music/
│   └── app/src/main/java/com/twilight_echo/music/
├── lib/
│   ├── main.dart             # 应用入口，依赖注入初始化
│   ├── app.dart              # MaterialApp 配置、主题、权限请求
│   ├── router.dart           # go_router 路由定义
│   ├── core/                 # 核心基础设施
│   │   ├── api/              # 网络层封装（Dio + 适配器）
│   │   ├── models/           # 数据模型（歌曲、音质、搜索响应等）
│   │   ├── music_sources/    # 自定义源运行时与管理
│   │   ├── sdk/              # 音源 SDK 适配（QQ/网易/酷狗/酷我/咪咕）
│   │   ├── services/         # 下载、标签、歌词、权限、日志服务
│   │   ├── storage/          # 本地持久化（设置、URL 配置）
│   │   └── ui/               # 通用 UI 组件（Toast、刷新、Cover 占位）
│   ├── features/
│   │   ├── search/           # 搜索页与结果处理
│   │   ├── downloads/        # 下载队列与历史
│   │   ├── songs/            # 本地歌曲库
│   │   ├── player/           # 播放器核心与歌词同步
│   │   ├── music_sources/    # 自定义源导入界面
│   │   ├── playlists/        # 歌单与收藏
│   │   ├── settings/         # 设置页
│   │   ├── shell/            # 底部导航框架
│   │   ├── startup/          # 启动页
│   │   ├── debug/            # 调试日志页
│   │   ├── discovery/        # 发现页
│   │   └── update/           # 版本更新提示
│   └── theme/                # Material 3 主题与动效定义
├── test/                     # 单元测试与诊断脚本
├── screenshots/              # 产品截图
├── icon.svg / icon.png       # 应用图标
├── pubspec.yaml              # Flutter 依赖配置
└── docs/                     # 开发文档
```

---

## 快速开始

### 环境要求

- Flutter stable，Dart SDK ≥ 3.11.4
- Android SDK（targetSdk 35）
- Android 真机或模拟器（建议 ARM64）

### 安装与运行

```bash
flutter pub get
flutter run
```

### 构建 APK

```bash
flutter build apk --target-platform=android-arm64
```

构建渠道由 Git 分支自动判断：`main` 生成正式版（`com.twilight.echo`），`dev` 生成开发版（`com.twilight.echo.dev`），两者可同时安装。

---

## 质量检查

```bash
flutter analyze
flutter test
```

---

## 开发与贡献

详见 `docs/` 目录：

- [架构总览](docs/architecture.md)
- [开发指南](docs/getting-started.md)
- [模块说明](docs/modules.md)

---

## 相关项目

- **GitHub 仓库**：https://github.com/asenyarzc-cpu/Twilight_Echo

---

## 免责声明

本项目仅用于技术研究与学习交流，不提供任何音乐内容，不保证任何自定义源的可用性。使用者应遵守所在地区法律法规、第三方服务条款及著作权要求，并自行承担使用本项目产生的责任。