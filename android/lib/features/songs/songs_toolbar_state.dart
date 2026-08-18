import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/storage/settings_store.dart';

const String songsLibraryPlaylistIdStorageKey = 'songs_library_playlist_id_v1';

enum SongSortMode {
  title('title', '标题', Icons.sort_by_alpha_rounded),
  artist('artist', '歌手', Icons.person_outline_rounded),
  added('added', '添加时间', Icons.schedule_rounded);

  const SongSortMode(this.code, this.label, this.icon);

  final String code;
  final String label;
  final IconData icon;

  static SongSortMode fromCode(String? code) {
    return switch (code) {
      'artist' => SongSortMode.artist,
      'added' => SongSortMode.added,
      _ => SongSortMode.title,
    };
  }
}

@immutable
class SongsToolbarState {
  const SongsToolbarState({
    this.owner,
    this.libraryTitle = '歌曲',
    this.activePlaylistId,
    this.songCount = 0,
    this.selectedCount = 0,
    this.allSelected = false,
    this.batchMode = false,
    this.onSelectLibraryPlaylist,
    this.onOpenPlaylists,
    this.onSearch,
    this.onShuffle,
    this.onOpenHistory,
    this.onUpdatePlaylist,
    this.updatingPlaylist = false,
    this.onToggleBatch,
    this.onToggleSelectAll,
  });

  final Object? owner;
  final String libraryTitle;
  final String? activePlaylistId;
  final int songCount;
  final int selectedCount;
  final bool allSelected;
  final bool batchMode;
  final ValueChanged<String?>? onSelectLibraryPlaylist;
  final VoidCallback? onOpenPlaylists;
  final VoidCallback? onSearch;
  final VoidCallback? onShuffle;
  final VoidCallback? onOpenHistory;
  final VoidCallback? onUpdatePlaylist;
  final bool updatingPlaylist;
  final VoidCallback? onToggleBatch;
  final VoidCallback? onToggleSelectAll;

  bool get attached => owner != null;
  bool get hasSongs => songCount > 0;
  bool get isPlaylistView => activePlaylistId != null;
  String get searchLabel => isPlaylistView ? '搜索歌单歌曲' : '搜索本地歌曲';

  bool matchesView({
    required Object owner,
    required String libraryTitle,
    required String? activePlaylistId,
    required int songCount,
    required int selectedCount,
    required bool allSelected,
    required bool batchMode,
    required bool canUpdatePlaylist,
    required bool updatingPlaylist,
  }) {
    return identical(this.owner, owner) &&
        this.libraryTitle == libraryTitle &&
        this.activePlaylistId == activePlaylistId &&
        this.songCount == songCount &&
        this.selectedCount == selectedCount &&
        this.allSelected == allSelected &&
        this.batchMode == batchMode &&
        (onUpdatePlaylist != null) == canUpdatePlaylist &&
        this.updatingPlaylist == updatingPlaylist;
  }
}

/// The library selected from the Songs header. It survives both the dedicated
/// search route and an App restart so Songs reopens the last visible
/// collection.
class SongsLibraryPlaylistIdNotifier extends Notifier<String?> {
  late final _prefs = ref.read(sharedPreferencesProvider);

  @override
  String? build() =>
      _normalize(_prefs.getString(songsLibraryPlaylistIdStorageKey));

  void select(String? playlistId) {
    final nextId = _normalize(playlistId);
    if (state == nextId) return;
    state = nextId;
    if (nextId == null) {
      unawaited(_prefs.remove(songsLibraryPlaylistIdStorageKey));
    } else {
      unawaited(_prefs.setString(songsLibraryPlaylistIdStorageKey, nextId));
    }
  }

  static String? _normalize(String? playlistId) {
    final normalized = playlistId?.trim();
    return normalized == null || normalized.isEmpty ? null : normalized;
  }
}

final songsLibraryPlaylistIdProvider =
    NotifierProvider<SongsLibraryPlaylistIdNotifier, String?>(
      SongsLibraryPlaylistIdNotifier.new,
    );

final songsToolbarStateProvider = StateProvider<SongsToolbarState>(
  (ref) => const SongsToolbarState(),
);
