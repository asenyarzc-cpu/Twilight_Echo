import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// 应用显示名称（同步自 `pubspec.yaml` 中的 `name` 字段）。
const appDisplayName = 'Twilight Echo';
/// 兜底版本号。当 `PackageInfo.version` 为空或平台不可用时使用。
const fallbackAppVersion = '1.0.0';

final packageInfoProvider = FutureProvider<PackageInfo>((ref) {
  return PackageInfo.fromPlatform();
});

final appVersionLabelProvider = Provider<String>((ref) {
  final version = ref
      .watch(packageInfoProvider)
      .maybeWhen(
        data: (info) {
          final value = info.version.trim();
          return value.isEmpty ? fallbackAppVersion : value;
        },
        orElse: () => fallbackAppVersion,
      );

  return '$appDisplayName $version';
});
