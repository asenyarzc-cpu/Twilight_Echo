import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../downloads/download_history_store.dart';

@immutable
class PlaylistTrack {
  const PlaylistTrack({
    required this.musicId,
    required this.name,
    required this.singer,
    required this.albumName,
    required this.sourceCode,
    required this.qualityCode,
    this.localPath,
    this.picUrl,
    this.musicJson,
  });

  final String musicId;
  final String name;
  final String singer;
  final String albumName;
  final String sourceCode;
  final String qualityCode;
  final String? localPath;
  final String? picUrl;
  final Map<String, dynamic>? musicJson;

  MusicSource get source => MusicSource.fromCode(sourceCode);

  String get id => identityKey;

  bool get isLocal => localPath?.trim().isNotEmpty ?? false;

  MusicInfo? get musicInfo {
    final json = musicJson;
    if (json == null) return null;
    try {
      return MusicInfo.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  String get identityKey {
    final normalizedSource = sourceCode.trim().toLowerCase();
    final normalizedMusicId = musicId.trim();
    if (normalizedMusicId.isNotEmpty &&
        normalizedSource.isNotEmpty &&
        normalizedSource != MusicSource.all.code) {
      return 'music:$normalizedSource:$normalizedMusicId';
    }

    final path = localPath?.trim();
    if (path != null && path.isNotEmpty) {
      return 'file:${normalizePlaylistPath(path)}';
    }

    return 'fallback:$normalizedSource:$normalizedMusicId:'
        '${name.trim().toLowerCase()}:${singer.trim().toLowerCase()}';
  }

  factory PlaylistTrack.fromDownloadHistory(DownloadHistoryEntry entry) {
    return PlaylistTrack(
      musicId: entry.musicId,
      name: entry.name,
      singer: entry.singer,
      albumName: entry.albumName,
      sourceCode: entry.sourceCode,
      qualityCode: entry.qualityCode,
      localPath: _nonEmpty(entry.savedPath),
      picUrl: _nonEmpty(entry.picUrl),
      musicJson: entry.musicJson == null
          ? null
          : Map<String, dynamic>.from(entry.musicJson!),
    );
  }

  factory PlaylistTrack.fromMusicInfo(MusicInfo music) {
    return PlaylistTrack(
      musicId: music.id,
      name: music.name,
      singer: music.singer,
      albumName: music.albumName,
      sourceCode: music.source.code,
      qualityCode: music.bestQuality.code,
      picUrl: _nonEmpty(music.meta.picUrl),
      musicJson: Map<String, dynamic>.from(music.toJson()),
    );
  }

  PlaylistTrack copyWith({
    String? musicId,
    String? name,
    String? singer,
    String? albumName,
    String? sourceCode,
    String? qualityCode,
    String? localPath,
    String? picUrl,
    Map<String, dynamic>? musicJson,
  }) {
    return PlaylistTrack(
      musicId: musicId ?? this.musicId,
      name: name ?? this.name,
      singer: singer ?? this.singer,
      albumName: albumName ?? this.albumName,
      sourceCode: sourceCode ?? this.sourceCode,
      qualityCode: qualityCode ?? this.qualityCode,
      localPath: localPath ?? this.localPath,
      picUrl: picUrl ?? this.picUrl,
      musicJson: musicJson ?? this.musicJson,
    );
  }

  PlaylistTrack mergePreferLocal(PlaylistTrack incoming) {
    if (incoming.isLocal || !isLocal) return incoming;
    return incoming.copyWith(localPath: localPath);
  }

  PlaylistTrack withoutLocalPath() {
    return PlaylistTrack(
      musicId: musicId,
      name: name,
      singer: singer,
      albumName: albumName,
      sourceCode: sourceCode,
      qualityCode: qualityCode,
      picUrl: picUrl,
      musicJson: musicJson == null
          ? null
          : Map<String, dynamic>.from(musicJson!),
    );
  }

  DownloadHistoryEntry? toDownloadHistoryEntry({required String playlistId}) {
    final path = localPath?.trim();
    if (path == null || path.isEmpty) return null;
    return DownloadHistoryEntry(
      id: 'playlist:$playlistId:$identityKey',
      musicId: musicId,
      name: name,
      singer: singer,
      albumName: albumName,
      sourceCode: sourceCode,
      qualityCode: qualityCode,
      status: DownloadHistoryStatus.completed,
      createdAt: DateTime.fromMillisecondsSinceEpoch(0),
      savedPath: path,
      picUrl: picUrl,
      musicJson: musicJson == null
          ? null
          : Map<String, dynamic>.from(musicJson!),
    );
  }

  DownloadHistoryEntry? toQueueEntry({required String playlistId}) {
    final path = localPath?.trim();
    final savedPath = path != null && path.isNotEmpty && File(path).existsSync()
        ? path
        : null;
    if (savedPath == null && musicInfo == null) return null;
    return DownloadHistoryEntry(
      id: 'playlist:$playlistId:$identityKey',
      musicId: musicId,
      name: name,
      singer: singer,
      albumName: albumName,
      sourceCode: sourceCode,
      qualityCode: qualityCode,
      status: DownloadHistoryStatus.completed,
      createdAt: DateTime.fromMillisecondsSinceEpoch(0),
      savedPath: savedPath,
      picUrl: picUrl,
      musicJson: musicJson == null
          ? null
          : Map<String, dynamic>.from(musicJson!),
    );
  }

  Map<String, dynamic> toJson() => {
    'musicId': musicId,
    'name': name,
    'singer': singer,
    'albumName': albumName,
    'source': sourceCode,
    'quality': qualityCode,
    if (localPath != null) 'localPath': localPath,
    if (picUrl != null) 'picUrl': picUrl,
    if (musicJson != null) 'musicInfo': musicJson,
  };

  static PlaylistTrack? tryFromJson(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;

    final track = PlaylistTrack(
      musicId: _string(json['musicId'] ?? json['id']),
      name: _string(json['name']),
      singer: _string(json['singer']),
      albumName: _string(json['albumName'] ?? json['album']),
      sourceCode: _string(json['source'], fallback: MusicSource.all.code),
      qualityCode: _string(json['quality'], fallback: Quality.k128.code),
      localPath: _nonEmpty(_stringOrNull(json['localPath'] ?? json['path'])),
      picUrl: _nonEmpty(_stringOrNull(json['picUrl'])),
      musicJson: _mapOrNull(json['musicInfo']),
    );

    if (track.name.trim().isEmpty && !track.isLocal) return null;
    if (track.identityKey.startsWith('fallback:') &&
        track.musicId.trim().isEmpty &&
        track.name.trim().isEmpty) {
      return null;
    }
    return track;
  }
}

@immutable
class LocalPlaylist {
  const LocalPlaylist({
    required this.id,
    required this.name,
    required this.tracks,
    required this.createdAt,
    required this.updatedAt,
    this.originPlaylistId,
    this.originSourceCode,
    this.onlineTrackIds,
    this.coverUrl,
    this.creator,
    this.description,
  });

  final String id;
  final String name;
  final List<PlaylistTrack> tracks;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? originPlaylistId;
  final String? originSourceCode;
  final List<String>? onlineTrackIds;
  final String? coverUrl;
  final String? creator;
  final String? description;

  String? get onlinePlaylistId {
    final value = originPlaylistId?.trim();
    return value == null || value.isEmpty ? null : value;
  }

  MusicSource? get onlineSource {
    final code = originSourceCode?.trim();
    if (code == null || code.isEmpty) return null;
    final source = MusicSource.tryFromCode(code);
    return source == null || source == MusicSource.all ? null : source;
  }

  bool get isOnlineImport => onlinePlaylistId != null && onlineSource != null;

  LocalPlaylist copyWith({
    String? name,
    List<PlaylistTrack>? tracks,
    DateTime? updatedAt,
    List<String>? onlineTrackIds,
  }) {
    return LocalPlaylist(
      id: id,
      name: name ?? this.name,
      tracks: tracks ?? this.tracks,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      originPlaylistId: originPlaylistId,
      originSourceCode: originSourceCode,
      onlineTrackIds: onlineTrackIds ?? this.onlineTrackIds,
      coverUrl: coverUrl,
      creator: creator,
      description: description,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': 1,
    'id': id,
    'name': name,
    'tracks': [for (final track in tracks) track.toJson()],
    'createdAt': createdAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
    if (originPlaylistId != null) 'originPlaylistId': originPlaylistId,
    if (originSourceCode != null) 'originSource': originSourceCode,
    if (onlineTrackIds != null) 'onlineTrackIds': onlineTrackIds,
    if (coverUrl != null) 'coverUrl': coverUrl,
    if (creator != null) 'creator': creator,
    if (description != null) 'description': description,
  };

  static LocalPlaylist? tryFromJson(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;

    final id = _string(json['id']).trim();
    final name = _string(json['name']).trim();
    if (id.isEmpty || name.isEmpty) return null;

    final tracks = <PlaylistTrack>[];
    final seen = <String>{};
    final rawTracks = json['tracks'];
    if (rawTracks is List) {
      for (final rawTrack in rawTracks) {
        final track = PlaylistTrack.tryFromJson(rawTrack);
        if (track != null && seen.add(track.identityKey)) tracks.add(track);
      }
    }

    final createdAt = _dateTime(json['createdAt']);
    final updatedAt = _dateTime(json['updatedAt']) ?? createdAt;
    return LocalPlaylist(
      id: id,
      name: name,
      tracks: List<PlaylistTrack>.unmodifiable(tracks),
      createdAt: createdAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      updatedAt:
          updatedAt ?? createdAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      originPlaylistId: _nonEmpty(_stringOrNull(json['originPlaylistId'])),
      originSourceCode: _nonEmpty(
        _stringOrNull(json['originSource'] ?? json['originSourceCode']),
      ),
      onlineTrackIds: _stringListOrNull(json['onlineTrackIds']),
      coverUrl: _nonEmpty(_stringOrNull(json['coverUrl'])),
      creator: _nonEmpty(_stringOrNull(json['creator'])),
      description: _nonEmpty(_stringOrNull(json['description'])),
    );
  }
}

String normalizePlaylistPath(String path) {
  final normalized = path.trim().replaceAll('\\', '/');
  return Platform.isWindows ? normalized.toLowerCase() : normalized;
}

Map<String, dynamic>? _mapOrNull(Object? value) {
  if (value is Map<String, dynamic>) return Map<String, dynamic>.from(value);
  if (value is Map) {
    try {
      return Map<String, dynamic>.from(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

String _string(Object? value, {String fallback = ''}) {
  return value is String ? value : fallback;
}

String? _stringOrNull(Object? value) => value is String ? value : null;

List<String>? _stringListOrNull(Object? value) {
  if (value is! List) return null;
  final values = <String>[];
  final seen = <String>{};
  for (final item in value) {
    if (item is! String) continue;
    final normalized = item.trim();
    if (normalized.isNotEmpty && seen.add(normalized)) values.add(normalized);
  }
  return List<String>.unmodifiable(values);
}

String? _nonEmpty(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

DateTime? _dateTime(Object? value) {
  if (value is! String) return null;
  return DateTime.tryParse(value);
}
