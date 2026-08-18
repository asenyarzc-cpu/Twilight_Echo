import 'dart:convert';
import 'dart:typed_data';

import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import 'internal/builders.dart';
import 'internal/crypto_util.dart';
import 'internal/format.dart';
import 'internal/sdk_http.dart';
import 'internal/wy_quality.dart';
import 'internal/wy_yrc.dart';

class WySdk {
  WySdk._();

  // EAPI uses an AES-128-ECB key fixed in the desktop client.
  static final Uint8List _eapiKey = Uint8List.fromList(
    utf8.encode('e82ckenh8dichen8'),
  );

  // WEAPI: AES-128-CBC with a fixed IV + preset key, then AES-128-CBC again
  // with a random base62 key, then RSA-1024 no-padding of (reverse(randomKey)).
  // The RSA public key from the desktop client; precomputed n / e to skip PEM
  // parsing at runtime. Source: src/musicSdk/wy.ts.
  static final Uint8List _weapiIv = Uint8List.fromList(
    utf8.encode('0102030405060708'),
  );
  static final Uint8List _weapiPresetKey = Uint8List.fromList(
    utf8.encode('0CoJUm6Qyw8W8jud'),
  );
  static final BigInt _weapiModulus = BigInt.parse(
    'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
    radix: 16,
  );
  static final BigInt _weapiExponent = BigInt.from(0x10001);

  static const _wyUserAgent =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/60.0.3112.90 Safari/537.36';

  static const _wyDetailUserAgent =
      'NeteaseMusic/9.1.40.250128161425(9001040);Dalvik/2.1.0 '
      '(Linux; U; Android 14)';

  static String? _normalizePicUrl(String? raw, {bool sized = false}) {
    if (raw == null || raw.isEmpty) return raw;
    var url =
        raw.startsWith('http://music.126.net') ||
            raw.startsWith('http://p1.music.126.net') ||
            raw.startsWith('http://p2.music.126.net') ||
            raw.startsWith('http://p3.music.126.net') ||
            raw.startsWith('http://p4.music.126.net')
        ? raw.replaceFirst('http://', 'https://')
        : raw;
    if (sized && url.contains('music.126.net')) {
      final separator = url.contains('?') ? '&' : '?';
      url = '$url${separator}param=500y500';
    }
    return url;
  }

  static Map<String, String> _eapi(String path, Object payload) {
    final text = payload is String ? payload : jsonEncode(payload);
    final message = 'nobody${path}use${text}md5forencrypt';
    final digest = CryptoUtil.md5Hex(message);
    final data = '$path-36cd479b6b5-$text-36cd479b6b5-$digest';
    final encrypted = CryptoUtil.aesEncryptEcbPkcs7(
      Uint8List.fromList(utf8.encode(data)),
      _eapiKey,
    );
    return {'params': CryptoUtil.bytesToHex(encrypted, upper: true)};
  }

  static Map<String, String> _weapi(Object payload) {
    final text = payload is String ? payload : jsonEncode(payload);
    // base62 random key — pick 16 bytes from a fixed alphabet (server does
    // `randomBytes(16).map(n => alphabet.charCodeAt(n % 62))`). We pick directly
    // from the alphabet to get the same shape.
    final randomKeyStr = CryptoUtil.randomBase62(16);
    final secretKey = Uint8List.fromList(utf8.encode(randomKeyStr));

    // Inner: AES-CBC(plaintext, presetKey, iv) -> base64
    final inner = CryptoUtil.aesEncryptCbcPkcs7(
      Uint8List.fromList(utf8.encode(text)),
      _weapiPresetKey,
      _weapiIv,
    );
    final innerB64 = base64.encode(inner);

    // Outer: AES-CBC(innerB64, secretKey, iv) -> base64
    final outer = CryptoUtil.aesEncryptCbcPkcs7(
      Uint8List.fromList(utf8.encode(innerB64)),
      secretKey,
      _weapiIv,
    );

    // RSA: reverse(secretKey) zero-padded to 128 bytes, raw modPow.
    final reversed = Uint8List.fromList(secretKey.reversed.toList());
    final padded = Uint8List(128);
    padded.setRange(128 - reversed.length, 128, reversed);
    final rsa = CryptoUtil.rsaNoPadding(padded, _weapiModulus, _weapiExponent);

    return {
      'params': base64.encode(outer),
      'encSecKey': CryptoUtil.bytesToHex(rsa),
    };
  }

  static String _singer(List? list) {
    if (list == null) return '';
    return list
        .map((item) => item is Map ? item['name']?.toString() : null)
        .where((v) => v != null && v.isNotEmpty)
        .join('、');
  }

  static Future<List<MusicInfo>> search(
    String keyword, {
    int page = 1,
    int limit = 30,
  }) async {
    const path = '/api/search/song/list/page';
    final form = _eapi(path, {
      'keyword': keyword,
      'needCorrect': '1',
      'channel': 'typing',
      'offset': limit * (page - 1),
      'scene': 'normal',
      'total': page == 1,
      'limit': limit,
    });

    final result = await SdkHttp.fetch<dynamic>(
      'https://interface.music.163.com/eapi/batch',
      method: 'POST',
      headers: const {
        'User-Agent': _wyUserAgent,
        'origin': 'https://music.163.com',
      },
      form: form,
    );
    final body = _decodeBody(result.body);
    if (body is! Map || body['code'] != 200) {
      throw Exception('wy search failed');
    }
    final resources = (body['data']?['resources'] as List?) ?? const [];
    final songs = <Map>[];
    for (final raw in resources) {
      if (raw is! Map) continue;
      final item = raw['baseInfo']?['simpleSongData'];
      if (item is! Map) continue;
      songs.add(item);
    }

    Map<String, List<QualityOption>> qualityDetails = const {};
    try {
      qualityDetails = await _getQualityDetails(songs);
    } catch (_) {
      // Keep the qualities carried by the search response when the optional
      // batch detail endpoint is unavailable.
    }

    final out = <MusicInfo>[];
    for (final item in songs) {
      final fallback = parseWySearchQualityOptions(item);
      final qualities = mergeWyQualityOptions(
        fallback,
        qualityDetails[item['id']?.toString()] ?? const [],
      );
      out.add(
        buildMusicInfo(
          name: item['name']?.toString() ?? '',
          singer: _singer(item['ar'] as List?),
          source: MusicSource.wy,
          songId: item['id'],
          qualitys: qualities,
          interval: formatPlayTime(
            (num.tryParse(item['dt']?.toString() ?? '0') ?? 0) / 1000,
          ),
          albumName: (item['al'] as Map?)?['name']?.toString() ?? '',
          albumId: (item['al'] as Map?)?['id'],
          picUrl: _normalizePicUrl((item['al'] as Map?)?['picUrl']?.toString()),
        ),
      );
    }
    return out;
  }

  static Future<Map<String, List<QualityOption>>> _getQualityDetails(
    List<Map> songs,
  ) async {
    final payload = buildWyQualityBatchPayload(songs.map((song) => song['id']));
    if (payload.isEmpty) return const {};

    final result = await SdkHttp.fetch<dynamic>(
      'https://interface.music.163.com/eapi/batch',
      method: 'POST',
      headers: const {
        'User-Agent': _wyDetailUserAgent,
        'Cookie': 'os=android; appver=9.1.40;',
      },
      form: _eapi('/api/batch', payload),
    );
    final body = _decodeBody(result.body);
    if (body is! Map || body['code'] != 200) {
      throw Exception('wy quality detail failed');
    }
    return parseWyBatchQualityDetails(body);
  }

  static Future<List<String>> tip(String keyword) async {
    final form = _weapi({'s': keyword});
    final result = await SdkHttp.fetch<dynamic>(
      'https://music.163.com/weapi/search/suggest/web',
      method: 'POST',
      headers: const {
        'Referer': 'https://music.163.com/',
        'Origin': 'https://music.163.com',
      },
      form: form,
    );
    final body = _decodeBody(result.body);
    if (body is! Map || body['code'] != 200) throw Exception('wy tip failed');
    final songs = body['result']?['songs'];
    if (songs is! List) return const [];
    return songs
        .map((item) {
          if (item is! Map) return '';
          final name = item['name']?.toString() ?? '';
          final artists = _singer(item['artists'] as List?);
          return '$name - $artists'.trim();
        })
        .where((v) => v.isNotEmpty && v != '-')
        .toList();
  }

  static Future<String?> getPicUrl(MusicInfo info) async {
    final pic = _normalizePicUrl(info.meta.picUrl, sized: true);
    if (pic != null && pic.isNotEmpty) return pic;
    return null;
  }

  static Future<LyricInfo> getLyric(MusicInfo info) async {
    // `yv=-1` additionally requests the word-timed `yrc` track, which we
    // convert to lxlyric so the player can render karaoke sweeps. Songs
    // without one simply omit the field.
    final body = await SdkHttp.getJson(
      'https://music.163.com/api/song/lyric?id=${info.meta.songId}'
      '&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1',
      headers: const {'Referer': 'https://music.163.com/'},
    );
    if (body is! Map || body['code'] != 200 || body['lrc']?['lyric'] == null) {
      throw Exception('wy lyric failed');
    }
    final yrcRaw = body['yrc']?['lyric']?.toString();
    return LyricInfo(
      lyric: body['lrc']['lyric']?.toString() ?? '',
      tlyric: body['tlyric']?['lyric']?.toString(),
      rlyric: body['romalrc']?['lyric']?.toString(),
      lxlyric: (yrcRaw == null || yrcRaw.isEmpty)
          ? null
          : wyYrcToLxLyric(yrcRaw),
    );
  }

  // wy returns JSON; if our http layer dropped JSON parsing for any reason
  // (e.g. non-application/json content-type), decode manually.
  static dynamic _decodeBody(dynamic raw) {
    if (raw is String) {
      try {
        return jsonDecode(raw);
      } catch (_) {
        return raw;
      }
    }
    return raw;
  }
}
