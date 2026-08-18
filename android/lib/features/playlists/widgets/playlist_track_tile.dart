import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../../../core/ui/expressive_download_button.dart';
import '../../../theme/app_motion.dart';
import '../../downloads/download_progress.dart';
import '../resolved_playlist_track.dart';
import 'playlist_artwork.dart';

const double _trackCoverSize = 52;
const double _trackRowMinHeight = 68;
const double _trackCoverRadius = 10;

class PlaylistTrackTile extends ConsumerWidget {
  const PlaylistTrackTile({
    super.key,
    required this.playlistId,
    required this.index,
    required this.item,
    required this.playing,
    required this.batchMode,
    required this.batchSubmitting,
    required this.selected,
    required this.onToggleSelected,
    required this.onPlay,
    required this.onDownload,
    required this.onRemove,
  });

  final String playlistId;
  final int index;
  final ResolvedPlaylistTrack item;
  final bool playing;
  final bool batchMode;
  final bool batchSubmitting;
  final bool selected;
  final VoidCallback onToggleSelected;
  final VoidCallback onPlay;
  final VoidCallback? onDownload;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final music = item.track.musicInfo;
    final task = music == null
        ? null
        : ref.watch(
            downloadProgressProvider.select(
              (value) => value.latestTaskForMusic(music.id),
            ),
          );
    final isLocal = item.localEntry != null;
    final selectionEnabled = !batchSubmitting && task?.isBusy != true;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final shortDuration = reduceMotion ? Duration.zero : AppMotion.short;
    final mediumDuration = reduceMotion ? Duration.zero : AppMotion.medium;

    final backgroundColor = batchMode && selected
        ? scheme.primaryContainer.withValues(alpha: 0.56)
        : playing
        ? scheme.primaryContainer.withValues(alpha: 0.2)
        : Colors.transparent;
    final titleColor = batchMode && selected
        ? scheme.onPrimaryContainer
        : playing
        ? scheme.primary
        : scheme.onSurface;
    final supportingColor = batchMode && selected
        ? scheme.onPrimaryContainer.withValues(alpha: 0.8)
        : playing
        ? scheme.primary.withValues(alpha: 0.86)
        : scheme.onSurfaceVariant;

    final row = AnimatedContainer(
      duration: shortDuration,
      curve: AppMotion.emphasized,
      constraints: const BoxConstraints(minHeight: _trackRowMinHeight),
      color: backgroundColor,
      child: Material(
        color: Colors.transparent,
        child: Semantics(
          button: true,
          selected: batchMode && selected,
          hint: batchMode ? '轻触选择歌曲' : '轻触播放',
          child: InkWell(
            onTap: batchMode
                ? (selectionEnabled ? onToggleSelected : null)
                : onPlay,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 2, 8),
              child: Row(
                children: [
                  ResolvingPlaylistTrackArtwork(
                    playlistId: playlistId,
                    track: item.track,
                    size: _trackCoverSize,
                    radius: _trackCoverRadius,
                    placeholder: Container(
                      width: _trackCoverSize,
                      height: _trackCoverSize,
                      color: scheme.secondaryContainer,
                      alignment: Alignment.center,
                      child: Text(
                        '${index + 1}',
                        style: TextStyle(
                          color: scheme.onSecondaryContainer,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (playing) ...[
                              Icon(
                                Icons.graphic_eq_rounded,
                                size: 16,
                                color: scheme.primary,
                              ),
                              const SizedBox(width: 6),
                            ],
                            Expanded(
                              child: Text(
                                item.track.name.trim().isEmpty
                                    ? '未知歌曲'
                                    : item.track.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: titleColor,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  height: 1.1,
                                  letterSpacing: 0,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          [
                            item.track.singer.trim().isEmpty
                                ? '未知歌手'
                                : item.track.singer,
                            isLocal ? '本地' : item.track.source.label,
                          ].join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: supportingColor,
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                            height: 1.08,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  AnimatedSize(
                    duration: mediumDuration,
                    curve: AppMotion.emphasized,
                    alignment: Alignment.centerRight,
                    child: AnimatedSwitcher(
                      duration: mediumDuration,
                      switchInCurve: AppMotion.emphasizedDecelerate,
                      switchOutCurve: AppMotion.emphasizedAccelerate,
                      transitionBuilder: (child, animation) {
                        final offset = Tween<Offset>(
                          begin: const Offset(0.18, 0),
                          end: Offset.zero,
                        ).animate(animation);
                        return FadeTransition(
                          opacity: animation,
                          child: SlideTransition(
                            position: offset,
                            child: child,
                          ),
                        );
                      },
                      child: batchMode
                          ? SizedBox.square(
                              key: const ValueKey('playlist-select-action'),
                              dimension: 44,
                              child: Center(
                                child: Checkbox(
                                  value: selected,
                                  visualDensity: VisualDensity.compact,
                                  materialTapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                  onChanged: selectionEnabled
                                      ? (_) => onToggleSelected()
                                      : null,
                                ),
                              ),
                            )
                          : Row(
                              key: const ValueKey('playlist-track-actions'),
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (!isLocal && onDownload != null)
                                  ExpressiveDownloadButton(
                                    key: const ValueKey(
                                      'playlist-download-action',
                                    ),
                                    isLoading: task?.isBusy ?? false,
                                    isDone: task?.stage == DownloadStage.done,
                                    progress: task?.fraction,
                                    onPressed: task?.isBusy == true
                                        ? null
                                        : onDownload,
                                    tooltip: '选择音质下载',
                                    size: 44,
                                    tonal: true,
                                  )
                                else
                                  const SizedBox.square(dimension: 44),
                              ],
                            ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    return Slidable(
      key: ValueKey('playlist-track-slide-${item.track.id}'),
      groupTag: 'playlist-tracks',
      enabled: !batchMode,
      endActionPane: ActionPane(
        motion: const BehindMotion(),
        extentRatio: 0.24,
        children: [
          SlidableAction(
            key: const ValueKey('playlist-remove-action'),
            onPressed: (_) => onRemove(),
            backgroundColor: scheme.error,
            foregroundColor: scheme.onError,
            icon: Icons.playlist_remove_rounded,
            label: '移除',
          ),
        ],
      ),
      child: row,
    );
  }
}
