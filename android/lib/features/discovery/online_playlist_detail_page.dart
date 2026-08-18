import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../../core/models/playlist_info.dart';
import '../../core/models/playlist_summary.dart';
import '../../core/services/app_logger.dart';
import '../../core/ui/app_toast.dart';
import '../../core/ui/app_refresh_indicator.dart';
import '../../core/ui/app_scrollbar.dart';
import '../../core/ui/cover_placeholder.dart';
import '../downloads/download_history_store.dart';
import '../downloads/download_progress.dart';
import '../music_sources/music_source_action_guard.dart';
import '../player/player_controller.dart';
import '../playlists/playlist_models.dart';
import '../playlists/playlist_store.dart';
import '../playlists/widgets/immersive_playlist_chrome.dart';
import '../playlists/widgets/playlist_detail_actions.dart';
import '../playlists/widgets/playlist_wide_layout.dart';
import '../search/widgets/quality_picker_sheet.dart';
import '../search/widgets/search_result_tile.dart';
import 'discovery_controller.dart';

class OnlinePlaylistDetailPage extends ConsumerStatefulWidget {
  const OnlinePlaylistDetailPage({
    super.key,
    required this.source,
    required this.playlistId,
    this.summary,
  });

  final MusicSource source;
  final String playlistId;
  final PlaylistSummary? summary;

  @override
  ConsumerState<OnlinePlaylistDetailPage> createState() =>
      _OnlinePlaylistDetailPageState();
}

class _OnlinePlaylistDetailPageState
    extends ConsumerState<OnlinePlaylistDetailPage> {
  static const _summaryCacheLimit = 48;

  int _trackLimit = onlinePlaylistDetailInitialTrackLimit;
  PlaylistInfo? _lastPlaylist;
  PlaylistSummary? _summary;
  bool _saving = false;
  bool _removingFavorite = false;
  final ScrollController _scrollController = ScrollController();

  OnlinePlaylistIdentity get _identity =>
      (source: widget.source, id: widget.playlistId);

  OnlinePlaylistKey get _key => OnlinePlaylistKey(
    source: widget.source,
    id: widget.playlistId,
    maxTracks: _trackLimit,
  );

  String get _returnLocation =>
      '/discover/playlists/${widget.source.code}/${widget.playlistId}';

  @override
  void initState() {
    super.initState();
    _summary =
        widget.summary ??
        ref.read(onlinePlaylistSummaryCacheProvider)[_identity];
    _cacheSummary(_summary);
  }

  @override
  void didUpdateWidget(covariant OnlinePlaylistDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final identityChanged =
        oldWidget.source != widget.source ||
        oldWidget.playlistId != widget.playlistId;
    if (identityChanged) {
      _trackLimit = onlinePlaylistDetailInitialTrackLimit;
      _lastPlaylist = null;
      _summary =
          widget.summary ??
          ref.read(onlinePlaylistSummaryCacheProvider)[_identity];
      _saving = false;
      _removingFavorite = false;
    } else if (widget.summary != null) {
      _summary = widget.summary;
    }
    _cacheSummary(_summary);
  }

  void _cacheSummary(PlaylistSummary? summary) {
    if (summary == null) return;
    final cache = ref.read(onlinePlaylistSummaryCacheProvider);
    if (cache.length >= _summaryCacheLimit && !cache.containsKey(_identity)) {
      cache.remove(cache.keys.first);
    }
    cache[_identity] = summary;
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(onlinePlaylistDetailProvider(_key));
    final loaded = detail.asData?.value;
    if (loaded != null) {
      _lastPlaylist = _withDiscoveryArtwork(loaded);
    }
    final cached = _lastPlaylist;
    if (cached != null && loaded == null) {
      final loadMoreError = detail.whenOrNull(
        error: (error, _) => _friendlyError(error),
      );
      return _buildPlaylist(
        context,
        cached,
        loadingMore: detail.isLoading,
        loadMoreError: loadMoreError,
      );
    }
    return detail.when(
      loading: () => _DetailLoading(
        summary: _summary,
        source: widget.source,
        playlistId: widget.playlistId,
      ),
      error: (error, _) => _DetailError(
        summary: _summary,
        source: widget.source,
        playlistId: widget.playlistId,
        message: _friendlyError(error),
        onRetry: () => ref.invalidate(onlinePlaylistDetailProvider(_key)),
      ),
      data: (playlist) =>
          _buildPlaylist(context, _withDiscoveryArtwork(playlist)),
    );
  }

  PlaylistInfo _withDiscoveryArtwork(PlaylistInfo playlist) {
    final summary = _summary;
    if (summary == null) return playlist;
    return PlaylistInfo(
      id: playlist.id,
      name: playlist.name,
      source: playlist.source,
      tracks: playlist.tracks,
      coverUrl: summary.coverUrl,
      creator: playlist.creator,
      description: playlist.description,
      playCount: playlist.playCount,
      trackCount: playlist.trackCount,
    );
  }

  Widget _buildPlaylist(
    BuildContext context,
    PlaylistInfo playlist, {
    bool loadingMore = false,
    String? loadMoreError,
  }) {
    final local = _findSavedPlaylist(
      ref.watch(localPlaylistsProvider),
      playlist,
    );
    final queue = _onlinePlaylistQueue(playlist);

    final artworkProvider = networkPlaylistArtworkProvider(
      playlist.coverUrl,
      size: _summary == null ? 1200 : discoveryPlaylistArtworkSize,
    );
    final wide = playlistDetailUsesWideLayout(context);
    final metadata = [
      playlist.source.label,
      if (playlist.creator?.trim().isNotEmpty == true) playlist.creator!.trim(),
      '${playlist.totalTracks} 首',
      if (playlist.playCount != null)
        '${_compactCount(playlist.playCount!)} 次播放',
    ].join(' · ');
    return PlaylistArtworkTheme(
      artworkProvider: artworkProvider,
      cacheKey: _onlineArtworkCacheKey(
        widget.source,
        widget.playlistId,
        playlist.coverUrl,
      ),
      immersiveStatusBar: !wide,
      child: Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          Future<void> refresh() async {
            ref.invalidate(onlinePlaylistDetailProvider(_key));
            await ref.read(onlinePlaylistDetailProvider(_key).future);
          }

          PlaylistDetailActions actionsWith(EdgeInsetsGeometry padding) {
            return PlaylistDetailActions(
              onPlay: queue.isEmpty
                  ? null
                  : () => _playQueue(playlist, queue.first),
              onFavorite: _saving
                  ? null
                  : () => _toggleFavorite(playlist, local),
              saving: _saving,
              removingFavorite: _removingFavorite,
              saved: local != null,
              padding: padding,
            );
          }

          final hasTrackFooter =
              loadingMore ||
              (loadMoreError != null &&
                  playlist.tracks.length < playlist.totalTracks);
          final trackSlivers = <Widget>[
            SliverToBoxAdapter(
              child: _PlaylistTracksHeading(
                count: playlist.tracks.length,
                total: playlist.totalTracks,
              ),
            ),
            if (playlist.tracks.isEmpty)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: Text('这个歌单暂时没有可用歌曲')),
              )
            else
              SliverPadding(
                padding: EdgeInsets.fromLTRB(
                  12,
                  0,
                  12,
                  hasTrackFooter ? 0 : 156,
                ),
                sliver: SliverList.separated(
                  itemCount: playlist.tracks.length,
                  separatorBuilder: (_, _) => _trackListDivider(scheme),
                  itemBuilder: (context, index) {
                    _requestMoreTracksIfNeeded(playlist, index);
                    final music = playlist.tracks[index];
                    final entry = queue.where((item) {
                      final json = item.musicJson;
                      return json != null && json['id'] == music.id;
                    }).firstOrNull;
                    return Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 900),
                        child: _OnlinePlaylistTrackTile(
                          music: music,
                          onPlay: entry == null
                              ? null
                              : () => _playQueue(playlist, entry),
                        ),
                      ),
                    );
                  },
                ),
              ),
            if (loadingMore)
              const SliverToBoxAdapter(child: _LoadMoreTracksIndicator())
            else if (loadMoreError != null &&
                playlist.tracks.length < playlist.totalTracks)
              SliverToBoxAdapter(
                child: _LoadMoreTracksError(
                  message: loadMoreError,
                  onRetry: () => _loadMoreTracks(playlist),
                ),
              ),
          ];

          return Scaffold(
            backgroundColor: scheme.surface,
            body: wide
                ? PlaylistWideBody(
                    topBar: const ImmersivePlaylistTopBar(
                      title: '歌单详情',
                      onImage: false,
                    ),
                    infoPane: PlaylistWideInfoPane(
                      artworkProvider: artworkProvider,
                      artworkHeroTag: onlinePlaylistArtworkHeroTag(
                        playlist.source,
                        playlist.id,
                      ),
                      title: playlist.name,
                      metadata: metadata,
                      description: playlist.description,
                      actions: actionsWith(const EdgeInsets.only(top: 4)),
                    ),
                    right: AppScrollbar(
                      controller: _scrollController,
                      child: AppRefreshIndicator(
                        onRefresh: refresh,
                        child: CustomScrollView(
                          controller: _scrollController,
                          key: PageStorageKey(
                            'online-playlist-wide-${playlist.source.code}-${playlist.id}',
                          ),
                          physics: const AlwaysScrollableScrollPhysics(
                            parent: BouncingScrollPhysics(),
                          ),
                          slivers: trackSlivers,
                        ),
                      ),
                    ),
                  )
                : AppScrollbar(
                    controller: _scrollController,
                    child: AppRefreshIndicator(
                      onRefresh: refresh,
                      child: CustomScrollView(
                        controller: _scrollController,
                        key: PageStorageKey(
                          'online-playlist-${playlist.source.code}-${playlist.id}',
                        ),
                        physics: const AlwaysScrollableScrollPhysics(
                          parent: BouncingScrollPhysics(),
                        ),
                        slivers: [
                          SliverToBoxAdapter(
                            child: ImmersivePlaylistHeader(
                              artworkProvider: artworkProvider,
                              artworkHeroTag: onlinePlaylistArtworkHeroTag(
                                playlist.source,
                                playlist.id,
                              ),
                              topBar: const ImmersivePlaylistTopBar(
                                title: '歌单详情',
                              ),
                            ),
                          ),
                          SliverToBoxAdapter(
                            child: PlaylistDetailInfo(
                              title: playlist.name,
                              metadata: metadata,
                              description: playlist.description,
                            ),
                          ),
                          SliverToBoxAdapter(
                            child: actionsWith(
                              const EdgeInsets.fromLTRB(16, 4, 16, 8),
                            ),
                          ),
                          ...trackSlivers,
                        ],
                      ),
                    ),
                  ),
          );
        },
      ),
    );
  }

  Future<void> _playQueue(
    PlaylistInfo playlist,
    DownloadHistoryEntry selectedEntry,
  ) async {
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      selectedEntry,
    );
    if (!available || !mounted) return;

    final queue = _onlinePlaylistQueue(playlist);
    final entry = _matchingQueueEntry(queue, selectedEntry);
    if (entry == null) return;
    final player = ref.read(playerControllerProvider.notifier);
    final api = ref.read(musicApiProvider);

    context.go('/player', extra: _returnLocation);
    final playback = player.playFromPlaylistQueue(entry, queue);
    if (playlist.tracks.length < playlist.totalTracks) {
      unawaited(
        _expandOnlinePlaylistQueue(
          api: api,
          player: player,
          playlist: playlist,
          initialQueue: queue,
        ),
      );
    }
    await playback;
  }

  Future<void> _toggleFavorite(
    PlaylistInfo playlist,
    LocalPlaylist? savedPlaylist,
  ) async {
    if (_saving) return;
    final removing = savedPlaylist != null;
    setState(() {
      _saving = true;
      _removingFavorite = removing;
    });
    try {
      final notifier = ref.read(localPlaylistsProvider.notifier);
      if (savedPlaylist == null) {
        final fullPlaylist = _withDiscoveryArtwork(
          await ref
              .read(musicApiProvider)
              .parsePlaylist(input: playlist.id, source: playlist.source),
        );
        await notifier.importOnline(fullPlaylist);
      } else {
        await notifier.delete(savedPlaylist.id);
      }
      if (!mounted) return;
      showAppToast(
        context,
        removing ? '已取消收藏' : '已完整收藏到我的歌单',
        type: AppToastType.success,
      );
    } catch (error) {
      if (!mounted) return;
      showAppToast(
        context,
        '${removing ? '取消收藏' : '收藏'}失败：$error',
        type: AppToastType.error,
      );
    } finally {
      if (mounted) {
        setState(() {
          _saving = false;
          _removingFavorite = false;
        });
      }
    }
  }

  void _requestMoreTracksIfNeeded(PlaylistInfo playlist, int index) {
    if (index < playlist.tracks.length - 6) return;
    _loadMoreTracks(playlist);
  }

  void _loadMoreTracks(PlaylistInfo playlist) {
    if (playlist.tracks.length >= playlist.totalTracks) return;
    if (_trackLimit >= playlist.totalTracks) return;
    final next = _trackLimit + onlinePlaylistDetailTrackPageSize;
    final target = next > playlist.totalTracks ? playlist.totalTracks : next;
    if (target <= _trackLimit) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _trackLimit >= target) return;
      setState(() => _trackLimit = target);
    });
  }
}

class _OnlinePlaylistTrackTile extends ConsumerStatefulWidget {
  const _OnlinePlaylistTrackTile({required this.music, required this.onPlay});

  final MusicInfo music;
  final VoidCallback? onPlay;

  @override
  ConsumerState<_OnlinePlaylistTrackTile> createState() =>
      _OnlinePlaylistTrackTileState();
}

class _OnlinePlaylistTrackTileState
    extends ConsumerState<_OnlinePlaylistTrackTile> {
  late bool _fallbackRequested = _embeddedCover.isEmpty;

  String get _embeddedCover => widget.music.meta.picUrl?.trim() ?? '';

  @override
  void didUpdateWidget(covariant _OnlinePlaylistTrackTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.music.id != widget.music.id) {
      _fallbackRequested = _embeddedCover.isEmpty;
    }
  }

  void _requestFallbackCover() {
    if (_fallbackRequested || !mounted) return;
    setState(() => _fallbackRequested = true);
  }

  @override
  Widget build(BuildContext context) {
    final task = ref.watch(
      downloadProgressProvider.select(
        (value) => value.latestTaskForMusic(widget.music.id),
      ),
    );
    final fallback = _fallbackRequested
        ? ref.watch(onlineTrackCoverProvider(OnlineTrackCoverKey(widget.music)))
        : null;
    final resolved = fallback?.asData?.value?.trim() ?? '';
    final coverUrl = resolved.isNotEmpty ? resolved : _embeddedCover;
    return SearchResultTile(
      music: widget.music,
      coverUrl: coverUrl,
      coverLoading: fallback?.isLoading ?? false,
      onCoverError: _requestFallbackCover,
      downloadTask: task,
      onDownload: () => showQualityPickerSheet(context, widget.music),
      onPlay: widget.onPlay ?? () {},
    );
  }
}

class _DetailLoading extends StatelessWidget {
  const _DetailLoading({
    required this.summary,
    required this.source,
    required this.playlistId,
  });

  final PlaylistSummary? summary;
  final MusicSource source;
  final String playlistId;

  @override
  Widget build(BuildContext context) {
    final item = summary;
    final artworkProvider = networkPlaylistArtworkProvider(
      item?.coverUrl,
      size: discoveryPlaylistArtworkSize,
    );
    final wide = playlistDetailUsesWideLayout(context);
    final title = item?.name ?? '歌单详情';
    final metadata = item == null ? '正在读取歌单信息' : _summaryMetadata(item);
    final descriptionLoading = item?.description?.trim().isEmpty ?? true;
    return PlaylistArtworkTheme(
      artworkProvider: artworkProvider,
      cacheKey: _onlineArtworkCacheKey(source, playlistId, item?.coverUrl),
      immersiveStatusBar: !wide,
      child: Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          final skeletonSliver = SliverPadding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 150),
            sliver: SliverList.separated(
              itemCount: wide ? 8 : 5,
              separatorBuilder: (_, _) => _trackListDivider(scheme),
              itemBuilder: (_, _) => const _DetailTrackSkeleton(),
            ),
          );
          return Scaffold(
            backgroundColor: scheme.surface,
            body: wide
                ? PlaylistWideBody(
                    topBar: const ImmersivePlaylistTopBar(
                      title: '歌单详情',
                      onImage: false,
                    ),
                    infoPane: PlaylistWideInfoPane(
                      artworkProvider: artworkProvider,
                      artworkLoading: artworkProvider == null,
                      artworkHeroTag: onlinePlaylistArtworkHeroTag(
                        source,
                        playlistId,
                      ),
                      title: title,
                      metadata: metadata,
                      description: item?.description,
                      descriptionLoading: descriptionLoading,
                      actions: const PlaylistDetailActions(
                        loading: true,
                        padding: EdgeInsets.only(top: 4),
                      ),
                    ),
                    right: CustomScrollView(
                      physics: const AlwaysScrollableScrollPhysics(
                        parent: BouncingScrollPhysics(),
                      ),
                      slivers: [
                        SliverToBoxAdapter(
                          child: _PlaylistTracksHeading(
                            count: item?.trackCount,
                          ),
                        ),
                        skeletonSliver,
                      ],
                    ),
                  )
                : CustomScrollView(
                    physics: const AlwaysScrollableScrollPhysics(
                      parent: BouncingScrollPhysics(),
                    ),
                    slivers: [
                      SliverToBoxAdapter(
                        child: ImmersivePlaylistHeader(
                          artworkProvider: artworkProvider,
                          artworkLoading: artworkProvider == null,
                          artworkHeroTag: onlinePlaylistArtworkHeroTag(
                            source,
                            playlistId,
                          ),
                          topBar: const ImmersivePlaylistTopBar(title: '歌单详情'),
                        ),
                      ),
                      SliverToBoxAdapter(
                        child: PlaylistDetailInfo(
                          title: title,
                          metadata: metadata,
                          description: item?.description,
                          descriptionLoading: descriptionLoading,
                        ),
                      ),
                      const SliverToBoxAdapter(
                        child: PlaylistDetailActions(loading: true),
                      ),
                      SliverToBoxAdapter(
                        child: _PlaylistTracksHeading(count: item?.trackCount),
                      ),
                      skeletonSliver,
                    ],
                  ),
          );
        },
      ),
    );
  }
}

class _DetailError extends StatelessWidget {
  const _DetailError({
    required this.summary,
    required this.source,
    required this.playlistId,
    required this.message,
    required this.onRetry,
  });

  final PlaylistSummary? summary;
  final MusicSource source;
  final String playlistId;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final item = summary;
    final artworkProvider = networkPlaylistArtworkProvider(
      item?.coverUrl,
      size: discoveryPlaylistArtworkSize,
    );
    final wide = playlistDetailUsesWideLayout(context);
    final title = item?.name ?? '歌单详情';
    final metadata = item == null ? source.label : _summaryMetadata(item);
    final errorContent = Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 24, 28, 140),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 44),
            const SizedBox(height: 14),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 14),
            IconButton.filledTonal(
              tooltip: '重试',
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
      ),
    );
    return PlaylistArtworkTheme(
      artworkProvider: artworkProvider,
      cacheKey: _onlineArtworkCacheKey(source, playlistId, item?.coverUrl),
      immersiveStatusBar: !wide,
      child: Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          return Scaffold(
            backgroundColor: scheme.surface,
            body: wide
                ? PlaylistWideBody(
                    topBar: const ImmersivePlaylistTopBar(
                      title: '歌单详情',
                      onImage: false,
                    ),
                    infoPane: PlaylistWideInfoPane(
                      artworkProvider: artworkProvider,
                      artworkHeroTag: onlinePlaylistArtworkHeroTag(
                        source,
                        playlistId,
                      ),
                      title: title,
                      metadata: metadata,
                      description: item?.description,
                    ),
                    right: errorContent,
                  )
                : CustomScrollView(
                    physics: const AlwaysScrollableScrollPhysics(
                      parent: BouncingScrollPhysics(),
                    ),
                    slivers: [
                      SliverToBoxAdapter(
                        child: ImmersivePlaylistHeader(
                          artworkProvider: artworkProvider,
                          artworkHeroTag: onlinePlaylistArtworkHeroTag(
                            source,
                            playlistId,
                          ),
                          topBar: const ImmersivePlaylistTopBar(title: '歌单详情'),
                        ),
                      ),
                      SliverToBoxAdapter(
                        child: PlaylistDetailInfo(
                          title: title,
                          metadata: metadata,
                          description: item?.description,
                        ),
                      ),
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child: errorContent,
                      ),
                    ],
                  ),
          );
        },
      ),
    );
  }
}

class _PlaylistTracksHeading extends StatelessWidget {
  const _PlaylistTracksHeading({this.count, this.total});

  final int? count;
  final int? total;

  String get _label {
    final loaded = count;
    final all = total;
    if (loaded == null) return '歌曲';
    if (all != null && all > loaded) return '歌曲  $loaded/$all';
    return '歌曲  $loaded';
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 900),
          child: SizedBox(
            height: 24,
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                _label,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LoadMoreTracksIndicator extends StatelessWidget {
  const _LoadMoreTracksIndicator();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.fromLTRB(16, 12, 16, 156),
      child: Center(
        child: SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(strokeWidth: 2.4),
        ),
      ),
    );
  }
}

class _LoadMoreTracksError extends StatelessWidget {
  const _LoadMoreTracksError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 156),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 900),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: Text(
                  message,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: scheme.onSurfaceVariant),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                tooltip: '重试',
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DetailTrackSkeleton extends StatelessWidget {
  const _DetailTrackSkeleton();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 与数据态的 SearchResultTile 行保持同宽同高（900 限宽居中、行高 62、
    // 封面 44），loading → data 切换不跳动。
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 900),
        child: SizedBox(
          key: const ValueKey('detail-track-skeleton'),
          height: 62,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 2, 2, 2),
            child: Row(
              children: [
                const ClipRRect(
                  borderRadius: BorderRadius.all(Radius.circular(8)),
                  child: SizedBox.square(
                    dimension: 44,
                    child: CoverLoadingSkeleton(),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      FractionallySizedBox(
                        widthFactor: 0.58,
                        child: Container(
                          height: 12,
                          decoration: BoxDecoration(
                            color: scheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                      ),
                      const SizedBox(height: 9),
                      FractionallySizedBox(
                        widthFactor: 0.36,
                        child: Container(
                          height: 9,
                          decoration: BoxDecoration(
                            color: scheme.surfaceContainerHigh,
                            borderRadius: BorderRadius.circular(5),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 44),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Widget _trackListDivider(ColorScheme scheme) {
  return Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 900),
      child: Divider(
        height: 1,
        indent: 56,
        color: scheme.outlineVariant.withValues(alpha: 0.35),
      ),
    ),
  );
}

String _summaryMetadata(PlaylistSummary summary) {
  return [
    summary.source.label,
    if (summary.creator?.trim().isNotEmpty == true) summary.creator!.trim(),
    if (summary.trackCount != null) '${summary.trackCount} 首',
    if (summary.playCount != null) '${_compactCount(summary.playCount!)} 次播放',
  ].join(' · ');
}

String _onlineArtworkCacheKey(
  MusicSource source,
  String playlistId,
  String? coverUrl,
) {
  return 'online:${source.code}:$playlistId:${coverUrl?.trim() ?? ''}';
}

List<DownloadHistoryEntry> _onlinePlaylistQueue(PlaylistInfo playlist) {
  final queueId = 'online:${playlist.source.code}:${playlist.id}';
  final queue = <DownloadHistoryEntry>[];
  for (final music in playlist.tracks) {
    final entry = PlaylistTrack.fromMusicInfo(
      music,
    ).toQueueEntry(playlistId: queueId);
    if (entry != null) queue.add(entry);
  }
  return queue;
}

DownloadHistoryEntry? _matchingQueueEntry(
  Iterable<DownloadHistoryEntry> queue,
  DownloadHistoryEntry selected,
) {
  for (final entry in queue) {
    if (entry.id == selected.id ||
        (entry.sourceCode == selected.sourceCode &&
            entry.musicId == selected.musicId)) {
      return entry;
    }
  }
  return null;
}

Future<void> _expandOnlinePlaylistQueue({
  required MusicApi api,
  required PlayerController player,
  required PlaylistInfo playlist,
  required List<DownloadHistoryEntry> initialQueue,
}) async {
  try {
    final fullPlaylist = await api.parsePlaylist(
      input: playlist.id,
      source: playlist.source,
    );
    final fullQueue = _onlinePlaylistQueue(fullPlaylist);
    player.expandPlaylistQueue(
      expectedQueue: initialQueue,
      expandedQueue: fullQueue,
    );
  } catch (error) {
    await AppLogger.write(
      'player',
      'expand online playlist queue failed: $error',
    );
  }
}

LocalPlaylist? _findSavedPlaylist(
  List<LocalPlaylist> playlists,
  PlaylistInfo online,
) {
  for (final playlist in playlists) {
    if (playlist.originSourceCode == online.source.code &&
        playlist.originPlaylistId == online.id) {
      return playlist;
    }
  }
  return null;
}

String _compactCount(int count) {
  if (count >= 100000000) {
    return '${(count / 100000000).toStringAsFixed(count >= 1000000000 ? 0 : 1)}亿';
  }
  if (count >= 10000) {
    return '${(count / 10000).toStringAsFixed(count >= 100000 ? 0 : 1)}万';
  }
  return '$count';
}

String _friendlyError(Object error) {
  final value = error.toString().replaceFirst('Exception: ', '').trim();
  return value.isEmpty ? '歌单加载失败，请稍后重试' : value;
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
