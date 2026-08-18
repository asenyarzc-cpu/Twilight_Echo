# 开发指南

## 环境准备

1. **安装 Flutter**（stable 通道，Dart ≥ 3.11.4）
2. **安装 Android SDK**，targetSdk 设为 35
3. **连接设备**：Android 真机（推荐 ARM64）或 Genymotion / 模拟器

## 首次构建

```bash
flutter pub get
flutter run
```

如依赖下载缓慢，可配置 Flutter 镜像源：

```bash
flutter config --start-pausing-slow-operations
# 或使用国内镜像：https://flutter.cn/
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `flutter analyze` | 静态分析 |
| `flutter test` | 运行测试 |
| `flutter run --release` | 真机调试构建 |
| `flutter build apk --target-platform=android-arm64` | 发布 APK |

## 调试技巧

### 自定义源调试

在设置页 →「调试日志」可查看完整请求日志。日志文件位于：
`<app-documents>/logs/twilight_echo.log`

### 网络代理

通过 `NetworkAdapterMode` 设置切换直连 / 代理模式，影响 `dio_factory.dart` 中的请求方式。

### 性能分析

```bash
flutter run --profile
# 使用 DevTools 查看帧率、内存、网络
```

## 添加新音源

1. 在 `lib/core/sdk/` 下创建 SDK 适配文件（如 `my_sdk.dart`）。
2. 在 `MusicSDK` 注册器中增加入口。
3. 在 `lib/features/music_sources/` 添加管理 UI。

## 添加新页面

1. 在 `lib/features/<feature>/` 下创建页面组件。
2. 在 `lib/router.dart` 注册路由。
3. 在 `lib/features/shell/` 添加导航入口（如需）。

## 代码规范

- Dart 使用 `flutter_lints` 规则集（详见 `analysis_options.yaml`）。
- 异步代码统一使用 `async/await`。
- Provider 命名以 `Provider` 或 `NotifierProvider` 结尾。
- Widget 组件使用 `const` 构造器。
- 公开类添加注释说明用途和关键约束。