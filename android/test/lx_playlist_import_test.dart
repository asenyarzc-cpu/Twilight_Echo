import 'dart:convert';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/features/playlists/lx_playlist_import.dart';

void main() {
  test('recognizes LX playlist file extensions case-insensitively', () {
    expect(isSupportedLxPlaylistFileName('playlist.lxmc'), isTrue);
    expect(isSupportedLxPlaylistFileName('BACKUP.JSON'), isTrue);
    expect(isSupportedLxPlaylistFileName('playlist.zip'), isFalse);
    expect(isSupportedLxPlaylistFileName('playlist.lxmc.txt'), isFalse);
  });

  group('parseLxPlaylistFile', () {
    test('parses a gzip playListPart_v2 export', () {
      final payload = {
        'type': 'playListPart_v2',
        'data': {
          'id': 'love',
          'name': 'list__name_love',
          'list': [
            _currentTrack(
              id: 'mg_760365',
              name: 'Saving',
              source: 'mg',
              qualities: const [
                {'type': '320k', 'size': '0 B'},
                {'type': 'flac32bit', 'size': 4096},
              ],
              qualityMap: const {
                'flac32bit': {'size': '4096'},
              },
            ),
            _currentTrack(id: 'local_file', name: '本地歌曲', source: 'local'),
          ],
        },
      };
      final bytes = const GZipEncoder().encodeBytes(
        utf8.encode(jsonEncode(payload)),
      );

      final document = parseLxPlaylistFile(bytes, fileName: 'love.lxmc');

      expect(document.playlists, hasLength(1));
      expect(document.playlists.single.sourceId, 'love');
      expect(document.playlists.single.name, '我的收藏');
      expect(document.playlists.single.tracks, hasLength(1));
      expect(document.skippedTrackCount, 1);
      final track = document.playlists.single.tracks.single;
      expect(track.id, 'mg_760365');
      expect(track.source, MusicSource.mg);
      expect(track.meta.picUrl, '/cover.webp');
      expect(track.meta.copyrightId, 'copyright-id');
      expect(track.meta.qualitys.map((quality) => quality.type), [
        Quality.k320,
        Quality.flac24bit,
      ]);
      expect(track.meta.qualitys.last.size, '4096');
      expect(track.meta.raw['_qualitys'], {
        'flac24bit': {'size': '4096'},
      });
    });

    test('parses plain and double-encoded playList_v2 JSON', () {
      final payload = {
        'type': 'playList_v2',
        'data': [
          {
            'id': 'default',
            'name': 'list__name_default',
            'list': [_currentTrack(id: 'wy_1', name: '第一首')],
          },
          {'id': 'custom', 'name': '通勤', 'list': <Object?>[]},
        ],
      };
      final bytes = utf8.encode(jsonEncode(jsonEncode(payload)));

      final document = parseLxPlaylistFile(bytes, fileName: 'lx_list.json');

      expect(document.playlists.map((playlist) => playlist.name), [
        '试听列表',
        '通勤',
      ]);
      expect(document.playlists.first.tracks.single.id, 'wy_1');
      expect(document.playlists.last.tracks, isEmpty);
      expect(document.skippedPlaylistCount, 0);
    });

    test('converts a legacy playListPart track', () {
      final payload = {
        'type': 'playListPart',
        'data': {
          'id': 'old-list',
          'name': '旧歌单',
          'list': [
            {
              'songmid': 99,
              'name': '旧格式歌曲',
              'singer': '歌手',
              'source': 'kg',
              'interval': '03:30',
              'albumName': '专辑',
              'img': 'https://example.test/cover.jpg',
              'types': [
                {'type': '128k', 'size': '1024', 'hash': 'HASH_128'},
              ],
              '_types': {
                '128k': {'size': '1024', 'hash': 'HASH_128'},
              },
              'hash': 'TRACK_HASH',
            },
          ],
        },
      };

      final document = parseLxPlaylistFile(utf8.encode(jsonEncode(payload)));
      final track = document.playlists.single.tracks.single;

      expect(track.id, '99_TRACK_HASH');
      expect(track.source, MusicSource.kg);
      expect(track.meta.songId, 99);
      expect(track.meta.hash, 'TRACK_HASH');
      expect(track.meta.albumName, '专辑');
    });

    test('rejects unsupported and malformed files', () {
      expect(
        () => parseLxPlaylistFile(
          utf8.encode(jsonEncode({'type': 'setting_v2', 'data': {}})),
        ),
        throwsA(
          isA<LxPlaylistImportException>().having(
            (error) => error.message,
            'message',
            contains('暂不支持'),
          ),
        ),
      );
      expect(
        () => parseLxPlaylistFile([0x1f, 0x8b, 0x00]),
        throwsA(isA<LxPlaylistImportException>()),
      );
      expect(
        () => parseLxPlaylistFile(utf8.encode('{broken')),
        throwsA(isA<LxPlaylistImportException>()),
      );
    });
  });
}

Map<String, dynamic> _currentTrack({
  required String id,
  required String name,
  String source = 'wy',
  List<Map<String, dynamic>> qualities = const [
    {'type': '128k', 'size': '1024'},
  ],
  Map<String, dynamic>? qualityMap,
}) {
  final meta = <String, dynamic>{
    'songId': id.split('_').last,
    'albumName': '专辑',
    'picUrl': '/cover.webp',
    'qualitys': qualities,
    'copyrightId': 'copyright-id',
  };
  if (qualityMap != null) meta['_qualitys'] = qualityMap;
  return {
    'id': id,
    'name': name,
    'singer': '歌手',
    'source': source,
    'interval': '04:40',
    'meta': meta,
  };
}
