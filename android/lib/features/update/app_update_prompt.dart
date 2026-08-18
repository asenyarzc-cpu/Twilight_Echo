import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_info.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/app_update_service.dart';
import '../../core/ui/app_toast.dart';

enum AppUpdateCheckOutcome {
  updateAvailable,
  upToDate,
  failed,
  alreadyChecking,
}

bool _appUpdateCheckInProgress = false;

Future<AppUpdateCheckOutcome> checkForAppUpdate(
  BuildContext context,
  WidgetRef ref, {
  bool showFeedback = false,
}) async {
  if (_appUpdateCheckInProgress) {
    if (showFeedback && context.mounted) {
      showAppToast(context, '正在检查更新，请稍候');
    }
    return AppUpdateCheckOutcome.alreadyChecking;
  }
  _appUpdateCheckInProgress = true;

  AppToastHandle? progressToast;
  if (showFeedback) {
    progressToast = showAppToast(
      context,
      '正在检查更新…',
      duration: const Duration(seconds: 10),
    );
  }

  try {
    final packageInfo = await ref.read(packageInfoProvider.future);
    final latest = await ref
        .read(appUpdateServiceProvider)
        .fetchLatestRelease();
    if (!context.mounted) return AppUpdateCheckOutcome.failed;
    dismissAppToast(progressToast, showRemoveAnimation: false);
    progressToast = null;

    if (latest == null ||
        !isNewerAppVersion(
          currentVersion: packageInfo.version,
          latestVersion: latest.tagName,
        )) {
      if (showFeedback) {
        showAppToast(
          context,
          '已是最新版（${packageInfo.version}）',
          type: AppToastType.success,
        );
      }
      return AppUpdateCheckOutcome.upToDate;
    }

    await _showUpdateDialog(
      context,
      ref,
      currentVersion: packageInfo.version,
      release: latest,
    );
    return AppUpdateCheckOutcome.updateAvailable;
  } catch (error) {
    await AppLogger.write('update', 'check failed: $error');
    if (context.mounted && showFeedback) {
      showAppToast(context, '检查更新失败，请稍后重试', type: AppToastType.warning);
    }
    return AppUpdateCheckOutcome.failed;
  } finally {
    _appUpdateCheckInProgress = false;
    dismissAppToast(progressToast, showRemoveAnimation: false);
  }
}

Future<void> _showUpdateDialog(
  BuildContext context,
  WidgetRef ref, {
  required String currentVersion,
  required AppRelease release,
}) async {
  final shouldOpen = await showDialog<bool>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) => AlertDialog(
      key: const ValueKey('app-update-dialog'),
      icon: const Icon(Icons.system_update_alt_rounded, size: 36),
      title: const Text('发现新版本'),
      content: Text(
        '$currentVersion  →  ${release.version}\n\n'
        '${release.title}\n'
        '将前往 GitHub Release 页面，由你选择并下载更新包。',
      ),
      actions: [
        TextButton(
          key: const ValueKey('app-update-later'),
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('稍后再说'),
        ),
        FilledButton(
          key: const ValueKey('app-update-open-release'),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: const Text('前往下载'),
        ),
      ],
    ),
  );
  if (shouldOpen != true || !context.mounted) return;

  try {
    final opened = await ref.read(externalUriLauncherProvider)(release.pageUri);
    if (!opened && context.mounted) {
      showAppToast(context, '无法打开 GitHub Release 页面', type: AppToastType.error);
    }
  } catch (error) {
    await AppLogger.write('update', 'open release page failed: $error');
    if (context.mounted) {
      showAppToast(context, '无法打开 GitHub Release 页面', type: AppToastType.error);
    }
  }
}
