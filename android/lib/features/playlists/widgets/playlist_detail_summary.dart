import 'package:flutter/material.dart';

import '../../../core/models/enums.dart';
import '../playlist_models.dart';
import 'playlist_artwork.dart';

/// Compact playlist info card shown above the track list, replacing the old
/// full-width `PlaylistSummary` hero card.
class PlaylistDetailSummaryCard extends StatelessWidget {
  const PlaylistDetailSummaryCard({
    super.key,
    required this.playlist,
    required this.localCount,
  });

  final LocalPlaylist playlist;
  final int localCount;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final source = MusicSource.fromCode(playlist.originSourceCode ?? '');
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: scheme.outlineVariant.withValues(alpha: 0.22),
        ),
      ),
      child: Row(
        children: [
          PlaylistCover(
            playlist: playlist,
            size: 56,
            radius: 14,
            placeholder: Container(
              width: 56,
              height: 56,
              color: scheme.secondaryContainer,
              alignment: Alignment.center,
              child: Icon(
                Icons.queue_music_rounded,
                color: scheme.onSecondaryContainer,
                size: 24,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  playlist.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurface,
                    fontSize: 15.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  [
                    '${playlist.tracks.length} 首',
                    if (localCount > 0) '$localCount 首已在本地',
                    if (playlist.isOnlineImport) '${source.label}导入',
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
