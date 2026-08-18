import 'dart:async';
import 'dart:collection';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../../core/ui/cover_image_source.dart';
import 'lx_playlist_import.dart';
import 'playlist_models.dart';
import 'playlist_store.dart';

class PlaylistCoverResolver {
  PlaylistCoverResolver(this._api, {this.maxConcurrent = 3})
    : assert(maxConcurrent > 0);

  final MusicApi _api;
  final int maxConcurrent;
  final Queue<_CoverLookup> _queue = Queue<_CoverLookup>();
  final Map<_CoverLookupKey, Future<String?>> _inflight = {};
  final Map<_CoverLookupKey, String?> _cache = {};
  int _active = 0;

  Future<String?> resolve(MusicInfo music) {
    final id = music.id.trim();
    if (id.isEmpty || music.source == MusicSource.all) {
      return Future<String?>.value(null);
    }

    final key = _CoverLookupKey(music.source, id);
    if (_cache.containsKey(key)) {
      return Future<String?>.value(_cache[key]);
    }
    final pending = _inflight[key];
    if (pending != null) return pending;

    final completer = Completer<String?>();
    _inflight[key] = completer.future;
    _queue.add(_CoverLookup(key, music, completer));
    _drain();
    return completer.future;
  }

  void _drain() {
    while (_active < maxConcurrent && _queue.isNotEmpty) {
      final lookup = _queue.removeFirst();
      _active++;
      unawaited(_run(lookup));
    }
  }

  Future<void> _run(_CoverLookup lookup) async {
    String? resolved;
    try {
      final raw = await _api.getPicUrl(
        musicInfo: lookup.music,
        preferCached: false,
      );
      final normalized = CoverImageSource.normalizeUrl(raw, size: 500);
      if (CoverImageSource.isUsableUrl(normalized)) resolved = normalized;
    } catch (_) {
      resolved = null;
    } finally {
      if (resolved != null) _cache[lookup.key] = resolved;
      _inflight.remove(lookup.key);
      lookup.completer.complete(resolved);
      _active--;
      _drain();
    }
  }
}

class LxPlaylistCoverResolution {
  const LxPlaylistCoverResolution({
    required this.playlists,
    required this.lookupCount,
    required this.resolvedCount,
  });

  final List<LxPlaylistData> playlists;
  final int lookupCount;
  final int resolvedCount;
}

Future<LxPlaylistCoverResolution> resolveLxPlaylistCovers(
  Iterable<LxPlaylistData> sourcePlaylists,
  PlaylistCoverResolver resolver, {
  void Function(int completed, int total)? onProgress,
}) async {
  final playlists = sourcePlaylists.toList(growable: false);
  final lookupCount = playlists.fold<int>(
    0,
    (total, playlist) =>
        total + playlist.tracks.where(_needsImportCoverLookup).length,
  );
  if (lookupCount > 0) onProgress?.call(0, lookupCount);

  var completed = 0;
  var resolvedCount = 0;
  final resolvedPlaylists = <LxPlaylistData>[];
  for (final playlist in playlists) {
    final tracks = await Future.wait([
      for (final music in playlist.tracks)
        () async {
          final normalizedStored = CoverImageSource.normalizeUrl(
            music.meta.picUrl,
            size: 500,
          );
          final usableStored = CoverImageSource.isUsableUrl(normalizedStored)
              ? normalizedStored
              : null;
          if (!_needsImportCoverLookup(music)) {
            return normalizedStored == music.meta.picUrl
                ? music
                : _musicWithPicUrl(music, normalizedStored!);
          }

          final resolved = await resolver.resolve(music);
          if (resolved != null) resolvedCount++;
          completed++;
          onProgress?.call(completed, lookupCount);
          final finalUrl = resolved ?? usableStored;
          return finalUrl == null ? music : _musicWithPicUrl(music, finalUrl);
        }(),
    ]);
    resolvedPlaylists.add(
      LxPlaylistData(
        sourceId: playlist.sourceId,
        name: playlist.name,
        tracks: List<MusicInfo>.unmodifiable(tracks),
      ),
    );
  }

  return LxPlaylistCoverResolution(
    playlists: List<LxPlaylistData>.unmodifiable(resolvedPlaylists),
    lookupCount: lookupCount,
    resolvedCount: resolvedCount,
  );
}

bool _needsImportCoverLookup(MusicInfo music) {
  return music.source == MusicSource.kg ||
      !CoverImageSource.isUsableUrl(music.meta.picUrl);
}

MusicInfo _musicWithPicUrl(MusicInfo music, String picUrl) {
  final json = Map<String, dynamic>.from(music.toJson());
  final rawMeta = json['meta'];
  final meta = rawMeta is Map
      ? Map<String, dynamic>.from(rawMeta)
      : <String, dynamic>{};
  meta['picUrl'] = picUrl;
  json['meta'] = meta;
  return MusicInfo.fromJson(json);
}

class PlaylistTrackCoverKey {
  const PlaylistTrackCoverKey({required this.playlistId, required this.track});

  final String playlistId;
  final PlaylistTrack track;

  @override
  bool operator ==(Object other) =>
      other is PlaylistTrackCoverKey &&
      other.playlistId == playlistId &&
      other.track.identityKey == track.identityKey;

  @override
  int get hashCode => Object.hash(playlistId, track.identityKey);
}

final playlistCoverResolverProvider = Provider<PlaylistCoverResolver>((ref) {
  return PlaylistCoverResolver(ref.watch(musicApiProvider));
});

final playlistTrackCoverProvider = FutureProvider.autoDispose
    .family<String?, PlaylistTrackCoverKey>((ref, key) async {
      final music = key.track.musicInfo;
      if (music == null) return null;

      final store = ref.read(localPlaylistsProvider.notifier);
      final resolved = await ref
          .watch(playlistCoverResolverProvider)
          .resolve(music);
      if (resolved == null) return null;

      await store.updateTrackCover(
        playlistId: key.playlistId,
        trackId: key.track.identityKey,
        picUrl: resolved,
      );
      return resolved;
    });

class _CoverLookupKey {
  const _CoverLookupKey(this.source, this.musicId);

  final MusicSource source;
  final String musicId;

  @override
  bool operator ==(Object other) =>
      other is _CoverLookupKey &&
      other.source == source &&
      other.musicId == musicId;

  @override
  int get hashCode => Object.hash(source, musicId);
}

class _CoverLookup {
  const _CoverLookup(this.key, this.music, this.completer);

  final _CoverLookupKey key;
  final MusicInfo music;
  final Completer<String?> completer;
}
