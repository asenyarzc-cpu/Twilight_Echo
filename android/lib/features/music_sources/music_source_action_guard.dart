import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/download_capabilities.dart';
import '../../core/models/enums.dart';
import '../../core/music_sources/music_source_controller.dart';
import '../../core/ui/app_toast.dart';
import '../downloads/download_history_entry.dart';

Future<bool> ensureOnlineMusicSourcesAvailable(
  BuildContext context,
  Iterable<MusicSource> sources,
) async {
  final container = ProviderScope.containerOf(context, listen: false);
  var capabilities = container.read(downloadCapabilitiesProvider).valueOrNull;
  if (capabilities == null) {
    try {
      final state = await container.read(musicSourceControllerProvider.future);
      capabilities = state.downloadCapabilities;
    } catch (_) {
      if (!context.mounted) return false;
      showAppToast(context, '音乐源状态加载失败，请稍后重试', type: AppToastType.warning);
      return false;
    }
  }
  if (!context.mounted) return false;

  final message = onlineMusicSourceUnavailableMessage(capabilities, sources);
  if (message == null) return true;
  showAppToast(context, message, type: AppToastType.warning);
  return false;
}

Future<bool> ensureQueueEntryMusicSourceAvailable(
  BuildContext context,
  DownloadHistoryEntry entry,
) {
  final path = entry.savedPath?.trim();
  if (path != null && path.isNotEmpty && File(path).existsSync()) {
    return Future<bool>.value(true);
  }
  final music = entry.musicInfo;
  if (music == null) return Future<bool>.value(true);
  return ensureOnlineMusicSourcesAvailable(context, [music.source]);
}

String? onlineMusicSourceUnavailableMessage(
  DownloadCapabilities capabilities,
  Iterable<MusicSource> sources,
) {
  if (capabilities.availableSources.isEmpty) {
    return '请先在设置中导入并启用音源';
  }
  final checked = <MusicSource>{};
  for (final source in sources) {
    if (!checked.add(source) || capabilities.isAvailable(source)) continue;
    return '已启用的音源均不支持${source.label}';
  }
  return null;
}
