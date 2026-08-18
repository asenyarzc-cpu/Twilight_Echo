import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';

class LxPlaylistImportException implements Exception {
  const LxPlaylistImportException(this.message);

  final String message;

  @override
  String toString() => message;
}

class LxPlaylistData {
  const LxPlaylistData({
    required this.sourceId,
    required this.name,
    required this.tracks,
  });

  final String sourceId;
  final String name;
  final List<MusicInfo> tracks;
}

class LxPlaylistDocument {
  const LxPlaylistDocument({
    required this.playlists,
    required this.skippedTrackCount,
    required this.skippedPlaylistCount,
  });

  final List<LxPlaylistData> playlists;
  final int skippedTrackCount;
  final int skippedPlaylistCount;
}

class LxPlaylistPickedFile {
  const LxPlaylistPickedFile({required this.name, required this.bytes});

  final String name;
  final List<int> bytes;
}

typedef LxPlaylistFilePicker = Future<LxPlaylistPickedFile?> Function();

final lxPlaylistFilePickerProvider = Provider<LxPlaylistFilePicker>(
  (ref) => pickLxPlaylistFile,
);

Future<LxPlaylistPickedFile?> pickLxPlaylistFile() async {
  final result = await FilePicker.platform.pickFiles(
    dialogTitle: '选择洛雪歌单文件',
    type: FileType.any,
    allowMultiple: false,
    withData: true,
  );
  if (result == null) return null;

  final picked = result.files.single;
  if (!isSupportedLxPlaylistFileName(picked.name)) {
    throw const LxPlaylistImportException('请选择 .lxmc 或 .json 歌单文件');
  }
  final bytes =
      picked.bytes ??
      (picked.path == null ? null : await File(picked.path!).readAsBytes());
  if (bytes == null) {
    throw const LxPlaylistImportException('无法读取所选文件');
  }
  return LxPlaylistPickedFile(name: picked.name, bytes: bytes);
}

bool isSupportedLxPlaylistFileName(String fileName) {
  final normalized = fileName.trim().toLowerCase();
  return normalized.endsWith('.lxmc') || normalized.endsWith('.json');
}

LxPlaylistDocument parseLxPlaylistFile(List<int> bytes, {String? fileName}) {
  if (bytes.isEmpty) {
    throw const LxPlaylistImportException('歌单文件为空');
  }

  List<int> jsonBytes = bytes;
  if (_isGzip(bytes)) {
    try {
      jsonBytes = const GZipDecoder().decodeBytes(bytes, verify: true);
    } catch (_) {
      throw const LxPlaylistImportException('无法解压这个 lxmc 文件');
    }
  }

  Object? root;
  try {
    root = jsonDecode(utf8.decode(jsonBytes));
    if (root is String) root = jsonDecode(root);
  } catch (_) {
    throw LxPlaylistImportException(
      fileName == null ? '歌单文件不是有效的 JSON' : '$fileName 不是有效的洛雪歌单文件',
    );
  }

  final document = _stringMap(root);
  if (document == null) {
    throw const LxPlaylistImportException('歌单文件缺少有效的数据结构');
  }

  final type = _text(document['type']);
  final Object? data = document['data'];
  final bool legacy;
  final List<Object?> rawPlaylists;
  switch (type) {
    case 'playListPart_v2':
      legacy = false;
      rawPlaylists = [data];
    case 'playList_v2':
      legacy = false;
      rawPlaylists = data is List ? data : const [];
    case 'playListPart':
    case 'defautlList':
      legacy = true;
      rawPlaylists = [data];
    case 'playList':
      legacy = true;
      rawPlaylists = data is List ? data : const [];
    default:
      throw LxPlaylistImportException(
        type.isEmpty ? '无法识别歌单文件类型' : '暂不支持洛雪文件类型：$type',
      );
  }

  final playlists = <LxPlaylistData>[];
  var skippedTrackCount = 0;
  var skippedPlaylistCount = 0;
  for (final rawPlaylist in rawPlaylists) {
    final playlist = _stringMap(rawPlaylist);
    final rawTracks = playlist?['list'];
    if (playlist == null || rawTracks is! List) {
      skippedPlaylistCount++;
      continue;
    }

    final tracks = <MusicInfo>[];
    for (final rawTrack in rawTracks) {
      final track = legacy
          ? _parseLegacyTrack(rawTrack)
          : _parseCurrentTrack(rawTrack);
      if (track == null) {
        skippedTrackCount++;
      } else {
        tracks.add(track);
      }
    }

    final sourceId = _text(playlist['id']).trim();
    playlists.add(
      LxPlaylistData(
        sourceId: sourceId,
        name: _playlistName(_text(playlist['name']).trim(), sourceId),
        tracks: List<MusicInfo>.unmodifiable(tracks),
      ),
    );
  }

  if (playlists.isEmpty) {
    throw const LxPlaylistImportException('文件中没有可导入的歌单');
  }
  return LxPlaylistDocument(
    playlists: List<LxPlaylistData>.unmodifiable(playlists),
    skippedTrackCount: skippedTrackCount,
    skippedPlaylistCount: skippedPlaylistCount,
  );
}

MusicInfo? _parseCurrentTrack(Object? value) {
  final raw = _stringMap(value);
  if (raw == null) return null;

  final id = _text(raw['id']).trim();
  final name = _text(raw['name']).trim();
  final source = MusicSource.tryFromCode(_text(raw['source']).trim());
  if (id.isEmpty ||
      name.isEmpty ||
      source == null ||
      source == MusicSource.all) {
    return null;
  }

  final normalized = Map<String, dynamic>.from(raw)
    ..['id'] = id
    ..['name'] = name
    ..['singer'] = _text(raw['singer'])
    ..['source'] = source.code
    ..['meta'] = _normalizeMeta(raw['meta']);
  if (normalized['interval'] is! String) normalized.remove('interval');

  try {
    return MusicInfo.fromJson(normalized);
  } catch (_) {
    return null;
  }
}

MusicInfo? _parseLegacyTrack(Object? value) {
  final old = _stringMap(value);
  if (old == null) return null;

  final name = _text(old['name']).trim();
  final source = MusicSource.tryFromCode(_text(old['source']).trim());
  final songId = old['songmid'];
  final songIdText = _text(songId).trim();
  if (name.isEmpty ||
      songIdText.isEmpty ||
      source == null ||
      source == MusicSource.all) {
    return null;
  }

  final hash = _optionalText(old['hash']);
  final meta = <String, dynamic>{
    'songId': songId,
    'albumName': _text(old['albumName']),
    'qualitys': old['types'],
  };
  _putIfNotNull(meta, 'picUrl', _optionalText(old['img']));
  _putIfNotNull(meta, 'albumId', old['albumId']);
  if (old['_types'] is Map) meta['_qualitys'] = old['_types'];
  _putIfNotNull(meta, 'hash', hash);
  _putIfNotNull(meta, 'strMediaMid', _optionalText(old['strMediaMid']));
  _putIfNotNull(meta, 'id', old['songId']);
  _putIfNotNull(meta, 'albumMid', _optionalText(old['albumMid']));
  _putIfNotNull(meta, 'copyrightId', _optionalText(old['copyrightId']));
  _putIfNotNull(meta, 'lrcUrl', _optionalText(old['lrcUrl']));
  _putIfNotNull(meta, 'mrcUrl', _optionalText(old['mrcUrl']));
  _putIfNotNull(meta, 'trcUrl', _optionalText(old['trcUrl']));
  final id = source == MusicSource.kg && hash != null
      ? '${songIdText}_$hash'
      : '${source.code}_$songIdText';
  return _parseCurrentTrack({
    'id': id,
    'name': name,
    'singer': _text(old['singer']),
    'source': source.code,
    if (old['interval'] is String) 'interval': old['interval'],
    'meta': meta,
  });
}

Map<String, dynamic> _normalizeMeta(Object? value) {
  final meta = _stringMap(value) ?? <String, dynamic>{};
  meta['albumName'] = _text(meta['albumName']);

  final rawQualities = meta['qualitys'];
  final qualities = <Map<String, dynamic>>[];
  if (rawQualities is List) {
    for (final rawQuality in rawQualities) {
      final quality = _stringMap(rawQuality);
      if (quality == null) continue;
      var type = _text(quality['type']);
      if (type == 'flac32bit') type = Quality.flac24bit.code;
      if (Quality.tryFromCode(type) == null) continue;
      final normalized = Map<String, dynamic>.from(quality)..['type'] = type;
      for (final key in const ['size', 'hash', 'mediaInfo']) {
        final field = _optionalText(normalized[key]);
        if (field == null) {
          normalized.remove(key);
        } else {
          normalized[key] = field;
        }
      }
      qualities.add(normalized);
    }
  }
  meta['qualitys'] = qualities;

  final qualityMap = _stringMap(meta['_qualitys']);
  if (qualityMap != null) {
    if (qualityMap.containsKey('flac32bit') &&
        !qualityMap.containsKey(Quality.flac24bit.code)) {
      qualityMap[Quality.flac24bit.code] = qualityMap.remove('flac32bit');
    }
    meta['_qualitys'] = qualityMap;
  }

  for (final key in const [
    'picUrl',
    'hash',
    'strMediaMid',
    'albumMid',
    'copyrightId',
    'lrcUrl',
    'mrcUrl',
    'trcUrl',
  ]) {
    final field = _optionalText(meta[key]);
    if (field == null) {
      meta.remove(key);
    } else {
      meta[key] = field;
    }
  }
  return meta;
}

String _playlistName(String name, String id) {
  if (name == 'list__name_default' || (name.isEmpty && id == 'default')) {
    return '试听列表';
  }
  if (name == 'list__name_love' || (name.isEmpty && id == 'love')) {
    return '我的收藏';
  }
  if (name == 'list__name_temp' || (name.isEmpty && id == 'temp')) {
    return '临时列表';
  }
  return name.isEmpty ? '导入的歌单' : name;
}

bool _isGzip(List<int> bytes) =>
    bytes.length >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b;

Map<String, dynamic>? _stringMap(Object? value) {
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

String _text(Object? value) {
  if (value == null) return '';
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return '';
}

String? _optionalText(Object? value) {
  final text = _text(value).trim();
  return text.isEmpty ? null : text;
}

void _putIfNotNull(Map<String, dynamic> target, String key, Object? value) {
  if (value != null) target[key] = value;
}
