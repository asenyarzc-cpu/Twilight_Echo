import 'package:flutter/material.dart';

import '../../../theme/app_motion.dart';

class SongsBatchActionBar extends StatelessWidget {
  const SongsBatchActionBar({
    super.key,
    required this.selectedCount,
    required this.onDelete,
    required this.onAddToPlaylist,
    required this.onPlaySelected,
    this.playlistMode = false,
  });

  final int selectedCount;
  final VoidCallback? onDelete;
  final VoidCallback? onAddToPlaylist;
  final VoidCallback? onPlaySelected;
  final bool playlistMode;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      key: const ValueKey('songs-batch-bottom-bar'),
      color: scheme.surfaceContainer,
      elevation: 5,
      shadowColor: scheme.shadow.withValues(alpha: 0.18),
      child: Container(
        height: 64,
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(
              color: scheme.outlineVariant.withValues(alpha: 0.42),
            ),
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: _SongsBatchAction(
                icon: playlistMode
                    ? Icons.playlist_remove_rounded
                    : Icons.delete_outline_rounded,
                label: playlistMode ? '移出歌单' : '永久删除',
                onPressed: onDelete,
                enabledColor: scheme.error,
              ),
            ),
            if (!playlistMode)
              Expanded(
                child: _SongsBatchAction(
                  icon: Icons.playlist_add_rounded,
                  label: '加入歌单',
                  onPressed: onAddToPlaylist,
                ),
              ),
            Expanded(
              child: _SongsBatchAction(
                icon: Icons.playlist_play_rounded,
                label: selectedCount == 0 ? '播放选中' : '播放 $selectedCount 首',
                onPressed: onPlaySelected,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SongsBatchAction extends StatelessWidget {
  const _SongsBatchAction({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.enabledColor,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final Color? enabledColor;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = onPressed != null;
    final color = enabled
        ? enabledColor ?? scheme.onSurfaceVariant
        : scheme.onSurface.withValues(alpha: 0.34);
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onPressed,
          child: AnimatedOpacity(
            duration: AppMotion.short,
            opacity: enabled ? 1 : 0.72,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 21, color: color),
                const SizedBox(height: 3),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: color,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
