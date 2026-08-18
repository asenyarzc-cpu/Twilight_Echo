import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import '../services/app_logger.dart';
import 'internal/builders.dart';
import 'internal/crypto_util.dart';
import 'internal/format.dart';
import 'internal/qrc.dart';
import 'internal/sdk_http.dart';
import 'internal/tx_lyric_routing.dart';
import 'internal/tx_qrc_lyric.dart';
import 'internal/tx_quality.dart';

class TxSdk {
  TxSdk._();

  static const _part1 = [23, 14, 6, 36, 16, 40, 7, 19];
  static const _part2 = [16, 1, 32, 12, 19, 27, 8, 5];
  static const _scramble = [
    89,
    39,
    179,
    150,
    218,
    82,
    58,
    252,
    177,
    52,
    186,
    123,
    120,
    64,
    242,
    133,
    143,
    161,
    121,
    179,
  ];

  static const _qqHeaders = {
    'Referer': 'https://y.qq.com/portal/player.html',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 '
        'Chrome/86 Safari/537.36',
  };

  // Reproduces the zzcSign helper from src/musicSdk/tx.ts: SHA-1 of the JSON
  // body, then mix a few hex chars with XOR'd "scrambleValues" base64-stripped
  // into a "zzc<part1><b64><part2>" string (lowercased).
  //
  // Out-of-range indexes (part1 includes 40, hash is only 40 chars long) are
  // skipped — this matches Node's silent `hash[40] === undefined` behavior
  // which the server relies on. Dart would otherwise throw RangeError.
  static String _zzcSign(String text) {
    final hash = CryptoUtil.sha1Hex(text);
    String pick(List<int> indexes) =>
        indexes.map((i) => i < hash.length ? hash[i] : '').join();
    final scrambled = Uint8List(_scramble.length);
    for (var i = 0; i < _scramble.length; i++) {
      final pair = hash.substring(i * 2, i * 2 + 2);
      scrambled[i] = _scramble[i] ^ int.parse(pair, radix: 16);
    }
    final b64 = base64.encode(scrambled).replaceAll(RegExp(r'[\\/+=]'), '');
    return 'zzc${pick(_part1)}$b64${pick(_part2)}'.toLowerCase();
  }

  static Future<Map> _doSearchRequest(
    String keyword,
    int page,
    int limit, [
    int retry = 0,
  ]) async {
    final data = {
      'comm': {
        'ct': '11',
        'cv': '14090508',
        'v': '14090508',
        'tmeAppID': 'qqmusic',
        'phonetype': 'EBG-AN10',
        'deviceScore': '553.47',
        'devicelevel': '50',
        'newdevicelevel': '20',
        'rom': 'HuaWei/EMOTION/EmotionUI_14.2.0',
        'os_ver': '12',
        'OpenUDID': '0',
        'OpenUDID2': '0',
        'QIMEI36': '0',
        'udid': '0',
        'chid': '0',
        'aid': '0',
        'oaid': '0',
        'taid': '0',
        'tid': '0',
        'wid': '0',
        'uid': '0',
        'sid': '0',
        'modeSwitch': '6',
        'teenMode': '0',
        'ui_mode': '2',
        'nettype': '1020',
        'v4ip': '',
      },
      'req': {
        'module': 'music.search.SearchCgiService',
        'method': 'DoSearchForQQMusicMobile',
        'param': {
          'search_type': 0,
          'searchid': Random().nextInt(1 << 32).toString(),
          'query': keyword,
          'page_num': page,
          'num_per_page': limit,
          'highlight': 0,
          'nqc_flag': 0,
          'multi_zhida': 0,
          'cat': 2,
          'grp': 1,
          'sin': 0,
          'sem': 0,
        },
      },
    };
    final jsonBody = jsonEncode(data);
    final sign = _zzcSign(jsonBody);
    final result = await SdkHttp.fetch<dynamic>(
      'https://u.y.qq.com/cgi-bin/musics.fcg?sign=$sign',
      method: 'POST',
      headers: const {'User-Agent': 'QQMusic 14090508(android 12)'},
      body: data,
    );
    // TX returns Content-Type text/html for this endpoint, so Dio leaves the
    // body as a String — decode it manually before structural checks.
    var body = result.body;
    if (body is String) {
      try {
        body = jsonDecode(body);
      } catch (_) {
        // fall through to retry on parse failure
      }
    }
    final reqNode = body is Map ? body['req'] : null;
    final reqCode = reqNode is Map ? reqNode['code'] : null;
    if (body is! Map || body['code'] != 0 || reqCode != 0) {
      if (retry < 8) {
        await Future<void>.delayed(
          Duration(milliseconds: (250 * (retry + 1)).clamp(0, 1500)),
        );
        return _doSearchRequest(keyword, page, limit, retry + 1);
      }
      throw Exception('tx search failed (http=${result.statusCode})');
    }
    return body['req']['data'] as Map;
  }

  static Future<List<MusicInfo>> search(
    String keyword, {
    int page = 1,
    int limit = 50,
  }) async {
    final data = await _doSearchRequest(keyword, page, limit);
    final dataBody = (data['body'] ?? data) as Map? ?? const {};
    final rawList =
        (dataBody['item_song'] ?? dataBody['song']?['list'] ?? const [])
            as List;
    final out = <MusicInfo>[];
    for (final item in rawList) {
      if (item is! Map) continue;
      final file = item['file'];
      if (file is! Map || file['media_mid'] == null) continue;
      final qualities = parseTxQualityOptions(
        fileData: file,
        versions: item['vs'],
      );
      final albumMid = (item['album'] as Map?)?['mid']?.toString() ?? '';
      out.add(
        buildMusicInfo(
          name: (item['title'] ?? item['name'])?.toString() ?? '',
          singer: formatSingerName(item['singer']),
          source: MusicSource.tx,
          songId: item['mid'],
          qualitys: qualities,
          interval: formatPlayTime(
            num.tryParse(item['interval']?.toString() ?? '0') ?? 0,
          ),
          albumName: (item['album'] as Map?)?['name']?.toString() ?? '',
          albumId: albumMid,
          picUrl: albumMid.isNotEmpty
              ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000$albumMid.jpg'
              : null,
          strMediaMid: file['media_mid']?.toString(),
          metaId: item['id'],
          albumMid: albumMid,
        ),
      );
    }
    return out;
  }

  static Future<List<String>> tip(String keyword) async {
    final url =
        'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?is_xml=0&format=json'
        '&key=${Uri.encodeComponent(keyword)}&loginUin=0&hostUin=0&inCharset=utf8'
        '&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0';
    final body = await SdkHttp.getJson(
      url,
      headers: const {'Referer': 'https://y.qq.com/portal/player.html'},
    );
    if (body is! Map || body['code'] != 0) throw Exception('tx tip failed');
    final list = body['data']?['song']?['itemlist'];
    if (list is! List) return const [];
    return list
        .map(
          (item) => item is Map
              ? '${item['name'] ?? ''} - ${item['singer'] ?? ''}'.trim()
              : '',
        )
        .where((v) => v.isNotEmpty && v != '-')
        .toList();
  }

  static Future<String?> getPicUrl(MusicInfo info) async {
    final albumMid = info.meta.albumMid;
    if (albumMid == null || albumMid.isEmpty) return null;
    return 'https://y.gtimg.cn/music/photo_new/T002R500x500M000$albumMid.jpg';
  }

  // Prefer PlayLyricInfo/QRC because it is the QQ Music path that carries
  // word-level timing. Fall back to the legacy line-level LRC endpoint when
  // the numeric songID is unavailable or the QRC payload is not usable.
  static Future<LyricInfo> getLyric(MusicInfo info) async {
    final songId = _resolveIntegerSongId(info);
    if (songId != null) {
      try {
        final viaQrc = await _getLyricViaPlayLyricInfo(songId);
        if (viaQrc != null) return viaQrc;
      } catch (e) {
        await AppLogger.write(
          'tx.lyric',
          'PlayLyricInfo failed: $e (fallback to legacy)',
        );
      }
    } else {
      await AppLogger.write(
        'tx.lyric',
        'no integer songID on meta — using legacy endpoint (no translation/roma)',
      );
    }
    return _getLyricLegacy(info);
  }

  static int? _resolveIntegerSongId(MusicInfo info) {
    return txResolveIntegerSongId(info);
  }

  static Future<LyricInfo?> _getLyricViaPlayLyricInfo(int songId) async {
    // `crypt: 1` gives QRC hex for the main lyric. `crypt: 0` is only a
    // secondary line-level fallback before the older fcg_query_lyric_new path.
    final c1 = await _callPlayLyricInfo(songId, crypt: 1);
    Map? c0;
    if (c1 == null || (c1['lyric']?.toString().isEmpty ?? true)) {
      c0 = await _callPlayLyricInfo(songId, crypt: 0);
    }

    final rawLyric1 = c1?['lyric']?.toString() ?? '';
    final rawTrans1 = c1?['trans']?.toString() ?? '';
    final rawRoma1 = c1?['roma']?.toString() ?? '';
    final rawLyric0 = c0?['lyric']?.toString() ?? '';
    final rawTrans0 = c0?['trans']?.toString() ?? '';

    await AppLogger.write(
      'tx.lyric',
      'PlayLyricInfo songID=$songId '
          'c1.lyric.len=${rawLyric1.length} c1.trans.len=${rawTrans1.length} '
          'c1.roma.len=${rawRoma1.length} '
          'c0.lyric.len=${rawLyric0.length} c0.trans.len=${rawTrans0.length}',
    );

    // Prefer crypt:1 QRC content (carries word-level timings); fall back to
    // crypt:0 base64/plain content if QRC didn't yield anything.
    final lyricRaw =
        _maybeDecrypt(rawLyric1, 'lyric.c1') ??
        _maybeDecrypt(rawLyric0, 'lyric.c0');
    if (lyricRaw == null || lyricRaw.isEmpty) return null;

    final lyricBody = _extractLyricContent(lyricRaw);
    String mainLyric;
    String? lxLyric;
    final hasWordTiming = lyricBody.contains(
      RegExp(r'^\[\d+,\d+\].+\(\d+,\d+\)', multiLine: true),
    );
    if (hasWordTiming) {
      final parsed = TxQrcLyric.parseQrcLyric(lyricBody);
      mainLyric = parsed.lyric;
      lxLyric = parsed.lxlyric.isEmpty ? null : parsed.lxlyric;
    } else {
      mainLyric = lyricBody.replaceAll('\r', '').trim();
      lxLyric = null;
    }

    // Translation: crypt:1 QRC decrypts to plain LRC (no XML wrapper);
    // crypt:0 trans is base64 plain LRC. Either way, TX uses centisecond
    // precision for trans while the main lyric (from QRC) is millisecond-
    // precise — so we re-align trans timestamps to main's exact labels.
    final transRaw =
        _maybeDecrypt(rawTrans1, 'trans.c1') ??
        _maybeDecrypt(rawTrans0, 'trans.c0');
    String? trans;
    if (transRaw != null && transRaw.isNotEmpty) {
      final transText = transRaw.replaceAll('\r', '').trim();
      final aligned = TxQrcLyric.alignTimestamps(transText, mainLyric);
      trans = aligned.isEmpty ? transText : aligned;
    }

    // Roma is only available via crypt:1. Same XML-wrapped QRC shape as
    // lyric, with the same per-line ms timestamps as main — but the FIRST
    // line is sometimes off by ~1ms, so we align defensively too.
    final romaRaw = _maybeDecrypt(rawRoma1, 'roma.c1');
    String? roma;
    if (romaRaw != null && romaRaw.isNotEmpty) {
      final romaBody = _extractLyricContent(romaRaw);
      String parsed;
      if (romaBody.contains(RegExp(r'^\[\d+,\d+\]', multiLine: true))) {
        parsed = TxQrcLyric.parseQrcRoma(romaBody);
      } else {
        parsed = romaBody.replaceAll('\r', '').trim();
      }
      final aligned = TxQrcLyric.alignTimestamps(parsed, mainLyric);
      roma = aligned.isEmpty ? parsed : aligned;
    }

    return LyricInfo(
      lyric: mainLyric,
      tlyric: (trans != null && trans.isNotEmpty) ? trans : null,
      rlyric: (roma != null && roma.isNotEmpty) ? roma : null,
      lxlyric: lxLyric,
    );
  }

  static String _extractLyricContent(String raw) {
    return txExtractLyricContent(raw);
  }

  static Future<Map?> _callPlayLyricInfo(
    int songId, {
    required int crypt,
  }) async {
    try {
      final body = await SdkHttp.fetch<dynamic>(
        'https://u.y.qq.com/cgi-bin/musicu.fcg',
        method: 'POST',
        headers: _qqHeaders,
        body: {
          'comm': {
            'ct': 24,
            'cv': 4747474,
            'format': 'json',
            'inCharset': 'utf-8',
            'outCharset': 'utf-8',
            'notice': 0,
            'platform': 'yqq.json',
            'needNewCode': 1,
            'uin': 0,
            'g_tk_new_20200303': 5381,
            'g_tk': 5381,
          },
          'request': {
            'module': 'music.musichallSong.PlayLyricInfo',
            'method': 'GetPlayLyricInfo',
            'param': {
              'songID': songId,
              'qrc': crypt,
              'crypt': crypt,
              'trans': 1,
              'roma': 1,
            },
          },
        },
      );
      var raw = body.body;
      if (raw is String) {
        try {
          raw = jsonDecode(raw);
        } catch (_) {}
      }
      if (raw is! Map) return null;
      final req = raw['request'] ?? raw['req'];
      if (req is! Map || req['code'] != 0) return null;
      final data = req['data'];
      return data is Map ? data : null;
    } catch (e) {
      await AppLogger.write(
        'tx.lyric',
        'PlayLyricInfo crypt=$crypt request FAIL: $e',
      );
      return null;
    }
  }

  // Decides between base64 plain text vs hex-QRC per field. Either is
  // accepted because the server's behaviour around `crypt: 0` differs by
  // song. For QRC: we attempt decryption with the public algorithm variants
  // but it currently doesn't match what TX uses for roma (the canonical
  // implementation lives in a closed-source binary), so a failure here just
  // means we skip that field rather than abort the lyric pipeline.
  static String? _maybeDecrypt(String raw, String fieldName) {
    if (raw.isEmpty) return null;
    if (_looksLikeHex(raw)) {
      try {
        return QrcDecoder.decrypt(raw);
      } catch (_) {
        // No public QRC algorithm matches TX's current encryption — silently
        // drop this field instead of throwing or logging on every download.
        return null;
      }
    }
    // Either already-plain text (starts with `[`) or base64-encoded plain text.
    final trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.contains('\n')) return trimmed;
    try {
      return utf8.decode(base64.decode(trimmed), allowMalformed: true);
    } catch (_) {
      return trimmed;
    }
  }

  static bool _looksLikeHex(String s) {
    final clean = s.replaceAll(RegExp(r'\s'), '');
    return clean.length.isEven &&
        clean.length > 16 &&
        RegExp(r'^[0-9a-fA-F]+$').hasMatch(clean);
  }

  static Future<LyricInfo> _getLyricLegacy(MusicInfo info) async {
    final body = await SdkHttp.getJson(
      'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?'
      'songmid=${info.meta.songId}&g_tk=5381&loginUin=0&hostUin=0'
      '&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq',
      headers: _qqHeaders,
    );
    if (body is! Map || body['code'] != 0 || body['lyric'] == null) {
      throw Exception('tx lyric failed');
    }
    return LyricInfo(
      lyric: utf8.decode(base64.decode(body['lyric'].toString())),
      tlyric: body['trans'] != null
          ? utf8.decode(base64.decode(body['trans'].toString()))
          : null,
    );
  }
}
