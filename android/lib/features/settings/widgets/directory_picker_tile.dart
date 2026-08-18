import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/services/permission_service.dart';
import '../../../core/storage/settings_store.dart';
import '../../../core/ui/app_toast.dart';

class DirectoryPickerTile extends ConsumerWidget {
  const DirectoryPickerTile({super.key, required this.currentPath});

  final String currentPath;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(
          leading: const Icon(Icons.folder_outlined),
          title: const Text('下载位置'),
          subtitle: Text(
            currentPath,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _pick(context, ref),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(72, 0, 16, 12),
          child: Wrap(
            spacing: 8,
            children: [
              ActionChip(
                avatar: const Icon(Icons.refresh, size: 16),
                label: const Text('恢复默认'),
                onPressed: () async {
                  await ref
                      .read(settingsProvider.notifier)
                      .setDownloadDir(kDefaultDownloadDir);
                  if (!context.mounted) return;
                  showAppToast(
                    context,
                    '已恢复默认下载位置',
                    type: AppToastType.success,
                  );
                },
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _pick(BuildContext context, WidgetRef ref) async {
    final ok = await PermissionService.ensureExternalStorageWrite();
    if (!context.mounted) return;
    if (!ok) {
      showAppToast(context, '未授予存储权限，将无法写入公共目录', type: AppToastType.warning);
      return;
    }

    final path = await FilePicker.platform.getDirectoryPath(
      dialogTitle: '选择下载目录',
      lockParentWindow: true,
    );
    if (!context.mounted) return;
    if (path == null || path.isEmpty) return;

    try {
      final dir = Directory(path);
      if (!dir.existsSync()) await dir.create(recursive: true);
      final probe = File('${dir.path}${Platform.pathSeparator}.twilight_echo_probe');
      await probe.writeAsString('ok');
      await probe.delete();
    } catch (e) {
      if (!context.mounted) return;
      showAppToast(context, '该目录不可写: $e', type: AppToastType.error);
      return;
    }

    await ref.read(settingsProvider.notifier).setDownloadDir(path);
    if (!context.mounted) return;
    showAppToast(context, '下载目录已切换到 $path', type: AppToastType.success);
  }
}
