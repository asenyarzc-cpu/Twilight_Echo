import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/services/tagger.dart';
import '../../../core/ui/cover_image_source.dart';
import '../../../theme/app_motion.dart';
import '../../downloads/download_history_store.dart';
import '../player_controller.dart';
import 'player_palette.dart';

const _queueEntryHeight = 66.0;
const _queueEntrySpacing = 6.0;
const _queueItemExtent = _queueEntryHeight + _queueEntrySpacing;
const _queueListTopPadding = 12.0;

class PlaybackQueueButton extends StatelessWidget {
  const PlaybackQueueButton({
    super.key,
    required this.count,
    required this.enabled,
    required this.onPressed,
  });

  final int count;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final color = enabled ? playerInk(context) : playerMuted(context);
    return IconButton(
      tooltip: count > 0 ? '播放列表，共 $count 首' : '播放列表',
      onPressed: enabled ? onPressed : null,
      style: IconButton.styleFrom(fixedSize: const Size.square(48)),
      icon: ExcludeSemantics(
        child: SizedBox.square(
          dimension: 30,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Align(
                alignment: Alignment.center,
                child: Icon(Icons.queue_music_rounded, color: color, size: 27),
              ),
              if (enabled && count > 0)
                Positioned(
                  top: -3,
                  right: -4,
                  child: Container(
                    constraints: const BoxConstraints(
                      minWidth: 16,
                      minHeight: 16,
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    decoration: BoxDecoration(
                      color: playerInk(context),
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(
                        color: playerSurface(context).withValues(alpha: 0.92),
                        width: 1.5,
                      ),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      count > 99 ? '99+' : '$count',
                      style: TextStyle(
                        color: playerSurface(context),
                        fontSize: 8.5,
                        fontWeight: FontWeight.w600,
                        height: 1,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<void> showPlaybackQueueSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    showDragHandle: false,
    backgroundColor: Colors.transparent,
    barrierColor: Colors.black.withValues(alpha: 0.32),
    builder: (_) => const _PlaybackQueueSheet(),
  );
}

class _PlaybackQueueSheet extends ConsumerWidget {
  const _PlaybackQueueSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vm = ref.watch(
      playerControllerProvider.select(
        (state) => (
          queue: state.queue,
          queueIndex: state.queueIndex,
          track: state.track,
          playing: state.playing,
          mode: state.playbackMode,
        ),
      ),
    );
    final count = vm.queue.isNotEmpty
        ? vm.queue.length
        : (vm.track == null ? 0 : 1);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final sheetColor = Color.alphaBlend(
      (dark ? Colors.black : Colors.white).withValues(alpha: 0.32),
      playerSurface(context),
    );

    return FractionallySizedBox(
      heightFactor: 0.72,
      child: Material(
        color: sheetColor,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(30)),
        clipBehavior: Clip.antiAlias,
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              const SizedBox(height: 10),
              Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: playerInk(context).withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 16, 14, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '播放列表',
                            style: TextStyle(
                              color: playerInk(context),
                              fontSize: 22,
                              fontWeight: FontWeight.w600,
                              height: 1.1,
                              letterSpacing: -0.2,
                            ),
                          ),
                          const SizedBox(height: 5),
                          Text(
                            '$count 首 · ${vm.mode.label}',
                            style: TextStyle(
                              color: playerMuted(context),
                              fontSize: 12.5,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭播放列表',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded),
                      color: playerInk(context),
                    ),
                  ],
                ),
              ),
              Divider(
                height: 1,
                color: playerInk(context).withValues(alpha: 0.08),
              ),
              Expanded(
                child: vm.queue.isNotEmpty
                    ? _PlaybackQueueList(
                        queue: vm.queue,
                        queueIndex: vm.queueIndex,
                        track: vm.track,
                        playing: vm.playing,
                        onSelect: (index) => ref
                            .read(playerControllerProvider.notifier)
                            .playQueueItem(index),
                      )
                    : vm.track == null
                    ? const _PlaybackQueueEmpty()
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
                        children: [
                          _PlaybackQueueCurrentTrackTile(
                            track: vm.track!,
                            playing: vm.playing,
                          ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlaybackQueueList extends StatefulWidget {
  const _PlaybackQueueList({
    required this.queue,
    required this.queueIndex,
    required this.track,
    required this.playing,
    required this.onSelect,
  });

  final List<DownloadHistoryEntry> queue;
  final int queueIndex;
  final PlayerTrack? track;
  final bool playing;
  final ValueChanged<int> onSelect;

  @override
  State<_PlaybackQueueList> createState() => _PlaybackQueueListState();
}

class _PlaybackQueueListState extends State<_PlaybackQueueList> {
  ScrollController? _scrollController;

  @override
  void dispose() {
    _scrollController?.dispose();
    super.dispose();
  }

  double _initialScrollOffset(double viewportHeight) {
    final currentIndex =
        widget.queueIndex >= 0 && widget.queueIndex < widget.queue.length
        ? widget.queueIndex
        : 0;
    final currentItemCenter =
        _queueListTopPadding +
        currentIndex * _queueItemExtent +
        _queueEntryHeight / 2;
    return math.max(0, currentItemCenter - viewportHeight / 2);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        _scrollController ??= ScrollController(
          initialScrollOffset: _initialScrollOffset(constraints.maxHeight),
        );
        return ListView.builder(
          key: const ValueKey('playback-queue-list'),
          controller: _scrollController,
          padding: const EdgeInsets.fromLTRB(14, _queueListTopPadding, 14, 18),
          itemCount: widget.queue.length,
          itemExtent: _queueItemExtent,
          itemBuilder: (context, index) {
            final active = index == widget.queueIndex;
            return Padding(
              padding: const EdgeInsets.only(bottom: _queueEntrySpacing),
              child: _PlaybackQueueEntryTile(
                key: ValueKey('playback-queue-entry-$index'),
                entry: widget.queue[index],
                active: active,
                playing: active && widget.playing,
                currentTrack: active ? widget.track : null,
                onTap: () => widget.onSelect(index),
              ),
            );
          },
        );
      },
    );
  }
}

class _PlaybackQueueEntryTile extends StatelessWidget {
  const _PlaybackQueueEntryTile({
    super.key,
    required this.entry,
    required this.active,
    required this.playing,
    required this.currentTrack,
    required this.onTap,
  });

  final DownloadHistoryEntry entry;
  final bool active;
  final bool playing;
  final PlayerTrack? currentTrack;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final title = active ? currentTrack?.title ?? entry.name : entry.name;
    final artist = active ? currentTrack?.artist ?? entry.singer : entry.singer;
    final album = active
        ? currentTrack?.album ?? entry.albumName
        : entry.albumName;
    final subtitle = [
      artist.trim().isEmpty ? '未知歌手' : artist.trim(),
      if (album.trim().isNotEmpty) album.trim(),
    ].join(' · ');

    return AnimatedContainer(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : AppMotion.medium,
      curve: AppMotion.emphasized,
      decoration: BoxDecoration(
        color: active
            ? playerInk(context).withValues(alpha: 0.075)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 10, 8),
            child: Row(
              children: [
                _QueueArtwork(
                  path: entry.savedPath,
                  url: entry.picUrl,
                  bytes: active ? currentTrack?.coverBytes : null,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: active
                              ? playerInk(context)
                              : playerInk(context).withValues(alpha: 0.86),
                          fontSize: 14.5,
                          fontWeight: active
                              ? FontWeight.w600
                              : FontWeight.w500,
                          height: 1.15,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: playerMuted(context),
                          fontSize: 11.5,
                          fontWeight: FontWeight.w500,
                          height: 1.15,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (active)
                  _PlaybackStateIcon(playing: playing)
                else
                  Text(
                    entry.qualityCode.toUpperCase(),
                    style: TextStyle(
                      color: playerMuted(context).withValues(alpha: 0.78),
                      fontSize: 9.5,
                      fontWeight: FontWeight.w600,
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

class _PlaybackQueueCurrentTrackTile extends StatelessWidget {
  const _PlaybackQueueCurrentTrackTile({
    required this.track,
    required this.playing,
  });

  final PlayerTrack track;
  final bool playing;

  @override
  Widget build(BuildContext context) {
    final subtitle = [
      track.artist,
      if (track.album.trim().isNotEmpty) track.album.trim(),
    ].join(' · ');
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 10, 8),
      decoration: BoxDecoration(
        color: playerInk(context).withValues(alpha: 0.075),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          _QueueArtwork(
            path: track.localPath,
            url: track.coverUrl,
            bytes: track.coverBytes,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  track.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: playerInk(context),
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: playerMuted(context),
                    fontSize: 11.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          _PlaybackStateIcon(playing: playing),
        ],
      ),
    );
  }
}

class _PlaybackStateIcon extends StatefulWidget {
  const _PlaybackStateIcon({required this.playing});

  final bool playing;

  @override
  State<_PlaybackStateIcon> createState() => _PlaybackStateIconState();
}

class _PlaybackStateIconState extends State<_PlaybackStateIcon>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _animationsDisabled = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 920),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animationsDisabled = MediaQuery.disableAnimationsOf(context);
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _PlaybackStateIcon oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.playing != oldWidget.playing) _syncAnimation();
  }

  void _syncAnimation() {
    if (widget.playing && !_animationsDisabled) {
      if (!_controller.isAnimating) _controller.repeat();
    } else {
      _controller.stop(canceled: false);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: 24,
      child: AnimatedSwitcher(
        duration: _animationsDisabled ? Duration.zero : AppMotion.short,
        child: widget.playing
            ? _AnimatedPlayingBars(
                key: const ValueKey('playing-bars'),
                animation: _controller,
                animate: !_animationsDisabled,
              )
            : Icon(
                Icons.play_arrow_rounded,
                key: ValueKey('play-arrow'),
                color: playerInk(context),
                size: 24,
              ),
      ),
    );
  }
}

class _AnimatedPlayingBars extends AnimatedWidget {
  const _AnimatedPlayingBars({
    super.key,
    required Animation<double> animation,
    required this.animate,
  }) : super(listenable: animation);

  final bool animate;

  @override
  Widget build(BuildContext context) {
    final progress = (listenable as Animation<double>).value;
    const barHeights = [12.0, 19.0, 15.0, 20.0, 11.0];

    return RepaintBoundary(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: List.generate(barHeights.length, (index) {
          final wave = animate
              ? (math.sin((progress * math.pi * 2) + (index * 1.18)) + 1) / 2
              : 0.55;
          final scaleY = 0.32 + (wave * 0.68);
          return Padding(
            padding: EdgeInsets.only(
              right: index == barHeights.length - 1 ? 0 : 1.5,
            ),
            child: Transform.scale(
              alignment: Alignment.bottomCenter,
              scaleY: scaleY,
              child: Container(
                width: 2.6,
                height: barHeights[index],
                decoration: BoxDecoration(
                  color: playerInk(context),
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ),
          );
        }),
      ),
    );
  }
}

class _QueueArtwork extends StatefulWidget {
  const _QueueArtwork({this.path, this.url, this.bytes});

  final String? path;
  final String? url;
  final Uint8List? bytes;

  @override
  State<_QueueArtwork> createState() => _QueueArtworkState();
}

class _QueueArtworkState extends State<_QueueArtwork> {
  // Process-wide LRU of embedded artwork reads plus inflight de-dup. Static
  // on purpose: the cache must survive sheet rebuilds and there must be
  // exactly one copy in the app (moved here verbatim from player_page.dart).
  static const _maxArtworkCacheEntries = 36;
  static final Map<String, Uint8List?> _artworkCache = {};
  static final Map<String, Future<Uint8List?>> _inflightArtworkReads = {};

  Uint8List? _embeddedBytes;
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    _rememberDirectArtwork();
    _resolveEmbeddedArtwork();
  }

  @override
  void didUpdateWidget(covariant _QueueArtwork oldWidget) {
    super.didUpdateWidget(oldWidget);
    _rememberDirectArtwork();
    if (_hasBytes(widget.bytes)) {
      _loadGeneration++;
      _embeddedBytes = null;
      return;
    }
    if (widget.path != oldWidget.path || _hasBytes(oldWidget.bytes)) {
      _resolveEmbeddedArtwork();
    }
  }

  void _rememberDirectArtwork() {
    final path = _normalizedPath(widget.path);
    final bytes = widget.bytes;
    if (path == null || !_hasBytes(bytes)) return;
    _cacheArtwork(path, bytes);
  }

  void _resolveEmbeddedArtwork() {
    final generation = ++_loadGeneration;
    final path = _normalizedPath(widget.path);
    if (_hasBytes(widget.bytes) || path == null) {
      _embeddedBytes = null;
      return;
    }

    if (_artworkCache.containsKey(path)) {
      final cached = _artworkCache.remove(path);
      _artworkCache[path] = cached;
      _embeddedBytes = cached;
      return;
    }

    _embeddedBytes = null;
    unawaited(
      _loadArtwork(path).then((bytes) {
        if (!mounted ||
            generation != _loadGeneration ||
            path != _normalizedPath(widget.path) ||
            _hasBytes(widget.bytes)) {
          return;
        }
        setState(() => _embeddedBytes = bytes);
      }),
    );
  }

  static Future<Uint8List?> _loadArtwork(String path) {
    if (_artworkCache.containsKey(path)) {
      final cached = _artworkCache.remove(path);
      _artworkCache[path] = cached;
      return Future<Uint8List?>.value(cached);
    }
    final inflight = _inflightArtworkReads[path];
    if (inflight != null) return inflight;

    final future = _readArtwork(path);
    _inflightArtworkReads[path] = future;
    unawaited(
      future
          .then((bytes) {
            _cacheArtwork(path, bytes);
          })
          .whenComplete(() {
            _inflightArtworkReads.remove(path);
          }),
    );
    return future;
  }

  static Future<Uint8List?> _readArtwork(String path) async {
    try {
      final bytes = (await Tagger.readEmbeddedTags(
        path,
        includeLyrics: false,
      ))?.artworkBytes;
      return _hasBytes(bytes) ? bytes : null;
    } catch (_) {
      return null;
    }
  }

  static void _cacheArtwork(String path, Uint8List? bytes) {
    _artworkCache.remove(path);
    _artworkCache[path] = bytes;
    while (_artworkCache.length > _maxArtworkCacheEntries) {
      _artworkCache.remove(_artworkCache.keys.first);
    }
  }

  static String? _normalizedPath(String? path) {
    final trimmed = path?.trim();
    return trimmed == null || trimmed.isEmpty ? null : trimmed;
  }

  static bool _hasBytes(Uint8List? bytes) => bytes != null && bytes.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final placeholder = Container(
      key: const ValueKey('queue-artwork-placeholder'),
      width: 50,
      height: 50,
      decoration: BoxDecoration(
        color: playerInk(context).withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(13),
      ),
      alignment: Alignment.center,
      child: Icon(
        Icons.music_note_rounded,
        color: playerInk(context).withValues(alpha: 0.42),
        size: 22,
      ),
    );
    final resolvedBytes = _hasBytes(widget.bytes)
        ? widget.bytes
        : _embeddedBytes;
    final Widget artwork;
    if (_hasBytes(resolvedBytes)) {
      artwork = ClipRRect(
        key: ValueKey(
          'queue-artwork-memory:${_normalizedPath(widget.path) ?? identityHashCode(resolvedBytes)}',
        ),
        borderRadius: BorderRadius.circular(13),
        child: Image.memory(
          resolvedBytes!,
          width: 50,
          height: 50,
          fit: BoxFit.cover,
          cacheWidth: 150,
          cacheHeight: 150,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => placeholder,
        ),
      );
    } else {
      final normalized = CoverImageSource.normalizeUrl(widget.url, size: 180);
      artwork = normalized == null || normalized.isEmpty
          ? placeholder
          : ClipRRect(
              key: ValueKey('queue-artwork-network:$normalized'),
              borderRadius: BorderRadius.circular(13),
              child: CachedNetworkImage(
                imageUrl: normalized,
                httpHeaders: CoverImageSource.headersFor(normalized),
                width: 50,
                height: 50,
                fit: BoxFit.cover,
                memCacheWidth: 150,
                memCacheHeight: 150,
                placeholder: (_, _) => placeholder,
                errorWidget: (_, _, _) => placeholder,
              ),
            );
    }
    return AnimatedSwitcher(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : AppMotion.short,
      switchInCurve: AppMotion.emphasizedDecelerate,
      switchOutCurve: AppMotion.emphasizedAccelerate,
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.94, end: 1).animate(animation),
          child: child,
        ),
      ),
      child: artwork,
    );
  }
}

class _PlaybackQueueEmpty extends StatelessWidget {
  const _PlaybackQueueEmpty();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        '当前没有可显示的播放列表',
        style: TextStyle(
          color: playerMuted(context),
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}
