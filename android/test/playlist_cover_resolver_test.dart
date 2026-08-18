import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/api/music_api.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/features/playlists/lx_playlist_import.dart';
import 'package:twilight_echo/features/playlists/playlist_cover_resolver.dart';

void main() {
  test(
    'playlist cover lookups are deduplicated, cached, and bounded',
    () async {
      final api = _ConcurrentCoverApi();
      final resolver = PlaylistCoverResolver(api, maxConcurrent: 2);
      final musics = [for (var index = 0; index < 5; index++) _music('$index')];

      final first = resolver.resolve(musics.first);
      final duplicate = resolver.resolve(musics.first);
      expect(identical(first, duplicate), isTrue);

      final resolved = await Future.wait([
        first,
        duplicate,
        for (final music in musics.skip(1)) resolver.resolve(music),
      ]);

      expect(api.requests, 5);
      expect(api.maxActive, 2);
      expect(api.preferCachedValues, everyElement(isFalse));
      expect(resolved.first, 'https://img.test/0.jpg');
      expect(resolved[1], resolved.first);

      expect(await resolver.resolve(musics.first), resolved.first);
      expect(api.requests, 5);
    },
  );

  test('failed playlist cover lookups can retry', () async {
    final api = _RetryCoverApi();
    final resolver = PlaylistCoverResolver(api);
    final music = _music('retry');

    expect(await resolver.resolve(music), isNull);
    expect(await resolver.resolve(music), 'https://img.test/retry.jpg');
    expect(api.requests, 2);
  });

  test(
    'LX import resolves every Kugou and missing cover before storage',
    () async {
      final api = _ImportCoverApi();
      final progress = <String>[];
      final originalKugou = _music(
        'kg-existing',
        picUrl: 'http://old.test/kg.jpg',
      );
      final result = await resolveLxPlaylistCovers(
        [
          LxPlaylistData(
            sourceId: 'love',
            name: '我的收藏',
            tracks: [
              originalKugou,
              _music('kw-missing', source: MusicSource.kw),
              _music(
                'mg-relative',
                source: MusicSource.mg,
                picUrl: '/data/oss/resource/cover.webp',
              ),
              _music(
                'wy-existing',
                source: MusicSource.wy,
                picUrl: 'https://img.test/existing.jpg',
              ),
            ],
          ),
        ],
        PlaylistCoverResolver(api),
        onProgress: (completed, total) => progress.add('$completed/$total'),
      );

      expect(result.lookupCount, 2);
      expect(result.resolvedCount, 2);
      expect(progress.first, '0/2');
      expect(progress.last, '2/2');
      expect(api.musicIds, ['kg-existing', 'kw-missing']);
      final tracks = result.playlists.single.tracks;
      expect(tracks[0].meta.picUrl, 'https://img.test/kg-existing.jpg');
      expect(tracks[1].meta.picUrl, 'https://img.test/kw-missing.jpg');
      expect(
        tracks[2].meta.picUrl,
        'https://d.musicapp.migu.cn/data/oss/resource/cover.webp',
      );
      expect(tracks[3].meta.picUrl, 'https://img.test/existing.jpg');
      expect(originalKugou.meta.picUrl, 'http://old.test/kg.jpg');
    },
  );
}

class _ConcurrentCoverApi extends MusicApi {
  int requests = 0;
  int active = 0;
  int maxActive = 0;
  final List<bool> preferCachedValues = [];

  @override
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) async {
    requests++;
    preferCachedValues.add(preferCached);
    active++;
    if (active > maxActive) maxActive = active;
    await Future<void>.delayed(const Duration(milliseconds: 10));
    active--;
    return 'https://img.test/${musicInfo.id}.jpg';
  }
}

class _RetryCoverApi extends MusicApi {
  int requests = 0;

  @override
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) async {
    requests++;
    return requests == 1 ? null : 'https://img.test/${musicInfo.id}.jpg';
  }
}

class _ImportCoverApi extends MusicApi {
  final List<String> musicIds = [];

  @override
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) async {
    musicIds.add(musicInfo.id);
    return 'https://img.test/${musicInfo.id}.jpg';
  }
}

MusicInfo _music(
  String id, {
  MusicSource source = MusicSource.kg,
  String? picUrl,
}) {
  return MusicInfo.fromJson({
    'id': id,
    'name': '歌曲 $id',
    'singer': '歌手',
    'source': source.code,
    'interval': '03:30',
    'meta': {
      'songId': id,
      'albumName': '专辑',
      'picUrl': ?picUrl,
      'qualitys': [
        {'type': Quality.k320.code, 'size': '1024'},
      ],
    },
  });
}
