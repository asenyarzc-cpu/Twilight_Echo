import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../../../core/services/embedded_artwork_cache.dart';
import '../../../core/ui/cover_image_source.dart';
import '../../../theme/app_motion.dart';
import '../../downloads/download_history_store.dart';
import '../../shell/widgets/horizontal_page_swipe.dart';

const double _songRowCoverSize = 52;
const double _songRowMinHeight = 68;
const double _songCoverRadius = 10;

class SongRow extends StatelessWidget {
  const SongRow({
    super.key,
    required this.entry,
    required this.artworkVersion,
    required this.playing,
    this.playingActive = false,
    required this.batchMode,
    required this.selected,
    required this.onToggleSelected,
    required this.onAddNext,
    required this.onAddToPlaylist,
    required this.onPlay,
    required this.onDelete,
    this.playlistMode = false,
  });

  final DownloadHistoryEntry entry;
  final int? artworkVersion;
  final bool playing;
  final bool playingActive;
  final bool batchMode;
  final bool selected;
  final VoidCallback onToggleSelected;
  final VoidCallback onAddNext;
  final VoidCallback onAddToPlaylist;
  final VoidCallback onPlay;
  final VoidCallback onDelete;
  final bool playlistMode;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final subtitle = _subtitle(entry);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final shortDuration = reduceMotion ? Duration.zero : AppMotion.short;
    final mediumDuration = reduceMotion ? Duration.zero : AppMotion.medium;
    final backgroundColor = selected
        ? scheme.primaryContainer.withValues(alpha: 0.56)
        : playing
        ? scheme.primaryContainer.withValues(alpha: 0.2)
        : Colors.transparent;
    final titleColor = selected
        ? scheme.onPrimaryContainer
        : playing
        ? scheme.primary
        : scheme.onSurface;
    final supportingColor = selected
        ? scheme.onPrimaryContainer.withValues(alpha: 0.8)
        : playing
        ? scheme.primary.withValues(alpha: 0.86)
        : scheme.onSurfaceVariant;

    final row = AnimatedContainer(
      duration: shortDuration,
      curve: AppMotion.emphasized,
      constraints: const BoxConstraints(minHeight: _songRowMinHeight),
      color: backgroundColor,
      child: Material(
        color: Colors.transparent,
        child: Semantics(
          button: true,
          selected: batchMode && selected,
          hint: batchMode ? '轻触选择歌曲' : '轻触播放',
          child: InkWell(
            onTap: batchMode ? onToggleSelected : onPlay,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 2, 8),
              child: Row(
                children: [
                  _SongCover(entry: entry, artworkVersion: artworkVersion),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (playing) ...[
                              _PlayingEqualizer(
                                key: ValueKey('song-playing-${entry.id}'),
                                active: playingActive,
                              ),
                              const SizedBox(width: 6),
                            ],
                            Expanded(
                              child: Text(
                                entry.name,
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
                        Row(
                          children: [
                            _QualityBadge(code: entry.qualityCode),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                subtitle,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: supportingColor,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                  height: 1.08,
                                ),
                              ),
                            ),
                          ],
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
                              key: const ValueKey('song-select-action'),
                              dimension: 44,
                              child: Center(
                                child: Checkbox(
                                  value: selected,
                                  visualDensity: VisualDensity.compact,
                                  materialTapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                  onChanged: (_) => onToggleSelected(),
                                ),
                              ),
                            )
                          : _SongActionButton(
                              key: const ValueKey('song-play-actions'),
                              tooltip: '添加到下一首播放',
                              icon: Icons.playlist_add_rounded,
                              onPressed: onAddNext,
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

    return HorizontalPageSwipeExclusion(
      child: Slidable(
        key: ValueKey('song-slide-${entry.id}'),
        groupTag: 'songs',
        enabled: !batchMode,
        endActionPane: ActionPane(
          motion: const BehindMotion(),
          extentRatio: playlistMode ? 0.22 : 0.4,
          children: [
            if (!playlistMode)
              SlidableAction(
                key: const ValueKey('song-add-playlist-action'),
                autoClose: false,
                onPressed: (actionContext) async {
                  await Slidable.of(actionContext)?.close();
                  onAddToPlaylist();
                },
                backgroundColor: scheme.secondaryContainer,
                foregroundColor: scheme.onSecondaryContainer,
                icon: Icons.playlist_add_rounded,
                label: '歌单',
              ),
            SlidableAction(
              key: ValueKey(
                playlistMode
                    ? 'song-remove-playlist-action'
                    : 'song-delete-action',
              ),
              onPressed: (_) => onDelete(),
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
              icon: playlistMode
                  ? Icons.playlist_remove_rounded
                  : Icons.delete_outline_rounded,
              label: playlistMode ? '移出歌单' : '删除',
            ),
          ],
        ),
        child: row,
      ),
    );
  }

  static String _subtitle(DownloadHistoryEntry entry) {
    final singer = entry.singer.trim().isEmpty ? '未知歌手' : entry.singer.trim();
    final album = entry.albumName.trim();
    return album.isEmpty ? singer : '$singer · $album';
  }
}

class _SongActionButton extends StatelessWidget {
  const _SongActionButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final backgroundColor = scheme.surfaceContainerHighest;
    final foregroundColor = scheme.onSurfaceVariant;
    const visualSize = 32.0;

    return SizedBox.square(
      dimension: 44,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        padding: const EdgeInsets.all(6),
        style: ButtonStyle(
          fixedSize: const WidgetStatePropertyAll(Size.square(44)),
          shape: const WidgetStatePropertyAll(CircleBorder()),
          overlayColor: WidgetStatePropertyAll(
            foregroundColor.withValues(alpha: 0.08),
          ),
        ),
        icon: Container(
          width: visualSize,
          height: visualSize,
          decoration: BoxDecoration(
            color: backgroundColor,
            shape: BoxShape.circle,
          ),
          child: Icon(icon, color: foregroundColor, size: 18),
        ),
      ),
    );
  }
}

class _PlayingEqualizer extends StatefulWidget {
  const _PlayingEqualizer({super.key, required this.active});

  final bool active;

  @override
  State<_PlayingEqualizer> createState() => _PlayingEqualizerState();
}

class _PlayingEqualizerState extends State<_PlayingEqualizer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 920),
  );
  bool _motionDisabled = false;

  @override
  void initState() {
    super.initState();
    _syncAnimation();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final disabled = MediaQuery.disableAnimationsOf(context);
    if (_motionDisabled != disabled) {
      _motionDisabled = disabled;
    }
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _PlayingEqualizer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _syncAnimation();
  }

  void _syncAnimation() {
    if (widget.active && !_motionDisabled) {
      if (!_controller.isAnimating) _controller.repeat();
    } else {
      _controller
        ..stop()
        ..value = 0.32;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    return ExcludeSemantics(
      child: SizedBox(
        width: 14,
        height: 16,
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) {
            final phase = _controller.value * math.pi * 2;
            final heights = _motionDisabled
                ? const [7.0, 13.0, 9.0]
                : [
                    6 + 5 * (0.5 + 0.5 * math.sin(phase)),
                    7 + 7 * (0.5 + 0.5 * math.sin(phase + 2.1)),
                    5 + 6 * (0.5 + 0.5 * math.sin(phase + 4.2)),
                  ];
            return Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                for (final height in heights)
                  Container(
                    width: 2.6,
                    height: height,
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SongCover extends StatefulWidget {
  const _SongCover({required this.entry, required this.artworkVersion});

  final DownloadHistoryEntry entry;
  final int? artworkVersion;

  @override
  State<_SongCover> createState() => _SongCoverState();
}

class _SongCoverState extends State<_SongCover> {
  Uint8List? _artworkBytes;
  EmbeddedArtworkRequest? _artworkRequest;
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    _loadEmbeddedArtwork();
  }

  @override
  void didUpdateWidget(covariant _SongCover oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.entry.savedPath != oldWidget.entry.savedPath ||
        widget.artworkVersion != oldWidget.artworkVersion) {
      _loadEmbeddedArtwork();
    }
  }

  @override
  void dispose() {
    _loadGeneration++;
    _artworkRequest?.cancel();
    _artworkRequest = null;
    super.dispose();
  }

  void _loadEmbeddedArtwork() {
    final generation = ++_loadGeneration;
    _artworkRequest?.cancel();
    _artworkRequest = null;
    _artworkBytes = null;
    final path = widget.entry.savedPath?.trim();
    if (path == null || path.isEmpty) return;
    final version = widget.artworkVersion;
    final request = EmbeddedArtworkCache.subscribe(path, version: version);
    _artworkRequest = request;
    unawaited(
      request.future.then((bytes) {
        if (identical(_artworkRequest, request)) _artworkRequest = null;
        request.cancel();
        if (!mounted ||
            generation != _loadGeneration ||
            path != widget.entry.savedPath?.trim() ||
            version != widget.artworkVersion ||
            bytes == null ||
            bytes.isEmpty) {
          return;
        }
        setState(() => _artworkBytes = bytes);
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final placeholder = Container(
      width: _songRowCoverSize,
      height: _songRowCoverSize,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(_songCoverRadius),
        border: Border.all(
          color: scheme.outlineVariant.withValues(alpha: 0.24),
        ),
      ),
      child: Icon(
        Icons.album_rounded,
        color: scheme.onSurfaceVariant,
        size: 22,
      ),
    );
    final url = CoverImageSource.normalizeUrl(widget.entry.picUrl, size: 300);
    final artworkBytes = _artworkBytes;
    if (artworkBytes != null && artworkBytes.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(_songCoverRadius),
        child: Image.memory(
          artworkBytes,
          width: _songRowCoverSize,
          height: _songRowCoverSize,
          fit: BoxFit.cover,
          cacheWidth: 156,
          cacheHeight: 156,
          filterQuality: FilterQuality.medium,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => placeholder,
        ),
      );
    }
    if (url == null || url.isEmpty) return placeholder;
    return ClipRRect(
      borderRadius: BorderRadius.circular(_songCoverRadius),
      child: CachedNetworkImage(
        imageUrl: url,
        httpHeaders: CoverImageSource.headersFor(url),
        width: _songRowCoverSize,
        height: _songRowCoverSize,
        fit: BoxFit.cover,
        memCacheWidth: 156,
        memCacheHeight: 156,
        filterQuality: FilterQuality.medium,
        placeholder: (_, _) => placeholder,
        errorWidget: (_, _, _) => placeholder,
      ),
    );
  }
}

class _QualityBadge extends StatelessWidget {
  const _QualityBadge({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final raw = code.trim();
    final normalized = raw.toLowerCase();
    final isHiRes =
        normalized.contains('hi') ||
        normalized.contains('hr') ||
        normalized.contains('master');
    final isLossless =
        isHiRes ||
        normalized.contains('flac') ||
        normalized.contains('lossless') ||
        normalized.contains('sq');

    final (label, backgroundColor, foregroundColor) = isHiRes
        ? ('Hi-Res', scheme.tertiaryContainer, scheme.onTertiaryContainer)
        : isLossless
        ? ('无损', scheme.secondaryContainer, scheme.onSecondaryContainer)
        : (
            raw.isEmpty ? '标准' : raw.toUpperCase(),
            scheme.surfaceContainerHighest,
            scheme.onSurfaceVariant,
          );

    return Container(
      constraints: const BoxConstraints(minWidth: 27, minHeight: 16),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(6),
      ),
      alignment: Alignment.center,
      child: Text(
        label,
        maxLines: 1,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: foregroundColor,
          fontSize: 8.75,
          fontWeight: FontWeight.w600,
          height: 1,
          letterSpacing: 0.08,
        ),
      ),
    );
  }
}
