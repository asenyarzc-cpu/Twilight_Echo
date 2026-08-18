import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/music_info.dart';
import '../../../core/storage/settings_store.dart';
import '../../../core/ui/app_toast.dart';
import '../../playlists/playlist_browser_sheet.dart';
import '../../playlists/playlist_store.dart';
import '../../search/widgets/quality_picker_sheet.dart';
import '../player_controller.dart';
import 'player_quality_sheet.dart';

enum _PlayerCoverResult { addToPlaylist, download, quality }

Future<void> showPlayerCoverActionsSheet(
  BuildContext context,
  WidgetRef ref, {
  required PlayerTrack track,
  required bool wide,
}) async {
  final music = ref.read(playerControllerProvider.notifier).currentMusic;
  final scheme = Theme.of(context).colorScheme;
  final result = await showModalBottomSheet<_PlayerCoverResult>(
    context: context,
    useRootNavigator: true,
    useSafeArea: true,
    showDragHandle: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    barrierColor: scheme.scrim.withValues(alpha: 0.36),
    builder: (_) =>
        _PlayerCoverActionsSheet(track: track, music: music, wide: wide),
  );
  if (result == null || !context.mounted) return;
  switch (result) {
    case _PlayerCoverResult.addToPlaylist:
      if (music != null) {
        await _addCurrentMusicToPlaylist(context, ref, music);
      }
    case _PlayerCoverResult.download:
      if (music != null && !track.isLocal) {
        await showQualityPickerSheet(context, music);
      }
    case _PlayerCoverResult.quality:
      await showPlaybackQualitySheet(context, ref, track: track);
  }
}

Future<void> _addCurrentMusicToPlaylist(
  BuildContext context,
  WidgetRef ref,
  MusicInfo music,
) async {
  final destination = await showPlaylistBrowserSheet(
    context,
    mode: PlaylistBrowserMode.addSongs,
  );
  if (!context.mounted || destination == null) return;

  const prefix = '/playlists/';
  if (!destination.startsWith(prefix)) return;
  final playlistId = destination.substring(prefix.length);
  final store = ref.read(localPlaylistsProvider.notifier);
  final playlist = store.byId(playlistId);
  if (playlist == null) {
    showAppToast(context, '歌单不存在或已被删除', type: AppToastType.warning);
    return;
  }

  try {
    final added = await store.addMusic(playlistId, music);
    if (!context.mounted) return;
    showAppToast(
      context,
      added == 0 ? '歌曲已在「${playlist.name}」中' : '已添加到「${playlist.name}」',
      type: added == 0 ? AppToastType.info : AppToastType.success,
    );
  } catch (error) {
    if (!context.mounted) return;
    showAppToast(context, '添加到歌单失败：$error', type: AppToastType.error);
  }
}

class _PlayerCoverActionsSheet extends ConsumerWidget {
  const _PlayerCoverActionsSheet({
    required this.track,
    required this.music,
    required this.wide,
  });

  final PlayerTrack track;
  final MusicInfo? music;
  final bool wide;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final miniLyrics = ref.watch(
      settingsProvider.select((settings) => settings.showMiniLyrics),
    );
    final loading = ref.watch(
      playerControllerProvider.select((state) => state.loading),
    );
    final qualityOptions = availablePlaybackQualityOptions(track);
    final canDownload = !track.isLocal && music != null;
    final canSwitchQuality =
        !track.isLocal && !loading && qualityOptions.length > 1;
    final actions = <_PlayerCoverAction>[
      _PlayerCoverAction(
        id: 'playlist',
        icon: Icons.playlist_add_rounded,
        title: '添加到歌单',
        subtitle: music == null ? '当前歌曲缺少可保存的歌曲信息' : '选择歌单并立即添加当前歌曲',
        enabled: music != null,
        onTap: () =>
            Navigator.of(context).pop(_PlayerCoverResult.addToPlaylist),
      ),
      _PlayerCoverAction(
        id: 'download',
        icon: Icons.download_rounded,
        title: '下载当前歌曲',
        subtitle: canDownload ? '选择音质并下载当前在线歌曲' : '仅在线歌曲支持下载',
        enabled: canDownload,
        onTap: () => Navigator.of(context).pop(_PlayerCoverResult.download),
      ),
      _PlayerCoverAction(
        id: 'quality',
        icon: Icons.high_quality_rounded,
        title: '切换播放音质',
        subtitle: canSwitchQuality ? '选择当前歌曲的其他可用音质' : '当前没有其他可切换音质',
        enabled: canSwitchQuality,
        onTap: () => Navigator.of(context).pop(_PlayerCoverResult.quality),
      ),
      _PlayerCoverAction(
        id: 'mini-lyrics',
        icon: Icons.subtitles_rounded,
        title: '显示迷你歌词',
        subtitle: wide ? '仅在手机播放封面页显示' : '在封面页左下角显示三行歌词',
        enabled: true,
        onTap: () => unawaited(
          ref.read(settingsProvider.notifier).setShowMiniLyrics(!miniLyrics),
        ),
        trailing: Switch(
          key: const ValueKey('player-cover-action-mini-lyrics-switch'),
          value: miniLyrics,
          onChanged: (value) => unawaited(
            ref.read(settingsProvider.notifier).setShowMiniLyrics(value),
          ),
        ),
      ),
    ];

    return SafeArea(
      key: const ValueKey('player-cover-actions-sheet'),
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.78,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 2, 8, 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      track.title.trim().isEmpty ? '未知歌曲' : track.title,
                      key: const ValueKey('player-cover-sheet-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleLarge?.copyWith(
                        color: scheme.onSurface,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 5),
                    Text(
                      '${playerQualityLabel(track)} · ${_sourceLabel(track)}',
                      key: const ValueKey('player-cover-sheet-subtitle'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: actions.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 4),
                  itemBuilder: (context, index) =>
                      _PlayerCoverActionTile(action: actions[index]),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlayerCoverAction {
  const _PlayerCoverAction({
    required this.id,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.enabled,
    required this.onTap,
    this.trailing,
  });

  final String id;
  final IconData icon;
  final String title;
  final String subtitle;
  final bool enabled;
  final VoidCallback onTap;
  final Widget? trailing;
}

class _PlayerCoverActionTile extends StatelessWidget {
  const _PlayerCoverActionTile({required this.action});

  final _PlayerCoverAction action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListTile(
      key: ValueKey('player-cover-action-${action.id}'),
      minTileHeight: 64,
      enabled: action.enabled,
      leading: Icon(action.icon),
      title: Text(
        action.title,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(action.subtitle),
      trailing: action.trailing,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      tileColor: scheme.surfaceContainer,
      onTap: action.enabled ? action.onTap : null,
    );
  }
}

String _sourceLabel(PlayerTrack track) {
  if (track.isLocal) return '本地';
  final source = track.sourceLabel.trim();
  return source.isEmpty ? '其他' : source;
}
