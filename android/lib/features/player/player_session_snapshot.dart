import '../../core/models/music_info.dart';
import '../downloads/download_history_entry.dart';

const Object _unsetPlayerSessionValue = Object();
const Object _invalidJsonValue = Object();

/// The serializable subset of [PlayerTrack]. Artwork bytes and resolved remote
/// URLs are excluded because they are large or may expire between launches.
class PersistedPlayerTrack {
  const PersistedPlayerTrack({
    required this.id,
    required this.kindCode,
    required this.title,
    required this.artist,
    required this.album,
    required this.sourceLabel,
    required this.qualityLabel,
    this.coverUrl,
    this.localPath,
  });

  static const String remoteKindCode = 'remote';
  static const String localFileKindCode = 'localFile';

  final String id;
  final String kindCode;
  final String title;
  final String artist;
  final String album;
  final String sourceLabel;
  final String qualityLabel;
  final String? coverUrl;
  final String? localPath;

  bool get isLocal => kindCode == localFileKindCode;

  Map<String, dynamic> toJson() => {
    'id': id,
    'kindCode': kindCode,
    'title': title,
    'artist': artist,
    'album': album,
    'sourceLabel': sourceLabel,
    'qualityLabel': qualityLabel,
    if (coverUrl != null) 'coverUrl': coverUrl,
    if (localPath != null) 'localPath': localPath,
  };

  static PersistedPlayerTrack? tryFromJson(Object? value) {
    final json = _stringKeyedMap(value);
    if (json == null) return null;

    final id = _nonEmptyString(json['id']);
    final kindCode = _nonEmptyString(json['kindCode']);
    if (id == null ||
        kindCode == null ||
        (kindCode != remoteKindCode && kindCode != localFileKindCode)) {
      return null;
    }

    final localPath = _optionalString(json['localPath']);
    if (kindCode == localFileKindCode &&
        (localPath == null || localPath.trim().isEmpty)) {
      return null;
    }

    return PersistedPlayerTrack(
      id: id,
      kindCode: kindCode,
      title: _stringOrEmpty(json['title']),
      artist: _stringOrEmpty(json['artist']),
      album: _stringOrEmpty(json['album']),
      sourceLabel: _stringOrEmpty(json['sourceLabel']),
      qualityLabel: _stringOrEmpty(json['qualityLabel']),
      coverUrl: _optionalString(json['coverUrl']),
      localPath: localPath,
    );
  }
}

class PlayerSessionSnapshot {
  factory PlayerSessionSnapshot({
    required PersistedPlayerTrack track,
    MusicInfo? music,
    String? qualityCode,
    Duration position = Duration.zero,
    Duration duration = Duration.zero,
    List<DownloadHistoryEntry> queue = const [],
    int queueIndex = -1,
    String playbackModeCode = sequencePlaybackModeCode,
  }) {
    final normalizedDuration = _nonNegativeDuration(duration);
    final normalizedQueue = List<DownloadHistoryEntry>.unmodifiable(queue);
    return PlayerSessionSnapshot._(
      version: currentVersion,
      track: track,
      music: normalizePlayerSessionMusic(music),
      qualityCode: _optionalNonEmptyString(qualityCode),
      position: _normalizedPosition(position, normalizedDuration),
      duration: normalizedDuration,
      queue: normalizedQueue,
      queueIndex: _normalizedQueueIndex(queueIndex, normalizedQueue.length),
      playbackModeCode: _normalizedPlaybackModeCode(playbackModeCode),
    );
  }

  const PlayerSessionSnapshot._({
    required this.version,
    required this.track,
    required this.music,
    required this.qualityCode,
    required this.position,
    required this.duration,
    required this.queue,
    required this.queueIndex,
    required this.playbackModeCode,
  });

  static const int currentVersion = 1;
  static const String sequencePlaybackModeCode = 'sequence';
  static const String shufflePlaybackModeCode = 'shuffle';
  static const String repeatOnePlaybackModeCode = 'repeatOne';

  final int version;
  final PersistedPlayerTrack track;
  final MusicInfo? music;
  final String? qualityCode;
  final Duration position;
  final Duration duration;
  final List<DownloadHistoryEntry> queue;
  final int queueIndex;
  final String playbackModeCode;

  PlayerSessionSnapshot copyWith({
    PersistedPlayerTrack? track,
    Object? music = _unsetPlayerSessionValue,
    Object? qualityCode = _unsetPlayerSessionValue,
    Duration? position,
    Duration? duration,
    List<DownloadHistoryEntry>? queue,
    int? queueIndex,
    String? playbackModeCode,
  }) {
    return PlayerSessionSnapshot(
      track: track ?? this.track,
      music: identical(music, _unsetPlayerSessionValue)
          ? this.music
          : music as MusicInfo?,
      qualityCode: identical(qualityCode, _unsetPlayerSessionValue)
          ? this.qualityCode
          : qualityCode as String?,
      position: position ?? this.position,
      duration: duration ?? this.duration,
      queue: queue ?? this.queue,
      queueIndex: queueIndex ?? this.queueIndex,
      playbackModeCode: playbackModeCode ?? this.playbackModeCode,
    );
  }

  PlayerSessionSnapshot applyCheckpoint(PlayerSessionCheckpoint checkpoint) {
    if (checkpoint.trackId != track.id) return this;
    return copyWith(
      position: checkpoint.position,
      duration: checkpoint.duration,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': version,
    'track': track.toJson(),
    if (music != null) 'music': music!.toJson(),
    if (qualityCode != null) 'qualityCode': qualityCode,
    'positionMs': position.inMilliseconds,
    'durationMs': duration.inMilliseconds,
    'queue': _queueToJson(queue),
    'queueIndex': queueIndex,
    'playbackModeCode': playbackModeCode,
  };

  static PlayerSessionSnapshot? tryFromJson(Object? value) {
    final json = _stringKeyedMap(value);
    if (json == null || json['version'] != currentVersion) return null;

    final track = PersistedPlayerTrack.tryFromJson(json['track']);
    if (track == null) return null;

    final queue = <DownloadHistoryEntry>[];
    final rawQueue = json['queue'];
    if (rawQueue is List) {
      for (final row in rawQueue) {
        final entryJson = _stringKeyedMap(row);
        if (entryJson == null) continue;
        try {
          final entry = DownloadHistoryEntry.fromJson(entryJson);
          if (entry.id.trim().isNotEmpty) queue.add(entry);
        } catch (_) {
          // One damaged queue row must not invalidate the current track.
        }
      }
    }

    final music = json.containsKey('music')
        ? _musicInfoFromJson(json['music'])
        : null;
    final duration = _durationFromJson(json['durationMs']);
    return PlayerSessionSnapshot._(
      version: currentVersion,
      track: track,
      music: music,
      qualityCode: _optionalNonEmptyString(json['qualityCode']),
      position: _normalizedPosition(
        _durationFromJson(json['positionMs']),
        duration,
      ),
      duration: duration,
      queue: List<DownloadHistoryEntry>.unmodifiable(queue),
      queueIndex: _normalizedQueueIndex(
        _intFromJson(json['queueIndex'], fallback: -1),
        queue.length,
      ),
      playbackModeCode: _normalizedPlaybackModeCode(
        _optionalString(json['playbackModeCode']),
      ),
    );
  }
}

class PlayerSessionCheckpoint {
  factory PlayerSessionCheckpoint({
    required String trackId,
    Duration position = Duration.zero,
    Duration duration = Duration.zero,
  }) {
    final normalizedDuration = _nonNegativeDuration(duration);
    return PlayerSessionCheckpoint._(
      version: currentVersion,
      trackId: trackId.trim(),
      position: _normalizedPosition(position, normalizedDuration),
      duration: normalizedDuration,
    );
  }

  const PlayerSessionCheckpoint._({
    required this.version,
    required this.trackId,
    required this.position,
    required this.duration,
  });

  static const int currentVersion = 1;

  final int version;
  final String trackId;
  final Duration position;
  final Duration duration;

  Map<String, dynamic> toJson() => {
    'version': version,
    'trackId': trackId,
    'positionMs': position.inMilliseconds,
    'durationMs': duration.inMilliseconds,
  };

  static PlayerSessionCheckpoint? tryFromJson(Object? value) {
    final json = _stringKeyedMap(value);
    if (json == null || json['version'] != currentVersion) return null;
    final trackId = _nonEmptyString(json['trackId']);
    if (trackId == null) return null;
    final duration = _durationFromJson(json['durationMs']);
    return PlayerSessionCheckpoint._(
      version: currentVersion,
      trackId: trackId,
      position: _normalizedPosition(
        _durationFromJson(json['positionMs']),
        duration,
      ),
      duration: duration,
    );
  }
}

/// Rebuilds a MusicInfo with a complete JSON payload instead of relying on its
/// optional raw map. This keeps programmatically-created MusicInfo values
/// restorable while preserving source-specific fields from API responses.
MusicInfo? normalizePlayerSessionMusic(MusicInfo? music) {
  if (music == null) return null;
  try {
    return MusicInfo.fromJson(_normalizedMusicInfoJson(music));
  } catch (_) {
    return null;
  }
}

/// Returns a deeply JSON-safe, immutable copy of a MusicInfo payload.
Map<String, dynamic>? normalizePlayerSessionMusicJson(Object? value) {
  final normalized = _normalizeJsonValue(value);
  return normalized is Map<String, dynamic> ? normalized : null;
}

MusicInfo? _musicInfoFromJson(Object? value) {
  final json = normalizePlayerSessionMusicJson(value);
  if (json == null) return null;
  try {
    final music = MusicInfo.fromJson(json);
    if (music.id.trim().isEmpty) return null;
    return normalizePlayerSessionMusic(music);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic> _normalizedMusicInfoJson(MusicInfo music) {
  final raw = normalizePlayerSessionMusicJson(music.raw) ?? const {};
  final rawMeta = normalizePlayerSessionMusicJson(music.meta.raw) ?? const {};
  final meta = <String, dynamic>{
    ...rawMeta,
    'songId': _jsonSafeScalar(music.meta.songId),
    'albumName': music.meta.albumName,
    if (music.meta.picUrl != null) 'picUrl': music.meta.picUrl,
    if (music.meta.albumId != null)
      'albumId': _jsonSafeScalar(music.meta.albumId),
    'qualitys': [
      for (final option in music.meta.qualitys)
        {
          'type': option.type.code,
          if (option.size != null) 'size': option.size,
          if (option.hash != null) 'hash': option.hash,
        },
    ],
    if (music.meta.hash != null) 'hash': music.meta.hash,
    if (music.meta.strMediaMid != null) 'strMediaMid': music.meta.strMediaMid,
    if (music.meta.metaId != null) 'id': _jsonSafeScalar(music.meta.metaId),
    if (music.meta.albumMid != null) 'albumMid': music.meta.albumMid,
    if (music.meta.copyrightId != null) 'copyrightId': music.meta.copyrightId,
    if (music.meta.lrcUrl != null) 'lrcUrl': music.meta.lrcUrl,
    if (music.meta.mrcUrl != null) 'mrcUrl': music.meta.mrcUrl,
    if (music.meta.trcUrl != null) 'trcUrl': music.meta.trcUrl,
  };
  return Map<String, dynamic>.unmodifiable({
    ...raw,
    'id': music.id,
    'name': music.name,
    'singer': music.singer,
    'source': music.source.code,
    'interval': music.interval,
    'meta': Map<String, dynamic>.unmodifiable(meta),
  });
}

Object? _jsonSafeScalar(Object? value) {
  final normalized = _normalizeJsonValue(value);
  return identical(normalized, _invalidJsonValue)
      ? value.toString()
      : normalized;
}

Object? _normalizeJsonValue(Object? value) {
  if (value == null || value is String || value is bool || value is int) {
    return value;
  }
  if (value is double) {
    return value.isFinite ? value : _invalidJsonValue;
  }
  if (value is num) return value.toDouble();
  if (value is List) {
    final out = <Object?>[];
    for (final item in value) {
      final normalized = _normalizeJsonValue(item);
      if (identical(normalized, _invalidJsonValue)) return _invalidJsonValue;
      out.add(normalized);
    }
    return List<Object?>.unmodifiable(out);
  }
  if (value is Map) {
    final out = <String, dynamic>{};
    for (final entry in value.entries) {
      final key = entry.key;
      if (key is! String) return _invalidJsonValue;
      final normalized = _normalizeJsonValue(entry.value);
      if (identical(normalized, _invalidJsonValue)) return _invalidJsonValue;
      out[key] = normalized;
    }
    return Map<String, dynamic>.unmodifiable(out);
  }
  return _invalidJsonValue;
}

List<Map<String, dynamic>> _queueToJson(List<DownloadHistoryEntry> queue) {
  final rows = <Map<String, dynamic>>[];
  for (final entry in queue) {
    final normalized = normalizePlayerSessionMusicJson(entry.toJson());
    if (normalized != null) rows.add(normalized);
  }
  return rows;
}

Map<String, dynamic>? _stringKeyedMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is! Map) return null;
  final out = <String, dynamic>{};
  for (final entry in value.entries) {
    if (entry.key is! String) return null;
    out[entry.key as String] = entry.value;
  }
  return out;
}

String _stringOrEmpty(Object? value) => value is String ? value : '';

String? _optionalString(Object? value) => value is String ? value : null;

String? _nonEmptyString(Object? value) {
  final string = _optionalString(value)?.trim();
  return string == null || string.isEmpty ? null : string;
}

String? _optionalNonEmptyString(Object? value) => _nonEmptyString(value);

Duration _durationFromJson(Object? value) {
  final milliseconds = _intFromJson(value, fallback: 0);
  return milliseconds <= 0
      ? Duration.zero
      : Duration(milliseconds: milliseconds);
}

int _intFromJson(Object? value, {required int fallback}) {
  if (value is int) return value;
  if (value is num && value.isFinite) return value.toInt();
  return fallback;
}

Duration _nonNegativeDuration(Duration value) {
  return value.isNegative ? Duration.zero : value;
}

Duration _normalizedPosition(Duration position, Duration duration) {
  final nonNegative = _nonNegativeDuration(position);
  if (duration > Duration.zero && nonNegative > duration) return duration;
  return nonNegative;
}

int _normalizedQueueIndex(int value, int queueLength) {
  return value >= 0 && value < queueLength ? value : -1;
}

String _normalizedPlaybackModeCode(String? value) {
  return switch (value) {
    PlayerSessionSnapshot.shufflePlaybackModeCode =>
      PlayerSessionSnapshot.shufflePlaybackModeCode,
    PlayerSessionSnapshot.repeatOnePlaybackModeCode =>
      PlayerSessionSnapshot.repeatOnePlaybackModeCode,
    _ => PlayerSessionSnapshot.sequencePlaybackModeCode,
  };
}
