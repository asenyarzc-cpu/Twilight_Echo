import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:dio/dio.dart' show ResponseType;
import 'package:fast_gbk/fast_gbk.dart';

import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import 'internal/builders.dart';
import 'internal/format.dart';
import 'internal/kw_lyricx.dart';
import 'internal/kw_quality.dart';
import 'internal/sdk_http.dart';

class KwSdk {
  const KwSdk._();

  static String _formatSinger(String name) =>
      decodeName(name).replaceAll('&', '、');

  static Future<List<MusicInfo>> search(
    String keyword, {
    int page = 1,
    int limit = 30,
  }) async {
    final url =
        'https://search.kuwo.cn/r.s?client=kt&all=${Uri.encodeComponent(keyword)}'
        '&pn=${page - 1}&rn=$limit&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1'
        '&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012'
        '&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
    final body = await SdkHttp.getJson(url);
    final rawList = body is Map
        ? (body['abslist'] as List? ?? const [])
        : const [];
    final out = <MusicInfo>[];
    for (final info in rawList) {
      if (info is! Map) continue;
      final musicRid = info['MUSICRID']?.toString();
      final minfo = info['N_MINFO']?.toString();
      if (musicRid == null || musicRid.isEmpty || minfo == null) continue;
      final songId = musicRid.replaceFirst('MUSIC_', '');
      final qualities = parseKwQualityOptions(minfo);
      out.add(
        buildMusicInfo(
          name: decodeName(info['SONGNAME']),
          singer: _formatSinger(decodeName(info['ARTIST'])),
          source: MusicSource.kw,
          songId: songId,
          qualitys: qualities,
          interval: formatPlayTime(
            num.tryParse(info['DURATION']?.toString() ?? '0') ?? 0,
          ),
          albumName: decodeName(info['ALBUM']),
          albumId: info['ALBUMID']?.toString(),
          picUrl: _albumPicUrl(info['web_albumpic_short']?.toString()),
        ),
      );
    }
    return out;
  }

  // Search response includes a relative cover path under `web_albumpic_short`
  // (e.g. "120/s3s94/93/211513640.jpg"). Prefix it with KW's image CDN host so
  // we don't have to hit `artistpicserver.kuwo.cn/pic.web` once per row.
  static String? _albumPicUrl(String? short) {
    if (short == null || short.isEmpty) return null;
    return 'https://img2.kuwo.cn/star/albumcover/$short';
  }

  static Future<List<String>> tip(String keyword) async {
    final url =
        'https://tips.kuwo.cn/t.s?corp=kuwo&newver=3&p2p=1&notrace=0'
        '&c=mbox&w=${Uri.encodeComponent(keyword)}&encoding=utf8&rformat=json';
    final body = await SdkHttp.getJson(
      url,
      headers: const {'Referer': 'https://www.kuwo.cn/'},
    );
    final list = body is Map ? body['WORDITEMS'] : null;
    if (list is! List) throw Exception('kw tip failed');
    return list
        .map((item) => item is Map ? (item['RELWORD']?.toString() ?? '') : '')
        .where((v) => v.isNotEmpty)
        .toList();
  }

  static Future<String?> getPicUrl(MusicInfo info) async {
    final id = info.meta.songId;
    final url =
        'http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic'
        '&pictype=500&size=500&rid=$id';
    final text = await SdkHttp.getText(url);
    return RegExp(r'^https?:').hasMatch(text.trim()) ? text.trim() : null;
  }

  static Future<LyricInfo> getLyric(MusicInfo info) async {
    // Try the lyricx (per-character timed) path first; fall back to the JSON
    // line-level path. Mirrors getKwLyric in musicResource.service.ts.
    try {
      final raw = await _fetchRaw(
        'http://newlyric.kuwo.cn/newlyric.lrc?${_buildParams(info.meta.songId, true)}',
      );
      final text = await _decodeLyric(raw, true);
      final parsed = KwLyricx.parse(text);
      if (RegExp(r'\[\d{1,2}:.*\d{1,4}\]').hasMatch(parsed.lyric)) {
        return parsed;
      }
    } catch (_) {}

    final body = await SdkHttp.getJson(
      'http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${info.meta.songId}',
      headers: const {'Referer': 'http://m.kuwo.cn/'},
    );
    final data = body is Map ? body['data'] : null;
    final list = data is Map ? data['lrclist'] : null;
    if (list is! List || list.isEmpty) throw Exception('kw lyric failed');
    final lyric = list
        .map(
          (item) =>
              item is Map ? '[${item['time']}]${item['lineLyric'] ?? ''}' : '',
        )
        .join('\n');
    return LyricInfo(lyric: lyric);
  }

  // --- kw lyric helpers (XOR with "yeelion" + zlib + GB18030 decode) ---

  static final Uint8List _key = Uint8List.fromList(utf8.encode('yeelion'));

  static String _buildParams(Object songId, bool lyricx) {
    var params =
        'user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_$songId';
    if (lyricx) params += '&lrcx=1';
    final input = Uint8List.fromList(utf8.encode(params));
    final output = Uint8List(input.length);
    var i = 0;
    while (i < input.length) {
      var j = 0;
      while (j < _key.length && i < input.length) {
        output[i] = _key[j] ^ input[i];
        i++;
        j++;
      }
    }
    return base64.encode(output);
  }

  static Future<Uint8List> _fetchRaw(String url) async {
    final result = await SdkHttp.fetch<List<int>>(
      url,
      headers: const {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            'Chrome/120 Safari/537.36',
      },
      responseType: ResponseType.bytes,
    );
    return Uint8List.fromList(result.body);
  }

  static Future<String> _decodeLyric(Uint8List raw, bool lyricx) async {
    final header = String.fromCharCodes(raw.sublist(0, 10));
    if (header != 'tp=content') return '';
    final sep = Uint8List.fromList([13, 10, 13, 10]);
    final start = _indexOfSubsequence(raw, sep);
    if (start < 0) return '';
    final compressed = raw.sublist(start + 4);
    final inflated = Uint8List.fromList(ZLibDecoder().decodeBytes(compressed));
    if (!lyricx) return gbk.decode(inflated);
    final encoded = base64.decode(utf8.decode(inflated));
    final output = Uint8List(encoded.length);
    var i = 0;
    while (i < encoded.length) {
      var j = 0;
      while (j < _key.length && i < encoded.length) {
        output[i] = encoded[i] ^ _key[j];
        i++;
        j++;
      }
    }
    return gbk.decode(output);
  }

  static int _indexOfSubsequence(Uint8List source, Uint8List needle) {
    if (needle.isEmpty) return 0;
    for (var i = 0; i <= source.length - needle.length; i++) {
      var matched = true;
      for (var j = 0; j < needle.length; j++) {
        if (source[i + j] != needle[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return i;
    }
    return -1;
  }
}
