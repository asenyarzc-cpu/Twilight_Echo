import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/music_sources/music_source_runtime.dart';
import 'package:twilight_echo/core/sdk/internal/builders.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('legacy musicInfo compatibility', () {
    test('keeps Kuwo songmid and quality maps flat', () {
      final old = toOldMusicInfoJson(
        _music(source: MusicSource.kw, songId: '987654'),
      );

      _expectCommonShape(old, source: 'kw', songId: '987654');
    });

    test('keeps Kugou top-level and per-quality hashes', () {
      final old = toOldMusicInfoJson(
        _music(source: MusicSource.kg, songId: 2468, hash: 'TRACK_HASH'),
      );

      _expectCommonShape(old, source: 'kg', songId: 2468);
      expect(old['hash'], 'TRACK_HASH');
      expect((old['types'] as List).first, {
        'type': '128k',
        'size': '1024',
        'hash': 'HASH_128',
      });
      expect((old['_types'] as Map)['flac'], {
        'size': '4096',
        'hash': 'HASH_FLAC',
      });
    });

    test('keeps QQ mids, numeric songId, and albumMid', () {
      final old = toOldMusicInfoJson(
        _music(
          source: MusicSource.tx,
          songId: '001MID',
          strMediaMid: 'MEDIA_MID',
          metaId: 112233,
          albumMid: 'ALBUM_MID',
        ),
      );

      _expectCommonShape(old, source: 'tx', songId: '001MID');
      expect(old['strMediaMid'], 'MEDIA_MID');
      expect(old['songId'], 112233);
      expect(old['albumMid'], 'ALBUM_MID');
    });

    test('uses the selected QQ quality version MID for source resolution', () {
      final old = toOldMusicInfoJson(
        _music(
          source: MusicSource.tx,
          songId: '001MID',
          strMediaMid: 'BASE_MEDIA_MID',
          flacMediaInfo: 'VERSION_MEDIA_MID',
        ),
        quality: Quality.flac,
      );

      expect(old['strMediaMid'], 'VERSION_MEDIA_MID');
      expect((old['_types'] as Map)['flac'], {
        'size': '4096',
        'hash': 'HASH_FLAC',
        'mediaInfo': 'VERSION_MEDIA_MID',
      });
    });

    test('keeps numeric NetEase songmid', () {
      final old = toOldMusicInfoJson(
        _music(source: MusicSource.wy, songId: 99887766),
      );

      _expectCommonShape(old, source: 'wy', songId: 99887766);
      expect(old['songmid'], isA<int>());
    });

    test('keeps Migu copyright and lyric URLs', () {
      final old = toOldMusicInfoJson(
        _music(
          source: MusicSource.mg,
          songId: 'MG_SONG',
          copyrightId: 'COPYRIGHT',
          lrcUrl: 'https://example.test/song.lrc',
          mrcUrl: 'https://example.test/song.mrc',
          trcUrl: 'https://example.test/song.trc',
        ),
      );

      _expectCommonShape(old, source: 'mg', songId: 'MG_SONG');
      expect(old['copyrightId'], 'COPYRIGHT');
      expect(old['lrcUrl'], 'https://example.test/song.lrc');
      expect(old['mrcUrl'], 'https://example.test/song.mrc');
      expect(old['trcUrl'], 'https://example.test/song.trc');
    });
  });

  test(
    'runtime sends the flat compatibility object to the native bridge',
    () async {
      const channel = MethodChannel('test/music_source_runtime');
      Map<Object?, Object?>? resolveArguments;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'resolve') {
              resolveArguments = Map<Object?, Object?>.from(
                call.arguments as Map,
              );
              return <String, dynamic>{
                'url': 'https://audio.example.test/song.mp3',
              };
            }
            return null;
          });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });

      final runtime = MusicSourceRuntime(Dio(), channel: channel);
      final music = _music(
        source: MusicSource.kg,
        songId: 1357,
        hash: 'REAL_HASH',
      );
      final resolved = await runtime.resolve(
        music: music,
        quality: Quality.flac,
      );

      expect(resolved.url, 'https://audio.example.test/song.mp3');
      expect(resolveArguments?['source'], 'kg');
      expect(resolveArguments?['quality'], 'flac');
      final old = Map<Object?, Object?>.from(
        resolveArguments?['musicInfo'] as Map,
      );
      expect(old['songmid'], 1357);
      expect(old['hash'], 'REAL_HASH');
      expect(old, isNot(contains('meta')));
      expect(old, isNot(contains('id')));
    },
  );
}

MusicInfo _music({
  required MusicSource source,
  required Object songId,
  String? hash,
  String? strMediaMid,
  String? flacMediaInfo,
  Object? metaId,
  String? albumMid,
  String? copyrightId,
  String? lrcUrl,
  String? mrcUrl,
  String? trcUrl,
}) {
  return buildMusicInfo(
    name: 'Test Song',
    singer: 'Test Artist',
    source: source,
    songId: songId,
    interval: '03:30',
    albumName: 'Test Album',
    albumId: 42,
    picUrl: 'https://example.test/cover.jpg',
    qualitys: [
      const QualityOption(type: Quality.k128, size: '1024', hash: 'HASH_128'),
      QualityOption(
        type: Quality.flac,
        size: '4096',
        hash: 'HASH_FLAC',
        mediaInfo: flacMediaInfo,
      ),
    ],
    hash: hash,
    strMediaMid: strMediaMid,
    metaId: metaId,
    albumMid: albumMid,
    copyrightId: copyrightId,
    lrcUrl: lrcUrl,
    mrcUrl: mrcUrl,
    trcUrl: trcUrl,
  );
}

void _expectCommonShape(
  Map<String, dynamic> old, {
  required String source,
  required Object songId,
}) {
  expect(old['name'], 'Test Song');
  expect(old['singer'], 'Test Artist');
  expect(old['source'], source);
  expect(old['songmid'], songId);
  expect(old['interval'], '03:30');
  expect(old['albumName'], 'Test Album');
  expect(old['albumId'], 42);
  expect(old['img'], 'https://example.test/cover.jpg');
  expect(old['types'], isA<List<dynamic>>());
  expect(old['_types'], isA<Map<String, dynamic>>());
  expect(old['typeUrl'], isEmpty);
  expect(old, isNot(contains('meta')));
  expect(old, isNot(contains('id')));
}
