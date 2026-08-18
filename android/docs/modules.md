# 模块说明

## core/services/

| 文件 | 职责 |
|------|------|
| `download_service.dart` | 下载队列调度、分片缓存、文件写入 |
| `app_logger.dart` | 文件级日志（1 MiB 轮转） |
| `app_update_service.dart` | GitHub Release 检查与解析 |
| `flac_metadata_writer.dart` | FLAC 标签写入（Sidecar 文件） |
| `tagger.dart` | 音频标签通用接口（ID3v2 / Vorbis / FLAC） |
| `lyric_builder.dart` | 歌词合并（逐句 + 逐字 + 翻译） |
| `permission_service.dart` | 存储/媒体权限处理 |
| `storage_browser_service.dart` | Android SAF 文件选择器 |

## core/sdk/

| 文件 | 对应音源 |
|------|----------|
| `tx_sdk.dart` | 腾讯音乐 |
| `wy_sdk.dart` | 网易云音乐 |
| `kg_sdk.dart` | 酷狗音乐 |
| `kw_sdk.dart` | 酷我音乐 |
| `mg_sdk.dart` | 咪咕音乐 |

每个 SDK 统一实现 `search`、`urlResolve`、`lyrics`、`playlists` 接口。

## core/music_sources/

自定义源运行时，通过 `QuickJS` 引擎执行 JavaScript 脚本。脚本接口由 `music_source_models.dart` 定义，运行时通过 `MusicSourceController` 注册和生命周期管理。

## core/storage/

- `settings_store.dart` — 全局偏好设置（主题、下载目录、网络模式）
- `base_url.dart` — 默认路径配置

## features/

| 目录 | 说明 |
|------|------|
| `search/` | 搜索页、搜索控制器、音质选择器 |
| `downloads/` | 下载历史、进度展示、下载队列 |
| `songs/` | 本地歌曲库、扫描缓存、排序操作 |
| `player/` | 播放器核心、歌词面板、音轨模型 |
| `music_sources/` | 自定义源导入与管理界面 |
| `playlists/` | 在线歌单导入、本地收藏、跨源合并 |
| `settings/` | 下载/网络/外观/音源设置 |
| `shell/` | 底部导航、页面切换、工具栏 |
| `startup/` | 启动页、每日诗词 |
| `debug/` | 调试日志页 |
| `discovery/` | 发现页、推荐歌单 |
| `update/` | 版本更新提示 |

## theme/

- `app_theme.dart` — Material 3 主题定义（light / dark）
- `app_motion.dart` — 统一动效曲线
- `dynamic_color_scheme.dart` — 从 `CorePalette` 提取主题色
- `seed_palette.dart` — 种子色选取

## Android 原生层

| 文件 | 职责 |
|------|------|
| `MainActivity.kt` | Flutter 引擎初始化、MethodChannel 注册 |
| `MusicSourceRuntimeBridge.java` | QuickJS 引擎 + 音源脚本运行 |
| `MusicSourceConsole.java` | JS 控制台日志转发 |
| `MusicSourceCrypto.java` | JS 加密函数桥接 |

## 通信通道

Dart ↔ Kotlin/Java 通过以下 MethodChannel 通信：

- `twilight_echo/media_scan` — 媒体扫描
- `twilight_echo/audio_intent` — 音频 Intent 处理
- `twilight_echo/native_tagger` — 音频标签写入
- `twilight_echo/app_task` — 前台任务
- `twilight_echo/storage_browser` — SAF 文件选择
- `twilight_echo/music_source_runtime` — 音源脚本执行