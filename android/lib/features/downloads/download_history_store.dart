import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/cover_image_source.dart';
import 'download_history_entry.dart';

export 'download_history_entry.dart';

const String _kDownloadHistoryKey = 'download_history_v1';
const int _kMaxHistoryEntries = 160;

class DownloadHistoryNotifier extends Notifier<List<DownloadHistoryEntry>> {
  @override
  List<DownloadHistoryEntry> build() {
    final prefs = ref.read(sharedPreferencesProvider);
    final raw = prefs.getStringList(_kDownloadHistoryKey) ?? const [];
    final entries = <DownloadHistoryEntry>[];
    for (final item in raw) {
      try {
        final decoded = jsonDecode(item);
        if (decoded is Map<String, dynamic>) {
          entries.add(DownloadHistoryEntry.fromJson(decoded));
        } else if (decoded is Map) {
          entries.add(
            DownloadHistoryEntry.fromJson(Map<String, dynamic>.from(decoded)),
          );
        }
      } catch (_) {
        // Ignore corrupt rows so one bad record never hides the whole history.
      }
    }
    entries.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return entries;
  }

  Future<void> addCompleted({
    required MusicInfo music,
    required Quality quality,
    required String savedPath,
    int? sizeBytes,
  }) {
    return _add(
      music: music,
      quality: quality,
      status: DownloadHistoryStatus.completed,
      savedPath: savedPath,
      sizeBytes: sizeBytes,
    );
  }

  Future<void> addFailed({
    required MusicInfo music,
    required Quality quality,
    required String message,
  }) {
    return _add(
      music: music,
      quality: quality,
      status: DownloadHistoryStatus.failed,
      message: message,
    );
  }

  Future<void> remove(String id) async {
    state = state.where((entry) => entry.id != id).toList(growable: false);
    await _persist();
  }

  Future<void> removeMany(Iterable<String> ids) async {
    final idSet = ids.toSet();
    if (idSet.isEmpty) return;
    state = state
        .where((entry) => !idSet.contains(entry.id))
        .toList(growable: false);
    await _persist();
  }

  Future<void> clear() async {
    state = const [];
    await _persist();
  }

  Future<void> _add({
    required MusicInfo music,
    required Quality quality,
    required DownloadHistoryStatus status,
    String? savedPath,
    String? message,
    int? sizeBytes,
  }) async {
    final now = DateTime.now();
    final entry = DownloadHistoryEntry(
      id: '${music.id}-${now.microsecondsSinceEpoch}',
      musicId: music.id,
      name: music.name,
      singer: music.singer,
      albumName: music.albumName,
      sourceCode: music.source.code,
      qualityCode: quality.code,
      status: status,
      createdAt: now,
      savedPath: savedPath,
      message: message,
      picUrl: CoverImageSource.normalizeUrl(music.meta.picUrl, size: 500),
      sizeBytes: sizeBytes,
      musicJson: music.toJson(),
    );
    state = [entry, ...state].take(_kMaxHistoryEntries).toList(growable: false);
    await _persist();
  }

  Future<void> _persist() {
    final prefs = ref.read(sharedPreferencesProvider);
    return prefs.setStringList(_kDownloadHistoryKey, [
      for (final entry in state) jsonEncode(entry.toJson()),
    ]);
  }
}

final downloadHistoryProvider =
    NotifierProvider<DownloadHistoryNotifier, List<DownloadHistoryEntry>>(
      DownloadHistoryNotifier.new,
    );
