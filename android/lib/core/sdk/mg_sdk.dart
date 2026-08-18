import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import 'internal/builders.dart';
import 'internal/crypto_util.dart';
import 'internal/format.dart';
import 'internal/sdk_http.dart';

class MgSdk {
  const MgSdk._();

  static const _deviceId = '963B7AA0D21511ED807EE5846EC87D20';
  static const _signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73';
  static const _qualityMap = {
    'PQ': Quality.k128,
    'HQ': Quality.k320,
    'SQ': Quality.flac,
    'ZQ24': Quality.flac24bit,
  };

  static Map<String, String> _signHeaders(String time, String keyword) {
    final sign = CryptoUtil.md5Hex(
      '$keyword${_signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50$_deviceId$time',
    );
    return {
      'uiVersion': 'A_music_3.6.1',
      'deviceId': _deviceId,
      'timestamp': time,
      'sign': sign,
      'channel': '0146921',
      'User-Agent':
          'Mozilla/5.0 (Linux; Android 11.0.0) AppleWebKit/534.30 '
          'Mobile Safari/534.30',
    };
  }

  static Future<List<MusicInfo>> search(
    String keyword, {
    int page = 1,
    int limit = 20,
  }) async {
    final time = DateTime.now().millisecondsSinceEpoch.toString();
    final url =
        'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0'
        '&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C'
        '%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C'
        '%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D'
        '&pageSize=$limit&text=${Uri.encodeComponent(keyword)}&pageNo=$page'
        '&sort=0&sid=USS';
    final body = await SdkHttp.getJson(
      url,
      headers: _signHeaders(time, keyword),
    );
    if (body is! Map || body['code'] != '000000') {
      throw Exception(
        body is Map
            ? (body['info']?.toString() ?? 'mg search failed')
            : 'mg search failed',
      );
    }
    final result = body['songResultData'] as Map? ?? const {};
    final seen = <String>{};
    final out = <MusicInfo>[];
    for (final group in (result['resultList'] as List? ?? const [])) {
      if (group is! List) continue;
      for (final data in group) {
        if (data is! Map) continue;
        final songId = data['songId'];
        final copyrightId = data['copyrightId']?.toString();
        if (songId == null ||
            copyrightId == null ||
            seen.contains(copyrightId)) {
          continue;
        }
        seen.add(copyrightId);
        final qualities = <QualityOption>[];
        for (final fmt in (data['audioFormats'] as List? ?? const [])) {
          if (fmt is! Map) continue;
          final type = _qualityMap[fmt['formatType']?.toString()];
          if (type == null) continue;
          final size = sizeFormat(fmt['asize'] ?? fmt['isize']);
          qualities.add(QualityOption(type: type, size: size));
        }
        var img =
            (data['img3'] ?? data['img2'] ?? data['img1'])?.toString() ?? '';
        if (img.isNotEmpty && !RegExp(r'^https?:').hasMatch(img)) {
          img = 'http://d.musicapp.migu.cn$img';
        }
        out.add(
          buildMusicInfo(
            name: data['name']?.toString() ?? '',
            singer: formatSingerName(data['singerList']),
            source: MusicSource.mg,
            songId: songId,
            qualitys: qualities,
            interval: formatPlayTime(
              num.tryParse(data['duration']?.toString() ?? '0') ?? 0,
            ),
            albumName: data['album']?.toString() ?? '',
            albumId: data['albumId'],
            picUrl: img,
            copyrightId: copyrightId,
            lrcUrl: data['lrcUrl']?.toString(),
            mrcUrl: data['mrcurl']?.toString(),
            trcUrl: data['trcUrl']?.toString(),
          ),
        );
      }
    }
    return out;
  }

  static Future<List<String>> tip(String keyword) async {
    final url =
        'https://app.u.nf.migu.cn/pc/resource/content/tone_search_suggest/v1.0'
        '?text=${Uri.encodeComponent(keyword)}';
    final body = await SdkHttp.getJson(
      url,
      headers: const {'Referer': 'https://music.migu.cn/v5/'},
    );
    if (body is! Map || body['code'] != '000000') {
      throw Exception('mg tip failed');
    }
    final data = body['data'];
    if (data is! Map) throw Exception('mg tip failed');
    final out = <String>[];
    final seen = <String>{};
    void add(Object? raw) {
      if (raw is! String) return;
      final value = raw.trim();
      if (value.isEmpty || !seen.add(value)) return;
      out.add(value);
    }

    for (final s in (data['singerList'] as List? ?? const [])) {
      if (s is Map) add(s['singerName']);
    }
    for (final s in (data['songList'] as List? ?? const [])) {
      if (s is Map) add(s['songName']);
    }
    return out;
  }

  static Future<String?> getPicUrl(MusicInfo info) async {
    final body = await SdkHttp.getJson(
      'http://music.migu.cn/v3/api/music/audioPlayer/getSongPic?songId=${info.meta.songId}',
      headers: const {
        'Referer': 'http://music.migu.cn/v3/music/player/audio?from=migu',
      },
    );
    if (body is! Map) return null;
    var url = (body['largePic'] ?? body['mediumPic'] ?? body['smallPic'])
        ?.toString();
    if (url == null || url.isEmpty) return null;
    if (!RegExp(r'^https?:').hasMatch(url)) url = 'http:$url';
    return url;
  }

  static Future<LyricInfo> getLyric(MusicInfo info) async {
    final lrcUrl = info.meta.lrcUrl;
    if (lrcUrl == null || lrcUrl.isEmpty) throw Exception('mg lyric failed');
    final lyric = await SdkHttp.getText(
      lrcUrl,
      headers: const {
        'Referer': 'https://app.c.nf.migu.cn/',
        'User-Agent':
            'Mozilla/5.0 (Linux; Android 5.1.1) AppleWebKit/537.36 Mobile Safari/537.36',
        'channel': '0146921',
      },
    );
    String? tlyric;
    if (info.meta.trcUrl != null && info.meta.trcUrl!.isNotEmpty) {
      try {
        tlyric = await SdkHttp.getText(info.meta.trcUrl!);
      } catch (_) {}
    }
    return LyricInfo(lyric: lyric, tlyric: tlyric);
  }
}
