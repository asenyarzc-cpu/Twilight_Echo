import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'tagger.dart';

/// Loads embedded covers on demand without allowing a visible list to start an
/// unbounded number of metadata reads at once.
class EmbeddedArtworkCache {
  const EmbeddedArtworkCache._();

  static const int _maxEntries = 36;
  static const int _maxBytes = 24 * 1024 * 1024;
  static const int _maxConcurrentReads = 2;
  static const Duration _readTimeout = Duration(seconds: 8);

  static final LinkedHashMap<String, Uint8List?> _cache = LinkedHashMap();
  static final Map<String, _ArtworkLoad> _loads = {};
  static final Queue<_ArtworkLoad> _pending = Queue();
  static int _activeReads = 0;
  static int _cachedBytes = 0;

  static EmbeddedArtworkRequest subscribe(String path, {Object? version}) {
    final normalizedPath = path.trim();
    if (normalizedPath.isEmpty) {
      return EmbeddedArtworkRequest._completed(null);
    }
    final key = _cacheKey(normalizedPath, version);

    if (_cache.containsKey(key)) {
      final cached = _cache.remove(key);
      _cache[key] = cached;
      return EmbeddedArtworkRequest._completed(cached);
    }

    final existing = _loads[key];
    if (existing != null) {
      existing.consumers++;
      return EmbeddedArtworkRequest._(existing);
    }

    final load = _ArtworkLoad(key: key, path: normalizedPath, consumers: 1);
    _loads[key] = load;
    _pending.add(load);
    _pump();
    return EmbeddedArtworkRequest._(load);
  }

  static Future<Uint8List?> load(String path, {Object? version}) {
    return subscribe(path, version: version).future;
  }

  static void evictPath(String path) {
    final normalizedPath = path.trim();
    if (normalizedPath.isEmpty) return;
    final versionedPrefix = '$normalizedPath\u0000';
    final matches = _cache.keys
        .where(
          (key) => key == normalizedPath || key.startsWith(versionedPrefix),
        )
        .toList(growable: false);
    for (final key in matches) {
      _cachedBytes -= _cache.remove(key)?.length ?? 0;
    }

    final pendingOrActive = _loads.values
        .where(
          (load) =>
              load.path == normalizedPath &&
              (load.key == normalizedPath ||
                  load.key.startsWith(versionedPrefix)),
        )
        .toList(growable: false);
    for (final load in pendingOrActive) {
      load.invalidated = true;
      if (!load.active) _cancelPending(load);
    }
  }

  static String _cacheKey(String path, Object? version) {
    return version == null ? path : '$path\u0000$version';
  }

  static void _pump() {
    while (_activeReads < _maxConcurrentReads && _pending.isNotEmpty) {
      final load = _pending.removeFirst();
      if (load.invalidated || load.consumers == 0) {
        _complete(load, null);
        continue;
      }
      load.active = true;
      _activeReads++;
      unawaited(_run(load));
    }
  }

  static Future<void> _run(_ArtworkLoad load) async {
    Uint8List? bytes;
    try {
      bytes = (await Tagger.readEmbeddedTags(
        load.path,
        includeLyrics: false,
      ).timeout(_readTimeout))?.artworkBytes;
      if (bytes != null && bytes.isEmpty) bytes = null;
    } catch (_) {
      bytes = null;
    }

    if (load.invalidated) bytes = null;
    if (!load.invalidated && load.consumers > 0) _store(load.key, bytes);
    _complete(load, bytes);
    _activeReads--;
    _pump();
  }

  static void _release(_ArtworkLoad load) {
    if (load.consumers > 0) load.consumers--;
    if (load.consumers == 0 && !load.active) _cancelPending(load);
  }

  static void _cancelPending(_ArtworkLoad load) {
    _pending.remove(load);
    _complete(load, null);
  }

  static void _complete(_ArtworkLoad load, Uint8List? bytes) {
    if (identical(_loads[load.key], load)) _loads.remove(load.key);
    if (!load.completer.isCompleted) load.completer.complete(bytes);
  }

  static void _store(String key, Uint8List? bytes) {
    _cachedBytes -= _cache.remove(key)?.length ?? 0;
    _cache[key] = bytes;
    _cachedBytes += bytes?.length ?? 0;
    while (_cache.length > _maxEntries || _cachedBytes > _maxBytes) {
      _cachedBytes -= _cache.remove(_cache.keys.first)?.length ?? 0;
    }
  }
}

class EmbeddedArtworkRequest {
  EmbeddedArtworkRequest._(_ArtworkLoad load)
    : _load = load,
      future = load.completer.future;

  EmbeddedArtworkRequest._completed(Uint8List? bytes)
    : _load = null,
      future = Future<Uint8List?>.value(bytes);

  final _ArtworkLoad? _load;
  final Future<Uint8List?> future;
  bool _cancelled = false;

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    final load = _load;
    if (load != null) EmbeddedArtworkCache._release(load);
  }
}

class _ArtworkLoad {
  _ArtworkLoad({
    required this.key,
    required this.path,
    required this.consumers,
  });

  final String key;
  final String path;
  final Completer<Uint8List?> completer = Completer<Uint8List?>();
  int consumers;
  bool active = false;
  bool invalidated = false;
}
