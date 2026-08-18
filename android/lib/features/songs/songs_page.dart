import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/enums.dart';
import '../../core/services/embedded_artwork_cache.dart';
import '../../core/services/tagger.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/app_scrollbar.dart';
import '../../core/ui/app_toast.dart';
import '../../core/ui/app_refresh_indicator.dart';
import '../../theme/app_motion.dart';
import '../downloads/download_history_store.dart';
import '../music_sources/music_source_action_guard.dart';
import '../player/player_controller.dart';
import '../playlists/playlist_browser_sheet.dart';
import '../playlists/playlist_models.dart';
import '../playlists/online_playlist_updater.dart';
import '../playlists/resolved_playlist_track.dart';
import '../playlists/playlist_store.dart';
import '../shell/shell_toolbar_visibility.dart';
import 'local_song_scan_cache.dart';
import 'scanned_song_file.dart';
import 'song_search.dart';
import 'songs_toolbar_state.dart';
import 'widgets/song_row.dart';
import 'widgets/songs_batch_action_bar.dart';
import 'widgets/songs_placeholders.dart';
import 'widgets/songs_sort_sheet.dart';

const _songTagReadTimeout = Duration(seconds: 8);
const _songScanCacheTtl = Duration(seconds: 12);
const _songSortModeKey = 'songs_sort_mode_v1';
const _songSortAscendingKey = 'songs_sort_ascending_v1';

class SongsPage extends ConsumerStatefulWidget {
  const SongsPage({super.key, this.searchMode = false});

  final bool searchMode;

  @override
  ConsumerState<SongsPage> createState() => _SongsPageState();
}

class _SongsPageState extends ConsumerState<SongsPage> {
  SongSortMode _sortMode = SongSortMode.title;
  bool _ascending = true;
  bool _batchMode = false;
  String _searchQuery = '';
  final Object _toolbarOwner = Object();
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();
  final FocusNode _searchFocusNode = FocusNode(debugLabel: 'songs-search');
  bool? _toolbarVisibilityBeforeSearchFocus;
  List<DownloadHistoryEntry> _visibleSongs = const [];
  Map<String, PlaylistTrack> _visiblePlaylistTracks = const {};
  final Set<String> _selectedIds = <String>{};
  final Set<String> _updatingPlaylistIds = <String>{};
  final Map<String, EmbeddedAudioTags?> _tagCache = {};
  final Map<String, DateTime> _tagModifiedAt = {};
  final Set<String> _tagLoadingKeys = <String>{};
  List<ScannedSongFile>? _scannedFiles;
  String? _scanError;
  int _scanGeneration = 0;
  Timer? _tagFlushTimer;
  ProviderSubscription<String>? _localMusicDirSubscription;
  late final StateController<SongsToolbarState> _toolbarStateController;
  late final LocalSongScanCache _scanCache;
  late final Future<void> _firstRouteTransitionSettled;

  @override
  void initState() {
    super.initState();
    final prefs = ref.read(sharedPreferencesProvider);
    _sortMode = SongSortMode.fromCode(prefs.getString(_songSortModeKey));
    _ascending = prefs.getBool(_songSortAscendingKey) ?? true;
    _toolbarStateController = ref.read(songsToolbarStateProvider.notifier);
    _scanCache = ref.read(localSongScanCacheProvider);
    _scanCache.addListener(_handleScanCacheChanged);
    if (widget.searchMode) _enableSearchFocusHandling();
    _firstRouteTransitionSettled = _waitForFirstRouteTransition();
    _localMusicDirSubscription = ref.listenManual(
      settingsProvider.select((settings) => settings.localMusicDir),
      (previous, next) {
        if (previous == null || previous == next) return;
        // Keep the currently rendered library in place while the new folder is
        // scanned, then swap the result in one frame. This avoids a loading
        // flash when the local music folder changes from Settings.
        unawaited(_scanLocalMusicFolder());
      },
    );
    unawaited(_initializeScan());
  }

  @override
  void didUpdateWidget(covariant SongsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.searchMode == widget.searchMode) return;
    if (widget.searchMode) {
      _enableSearchFocusHandling();
    } else {
      _disableSearchFocusHandling();
    }
  }

  Future<void> _initializeScan() async {
    await _scanCache.ensureLoaded();
    if (!mounted) return;

    _handleScanCacheChanged();
    final snapshot = _scanCache.snapshot;
    final currentDirectory = ref.read(settingsProvider).localMusicDir;
    final shouldRefresh =
        snapshot == null ||
        snapshot.directory != currentDirectory ||
        snapshot.error != null ||
        DateTime.now().difference(snapshot.cachedAt) >= _songScanCacheTtl;
    if (shouldRefresh) {
      unawaited(_scanCache.refresh(directory: currentDirectory));
    }
  }

  @override
  void dispose() {
    _scanGeneration++;
    _disableSearchFocusHandling();
    _scanCache.removeListener(_handleScanCacheChanged);
    _localMusicDirSubscription?.close();
    _tagFlushTimer?.cancel();
    _scrollController.dispose();
    _searchController.dispose();
    _searchFocusNode.dispose();
    final toolbarStateController = _toolbarStateController;
    final toolbarOwner = _toolbarOwner;
    scheduleMicrotask(() {
      if (!toolbarStateController.mounted) return;
      final toolbarState = toolbarStateController.state;
      if (identical(toolbarState.owner, toolbarOwner)) {
        toolbarStateController.state = const SongsToolbarState();
      }
    });
    super.dispose();
  }

  void _enableSearchFocusHandling() {
    _searchFocusNode.addListener(_handleSearchFocusChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.searchMode) _searchFocusNode.requestFocus();
    });
  }

  void _disableSearchFocusHandling() {
    _searchFocusNode.removeListener(_handleSearchFocusChanged);
    _restoreToolbarAfterSearchFocus();
  }

  void _handleSearchFocusChanged() {
    if (!mounted || !widget.searchMode) return;
    if (!_searchFocusNode.hasFocus) {
      _restoreToolbarAfterSearchFocus();
      return;
    }

    _toolbarVisibilityBeforeSearchFocus ??= ref.read(
      shellToolbarVisibleProvider,
    );
    final toolbar = ref.read(shellToolbarVisibleProvider.notifier);
    if (toolbar.mounted) toolbar.state = false;
  }

  void _restoreToolbarAfterSearchFocus() {
    final previous = _toolbarVisibilityBeforeSearchFocus;
    if (previous == null) return;
    _toolbarVisibilityBeforeSearchFocus = null;
    final toolbar = ref.read(shellToolbarVisibleProvider.notifier);
    if (toolbar.mounted) toolbar.state = previous;
  }

  Future<void> _waitForFirstRouteTransition() async {
    await WidgetsBinding.instance.endOfFrame;
    final reduceMotion = WidgetsBinding
        .instance
        .platformDispatcher
        .accessibilityFeatures
        .disableAnimations;
    if (!reduceMotion) await Future<void>.delayed(AppMotion.long);
  }

  bool _isActiveScan(int generation) {
    if (!mounted || generation != _scanGeneration) return false;
    return _isSongsRouteActive();
  }

  bool _isSongsRouteActive() {
    if (!mounted) return false;
    final path = GoRouter.of(context).routeInformationProvider.value.uri.path;
    return path == (widget.searchMode ? '/songs/search' : '/songs');
  }

  Future<void> _resumeCachedHydration(
    List<ScannedSongFile> files,
    int generation,
  ) async {
    await _firstRouteTransitionSettled;
    if (!_isActiveScan(generation)) return;
    await _hydrateScannedTags(files, generation);
  }

  void _handleScanCacheChanged() {
    if (!mounted) return;
    final snapshot = _scanCache.snapshot;
    if (snapshot == null) return;
    final currentDirectory = ref.read(settingsProvider).localMusicDir;
    if (snapshot.directory != currentDirectory) return;

    final files = [
      for (final file in snapshot.files) ScannedSongFile.fromSnapshot(file),
    ];
    final previousFiles = _scannedFiles ?? const <ScannedSongFile>[];
    final nextFilesByKey = {
      for (final file in files) _pathKey(file.path): file,
    };
    for (final previous in previousFiles) {
      final next = nextFilesByKey[_pathKey(previous.path)];
      if (next == null || next.modifiedAt != previous.modifiedAt) {
        EmbeddedArtworkCache.evictPath(previous.path);
      }
    }

    final generation = ++_scanGeneration;
    setState(() {
      _scannedFiles = files;
      _scanError = snapshot.error;
      final currentKeys = nextFilesByKey.keys.toSet();
      _tagCache.removeWhere((key, _) => !currentKeys.contains(key));
      _tagModifiedAt.removeWhere((key, _) => !currentKeys.contains(key));
      _tagLoadingKeys.clear();
      _selectedIds.clear();
      _batchMode = false;
      _tagCache.addAll(songTagCacheSnapshot);
      _tagModifiedAt.addAll(songTagModifiedAtSnapshot);
    });
    if (snapshot.error == null && files.isNotEmpty) {
      unawaited(_resumeCachedHydration(files, generation));
    }
  }

  Future<void> _scanLocalMusicFolder() {
    return _scanCache.refresh(
      directory: ref.read(settingsProvider).localMusicDir,
    );
  }

  List<DownloadHistoryEntry> _songs(List<DownloadHistoryEntry> history) {
    final scannedFiles = _scannedFiles;
    if (scannedFiles == null) return const [];
    final historyByPath = <String, DownloadHistoryEntry>{};
    for (final entry in history) {
      final path = entry.savedPath;
      if (path == null || path.isEmpty) continue;
      historyByPath[_pathKey(path)] = entry;
    }

    final out = <DownloadHistoryEntry>[];
    final seen = <String>{};
    for (final file in scannedFiles) {
      final key = _pathKey(file.path);
      final tags = _tagCache[key];
      final historyEntry = historyByPath[key];
      final entry = historyEntry == null
          ? _syntheticEntryFor(file, tags)
          : _entryWithScannedFile(historyEntry, file, tags);
      if (seen.add(key)) out.add(entry);
    }

    int compare(DownloadHistoryEntry a, DownloadHistoryEntry b) {
      switch (_sortMode) {
        case SongSortMode.title:
          return a.name.toLowerCase().compareTo(b.name.toLowerCase());
        case SongSortMode.artist:
          return a.singer.toLowerCase().compareTo(b.singer.toLowerCase());
        case SongSortMode.added:
          return a.createdAt.compareTo(b.createdAt);
      }
    }

    out.sort(_ascending ? compare : (a, b) => compare(b, a));
    return out;
  }

  ({
    List<DownloadHistoryEntry> songs,
    Map<String, PlaylistTrack> tracksByEntryId,
  })
  _songsForPlaylist(
    LocalPlaylist playlist,
    List<DownloadHistoryEntry> history,
  ) {
    final localIndex = LocalHistoryIndex(history);
    final songs = <DownloadHistoryEntry>[];
    final tracksByEntryId = <String, PlaylistTrack>{};
    for (final track in playlist.tracks) {
      final localEntry = localIndex.resolve(track, playlist.id);
      final entry =
          localEntry ??
          track.toQueueEntry(playlistId: playlist.id) ??
          DownloadHistoryEntry(
            id: 'playlist:${playlist.id}:${track.identityKey}',
            musicId: track.musicId,
            name: track.name,
            singer: track.singer,
            albumName: track.albumName,
            sourceCode: track.sourceCode,
            qualityCode: track.qualityCode,
            status: DownloadHistoryStatus.completed,
            createdAt: DateTime.fromMillisecondsSinceEpoch(0),
            savedPath: track.localPath,
            picUrl: track.picUrl,
            musicJson: track.musicJson,
          );
      songs.add(entry);
      tracksByEntryId[entry.id] = track;
    }
    return (
      songs: List<DownloadHistoryEntry>.unmodifiable(songs),
      tracksByEntryId: Map<String, PlaylistTrack>.unmodifiable(tracksByEntryId),
    );
  }

  DownloadHistoryEntry _entryWithScannedFile(
    DownloadHistoryEntry entry,
    ScannedSongFile file,
    EmbeddedAudioTags? tags,
  ) {
    return DownloadHistoryEntry(
      id: entry.id,
      musicId: entry.musicId,
      name: _preferTag(
        tags?.title,
        entry.name.isEmpty ? file.title : entry.name,
      ),
      singer: _preferTag(tags?.artist, entry.singer),
      albumName: _preferTag(tags?.album, entry.albumName),
      sourceCode: entry.sourceCode,
      qualityCode: entry.qualityCode,
      status: entry.status,
      createdAt: file.createdAt,
      savedPath: file.path,
      message: entry.message,
      picUrl: entry.picUrl,
      sizeBytes: file.sizeBytes,
      musicJson: entry.musicJson,
    );
  }

  DownloadHistoryEntry _syntheticEntryFor(
    ScannedSongFile file,
    EmbeddedAudioTags? tags,
  ) {
    return DownloadHistoryEntry(
      id: 'file:${file.path}',
      musicId: file.path,
      name: _preferTag(tags?.title, file.title),
      singer: _preferTag(tags?.artist, file.artist),
      albumName: _preferTag(tags?.album, ''),
      sourceCode: MusicSource.all.code,
      qualityCode: file.extension.toLowerCase(),
      status: DownloadHistoryStatus.completed,
      createdAt: file.createdAt,
      savedPath: file.path,
      sizeBytes: file.sizeBytes,
    );
  }

  Future<void> _hydrateScannedTags(
    List<ScannedSongFile> files,
    int generation,
  ) async {
    for (final file in files) {
      if (!_isActiveScan(generation)) return;
      final key = _pathKey(file.path);
      if (_tagCache.containsKey(key) &&
          _tagModifiedAt[key] == file.modifiedAt) {
        continue;
      }
      if (!_tagLoadingKeys.add(key)) continue;
      EmbeddedAudioTags? tags;
      try {
        tags = await Tagger.readEmbeddedTags(
          file.path,
          includeLyrics: false,
          includeArtwork: false,
        ).timeout(_songTagReadTimeout);
      } catch (_) {
        tags = null;
      }
      if (!_isActiveScan(generation)) {
        _tagLoadingKeys.remove(key);
        return;
      }
      _tagLoadingKeys.remove(key);
      if (tags == null) {
        _tagCache.remove(key);
        _tagModifiedAt.remove(key);
        songTagCacheSnapshot.remove(key);
        songTagModifiedAtSnapshot.remove(key);
      } else {
        _tagCache[key] = tags;
        _tagModifiedAt[key] = file.modifiedAt;
        songTagCacheSnapshot[key] = tags;
        songTagModifiedAtSnapshot[key] = file.modifiedAt;
      }
      // One setState per file means N full list rebuild+sorts while a large
      // library hydrates; coalesce text metadata into small batches.
      _scheduleTagFlush();
    }
  }

  void _scheduleTagFlush() {
    _tagFlushTimer ??= Timer(const Duration(milliseconds: 90), () {
      _tagFlushTimer = null;
      if (_isSongsRouteActive()) setState(() {});
    });
  }

  Future<void> _play(
    DownloadHistoryEntry entry,
    List<DownloadHistoryEntry> queue,
  ) async {
    final path = entry.savedPath;
    final hasLocalFile =
        path != null && path.isNotEmpty && File(path).existsSync();
    final playlistMode = ref.read(songsLibraryPlaylistIdProvider) != null;
    if (!hasLocalFile && (!playlistMode || entry.musicInfo == null)) {
      showAppToast(
        context,
        playlistMode ? '这首歌曲暂时无法播放' : '文件不存在，可能已被移动或删除',
        type: AppToastType.warning,
      );
      return;
    }
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      entry,
    );
    if (!available || !mounted) return;
    context.go(
      '/player',
      extra: widget.searchMode ? '/songs/search' : '/songs',
    );
    final player = ref.read(playerControllerProvider.notifier);
    if (playlistMode) {
      await player.playFromPlaylistQueue(entry, queue);
    } else {
      await player.playFromHistoryQueue(entry, queue);
    }
  }

  Future<void> _playRandom(List<DownloadHistoryEntry> songs) async {
    final playable = songs
        .where((entry) {
          final path = entry.savedPath;
          return (path != null && path.isNotEmpty && File(path).existsSync()) ||
              entry.musicInfo != null;
        })
        .toList(growable: false);
    if (playable.isEmpty) {
      showAppToast(context, '没有可播放的本地歌曲', type: AppToastType.warning);
      return;
    }
    final shuffled = [...playable]..shuffle(math.Random());
    await _play(shuffled.first, shuffled);
  }

  void _shuffleVisibleSongs() {
    unawaited(_playRandom(_visibleSongs));
  }

  Future<void> _playSelected(List<DownloadHistoryEntry> songs) async {
    final selected = songs
        .where((entry) => _selectedIds.contains(entry.id))
        .where((entry) {
          final path = entry.savedPath;
          return (path != null && path.isNotEmpty && File(path).existsSync()) ||
              entry.musicInfo != null;
        })
        .toList(growable: false);
    if (selected.isEmpty) {
      showAppToast(context, '请先选择可播放的歌曲', type: AppToastType.warning);
      return;
    }
    setState(() {
      _selectedIds.clear();
      _batchMode = false;
    });
    await _play(selected.first, selected);
  }

  Future<void> _addNext(DownloadHistoryEntry entry) async {
    final path = entry.savedPath;
    final hasLocalFile =
        path != null && path.isNotEmpty && File(path).existsSync();
    if (!hasLocalFile && entry.musicInfo == null) {
      showAppToast(context, '文件不存在，无法加入队列', type: AppToastType.warning);
      return;
    }
    final available = await ensureQueueEntryMusicSourceAvailable(
      context,
      entry,
    );
    if (!available || !mounted) return;
    await ref.read(playerControllerProvider.notifier).enqueueNext(entry);
    if (!mounted) return;
    showAppToast(context, '已添加到下一首播放', type: AppToastType.success);
  }

  Future<void> _addSongToPlaylist(
    DownloadHistoryEntry entry,
    LocalPlaylist playlist,
  ) async {
    try {
      final added = await ref.read(localPlaylistsProvider.notifier).addEntries(
        playlist.id,
        [entry],
      );
      if (!mounted) return;
      if (added == 0) {
        showAppToast(
          context,
          '歌曲已在「${playlist.name}」中',
          type: AppToastType.info,
        );
        return;
      }
      showAppToast(
        context,
        '已添加到「${playlist.name}」',
        type: AppToastType.success,
      );
    } catch (error) {
      if (!mounted) return;
      showAppToast(context, '添加到歌单失败：$error', type: AppToastType.error);
    }
  }

  Future<void> _selectPlaylistForSong(DownloadHistoryEntry entry) async {
    final destination = await showPlaylistBrowserSheet(
      context,
      mode: PlaylistBrowserMode.addSongs,
    );
    if (!mounted || destination == null) return;

    const prefix = '/playlists/';
    if (!destination.startsWith(prefix)) return;
    final playlistId = destination.substring(prefix.length);
    LocalPlaylist? playlist;
    for (final candidate in ref.read(localPlaylistsProvider)) {
      if (candidate.id == playlistId) {
        playlist = candidate;
        break;
      }
    }
    if (playlist == null) {
      showAppToast(context, '歌单不存在或已被删除', type: AppToastType.warning);
      return;
    }
    await _addSongToPlaylist(entry, playlist);
  }

  Future<void> _deleteSong(DownloadHistoryEntry entry) async {
    try {
      await _deleteSongData(entry);
      await _scanLocalMusicFolder();
      if (!mounted) return;
      showAppToast(context, '歌曲已删除', type: AppToastType.success);
    } catch (e) {
      if (!mounted) return;
      showAppToast(context, '删除失败：$e', type: AppToastType.error);
    }
  }

  Future<void> _removePlaylistTrack(
    LocalPlaylist playlist,
    PlaylistTrack track,
  ) async {
    final removed = await ref
        .read(localPlaylistsProvider.notifier)
        .removeTrack(playlist.id, track.id);
    if (!mounted || !removed) return;
    setState(
      () => _selectedIds.removeWhere(
        (entryId) => _visiblePlaylistTracks[entryId]?.id == track.id,
      ),
    );
    showAppToast(context, '已从歌单移除', type: AppToastType.success);
  }

  Future<void> _removeSelectedFromPlaylist(
    LocalPlaylist playlist,
    List<DownloadHistoryEntry> songs,
  ) async {
    final selectedEntries = songs
        .where((entry) => _selectedIds.contains(entry.id))
        .toList(growable: false);
    final trackIds = <String>{};
    for (final entry in selectedEntries) {
      final track = _visiblePlaylistTracks[entry.id];
      if (track != null) trackIds.add(track.id);
    }
    if (trackIds.isEmpty) {
      showAppToast(context, '请先选择要移出的歌曲', type: AppToastType.warning);
      return;
    }
    final removed = await ref
        .read(localPlaylistsProvider.notifier)
        .removeTracks(playlist.id, trackIds);
    if (!mounted || removed == 0) return;
    setState(() {
      _selectedIds.clear();
      _batchMode = false;
    });
    showAppToast(context, '已从歌单移出 $removed 首歌曲', type: AppToastType.success);
  }

  Future<void> _deleteSongData(DownloadHistoryEntry entry) async {
    await _deleteSongFile(entry);
    if (!entry.id.startsWith('file:')) {
      await ref.read(downloadHistoryProvider.notifier).remove(entry.id);
    }
  }

  Future<void> _deleteSongFile(DownloadHistoryEntry entry) async {
    final path = entry.savedPath;
    if (path == null || path.isEmpty) return;
    final file = File(path);
    if (await file.exists()) await file.delete();
    await ref
        .read(localPlaylistsProvider.notifier)
        .removeLocalPathFromAll(path);
    _forgetTagCache(path);
  }

  Future<void> _openPlaylists() async {
    final destination = await showPlaylistBrowserSheet(context);
    if (!mounted || destination == null) return;
    context.go(destination);
  }

  void _openHistory() {
    context.go('/downloads');
  }

  void _openSearch() {
    context.go('/songs/search');
  }

  Future<void> _updatePlaylist(LocalPlaylist playlist) async {
    if (_updatingPlaylistIds.contains(playlist.id)) return;
    setState(() => _updatingPlaylistIds.add(playlist.id));
    try {
      final result = await ref
          .read(onlinePlaylistUpdaterProvider)
          .update(
            playlist: playlist,
            store: ref.read(localPlaylistsProvider.notifier),
          );
      if (!mounted) return;
      showAppToast(
        context,
        onlinePlaylistUpdateMessage(result),
        type: AppToastType.success,
      );
    } catch (error) {
      if (!mounted) return;
      showAppToast(context, '更新歌单失败：$error', type: AppToastType.error);
    } finally {
      if (mounted) setState(() => _updatingPlaylistIds.remove(playlist.id));
    }
  }

  void _selectLibraryPlaylist(String? playlistId) {
    final normalized = playlistId?.trim();
    final nextId = normalized == null || normalized.isEmpty ? null : normalized;
    if (ref.read(songsLibraryPlaylistIdProvider) == nextId) return;
    ref.read(songsLibraryPlaylistIdProvider.notifier).select(nextId);
    setState(() {
      _selectedIds.clear();
      _batchMode = false;
    });
  }

  void _setSort(SongSortMode mode, bool ascending) {
    if (!mounted || (_sortMode == mode && _ascending == ascending)) return;
    setState(() {
      _sortMode = mode;
      _ascending = ascending;
    });
    unawaited(_persistSongSortPreferences());
  }

  Future<void> _openSortSheet() async {
    FocusManager.instance.primaryFocus?.unfocus();
    final toolbar = ref.read(shellToolbarVisibleProvider.notifier);
    final wasToolbarVisible = ref.read(shellToolbarVisibleProvider);
    toolbar.state = false;
    try {
      await showSongsSortSheet(
        context: context,
        initialMode: _sortMode,
        initialAscending: _ascending,
        onChanged: _setSort,
      );
    } finally {
      if (toolbar.mounted) toolbar.state = wasToolbarVisible;
    }
  }

  void _updateSearchQuery(String query) {
    if (_searchQuery == query) return;
    setState(() {
      _searchQuery = query;
      if (_batchMode) _selectedIds.clear();
    });
  }

  void _clearSearch() {
    _searchController.clear();
    _updateSearchQuery('');
    FocusManager.instance.primaryFocus?.unfocus();
  }

  Future<void> _persistSongSortPreferences() async {
    final prefs = ref.read(sharedPreferencesProvider);
    await Future.wait([
      prefs.setString(_songSortModeKey, _sortMode.code),
      prefs.setBool(_songSortAscendingKey, _ascending),
    ]);
  }

  void _toggleVisibleSelection() {
    _toggleSelectAll(_visibleSongs);
  }

  Future<void> _addSelectedToPlaylist(List<DownloadHistoryEntry> songs) async {
    final selected = songs
        .where((entry) => _selectedIds.contains(entry.id))
        .toList(growable: false);
    if (selected.isEmpty) {
      showAppToast(context, '请先选择歌曲', type: AppToastType.warning);
      return;
    }
    final destination = await showPlaylistBrowserSheet(
      context,
      mode: PlaylistBrowserMode.addSongs,
    );
    if (!mounted || destination == null) return;
    const prefix = '/playlists/';
    if (!destination.startsWith(prefix)) return;
    final playlistId = destination.substring(prefix.length);
    final added = await ref
        .read(localPlaylistsProvider.notifier)
        .addEntries(playlistId, selected);
    if (!mounted) return;
    if (added == 0) {
      showAppToast(context, '所选歌曲已在这个歌单中', type: AppToastType.info);
      return;
    }
    setState(() {
      _selectedIds.clear();
      _batchMode = false;
    });
    showAppToast(context, '已加入 $added 首歌曲', type: AppToastType.success);
  }

  void _forgetTagCache(String path) {
    final key = _pathKey(path);
    _tagCache.remove(key);
    _tagModifiedAt.remove(key);
    _tagLoadingKeys.remove(key);
    songTagCacheSnapshot.remove(key);
    songTagModifiedAtSnapshot.remove(key);
    EmbeddedArtworkCache.evictPath(path);
  }

  void _toggleBatchMode() {
    _setBatchMode(!_batchMode);
  }

  void _setBatchMode(bool enabled) {
    if (_batchMode == enabled) return;
    setState(() {
      _batchMode = enabled;
      if (!enabled) _selectedIds.clear();
    });
  }

  void _toggleSelection(DownloadHistoryEntry entry) {
    setState(() {
      if (!_selectedIds.add(entry.id)) _selectedIds.remove(entry.id);
    });
  }

  void _toggleSelectAll(List<DownloadHistoryEntry> songs) {
    if (songs.isEmpty) return;
    final ids = {for (final entry in songs) entry.id};
    setState(() {
      final selectedCount = _selectedIds.where(ids.contains).length;
      if (selectedCount == ids.length) {
        _selectedIds.clear();
      } else {
        _selectedIds
          ..clear()
          ..addAll(ids);
      }
    });
  }

  Future<void> _confirmDeleteSelected(List<DownloadHistoryEntry> songs) async {
    final selected = songs
        .where((entry) => _selectedIds.contains(entry.id))
        .toList(growable: false);
    if (selected.isEmpty) {
      showAppToast(context, '请先选择要删除的歌曲', type: AppToastType.warning);
      return;
    }

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.delete_outline_rounded),
        title: const Text('删除已选歌曲？'),
        content: Text('将删除 ${selected.length} 首本地歌曲文件，并移除对应下载记录。此操作无法撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;

    final historyIds = <String>[];
    final deletedIds = <String>[];
    final failures = <String>[];
    for (final entry in selected) {
      try {
        await _deleteSongFile(entry);
        deletedIds.add(entry.id);
        if (!entry.id.startsWith('file:')) historyIds.add(entry.id);
      } catch (e) {
        final name = entry.name.trim().isEmpty
            ? entry.savedPath ?? entry.id
            : entry.name;
        failures.add('$name：$e');
      }
    }

    if (historyIds.isNotEmpty) {
      await ref.read(downloadHistoryProvider.notifier).removeMany(historyIds);
    }
    await _scanLocalMusicFolder();
    if (!mounted) return;
    setState(() {
      _selectedIds.removeAll(deletedIds);
      if (failures.isEmpty) {
        _selectedIds.clear();
        _batchMode = false;
      }
    });

    if (failures.isEmpty) {
      showAppToast(
        context,
        '已删除 ${deletedIds.length} 首歌曲',
        type: AppToastType.success,
      );
    } else {
      final type = deletedIds.isEmpty
          ? AppToastType.error
          : AppToastType.warning;
      showAppToast(
        context,
        '已删除 ${deletedIds.length} 首，${failures.length} 首失败：${failures.first}',
        type: type,
      );
    }
  }

  void _syncToolbarState({
    required String libraryTitle,
    required String? activePlaylistId,
    required int songCount,
    required int selectedCount,
    required LocalPlaylist? activePlaylist,
  }) {
    final allSelected = songCount > 0 && selectedCount == songCount;
    final canUpdatePlaylist = activePlaylist?.isOnlineImport == true;
    final updatingPlaylist =
        activePlaylist != null &&
        _updatingPlaylistIds.contains(activePlaylist.id);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final current = ref.read(songsToolbarStateProvider);
      if (current.matchesView(
        owner: _toolbarOwner,
        libraryTitle: libraryTitle,
        activePlaylistId: activePlaylistId,
        songCount: songCount,
        selectedCount: selectedCount,
        allSelected: allSelected,
        batchMode: _batchMode,
        canUpdatePlaylist: canUpdatePlaylist,
        updatingPlaylist: updatingPlaylist,
      )) {
        return;
      }
      ref.read(songsToolbarStateProvider.notifier).state = SongsToolbarState(
        owner: _toolbarOwner,
        libraryTitle: libraryTitle,
        activePlaylistId: activePlaylistId,
        songCount: songCount,
        selectedCount: selectedCount,
        allSelected: allSelected,
        batchMode: _batchMode,
        onSelectLibraryPlaylist: _selectLibraryPlaylist,
        onOpenPlaylists: _openPlaylists,
        onSearch: _openSearch,
        onShuffle: _shuffleVisibleSongs,
        onOpenHistory: _openHistory,
        onUpdatePlaylist: canUpdatePlaylist
            ? () => _updatePlaylist(activePlaylist!)
            : null,
        updatingPlaylist: updatingPlaylist,
        onToggleBatch: _toggleBatchMode,
        onToggleSelectAll: _toggleVisibleSelection,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final playlists = ref.watch(localPlaylistsProvider);
    final selectedPlaylistId = ref.watch(songsLibraryPlaylistIdProvider);
    LocalPlaylist? selectedPlaylist;
    if (selectedPlaylistId != null) {
      for (final playlist in playlists) {
        if (playlist.id == selectedPlaylistId) {
          selectedPlaylist = playlist;
          break;
        }
      }
      if (selectedPlaylist == null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted ||
              ref.read(songsLibraryPlaylistIdProvider) != selectedPlaylistId) {
            return;
          }
          ref.read(songsLibraryPlaylistIdProvider.notifier).select(null);
        });
      }
    }
    final playlistMode = selectedPlaylist != null;
    final history = ref.watch(downloadHistoryProvider);
    final playlistSongs = selectedPlaylist == null
        ? null
        : _songsForPlaylist(selectedPlaylist, history);
    final allSongs = playlistSongs?.songs ?? _songs(history);
    _visiblePlaylistTracks = playlistSongs?.tracksByEntryId ?? const {};
    final songs = widget.searchMode
        ? filterSongsByQuery(allSongs, _searchQuery)
        : allSongs;
    final scanning = !playlistMode && _scannedFiles == null;
    final playbackIdentity = ref.watch(
      playerControllerProvider.select((state) {
        final queueIndex = state.queueIndex;
        final queueEntry = queueIndex >= 0 && queueIndex < state.queue.length
            ? state.queue[queueIndex]
            : null;
        return (
          queueEntry: queueEntry,
          localPath: state.track?.localPath,
          playing: state.playing,
        );
      }),
    );
    final artworkVersionByPath = <String, int>{
      for (final file in _scannedFiles ?? const <ScannedSongFile>[])
        _pathKey(file.path): file.modifiedAt.microsecondsSinceEpoch,
    };
    final selectedCount = songs
        .where((entry) => _selectedIds.contains(entry.id))
        .length;
    _visibleSongs = songs;
    _syncToolbarState(
      libraryTitle: selectedPlaylist?.name ?? '歌曲',
      activePlaylistId: selectedPlaylist?.id,
      songCount: songs.length,
      selectedCount: selectedCount,
      activePlaylist: selectedPlaylist,
    );

    final libraryView = AppScrollbar(
      controller: _scrollController,
      child: CustomScrollView(
        controller: _scrollController,
        key: PageStorageKey(
          '${widget.searchMode ? 'songs-search' : 'songs'}-'
          '${selectedPlaylist?.id ?? 'local'}-scroll',
        ),
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        slivers: [
          if (widget.searchMode)
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(14, 2, 14, 0),
              sliver: SliverToBoxAdapter(
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
          if (allSongs.isNotEmpty)
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 2),
              sliver: SliverToBoxAdapter(
                child: SongsListSummary(
                  count: songs.length,
                  totalCount: allSongs.length,
                  searching:
                      widget.searchMode && _searchQuery.trim().isNotEmpty,
                  sortMode: _sortMode,
                  ascending: _ascending,
                  batchMode: _batchMode,
                  onOpenSort: () => unawaited(_openSortSheet()),
                  onToggleBatch: songs.isEmpty ? null : _toggleBatchMode,
                  showSort: !playlistMode,
                  collectionLabel: playlistMode ? '歌单歌曲' : '本地歌曲',
                ),
              ),
            ),
          if (allSongs.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: scanning
                  ? const SongsLoading()
                  : EmptySongs(
                      error: playlistMode ? null : _scanError,
                      playlistMode: playlistMode,
                    ),
            )
          else if (songs.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: EmptySongSearch(),
            )
          else
            SliverPadding(
              padding: EdgeInsets.fromLTRB(12, 0, 12, _batchMode ? 12 : 104),
              sliver: SlidableAutoCloseBehavior(
                child: SliverList.separated(
                  itemCount: songs.length,
                  separatorBuilder: (_, _) => const SongListDivider(),
                  itemBuilder: (context, index) {
                    final entry = songs[index];
                    final path = entry.savedPath;
                    final playing = _matchesPlayingEntry(
                      entry,
                      playbackIdentity.queueEntry,
                      playbackIdentity.localPath,
                    );
                    return SongRow(
                      key: ValueKey(entry.id),
                      entry: entry,
                      artworkVersion: path == null
                          ? null
                          : artworkVersionByPath[_pathKey(path)],
                      playing: playing,
                      playingActive: playing && playbackIdentity.playing,
                      batchMode: _batchMode,
                      selected: _selectedIds.contains(entry.id),
                      onToggleSelected: () => _toggleSelection(entry),
                      onAddNext: () => _addNext(entry),
                      onAddToPlaylist: () =>
                          unawaited(_selectPlaylistForSong(entry)),
                      onPlay: () => _play(entry, songs),
                      onDelete: playlistMode
                          ? () {
                              final track = _visiblePlaylistTracks[entry.id];
                              if (track != null) {
                                unawaited(
                                  _removePlaylistTrack(
                                    selectedPlaylist!,
                                    track,
                                  ),
                                );
                              }
                            }
                          : () => _deleteSong(entry),
                      playlistMode: playlistMode,
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );

    return Scaffold(
      backgroundColor: Colors.transparent,
      bottomNavigationBar: _batchMode
          ? SongsBatchActionBar(
              selectedCount: selectedCount,
              onDelete: selectedCount == 0
                  ? null
                  : playlistMode
                  ? () => unawaited(
                      _removeSelectedFromPlaylist(selectedPlaylist!, songs),
                    )
                  : () => unawaited(_confirmDeleteSelected(songs)),
              onAddToPlaylist: playlistMode || selectedCount == 0
                  ? null
                  : () => unawaited(_addSelectedToPlaylist(songs)),
              onPlaySelected: selectedCount == 0
                  ? null
                  : () => unawaited(_playSelected(songs)),
              playlistMode: playlistMode,
            )
          : null,
      body: _batchMode || playlistMode
          ? libraryView
          : AppRefreshIndicator(
              onRefresh: _scanLocalMusicFolder,
              child: libraryView,
            ),
    );
  }
}

String _pathKey(String path) {
  final normalized = path.replaceAll('\\', '/');
  return Platform.isWindows ? normalized.toLowerCase() : normalized;
}

bool _matchesPlayingEntry(
  DownloadHistoryEntry entry,
  DownloadHistoryEntry? queueEntry,
  String? playerLocalPath,
) {
  if (queueEntry != null) {
    if (queueEntry.id == entry.id) return true;
    final queuedPath = queueEntry.savedPath?.trim();
    final entryPath = entry.savedPath?.trim();
    if (queuedPath != null &&
        queuedPath.isNotEmpty &&
        entryPath != null &&
        entryPath.isNotEmpty &&
        _pathKey(queuedPath) == _pathKey(entryPath)) {
      return true;
    }
    if (queueEntry.sourceCode == entry.sourceCode &&
        queueEntry.musicId.isNotEmpty &&
        queueEntry.musicId == entry.musicId) {
      return true;
    }
  }

  final entryPath = entry.savedPath?.trim();
  final activePath = playerLocalPath?.trim();
  return entryPath != null &&
      entryPath.isNotEmpty &&
      activePath != null &&
      activePath.isNotEmpty &&
      _pathKey(entryPath) == _pathKey(activePath);
}

String _preferTag(String? value, String fallback) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? fallback : trimmed;
}
