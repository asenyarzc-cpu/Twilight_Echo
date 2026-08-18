import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

const _audioExtensions = {
  'mp3',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'wav',
  'ape',
  'wma',
};

@immutable
class LocalSongFileSnapshot {
  const LocalSongFileSnapshot({
    required this.path,
    required this.fileName,
    required this.extension,
    required this.createdAt,
    required this.modifiedAt,
    required this.sizeBytes,
  });

  final String path;
  final String fileName;
  final String extension;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final int sizeBytes;

  factory LocalSongFileSnapshot.fromJson(Map<String, dynamic> json) {
    return LocalSongFileSnapshot(
      path: json['path'] as String? ?? '',
      fileName: json['fileName'] as String? ?? '',
      extension: json['extension'] as String? ?? '',
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      modifiedAt:
          DateTime.tryParse(json['modifiedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
    'path': path,
    'fileName': fileName,
    'extension': extension,
    'createdAt': createdAt.toIso8601String(),
    'modifiedAt': modifiedAt.toIso8601String(),
    'sizeBytes': sizeBytes,
  };
}

@immutable
class LocalSongScanSnapshot {
  const LocalSongScanSnapshot({
    required this.directory,
    required this.cachedAt,
    required this.files,
    this.error,
  });

  final String directory;
  final DateTime cachedAt;
  final List<LocalSongFileSnapshot> files;
  final String? error;

  factory LocalSongScanSnapshot.fromJson(Map<String, dynamic> json) {
    final rawFiles = json['files'];
    final files = <LocalSongFileSnapshot>[];
    if (rawFiles is List) {
      for (final item in rawFiles) {
        if (item is Map) {
          final file = LocalSongFileSnapshot.fromJson(
            Map<String, dynamic>.from(item),
          );
          if (file.path.isNotEmpty && file.fileName.isNotEmpty) files.add(file);
        }
      }
    }
    return LocalSongScanSnapshot(
      directory: json['directory'] as String? ?? '',
      cachedAt:
          DateTime.tryParse(json['cachedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      files: List.unmodifiable(files),
      error: json['error'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'directory': directory,
    'cachedAt': cachedAt.toIso8601String(),
    'files': [for (final file in files) file.toJson()],
    if (error != null) 'error': error,
  };
}

class LocalSongScanCache extends ChangeNotifier {
  static const _fileName = 'local_song_scan_v1.json';

  LocalSongScanSnapshot? _snapshot;
  Future<void>? _loadFuture;
  Future<void>? _scanFuture;
  String? _scanDirectory;
  int _scanGeneration = 0;

  LocalSongScanSnapshot? get snapshot => _snapshot;

  Future<void> ensureLoaded() => _loadFuture ??= _load();

  Future<void> _load() async {
    try {
      final file = await _cacheFile();
      if (!await file.exists()) return;
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is Map) {
        _snapshot = LocalSongScanSnapshot.fromJson(
          Map<String, dynamic>.from(decoded),
        );
        notifyListeners();
      }
    } catch (_) {
      // A corrupt cache must never prevent the library from being rescanned.
      _snapshot = null;
    }
  }

  Future<void> ensureScan({required String directory}) async {
    await ensureLoaded();
    final snapshot = _snapshot;
    final fresh =
        snapshot != null &&
        snapshot.directory == directory &&
        snapshot.error == null &&
        DateTime.now().difference(snapshot.cachedAt) <
            const Duration(seconds: 12);
    if (fresh) return;
    await refresh(directory: directory);
  }

  Future<void> refresh({required String directory}) {
    final running = _scanFuture;
    if (running != null && _scanDirectory == directory) return running;

    final generation = ++_scanGeneration;
    _scanDirectory = directory;
    final future = _scanDirectoryContents(directory, generation);
    _scanFuture = future;
    return future;
  }

  Future<void> _scanDirectoryContents(String directory, int generation) async {
    try {
      final dir = Directory(directory);
      if (!await dir.exists()) {
        if (generation != _scanGeneration) return;
        await save(directory: directory, files: const [], error: null);
        return;
      }

      final files = <LocalSongFileSnapshot>[];
      await for (final item in dir.list(recursive: true, followLinks: false)) {
        if (generation != _scanGeneration) return;
        if (item is! File) continue;
        final fileName = p.basename(item.path);
        final extension = p.extension(fileName).replaceFirst('.', '');
        if (!_audioExtensions.contains(extension.toLowerCase())) continue;
        final stat = await item.stat();
        files.add(
          LocalSongFileSnapshot(
            path: item.path,
            fileName: fileName,
            extension: extension,
            createdAt: stat.changed,
            modifiedAt: stat.modified,
            sizeBytes: stat.size,
          ),
        );
      }
      if (generation != _scanGeneration) return;
      await save(directory: directory, files: files, error: null);
    } catch (error) {
      if (generation != _scanGeneration) return;
      await save(
        directory: directory,
        files: const [],
        error: '无法读取本地音乐文件夹：$error',
      );
    } finally {
      if (generation == _scanGeneration) _scanFuture = null;
    }
  }

  Future<void> save({
    required String directory,
    required List<LocalSongFileSnapshot> files,
    String? error,
  }) async {
    final snapshot = LocalSongScanSnapshot(
      directory: directory,
      cachedAt: DateTime.now(),
      files: List.unmodifiable(files),
      error: error,
    );
    _snapshot = snapshot;
    notifyListeners();
    try {
      final file = await _cacheFile();
      await file.parent.create(recursive: true);
      await file.writeAsString(jsonEncode(snapshot.toJson()), flush: true);
    } catch (_) {
      // The in-memory snapshot remains useful even when disk persistence fails.
    }
  }

  Future<File> _cacheFile() async {
    final support = await getApplicationSupportDirectory();
    return File(p.join(support.path, _fileName));
  }
}

final localSongScanCacheProvider = ChangeNotifierProvider<LocalSongScanCache>(
  (_) => LocalSongScanCache(),
);
