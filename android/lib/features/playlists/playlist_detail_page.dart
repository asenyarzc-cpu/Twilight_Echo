import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/enums.dart';
import '../../core/services/embedded_artwork_cache.dart';
import '../../core/services/download_service.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/app_scrollbar.dart';
import '../../core/ui/app_toast.dart';
import '../downloads/download_history_store.dart';
import '../downloads/download_progress.dart';
import '../music_sources/music_source_action_guard.dart';
import '../player/player_controller.dart';
import '../search/widgets/quality_picker_sheet.dart';
import '../shell/shell_toolbar_visibility.dart';
import '../songs/songs_toolbar_state.dart';
import '../songs/widgets/songs_placeholders.dart';
import '../songs/widgets/songs_sort_sheet.dart';
import 'playlist_detail_toolbar_state.dart';
import 'playlist_models.dart';
import 'playlist_search.dart';
import 'playlist_store.dart';
import 'resolved_playlist_track.dart';
import 'widgets/playlist_batch_download_bar.dart';
import 'widgets/playlist_artwork.dart';
import 'widgets/playlist_detail_actions.dart';
import 'widgets/playlist_detail_placeholders.dart';
import 'widgets/immersive_playlist_chrome.dart';
import 'widgets/playlist_track_tile.dart';
import 'widgets/playlist_wide_layout.dart';

class PlaylistDetailPage extends ConsumerStatefulWidget {
  const PlaylistDetailPage({
    super.key,
    required this.playlistId,
    this.returnLocation,
  });

  final String playlistId;
  final String? returnLocation;

  @override
  ConsumerState<PlaylistDetailPage> createState() => _PlaylistDetailPageState();
}

class _PlaylistDetailPageState extends ConsumerState<PlaylistDetailPage> {
  final Set<String> _selectedTrackIds = {};
  final ScrollController _scrollController = ScrollController();
  bool _batchMode = false;
  bool _batchSubmitting = false;
  bool _removingFavorite = false;

  SongSortMode _sortMode = SongSortMode.added;
  bool _ascending = true;

  bool _searchMode = false;
  String _searchQuery = '';
  final TextEditingController _searchController = TextEditingController();
  final FocusNode _searchFocusNode = FocusNode(debugLabel: 'playlist-search');
  bool? _toolbarVisibilityBeforeTransientUi;

  final Object _toolbarOwner = Object();
  late final StateController<PlaylistDetailToolbarState>
  _toolbarStateController;
  // Captured in initState so dispose-time restoration never touches `ref`.
  late final StateController<bool> _shellToolbarController;
  List<ResolvedPlaylistTrack> _visibleResolved = const [];
  List<DownloadHistoryEntry> _visibleQueue = const [];
  EmbeddedArtworkRequest? _artworkRequest;
  Uint8List? _artworkBytes;
  String? _artworkPath;

  String get _resolvedReturnLocation {
    final location = widget.returnLocation?.trim();
    return location == null || location.isEmpty
        ? '/playlists/${widget.playlistId}'
        : location;
  }

  @override
  void initState() {
    super.initState();
    _toolbarStateController = ref.read(
      playlistDetailToolbarStateProvider.notifier,
    );
    _shellToolbarController = ref.read(shellToolbarVisibleProvider.notifier);
  }

  @override
  void dispose() {
    _artworkRequest?.cancel();
    _artworkRequest = null;
    _searchFocusNode.removeListener(_handleSearchFocusChanged);
    _restoreToolbarAfterSearchFocus();
    _scrollController.dispose();
    _searchController.dispose();
    _searchFocusNode.dispose();
    final toolbarStateController = _toolbarStateController;
    final toolbarOwner = _toolbarOwner;
    scheduleMicrotask(() {
      if (!toolbarStateController.mounted) return;
      final toolbarState = toolbarStateController.state;
      if (identical(toolbarState.owner, toolbarOwner)) {
        toolbarStateController.state = const PlaylistDetailToolbarState();
      }
    });
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final playlists = ref.watch(localPlaylistsProvider);
    final playlist = _playlistById(playlists, widget.playlistId);
    if (playlist == null) {
      _visibleResolved = const [];
      _visibleQueue = const [];
      _syncToolbarState(
        title: null,
        visibleCount: 0,
        queueCount: 0,
        downloadableCount: 0,
        selectedCount: 0,
      );
      return const _MissingImmersivePlaylist();
    }

    final history = ref.watch(downloadHistoryProvider);
    final localIndex = LocalHistoryIndex(history);
    final resolved = playlist.tracks
        .map((track) {
          final localEntry = localIndex.resolve(track, playlist.id);
          return ResolvedPlaylistTrack(
            track: track,
            localEntry: localEntry,
            queueEntry:
                localEntry ?? track.toQueueEntry(playlistId: playlist.id),
          );
        })
        .toList(growable: false);
    final localCount = resolved.where((item) => item.localEntry != null).length;
    final matching = _searchMode
        ? filterResolvedTracksByQuery(resolved, _searchQuery)
        : resolved;
    final filtered = _sortResolvedTracks(matching);
    final queue = [
      for (final item in filtered)
        if (item.queueEntry != null) item.queueEntry!,
    ];
    final downloadable = filtered
        .where((item) => item.canDownload)
        .toList(growable: false);
    final visibleIds = {for (final item in filtered) item.track.id};
    final selectedCount = _selectedTrackIds.where(visibleIds.contains).length;
    final downloadableIds = {for (final item in downloadable) item.track.id};
    final downloadableSelectedCount = _selectedTrackIds
        .where(downloadableIds.contains)
        .length;

    _visibleResolved = filtered;
    _visibleQueue = queue;
    _syncToolbarState(
      title: playlist.name,
      visibleCount: filtered.length,
      queueCount: queue.length,
      downloadableCount: downloadable.length,
      selectedCount: selectedCount,
    );

    final artworkProvider = _artworkProviderFor(playlist);
    final artworkIdentity = _artworkIdentityFor(playlist);
    final wide = playlistDetailUsesWideLayout(context);
    return PlaylistArtworkTheme(
      artworkProvider: artworkProvider,
      cacheKey: 'local:${playlist.id}:$artworkIdentity',
      immersiveStatusBar: !wide,
      child: Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          return Scaffold(
            backgroundColor: scheme.surface,
            bottomNavigationBar: _batchMode
                ? PlaylistBatchDownloadBar(
                    selectedCount: selectedCount,
                    downloadableCount: downloadableSelectedCount,
                    submitting: _batchSubmitting,
                    onRemove: selectedCount == 0
                        ? null
                        : () => unawaited(
                            _removeSelectedVisible(playlist, filtered),
                          ),
                    onDownload: selectedCount == 0
                        ? null
                        : () => unawaited(_downloadSelectedVisible()),
                    onPlaySelected: selectedCount == 0
                        ? null
                        : () => unawaited(_playSelectedVisible(filtered)),
                  )
                : null,
            body: wide
                ? _buildWideBody(
                    playlist: playlist,
                    resolved: resolved,
                    filtered: filtered,
                    queue: queue,
                    selectedCount: selectedCount,
                    localCount: localCount,
                    artworkProvider: artworkProvider,
                  )
                : _buildCompactBody(
                    playlist: playlist,
                    resolved: resolved,
                    filtered: filtered,
                    queue: queue,
                    selectedCount: selectedCount,
                    localCount: localCount,
                    artworkProvider: artworkProvider,
                  ),
          );
        },
      ),
    );
  }

  Widget _buildCompactBody({
    required LocalPlaylist playlist,
    required List<ResolvedPlaylistTrack> resolved,
    required List<ResolvedPlaylistTrack> filtered,
    required List<DownloadHistoryEntry> queue,
    required int selectedCount,
    required int localCount,
    required ImageProvider<Object>? artworkProvider,
  }) {
    return AppScrollbar(
      controller: _scrollController,
      child: CustomScrollView(
        controller: _scrollController,
        key: PageStorageKey('playlist-detail-${widget.playlistId}'),
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        slivers: [
          SliverToBoxAdapter(
            child: ImmersivePlaylistHeader(
              artworkProvider: artworkProvider,
              topBar: _buildImmersiveTopBar(
                queue: queue,
                selectedCount: selectedCount,
                visibleCount: filtered.length,
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: PlaylistDetailInfo(
              title: playlist.name,
              metadata: _playlistMetadata(playlist, localCount: localCount),
              description: playlist.description,
            ),
          ),
          SliverToBoxAdapter(child: _buildActions(playlist, queue)),
          ..._trackListSlivers(
            playlist: playlist,
            resolved: resolved,
            filtered: filtered,
            queue: queue,
          ),
        ],
      ),
    );
  }

  Widget _buildWideBody({
    required LocalPlaylist playlist,
    required List<ResolvedPlaylistTrack> resolved,
    required List<ResolvedPlaylistTrack> filtered,
    required List<DownloadHistoryEntry> queue,
    required int selectedCount,
    required int localCount,
    required ImageProvider<Object>? artworkProvider,
  }) {
    return PlaylistWideBody(
      topBar: _buildImmersiveTopBar(
        queue: queue,
        selectedCount: selectedCount,
        visibleCount: filtered.length,
        onImage: false,
      ),
      infoPane: PlaylistWideInfoPane(
        artworkProvider: artworkProvider,
        title: playlist.name,
        metadata: _playlistMetadata(playlist, localCount: localCount),
        description: playlist.description,
        actions: _buildActions(
          playlist,
          queue,
          padding: const EdgeInsets.only(top: 4),
        ),
        bottomPadding: _batchMode ? 12 : 156,
      ),
      right: AppScrollbar(
        controller: _scrollController,
        child: CustomScrollView(
          controller: _scrollController,
          key: PageStorageKey('playlist-detail-wide-${widget.playlistId}'),
          physics: const BouncingScrollPhysics(
            parent: AlwaysScrollableScrollPhysics(),
          ),
          slivers: _trackListSlivers(
            playlist: playlist,
            resolved: resolved,
            filtered: filtered,
            queue: queue,
          ),
        ),
      ),
    );
  }

  Widget _buildActions(
    LocalPlaylist playlist,
    List<DownloadHistoryEntry> queue, {
    EdgeInsetsGeometry? padding,
  }) {
    return PlaylistDetailActions(
      onPlay: queue.isEmpty ? null : () => unawaited(_playAll(queue)),
      showFavorite: playlist.isOnlineImport,
      saved: true,
      favoriteLabel: '取消收藏',
      saving: _removingFavorite,
      removingFavorite: _removingFavorite,
      onFavorite: _removingFavorite
          ? null
          : () => unawaited(_confirmUnfavorite(playlist)),
      padding: padding ?? const EdgeInsets.fromLTRB(16, 4, 16, 8),
    );
  }

  List<Widget> _trackListSlivers({
    required LocalPlaylist playlist,
    required List<ResolvedPlaylistTrack> resolved,
    required List<ResolvedPlaylistTrack> filtered,
    required List<DownloadHistoryEntry> queue,
  }) {
    return [
      if (_searchMode)
        SliverPadding(
          key: const ValueKey('playlist-search-bar-sliver'),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 0),
          sliver: SliverToBoxAdapter(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 900),
                child: SongsSearchBar(
                  controller: _searchController,
                  focusNode: _searchFocusNode,
                  query: _searchQuery,
                  autofocus: true,
                  onChanged: _updateSearchQuery,
                  onClear: _clearSearch,
                ),
              ),
            ),
          ),
        ),
      if (resolved.isNotEmpty)
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(14, 2, 14, 0),
          sliver: SliverToBoxAdapter(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 900),
                child: _PlaylistTracksSummary(
                  count: filtered.length,
                  totalCount: resolved.length,
                  searching: _searchMode && _searchQuery.trim().isNotEmpty,
                  sortMode: _sortMode,
                  ascending: _ascending,
                  batchMode: _batchMode,
                  onOpenSort: _batchMode
                      ? null
                      : () => unawaited(_openSortSheet()),
                  onToggleBatch: filtered.isEmpty || _batchSubmitting
                      ? null
                      : _toggleBatchMode,
                ),
              ),
            ),
          ),
        ),
      if (resolved.isEmpty)
        const SliverFillRemaining(
          hasScrollBody: false,
          child: EmptyPlaylistDetail(),
        )
      else if (filtered.isEmpty)
        const SliverFillRemaining(
          hasScrollBody: false,
          child: EmptySongSearch(),
        )
      else
        SliverPadding(
          key: const ValueKey('playlist-tracks-sliver'),
          padding: EdgeInsets.fromLTRB(12, 0, 12, _batchMode ? 12 : 156),
          sliver: SlidableAutoCloseBehavior(
            child: SliverList.separated(
              itemCount: filtered.length,
              separatorBuilder: (_, _) => Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 900),
                  child: const SongListDivider(),
                ),
              ),
              itemBuilder: (context, index) {
                final item = filtered[index];
                return Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 900),
                    child: PlaylistTrackTile(
                      playlistId: playlist.id,
                      index: index,
                      item: item,
                      playing: false,
                      batchMode: _batchMode,
                      batchSubmitting: _batchSubmitting,
                      selected: _selectedTrackIds.contains(item.track.id),
                      onToggleSelected: () => _toggleSelection(item),
                      onPlay: () => _playTrack(context, ref, item, queue),
                      onDownload: item.track.musicInfo == null
                          ? null
                          : () => showQualityPickerSheet(
                              context,
                              item.track.musicInfo!,
                            ),
                      onRemove: () =>
                          _removeTrack(context, ref, playlist, item.track),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
    ];
  }

  Widget _buildImmersiveTopBar({
    required List<DownloadHistoryEntry> queue,
    required int selectedCount,
    required int visibleCount,
    bool onImage = true,
  }) {
    if (_searchMode) {
      return ImmersivePlaylistTopBar(
        title: '搜索歌单歌曲',
        onImage: onImage,
        actions: [
          ImmersiveTopIconButton(
            tooltip: '退出搜索',
            icon: Icons.close_rounded,
            onPressed: _closeSearch,
            onImage: onImage,
          ),
        ],
      );
    }
    if (_batchMode) {
      final allSelected = visibleCount > 0 && selectedCount == visibleCount;
      return ImmersivePlaylistTopBar(
        title: '已选中 $selectedCount 项',
        onImage: onImage,
        actions: [
          ImmersiveTopIconButton(
            tooltip: allSelected ? '取消全选' : '全选',
            icon: allSelected
                ? Icons.deselect_rounded
                : Icons.select_all_rounded,
            onPressed: visibleCount == 0 || _batchSubmitting
                ? null
                : _toggleSelectAllVisible,
            onImage: onImage,
          ),
          const SizedBox(width: 4),
          ImmersiveTopIconButton(
            tooltip: '退出批量管理',
            icon: Icons.close_rounded,
            onPressed: _batchSubmitting ? null : _toggleBatchMode,
            onImage: onImage,
          ),
        ],
      );
    }
    return ImmersivePlaylistTopBar(
      title: '歌单详情',
      onImage: onImage,
      actions: [
        ImmersiveTopIconButton(
          tooltip: '搜索歌单歌曲',
          icon: Icons.search_rounded,
          onPressed: _openSearch,
          onImage: onImage,
        ),
        const SizedBox(width: 4),
        ImmersiveTopIconButton(
          tooltip: '随机播放',
          icon: Icons.shuffle_rounded,
          onPressed: queue.length >= 2 ? _shuffleVisible : null,
          onImage: onImage,
        ),
      ],
    );
  }

  List<ResolvedPlaylistTrack> _sortResolvedTracks(
    List<ResolvedPlaylistTrack> tracks,
  ) {
    if (_sortMode == SongSortMode.added) {
      return _ascending
          ? List<ResolvedPlaylistTrack>.of(tracks)
          : tracks.reversed.toList(growable: false);
    }
    final indexed = tracks.indexed.toList(growable: false);
    int compare(
      (int, ResolvedPlaylistTrack) a,
      (int, ResolvedPlaylistTrack) b,
    ) {
      final left = a.$2.track;
      final right = b.$2.track;
      final primary = switch (_sortMode) {
        SongSortMode.title => left.name.trim().toLowerCase().compareTo(
          right.name.trim().toLowerCase(),
        ),
        SongSortMode.artist => left.singer.trim().toLowerCase().compareTo(
          right.singer.trim().toLowerCase(),
        ),
        SongSortMode.added => a.$1.compareTo(b.$1),
      };
      final directed = _ascending ? primary : -primary;
      return directed == 0 ? a.$1.compareTo(b.$1) : directed;
    }

    indexed.sort(compare);
    return [for (final item in indexed) item.$2];
  }

  void _setSort(SongSortMode mode, bool ascending) {
    if (!mounted || (_sortMode == mode && _ascending == ascending)) return;
    setState(() {
      _sortMode = mode;
      _ascending = ascending;
    });
  }

  Future<void> _openSortSheet() async {
    if (_batchMode || _batchSubmitting) return;
    FocusManager.instance.primaryFocus?.unfocus();
    final toolbar = _shellToolbarController;
    final wasToolbarVisible = toolbar.mounted ? toolbar.state : true;
    if (toolbar.mounted) toolbar.state = false;
    try {
      await showSongsSortSheet(
        context: context,
        initialMode: _sortMode,
        initialAscending: _ascending,
        onChanged: _setSort,
      );
    } finally {
      if (toolbar.mounted && !_batchMode && !_searchMode) {
        toolbar.state = wasToolbarVisible;
      }
    }
  }

  ImageProvider<Object>? _artworkProviderFor(LocalPlaylist playlist) {
    final explicit = playlist.coverUrl?.trim();
    if (explicit != null && explicit.isNotEmpty) {
      _clearEmbeddedArtwork();
      return networkPlaylistArtworkProvider(explicit);
    }
    final fallback = playlistCoverFallbackTrack(playlist);
    final fallbackUrl = fallback?.picUrl?.trim();
    if (fallbackUrl != null && fallbackUrl.isNotEmpty) {
      final provider = networkPlaylistArtworkProvider(fallbackUrl);
      if (provider != null) {
        _clearEmbeddedArtwork();
        return provider;
      }
    }
    final path = fallback?.localPath?.trim();
    if (path == null || path.isEmpty) {
      _clearEmbeddedArtwork();
      return null;
    }
    _ensureEmbeddedArtwork(path);
    final bytes = _artworkBytes;
    return bytes == null || bytes.isEmpty ? null : MemoryImage(bytes);
  }

  String _artworkIdentityFor(LocalPlaylist playlist) {
    final explicit = playlist.coverUrl?.trim();
    if (explicit != null && explicit.isNotEmpty) return 'url:$explicit';
    final fallback = playlistCoverFallbackTrack(playlist);
    final fallbackUrl = fallback?.picUrl?.trim();
    if (fallbackUrl != null && fallbackUrl.isNotEmpty) {
      return 'track-url:$fallbackUrl';
    }
    final path = fallback?.localPath?.trim();
    return path == null || path.isEmpty ? 'none' : 'embedded:$path';
  }

  void _clearEmbeddedArtwork() {
    if (_artworkPath == null && _artworkBytes == null) return;
    _artworkRequest?.cancel();
    _artworkRequest = null;
    _artworkPath = null;
    _artworkBytes = null;
  }

  void _ensureEmbeddedArtwork(String path) {
    if (_artworkPath == path) return;
    _artworkRequest?.cancel();
    _artworkBytes = null;
    _artworkPath = path;
    final request = EmbeddedArtworkCache.subscribe(path);
    _artworkRequest = request;
    unawaited(
      request.future.then((bytes) {
        if (identical(_artworkRequest, request)) _artworkRequest = null;
        request.cancel();
        if (!mounted ||
            _artworkPath != path ||
            bytes == null ||
            bytes.isEmpty) {
          return;
        }
        setState(() => _artworkBytes = bytes);
      }),
    );
  }

  String _playlistMetadata(LocalPlaylist playlist, {required int localCount}) {
    final sourceCode = playlist.originSourceCode?.trim() ?? '';
    final source = MusicSource.fromCode(sourceCode);
    return [
      playlist.isOnlineImport ? source.label : '本地歌单',
      if (playlist.creator?.trim().isNotEmpty == true) playlist.creator!.trim(),
      '${playlist.tracks.length} 首',
      if (localCount > 0) '$localCount 首已下载',
    ].join(' · ');
  }

  void _syncToolbarState({
    required String? title,
    required int visibleCount,
    required int queueCount,
    required int downloadableCount,
    required int selectedCount,
  }) {
    final allSelected = visibleCount > 0 && selectedCount == visibleCount;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final current = ref.read(playlistDetailToolbarStateProvider);
      if (current.matchesView(
        owner: _toolbarOwner,
        title: title,
        queueCount: queueCount,
        downloadableCount: downloadableCount,
        selectedCount: selectedCount,
        allSelected: allSelected,
        batchMode: _batchMode,
        batchSubmitting: _batchSubmitting,
        searchMode: _searchMode,
      )) {
        return;
      }
      ref
          .read(playlistDetailToolbarStateProvider.notifier)
          .state = PlaylistDetailToolbarState(
        owner: _toolbarOwner,
        title: title,
        queueCount: queueCount,
        downloadableCount: downloadableCount,
        selectedCount: selectedCount,
        allSelected: allSelected,
        batchMode: _batchMode,
        batchSubmitting: _batchSubmitting,
        searchMode: _searchMode,
        onShuffle: _shuffleVisible,
        onToggleBatch: _toggleBatchMode,
        onToggleSelectAll: _toggleSelectAllVisible,
        onToggleSearch: _toggleSearchMode,
      );
    });
  }

  void _toggleBatchMode() {
    if (_batchSubmitting) return;
    if (_searchMode) _closeSearch();
    final next = !_batchMode;
    setState(() {
      _batchMode = next;
      if (!next) _selectedTrackIds.clear();
    });
    if (next) {
      _hideShellToolbarForTransientUi();
    } else {
      _restoreToolbarAfterSearchFocus();
    }
  }

  void _toggleSearchMode() {
    if (_searchMode) {
      _closeSearch();
    } else {
      _openSearch();
    }
  }

  void _openSearch() {
    if (_searchMode || _batchSubmitting) return;
    setState(() {
      _searchMode = true;
      _batchMode = false;
      _selectedTrackIds.clear();
    });
    _searchFocusNode.addListener(_handleSearchFocusChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _searchMode) _searchFocusNode.requestFocus();
    });
  }

  void _closeSearch() {
    if (!_searchMode) return;
    _searchFocusNode.removeListener(_handleSearchFocusChanged);
    _restoreToolbarAfterSearchFocus();
    _searchController.clear();
    setState(() {
      _searchMode = false;
      _searchQuery = '';
      _selectedTrackIds.clear();
    });
    FocusManager.instance.primaryFocus?.unfocus();
  }

  void _handleSearchFocusChanged() {
    if (!mounted || !_searchMode) return;
    if (!_searchFocusNode.hasFocus) {
      _restoreToolbarAfterSearchFocus();
      return;
    }

    _hideShellToolbarForTransientUi();
  }

  void _hideShellToolbarForTransientUi() {
    final toolbar = _shellToolbarController;
    if (!toolbar.mounted) return;
    _toolbarVisibilityBeforeTransientUi ??= toolbar.state;
    toolbar.state = false;
  }

  void _restoreToolbarAfterSearchFocus() {
    final previous = _toolbarVisibilityBeforeTransientUi;
    if (previous == null) return;
    _toolbarVisibilityBeforeTransientUi = null;
    final toolbar = _shellToolbarController;
    if (toolbar.mounted) toolbar.state = previous;
  }

  void _updateSearchQuery(String query) {
    if (_searchQuery == query) return;
    setState(() => _searchQuery = query);
  }

  void _clearSearch() {
    _searchController.clear();
    _updateSearchQuery('');
    FocusManager.instance.primaryFocus?.unfocus();
  }

  void _toggleSelection(ResolvedPlaylistTrack item) {
    if (_batchSubmitting) return;
    setState(() {
      if (!_selectedTrackIds.add(item.track.id)) {
        _selectedTrackIds.remove(item.track.id);
      }
    });
  }

  void _toggleSelectAllVisible() {
    final selectableIds = {for (final item in _visibleResolved) item.track.id};
    if (_batchSubmitting || selectableIds.isEmpty) return;
    setState(() {
      final selectedCount = _selectedTrackIds
          .where(selectableIds.contains)
          .length;
      if (selectedCount == selectableIds.length) {
        _selectedTrackIds.removeAll(selectableIds);
      } else {
        _selectedTrackIds.addAll(selectableIds);
      }
    });
  }

  Future<void> _downloadSelectedVisible() async {
    if (_batchSubmitting) return;
    final selectedVisible = [
      for (final item in _visibleResolved)
        if (_selectedTrackIds.contains(item.track.id)) item,
    ];
    if (selectedVisible.isEmpty) {
      showAppToast(context, '请先选择歌曲', type: AppToastType.warning);
      return;
    }

    final progress = ref.read(downloadProgressProvider);
    final selected = <ResolvedPlaylistTrack>[];
    for (final item in selectedVisible) {
      final music = item.track.musicInfo;
      if (item.localEntry != null ||
          music == null ||
          progress.isMusicBusy(music.id)) {
        continue;
      }
      selected.add(item);
    }
    final preSkipped = selectedVisible.length - selected.length;
    if (selected.isEmpty) {
      setState(() {
        _selectedTrackIds.clear();
        _batchMode = false;
      });
      _restoreToolbarAfterSearchFocus();
      showAppToast(
        context,
        '已跳过 ${selectedVisible.length} 首，无需下载',
        type: AppToastType.warning,
        duration: const Duration(seconds: 4),
      );
      return;
    }
    final available = await ensureOnlineMusicSourcesAvailable(
      context,
      selected.map((item) => item.track.musicInfo!.source),
    );
    if (!available || !mounted) return;

    final qualityPreference = ref.read(settingsProvider).batchDownloadQuality;
    setState(() {
      _selectedTrackIds.clear();
      _batchMode = false;
    });
    _restoreToolbarAfterSearchFocus();
    showAppToast(
      context,
      '已加入下载队列：${selected.length} 首，音质：${qualityPreference.label}',
      type: AppToastType.info,
    );

    try {
      final results = await ref
          .read(downloadServiceProvider)
          .downloadMany(
            musics: [for (final item in selected) item.track.musicInfo!],
            embed: const EmbedRequest.richest(),
            qualityPreference: qualityPreference,
          );
      if (!mounted) return;

      final failed = results.where((item) => !item.success).toList();
      final skipped = preSkipped + selected.length - results.length;

      final succeeded = results.length - failed.length;
      if (failed.isEmpty && skipped == 0) {
        showAppToast(
          context,
          '批量下载完成：$succeeded 首',
          type: AppToastType.success,
          duration: const Duration(seconds: 4),
        );
      } else if (succeeded == 0 && failed.isNotEmpty) {
        showAppToast(
          context,
          '批量下载失败：${failed.first.music.name}（${failed.first.error}）',
          type: AppToastType.error,
          duration: const Duration(seconds: 4),
        );
      } else {
        final parts = <String>['$succeeded 首成功'];
        if (failed.isNotEmpty) parts.add('${failed.length} 首失败');
        if (skipped > 0) parts.add('$skipped 首已跳过');
        showAppToast(
          context,
          '批量下载完成：${parts.join('，')}',
          type: AppToastType.warning,
          duration: const Duration(seconds: 4),
        );
      }
    } catch (error) {
      if (mounted) {
        showAppToast(
          context,
          '批量下载失败：$error',
          type: AppToastType.error,
          duration: const Duration(seconds: 4),
        );
      }
    } finally {
      if (mounted) setState(() => _batchSubmitting = false);
    }
  }

  Future<void> _playAll(List<DownloadHistoryEntry> queue) async {
    if (queue.isEmpty) return;
    final first = queue.first;
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      first,
    );
    if (!available || !mounted) return;
    context.go('/player', extra: _resolvedReturnLocation);
    await ref
        .read(playerControllerProvider.notifier)
        .playFromPlaylistQueue(first, queue);
  }

  Future<void> _confirmUnfavorite(LocalPlaylist playlist) async {
    if (_removingFavorite) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.heart_broken_rounded),
        title: const Text('取消收藏这个歌单？'),
        content: Text('“${playlist.name}”会从我的歌单移除，本地音乐文件和下载记录不会受到影响。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('取消收藏'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _removingFavorite = true);
    try {
      await ref.read(localPlaylistsProvider.notifier).delete(playlist.id);
      if (!mounted) return;
      showAppToast(context, '已取消收藏', type: AppToastType.success);
      context.go('/playlists');
    } catch (error) {
      if (!mounted) return;
      showAppToast(context, '取消收藏失败：$error', type: AppToastType.error);
    } finally {
      if (mounted) setState(() => _removingFavorite = false);
    }
  }

  Future<void> _playSelectedVisible(List<ResolvedPlaylistTrack> visible) async {
    final selectedQueue = [
      for (final item in visible)
        if (_selectedTrackIds.contains(item.track.id) &&
            item.queueEntry != null)
          item.queueEntry!,
    ];
    if (selectedQueue.isEmpty) {
      showAppToast(context, '请先选择可播放的歌曲', type: AppToastType.warning);
      return;
    }
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      selectedQueue.first,
    );
    if (!available || !mounted) return;
    setState(() {
      _selectedTrackIds.clear();
      _batchMode = false;
    });
    _restoreToolbarAfterSearchFocus();
    context.go('/player', extra: _resolvedReturnLocation);
    await ref
        .read(playerControllerProvider.notifier)
        .playFromPlaylistQueue(selectedQueue.first, selectedQueue);
  }

  Future<void> _removeSelectedVisible(
    LocalPlaylist playlist,
    List<ResolvedPlaylistTrack> visible,
  ) async {
    final selected = [
      for (final item in visible)
        if (_selectedTrackIds.contains(item.track.id)) item,
    ];
    if (selected.isEmpty) {
      showAppToast(context, '请先选择要移出的歌曲', type: AppToastType.warning);
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.playlist_remove_rounded),
        title: const Text('移出已选歌曲？'),
        content: Text('将从这个歌单移出 ${selected.length} 首歌曲，不会删除本地文件。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('移出'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final removed = await ref
        .read(localPlaylistsProvider.notifier)
        .removeTracks(playlist.id, [
          for (final item in selected) item.track.id,
        ]);
    if (!mounted) return;
    setState(() {
      _selectedTrackIds.clear();
      _batchMode = false;
    });
    _restoreToolbarAfterSearchFocus();
    showAppToast(context, '已移出 $removed 首歌曲', type: AppToastType.success);
  }

  Future<void> _shuffleVisible() async {
    final queue = _visibleQueue;
    if (queue.isEmpty) return;
    final first = queue[math.Random().nextInt(queue.length)];
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      first,
    );
    if (!available || !mounted) return;
    ref
        .read(playerControllerProvider.notifier)
        .setPlaybackMode(PlayerPlaybackMode.shuffle);
    context.go('/player', extra: _resolvedReturnLocation);
    unawaited(
      ref
          .read(playerControllerProvider.notifier)
          .playFromPlaylistQueue(first, queue),
    );
  }

  Future<void> _playTrack(
    BuildContext context,
    WidgetRef ref,
    ResolvedPlaylistTrack item,
    List<DownloadHistoryEntry> queue,
  ) async {
    final entry = item.queueEntry;
    if (entry == null) {
      showAppToast(context, '这首歌曲暂时无法播放', type: AppToastType.warning);
      return;
    }
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      entry,
    );
    if (!available || !context.mounted) return;
    context.go('/player', extra: _resolvedReturnLocation);
    await ref
        .read(playerControllerProvider.notifier)
        .playFromPlaylistQueue(entry, queue);
  }

  Future<void> _removeTrack(
    BuildContext context,
    WidgetRef ref,
    LocalPlaylist playlist,
    PlaylistTrack track,
  ) async {
    await ref
        .read(localPlaylistsProvider.notifier)
        .removeTrack(playlist.id, track.id);
    if (context.mounted) {
      showAppToast(context, '已从歌单移除', type: AppToastType.success);
    }
  }
}

class _PlaylistTracksSummary extends StatelessWidget {
  const _PlaylistTracksSummary({
    required this.count,
    required this.totalCount,
    required this.searching,
    required this.sortMode,
    required this.ascending,
    required this.batchMode,
    required this.onOpenSort,
    required this.onToggleBatch,
  });

  final int count;
  final int totalCount;
  final bool searching;
  final SongSortMode sortMode;
  final bool ascending;
  final bool batchMode;
  final VoidCallback? onOpenSort;
  final VoidCallback? onToggleBatch;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 52,
      child: Row(
        children: [
          Expanded(
            child: Text(
              searching ? '找到 $count 首歌曲' : '$totalCount 首歌曲',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          _PlaylistSummaryIconButton(
            key: const ValueKey('playlist-sort-button'),
            tooltip: '排序：${sortMode.label}（${ascending ? '升序' : '降序'}）',
            icon: Icons.sort_rounded,
            onPressed: onOpenSort,
          ),
          _PlaylistSummaryIconButton(
            key: const ValueKey('playlist-batch-button'),
            tooltip: batchMode ? '退出批量操作' : '批量操作',
            icon: Icons.checklist_rounded,
            onPressed: onToggleBatch,
            active: batchMode,
          ),
        ],
      ),
    );
  }
}

class _PlaylistSummaryIconButton extends StatelessWidget {
  const _PlaylistSummaryIconButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.active = false,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 48,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          foregroundColor: active
              ? scheme.onSecondaryContainer
              : scheme.onSurfaceVariant,
          backgroundColor: active ? scheme.secondaryContainer : null,
          disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.34),
        ),
        icon: Icon(icon, size: 21),
      ),
    );
  }
}

class _MissingImmersivePlaylist extends StatelessWidget {
  const _MissingImmersivePlaylist();

  @override
  Widget build(BuildContext context) {
    return PlaylistArtworkTheme(
      artworkProvider: null,
      cacheKey: 'missing-local-playlist',
      child: Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          return Scaffold(
            backgroundColor: scheme.surface,
            body: CustomScrollView(
              physics: const AlwaysScrollableScrollPhysics(
                parent: BouncingScrollPhysics(),
              ),
              slivers: const [
                SliverToBoxAdapter(
                  child: ImmersivePlaylistHeader(
                    artworkProvider: null,
                    topBar: ImmersivePlaylistTopBar(title: '歌单详情'),
                  ),
                ),
                SliverToBoxAdapter(
                  child: PlaylistDetailInfo(title: '歌单不存在', metadata: '本地歌单'),
                ),
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: MissingPlaylist(),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

LocalPlaylist? _playlistById(List<LocalPlaylist> playlists, String id) {
  for (final playlist in playlists) {
    if (playlist.id == id) return playlist;
  }
  return null;
}
