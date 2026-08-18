# 架构总览

## 分层设计

```
┌──────────────────────────────────────┐
│  UI Layer                            │
│  lib/features/  (页面 + 组件)        │
│  lib/theme/       (主题 + 动效)       │
│  lib/core/ui/     (通用 UI 工具)      │
├──────────────────────────────────────┤
│  State Layer                         │
│  Riverpod Providers                  │
│  (settings / player / music sources) │
├──────────────────────────────────────┤
│  Domain Layer                        │
│  lib/core/services/  (业务服务)       │
│  lib/core/sdk/         (音源适配)     │
│  lib/core/models/      (数据模型)     │
├──────────────────────────────────────┤
│  Infrastructure Layer                │
│  lib/core/api/          (Dio 网络层)  │
│  lib/core/storage/      (持久化)      │
│  lib/core/music_sources/ (JS 运行时)  │
├──────────────────────────────────────┤
│  Platform Layer                      │
│  android/app/    (Kotlin + Java)     │
│  Just Audio / Audio Service          │
└──────────────────────────────────────┘
```

## 关键依赖

| 依赖 | 用途 |
|------|------|
| `flutter_riverpod` | 全局状态管理与依赖注入 |
| `dio` + `native_dio_adapter` | 网络请求（OkHttp 后端） |
| `just_audio` + `audio_service` | 音频播放 + 后台服务 |
| `go_router` | 深链接与路由管理 |
| `cached_network_image` | 图片缓存 |
| `quickjs` (Android 原生) | 自定义源 JS 运行时 |
| `jaudiotagger` (Android 原生) | 音频标签读写 |

## 数据流

```
[用户操作] → UI Widget → Riverpod State → Service → API / Storage
                                                      ↓
                                                      UI 更新
```

## 状态管理约定

1. **全局状态** 通过 Riverpod Provider 声明，位于 `lib/core/` 下的 `*_provider.dart` 或 `*_store.dart`。
2. **页面局部状态** 使用 `ConsumerStatefulWidget` 的 `ConsumerState`。
3. **异步数据** 使用 `FutureProvider` 或 `AsyncValue`。
4. **副作用** 通过 `ref.onDispose` 或 `PostFrameCallback` 注册。

## 音源架构

自定义音源以 JavaScript 脚本形式注入 `MusicSourceRuntimeBridge`，通过 `MethodChannel` 与 Dart 层通信。音源脚本暴露 `search`、`urlResolve`、`lyrics`、`playlists` 等接口，由 `music_source_runtime.dart` 统一调度。

参见 `lib/core/music_sources/` 目录。