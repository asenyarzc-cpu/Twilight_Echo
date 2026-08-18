import 'dart:io';

import '../../core/models/enums.dart';
import '../downloads/download_history_store.dart';
import 'playlist_models.dart';

class ResolvedPlaylistTrack {
  const ResolvedPlaylistTrack({
    required this.track,
    required this.queueEntry,
    this.localEntry,
  });

  final PlaylistTrack track;
  final DownloadHistoryEntry? localEntry;
  final DownloadHistoryEntry? queueEntry;

  bool get canDownload => localEntry == null && track.musicInfo != null;
}

class LocalHistoryIndex {
  LocalHistoryIndex(List<DownloadHistoryEntry> history) {
    for (final entry in history) {
      final path = entry.savedPath?.trim();
      if (!entry.isCompleted ||
          path == null ||
          path.isEmpty ||
          !_pathExists(path)) {
        continue;
      }
      final musicKey = _musicKey(entry.sourceCode, entry.musicId);
      if (musicKey != null) {
        _byMusic.putIfAbsent(musicKey, () => entry);
      }
    }
  }

  final Map<String, DownloadHistoryEntry> _byMusic = {};
  final Map<String, bool> _pathExistence = {};

  DownloadHistoryEntry? resolve(PlaylistTrack track, String playlistId) {
    final direct = track.toDownloadHistoryEntry(playlistId: playlistId);
    final directPath = direct?.savedPath?.trim();
    if (direct != null &&
        directPath != null &&
        directPath.isNotEmpty &&
        _pathExists(directPath)) {
      return direct;
    }
    final musicKey = _musicKey(track.sourceCode, track.musicId);
    return musicKey == null ? null : _byMusic[musicKey];
  }

  bool _pathExists(String path) {
    final key = normalizePlaylistPath(path);
    return _pathExistence.putIfAbsent(key, () => File(path).existsSync());
  }

  static String? _musicKey(String sourceCode, String musicId) {
    final source = sourceCode.trim().toLowerCase();
    final id = musicId.trim();
    if (source.isEmpty || source == MusicSource.all.code || id.isEmpty) {
      return null;
    }
    return '$source\u0000$id';
  }
}
