import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../../core/models/enums.dart';
import '../../../core/models/music_info.dart';
import '../../../core/services/app_logger.dart';
import '../../../core/ui/cover_image_source.dart';
import '../../../core/ui/cover_placeholder.dart';
import '../../../core/ui/expressive_download_button.dart';
import '../../../theme/app_motion.dart';
import '../../../theme/app_theme.dart';
import '../../downloads/download_progress.dart';

const double _resultCoverSize = 44;
const double _resultRowMinHeight = 62;

class SearchResultTile extends StatelessWidget {
  const SearchResultTile({
    super.key,
    required this.music,
    required this.onDownload,
    required this.onPlay,
    this.onAddToPlaylist,
    this.downloadTask,
    this.coverUrl,
    this.coverLoading = false,
    this.onCoverError,
  });

  final MusicInfo music;
  final VoidCallback onDownload;
  final VoidCallback onPlay;
  final VoidCallback? onAddToPlaylist;
  final DownloadTask? downloadTask;
  final String? coverUrl;
  final bool coverLoading;
  final VoidCallback? onCoverError;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final task = downloadTask;
    final done = task?.stage == DownloadStage.done;
    final busy = task?.isBusy ?? false;
    final failed = task?.stage == DownloadStage.failed;
    final artist = music.singer.trim().isEmpty ? '未知歌手' : music.singer.trim();
    final metadata = [
      artist,
      if (music.albumName.trim().isNotEmpty) music.albumName.trim(),
    ].join(' · ');
    final buttonTooltip = done
        ? '已下载完成'
        : failed
        ? '重新选择音质下载'
        : '选择音质下载';
    final backgroundColor = done
        ? scheme.primaryContainer.withValues(alpha: 0.22)
        : failed
        ? scheme.errorContainer.withValues(alpha: 0.18)
        : Colors.transparent;

    return AnimatedContainer(
      duration: AppMotion.short,
      curve: AppMotion.emphasized,
      constraints: const BoxConstraints(minHeight: _resultRowMinHeight),
      color: backgroundColor,
      child: Material(
        color: Colors.transparent,
        child: Semantics(
          button: true,
          hint: '轻触播放',
          child: InkWell(
            onTap: onPlay,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 2, 2, 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  _Cover(
                    picUrl: coverUrl ?? music.meta.picUrl,
                    loading: coverLoading,
                    onError: onCoverError,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          music.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: scheme.onSurface,
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                            height: 1.1,
                            letterSpacing: 0,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            _SourceBadge(source: music.source),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                metadata,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: scheme.onSurfaceVariant,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                  height: 1.08,
                                ),
                              ),
                            ),
                            if (music.interval?.trim().isNotEmpty ?? false) ...[
                              const SizedBox(width: 5),
                              Container(
                                width: 2,
                                height: 2,
                                decoration: BoxDecoration(
                                  color: scheme.onSurfaceVariant.withValues(
                                    alpha: 0.46,
                                  ),
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 5),
                              Text(
                                music.interval!,
                                style: TextStyle(
                                  color: scheme.onSurfaceVariant.withValues(
                                    alpha: 0.78,
                                  ),
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w500,
                                  fontFeatures: const [
                                    FontFeature.tabularFigures(),
                                  ],
                                ),
                              ),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  if (onAddToPlaylist != null)
                    ExpressiveDownloadButton(
                      key: ValueKey(
                        'search-result-add-to-playlist-${music.id}',
                      ),
                      isLoading: false,
                      onPressed: onAddToPlaylist,
                      tooltip: '添加到歌单',
                      size: 36,
                      tapTargetSize: 40,
                      tonal: true,
                      idleIcon: Icons.playlist_add_rounded,
                    ),
                  if (onAddToPlaylist != null) const SizedBox(width: 2),
                  ExpressiveDownloadButton(
                    key: ValueKey('search-result-download-${music.id}'),
                    isLoading: busy,
                    isDone: done,
                    progress: task?.fraction,
                    onPressed: busy || done ? null : onDownload,
                    tooltip: buttonTooltip,
                    size: 36,
                    tapTargetSize: 40,
                    tonal: true,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({required this.picUrl, required this.loading, this.onError});
  final String? picUrl;
  final bool loading;
  final VoidCallback? onError;

  // Dedup failures so we don't log the same broken cover URL hundreds of
  // times when the user scrolls / list rebuilds. CachedNetworkImage's
  // errorWidget fires once per rebuild per retry, which floods AppLogger.
  static final Set<String> _loggedFailures = <String>{};

  String? get _normalizedUrl {
    return CoverImageSource.normalizeUrl(picUrl, size: 300);
  }

  Map<String, String>? get _headers =>
      CoverImageSource.headersFor(_normalizedUrl);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final placeholder = Container(
      width: _resultCoverSize,
      height: _resultCoverSize,
      decoration: BoxDecoration(
        color: scheme.appContainerHighest,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: scheme.outlineVariant.withValues(alpha: 0.24),
        ),
      ),
      child: Icon(
        Icons.music_note_rounded,
        color: scheme.onSurfaceVariant,
        size: 19,
      ),
    );
    final imageUrl = _normalizedUrl;
    if (loading) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: const SizedBox.square(
          dimension: _resultCoverSize,
          child: CoverLoadingSkeleton(),
        ),
      );
    }
    if (imageUrl == null || imageUrl.isEmpty) return placeholder;
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: CachedNetworkImage(
        imageUrl: imageUrl,
        httpHeaders: _headers,
        width: _resultCoverSize,
        height: _resultCoverSize,
        memCacheWidth: 120,
        memCacheHeight: 120,
        fit: BoxFit.cover,
        fadeInDuration: AppMotion.medium,
        fadeOutDuration: AppMotion.short,
        placeholder: (_, _) => const CoverLoadingSkeleton(),
        errorWidget: (_, url, error) {
          if (_loggedFailures.add(url)) {
            AppLogger.write('cover', 'search image FAIL url=$url error=$error');
          }
          if (onError != null) {
            WidgetsBinding.instance.addPostFrameCallback((_) => onError!());
          }
          return placeholder;
        },
      ),
    );
  }
}

class _SourceBadge extends StatelessWidget {
  const _SourceBadge({required this.source});
  final MusicSource source;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      constraints: const BoxConstraints(minWidth: 25, minHeight: 16),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(6),
      ),
      alignment: Alignment.center,
      child: Text(
        source.label,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: scheme.onSecondaryContainer,
          fontSize: 8.75,
          fontWeight: FontWeight.w600,
          height: 1,
          letterSpacing: 0,
        ),
      ),
    );
  }
}
