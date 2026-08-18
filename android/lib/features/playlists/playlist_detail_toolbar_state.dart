import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// State bridge between [PlaylistDetailPage] and the shell header, mirroring
/// the songs page's `SongsToolbarState` owner-token pattern.
///
/// Callbacks are intentionally excluded from [matchesView]; enable/disable
/// decisions live in scalar fields ([queueCount], [downloadableCount],
/// [batchSubmitting]) so the header re-renders when they change.
@immutable
class PlaylistDetailToolbarState {
  const PlaylistDetailToolbarState({
    this.owner,
    this.title,
    this.queueCount = 0,
    this.downloadableCount = 0,
    this.selectedCount = 0,
    this.allSelected = false,
    this.batchMode = false,
    this.batchSubmitting = false,
    this.searchMode = false,
    this.onShuffle,
    this.onToggleBatch,
    this.onToggleSelectAll,
    this.onToggleSearch,
  });

  final Object? owner;
  final String? title;
  final int queueCount;
  final int downloadableCount;
  final int selectedCount;
  final bool allSelected;
  final bool batchMode;
  final bool batchSubmitting;
  final bool searchMode;
  final VoidCallback? onShuffle;
  final VoidCallback? onToggleBatch;
  final VoidCallback? onToggleSelectAll;
  final VoidCallback? onToggleSearch;

  bool get attached => owner != null;
  bool get canShuffle => queueCount >= 2;
  bool get hasDownloadable => downloadableCount > 0;

  bool matchesView({
    required Object owner,
    required String? title,
    required int queueCount,
    required int downloadableCount,
    required int selectedCount,
    required bool allSelected,
    required bool batchMode,
    required bool batchSubmitting,
    required bool searchMode,
  }) {
    return identical(this.owner, owner) &&
        this.title == title &&
        this.queueCount == queueCount &&
        this.downloadableCount == downloadableCount &&
        this.selectedCount == selectedCount &&
        this.allSelected == allSelected &&
        this.batchMode == batchMode &&
        this.batchSubmitting == batchSubmitting &&
        this.searchMode == searchMode;
  }
}

final playlistDetailToolbarStateProvider =
    StateProvider<PlaylistDetailToolbarState>(
      (ref) => const PlaylistDetailToolbarState(),
    );
