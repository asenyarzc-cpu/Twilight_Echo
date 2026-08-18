import 'dart:convert';

import 'package:test/test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/playlist_category.dart';
import 'package:twilight_echo/core/sdk/playlist_adapters/kg_playlist_adapter.dart';
import 'package:twilight_echo/core/sdk/playlist_adapters/kw_playlist_adapter.dart';
import 'package:twilight_echo/core/sdk/playlist_adapters/mg_playlist_adapter.dart';
import 'package:twilight_echo/core/sdk/playlist_catalog_sdk.dart';
import 'package:twilight_echo/core/ui/cover_image_source.dart';

void main() {
  group('PlaylistCatalogSdk.featured', () {
    test('maps all five platform fixtures', () async {
      final kuwo = await PlaylistCatalogSdk.featured(
        MusicSource.kw,
        jsonLoader: _catalogFixture,
      );
      final kugou = await PlaylistCatalogSdk.featured(
        MusicSource.kg,
        jsonLoader: _catalogFixture,
      );
      final qq = await PlaylistCatalogSdk.featured(
        MusicSource.tx,
        jsonLoader: _catalogFixture,
      );
      final netEase = await PlaylistCatalogSdk.featured(
        MusicSource.wy,
        jsonLoader: _catalogFixture,
      );
      final migu = await PlaylistCatalogSdk.featured(
        MusicSource.mg,
        jsonLoader: _catalogFixture,
      );

      expect(kuwo, hasLength(1));
      expect(kuwo.single.id, '1001');
      expect(kuwo.single.name, '酷我热门');
      expect(
        kuwo.single.coverUrl,
        'http://img1.kwcdn.kuwo.cn/star/userpl2015/kw.jpg',
      );
      expect(kuwo.single.trackCount, 31);
      expect(kuwo.single.playCount, 9001);

      expect(kugou.single.id, '2001');
      expect(kugou.single.creator, '酷狗编辑');
      expect(kugou.single.coverUrl, 'https://img.test/480/kg-real.jpg');
      expect(qq.single.id, '3001');
      expect(qq.single.trackCount, 2);
      expect(netEase.single.id, '4001');
      expect(netEase.single.description, '网易云简介');
      expect(migu.single.id, '5001');
      expect(migu.single.name, '咪咕推荐');
    });

    test(
      'deduplicates by source and id and applies the requested limit',
      () async {
        final items = await PlaylistCatalogSdk.featured(
          MusicSource.kw,
          limit: 1,
          jsonLoader: _catalogFixture,
        );

        expect(items, hasLength(1));
        expect(items.single.key, 'kw:1001');
      },
    );

    test('passes the requested page to Kugou catalog API', () async {
      String? requestedUrl;

      await PlaylistCatalogSdk.featured(
        MusicSource.kg,
        page: 2,
        jsonLoader: (url, {headers}) {
          requestedUrl = url;
          return _catalogFixture(url, headers: headers);
        },
      );

      expect(requestedUrl, contains('p=2'));
    });

    test('maps platform categories to their real sort parameters', () async {
      final urls = <MusicSource, String>{};

      Future<void> load(MusicSource source, String categoryId) async {
        await PlaylistCatalogSdk.featured(
          source,
          categoryId: categoryId,
          jsonLoader: (url, {headers}) {
            urls[source] = url;
            return _catalogFixture(url, headers: headers);
          },
        );
      }

      await load(MusicSource.kw, 'hot');
      await load(MusicSource.kg, '8');
      await load(MusicSource.tx, '2');

      expect(urls[MusicSource.kw], contains('order=hot'));
      expect(urls[MusicSource.kg], contains('t=8'));
      final qqRequest =
          jsonDecode(Uri.parse(urls[MusicSource.tx]!).queryParameters['data']!)
              as Map<String, dynamic>;
      expect(
        (qqRequest['playlist'] as Map<String, dynamic>)['param'],
        containsPair('order', 2),
      );
    });

    test('exposes only the categories supported by each platform', () {
      expect(
        playlistCatalogCategoriesFor(MusicSource.kg).map((item) => item.label),
        ['推荐', '最热', '最新', '热藏', '飙升'],
      );
      expect(
        playlistCatalogCategoriesFor(MusicSource.kw).map((item) => item.label),
        ['最新', '最热'],
      );
      expect(
        playlistCatalogCategoriesFor(MusicSource.tx).map((item) => item.label),
        ['最热', '最新'],
      );
      expect(playlistCatalogCategoriesFor(MusicSource.wy), hasLength(1));
      expect(playlistCatalogCategoriesFor(MusicSource.mg), hasLength(1));
    });
  });

  group('playlist cover normalization', () {
    test('expands Migu OSS relative covers to the image host', () {
      const raw = '/data/oss/resource/00/2u/wh/cover.webp';
      const expected =
          'https://d.musicapp.migu.cn/data/oss/resource/00/2u/wh/cover.webp';

      expect(CoverImageSource.normalizeUrl(raw, size: 480), expected);
      expect(CoverImageSource.isUsableUrl(raw), isTrue);
      expect(CoverImageSource.isUsableUrl('/unsupported/cover.jpg'), isFalse);
    });

    test('keeps Kuwo kwcdn on HTTP because that host has invalid TLS', () {
      const url = 'http://img1.kwcdn.kuwo.cn/star/userpl2015/cover.jpg';

      expect(CoverImageSource.normalizeUrl(url, size: 480), url);
    });

    test('upgrades Kuwo thumbnail paths to the requested dimensions', () {
      const raw =
          'https://img2.kuwo.cn/star/albumcover/120/78/66/3785767710.jpg';

      expect(
        CoverImageSource.normalizeUrl(raw, size: 500),
        'https://img2.kuwo.cn/star/albumcover/500/78/66/3785767710.jpg',
      );
    });

    test('uses the requested dimensions for Kugou covers', () {
      const album = 'http://imge.kugou.com/stdmusic/480/20210112/cover.jpg';
      const artist =
          'https://singerimg.kugou.com/uploadpic/softhead/{size}/artist.jpg';

      expect(
        CoverImageSource.normalizeUrl(album, size: 700),
        'https://imge.kugou.com/stdmusic/700/20210112/cover.jpg',
      );
      expect(
        CoverImageSource.normalizeUrl(artist, size: 500),
        'https://singerimg.kugou.com/uploadpic/softhead/500/artist.jpg',
      );
    });

    test('maps QQ covers to supported CDN dimensions', () {
      const raw =
          'https://y.gtimg.cn/music/photo_new/'
          'T002R500x500M0000015rUVB2OUdGA.jpg';

      expect(
        CoverImageSource.normalizeUrl(raw, size: 180),
        'https://y.gtimg.cn/music/photo_new/'
        'T002R300x300M0000015rUVB2OUdGA.jpg',
      );
      expect(
        CoverImageSource.normalizeUrl(raw, size: 700),
        'https://y.gtimg.cn/music/photo_new/'
        'T002R800x800M0000015rUVB2OUdGA.jpg',
      );
    });

    test('normalizes NetEase covers with dimensions and signed headers', () {
      const raw = 'http://p1.music.126.net/token/109951170000000000.jpg';
      final url = CoverImageSource.normalizeUrl(raw, size: 640);

      expect(
        url,
        'https://p1.music.126.net/token/109951170000000000.jpg'
        '?param=640y640',
      );
      expect(
        CoverImageSource.normalizeUrl('$raw?param=500y500', size: 700),
        'https://p1.music.126.net/token/109951170000000000.jpg'
        '?param=700y700',
      );
      expect(
        CoverImageSource.headersFor(url),
        containsPair('Referer', 'https://music.163.com/'),
      );
      expect(CoverImageSource.headersFor(url), contains('User-Agent'));
    });
  });

  group('new playlist detail adapters', () {
    test('maps Kuwo metadata, tracks, pagination and qualities', () async {
      final playlist = await KwPlaylistAdapter.parse(
        '1001',
        jsonLoader: _kuwoDetailFixture,
      );

      expect(playlist.name, '酷我详情');
      expect(playlist.creator, '酷我作者');
      expect(playlist.totalTracks, 1);
      expect(playlist.tracks.single.id, 'kw_101');
      expect(playlist.tracks.single.interval, '03:30');
      expect(
        playlist.tracks.single.meta.picUrl,
        'https://img3.kuwo.cn/star/albumcover/500/kw-song.jpg',
      );
      expect(playlist.tracks.single.meta.qualitys.map((item) => item.type), [
        Quality.flac,
        Quality.k320,
      ]);
    });

    test('maps Kugou metadata, songs and hashes', () async {
      final playlist = await KgPlaylistAdapter.parse(
        '2001',
        jsonLoader: _kugouDetailFixture,
        jsonPoster: _kugouDetailPoster,
      );

      expect(playlist.name, '酷狗详情');
      expect(playlist.playCount, 7654);
      expect(playlist.tracks.single.name, '酷狗歌曲');
      expect(playlist.tracks.single.singer, '酷狗歌手');
      expect(playlist.tracks.single.meta.songId, '901');
      expect(playlist.tracks.single.meta.hash, 'DETAILHASH');
      expect(playlist.tracks.single.albumName, '酷狗专辑');
      expect(playlist.tracks.single.meta.albumId, 'ALBUM-901');
      expect(
        playlist.tracks.single.meta.picUrl,
        'https://img.test/480/kg-song.jpg',
      );
      expect(playlist.tracks.single.meta.qualitys.map((item) => item.type), [
        Quality.k128,
        Quality.k320,
        Quality.flac,
      ]);
    });

    test('falls back to Kugou global collection detail API', () async {
      final requestedUrls = <String>[];

      final playlist = await KgPlaylistAdapter.parse(
        '2003',
        jsonLoader: (url, {headers}) {
          requestedUrls.add(url);
          return _kugouGlobalFallbackFixture(url, headers: headers);
        },
        jsonPoster: _kugouDetailPoster,
      );

      expect(playlist.id, 'collection_3_509005732_35_0');
      expect(playlist.name, '酷狗新版详情');
      expect(playlist.creator, '新版作者');
      expect(playlist.totalTracks, 1);
      expect(playlist.tracks.single.name, '酷狗歌曲');
      expect(playlist.tracks.single.meta.hash, 'DETAILHASH');
      expect(
        requestedUrls.any((url) => url.contains('/api/v5/special/info?')),
        isTrue,
      );
      expect(
        requestedUrls.any(
          (url) =>
              url.contains('/api/v5/special/info_v2') &&
              Uri.parse(url).queryParameters.containsKey('signature'),
        ),
        isTrue,
      );
      expect(
        requestedUrls.any(
          (url) =>
              url.contains('/api/v5/special/song_v2') &&
              Uri.parse(url).queryParameters.containsKey('signature'),
        ),
        isTrue,
      );
    });

    test('decodes Kugou gcid songlist links before loading detail', () async {
      final requestedPosts = <String>[];

      final playlist = await KgPlaylistAdapter.parse(
        'gcid:gcid_3z9ly0fxznz0d1',
        jsonLoader: _kugouGlobalFallbackFixture,
        jsonPoster: (url, {headers, body}) {
          requestedPosts.add(url);
          return _kugouGcidPoster(url, headers: headers, body: body);
        },
      );

      expect(playlist.id, 'collection_3_509005732_23_0');
      expect(playlist.name, '酷狗新版详情');
      expect(playlist.tracks.single.name, '酷狗歌曲');
      expect(
        requestedPosts.any(
          (url) =>
              url.contains('/v1/songlist/batch_decode') &&
              Uri.parse(url).queryParameters.containsKey('signature'),
        ),
        isTrue,
      );
    });

    test('keeps Kugou base fields when detail metadata is partial', () async {
      final playlist = await KgPlaylistAdapter.parse(
        'global:collection_3_509005732_23_0',
        jsonLoader: _kugouGlobalFallbackFixture,
        jsonPoster: _kugouPartialDetailPoster,
      );

      expect(playlist.totalTracks, 1);
      expect(playlist.tracks.single.name, '酷狗补全标题');
      expect(playlist.tracks.single.meta.hash, 'BASEHASH');
      expect(playlist.tracks.single.meta.songId, 301);
    });

    test('continues Kugou pagination when the total is unknown', () async {
      final requestedPages = <int>[];

      final playlist = await KgPlaylistAdapter.parse(
        '2002',
        jsonLoader: (url, {headers}) async {
          if (url.contains('/special/info')) {
            return {
              'status': 1,
              'data': {'specialname': '未知总数歌单'},
            };
          }
          final page = int.parse(Uri.parse(url).queryParameters['page']!);
          requestedPages.add(page);
          final count = page == 1 ? 30 : 1;
          return {
            'status': 1,
            'data': {
              'info': [
                for (var index = 0; index < count; index++)
                  {
                    'audio_id': (page - 1) * 30 + index + 1,
                    'hash': 'HASH-$page-$index',
                    'songname': '歌曲 ${((page - 1) * 30) + index + 1}',
                    'duration': 180,
                    'filesize': 3145728,
                  },
              ],
            },
          };
        },
        jsonPoster: (_, {headers, body}) async => {
          'error_code': 1,
          'data': const [],
        },
      );

      expect(requestedPages, [1, 2]);
      expect(playlist.tracks, hasLength(31));
      expect(playlist.trackCount, 31);
    });

    test('maps Migu metadata, copyright fields and qualities', () async {
      final playlist = await MgPlaylistAdapter.parse(
        '5001',
        jsonLoader: _miguDetailFixture,
      );

      expect(playlist.name, '咪咕详情');
      expect(playlist.coverUrl, 'https://img.test/mg-detail.jpg');
      expect(playlist.tracks.single.id, 'mg_501');
      expect(playlist.tracks.single.singer, '咪咕歌手');
      expect(playlist.tracks.single.meta.copyrightId, 'COPY-501');
      expect(playlist.tracks.single.meta.qualitys.map((item) => item.type), [
        Quality.k128,
        Quality.flac,
        Quality.flac24bit,
      ]);
    });
  });
}

Future<dynamic> _catalogFixture(
  String url, {
  Map<String, String>? headers,
}) async {
  if (url.contains('kuwo.cn')) {
    return {
      'code': 200,
      'data': {
        'data': [
          {
            'id': 1001,
            'name': '酷我热门',
            'img': 'http://img1.kwcdn.kuwo.cn/star/userpl2015/kw.jpg',
            'uname': '酷我编辑',
            'desc': '酷我简介',
            'total': 31,
            'listencnt': 9001,
          },
          {'id': 1001, 'name': '重复项'},
        ],
      },
    };
  }
  if (url.contains('kugou.com')) {
    return {
      'status': 1,
      'special_db': [
        {
          'specialid': 2001,
          'specialname': '酷狗精选',
          'img': 'http://img.test/{size}/kg-real.jpg',
          'imgurl': '',
          'nickname': '酷狗编辑',
          'intro': '酷狗简介',
          'songcount': 22,
          'playcount': 8002,
        },
      ],
    };
  }
  if (url.contains('y.qq.com')) {
    return {
      'code': 0,
      'playlist': {
        'code': 0,
        'data': {
          'v_playlist': [
            {
              'tid': 3001,
              'title': 'QQ 广场',
              'cover_url_medium': 'https://img.test/qq.jpg',
              'creator_info': {'nick': 'QQ 编辑'},
              'desc': 'QQ 简介',
              'song_ids': [1, 2],
              'access_num': 7003,
            },
          ],
        },
      },
    };
  }
  if (url.contains('music.163.com')) {
    return {
      'code': 200,
      'playlists': [
        {
          'id': 4001,
          'name': '网易云精品',
          'coverImgUrl': 'https://img.test/wy.jpg',
          'creator': {'nickname': '网易云编辑'},
          'description': '网易云简介',
          'trackCount': 44,
          'playCount': 6004,
        },
      ],
    };
  }
  if (url.contains('migu.cn')) {
    return {
      'code': '000000',
      'data': {
        'contents': [
          {
            'resType': '2021',
            'resId': '5001',
            'txt': '咪咕推荐',
            'txt2': '咪咕简介',
            'img': 'https://img.test/mg.jpg',
          },
        ],
      },
    };
  }
  throw StateError('Unexpected catalog URL: $url');
}

Future<dynamic> _kuwoDetailFixture(
  String url, {
  Map<String, String>? headers,
}) async {
  return {
    'result': 'ok',
    'total': 1,
    'title': '酷我详情',
    'pic': 'http://img.test/kw-detail.jpg',
    'uname': '酷我作者',
    'info': '酷我详情简介',
    'playcnt': 3456,
    'musiclist': [
      {
        'id': 101,
        'name': '酷我歌曲',
        'artist': '酷我歌手',
        'duration': 210,
        'album': '酷我专辑',
        // Real pl.svc responses carry an empty-string musicPic; the adapter
        // must skip it and fall through to albumpic.
        'musicPic': '',
        'albumpic': 'http://img3.kuwo.cn/star/albumcover/120/kw-song.jpg',
        'N_MINFO':
            'level:lossless,bitrate:2000,format:flac,size:24.96Mb;'
            'level:high,bitrate:320,format:mp3,size:9.16Mb',
      },
    ],
  };
}

Future<dynamic> _kugouDetailFixture(
  String url, {
  Map<String, String>? headers,
}) async {
  if (url.contains('/special/info')) {
    return {
      'status': 1,
      'data': {
        'specialname': '酷狗详情',
        'songcount': 1,
        'imgurl': 'http://img.test/{size}/kg-detail.jpg',
        'nickname': '酷狗作者',
        'intro': '酷狗详情简介',
        'playcount': 7654,
      },
    };
  }
  return {
    'status': 1,
    'data': {
      'total': 1,
      'info': [
        {
          'audio_id': 301,
          'hash': 'BASEHASH',
          'songname': '酷狗歌曲',
          'singername': '酷狗歌手',
          'duration': 180,
          'filesize': 3145728,
          '320filesize': 6291456,
          '320hash': 'HASH320',
          'sqfilesize': 12582912,
          'sqhash': 'HASHFLAC',
        },
      ],
    },
  };
}

Future<dynamic> _kugouDetailPoster(
  String url, {
  Map<String, String>? headers,
  Object? body,
}) async {
  expect(url, contains('/v3/album_audio/audio'));
  expect(headers, containsPair('x-router', 'kmr.service.kugou.com'));
  expect(body, isA<Map>());
  return {
    'error_code': 0,
    'data': [
      [
        {
          'author_name': '酷狗歌手',
          'songname': '酷狗歌曲',
          'album_info': {
            'album_id': 'ALBUM-901',
            'album_name': '酷狗专辑',
            'sizable_cover': 'http://img.test/{size}/kg-song.jpg',
          },
          'audio_info': {
            'audio_id': '901',
            'hash': 'DETAILHASH',
            'filesize': '3145728',
            'hash_320': 'DETAIL320',
            'filesize_320': '6291456',
            'hash_flac': 'DETAILFLAC',
            'filesize_flac': '12582912',
            'hash_high': '',
            'filesize_high': '0',
            'timelength': '180000',
          },
        },
      ],
    ],
  };
}

Future<dynamic> _kugouGcidPoster(
  String url, {
  Map<String, String>? headers,
  Object? body,
}) async {
  if (url.contains('/v1/songlist/batch_decode')) {
    expect(body, contains('gcid_3z9ly0fxznz0d1'));
    return {
      'status': 1,
      'err_code': 0,
      'data': {
        'list': [
          {'global_collection_id': 'collection_3_509005732_23_0'},
        ],
      },
    };
  }
  return _kugouDetailPoster(url, headers: headers, body: body);
}

Future<dynamic> _kugouPartialDetailPoster(
  String url, {
  Map<String, String>? headers,
  Object? body,
}) async {
  return {
    'error_code': 0,
    'data': [
      [
        {
          'songname': '酷狗补全标题',
          'album_info': {'album_name': '补全专辑'},
        },
      ],
    ],
  };
}

Future<dynamic> _kugouGlobalFallbackFixture(
  String url, {
  Map<String, String>? headers,
}) async {
  if (url.contains('/api/v3/special/info')) {
    return {'status': 1};
  }
  if (url.contains('/api/v5/special/info?')) {
    return {
      'status': 1,
      'errcode': 0,
      'data': {'global_specialid': 'collection_3_509005732_35_0'},
    };
  }
  if (url.contains('/api/v5/special/info_v2')) {
    return {
      'status': 1,
      'errcode': 0,
      'data': {
        'global_specialid': Uri.parse(url).queryParameters['global_specialid'],
        'specialname': '酷狗新版详情',
        'songcount': 1,
        'imgurl': 'http://img.test/{size}/kg-global.jpg',
        'nickname': '新版作者',
        'intro': '新版详情简介',
        'playcount': 9876,
      },
    };
  }
  if (url.contains('/api/v5/special/song_v2')) {
    return {
      'status': 1,
      'errcode': 0,
      'data': {
        'total': 1,
        'info': [
          {
            'audio_id': 301,
            'hash': 'BASEHASH',
            'songname': '酷狗歌曲',
            'singername': '酷狗歌手',
            'duration': 180,
            'filesize': 3145728,
          },
        ],
      },
    };
  }
  throw StateError('Unexpected Kugou global URL: $url');
}

Future<dynamic> _miguDetailFixture(
  String url, {
  Map<String, String>? headers,
}) async {
  if (url.contains('/playlist/v2.0')) {
    return {
      'code': '000000',
      'data': {
        'title': '咪咕详情',
        'ownerName': '咪咕作者',
        'summary': '咪咕详情简介',
        'imgItem': {'img': 'http://img.test/mg-detail.jpg'},
        'opNumItem': {'playNum': 4567},
      },
    };
  }
  return {
    'code': '000000',
    'data': {
      'totalCount': 1,
      'songList': [
        {
          'songId': 501,
          'copyrightId': 'COPY-501',
          'songName': '咪咕歌曲',
          'singerList': [
            {'name': '咪咕歌手'},
          ],
          'duration': 240,
          'audioFormats': [
            {'formatType': 'PQ', 'size': 3145728},
            {'formatType': 'SQ', 'size': 12582912},
            {'formatType': 'ZQ24', 'size': 25165824},
          ],
        },
      ],
    },
  };
}
