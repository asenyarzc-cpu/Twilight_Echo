import 'dart:convert';

import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import 'internal/builders.dart';
import 'internal/format.dart';
import 'internal/kg_krc.dart';
import 'internal/kg_quality.dart';
import 'internal/sdk_http.dart';

class KgSdk {
  const KgSdk._();

  static const _kgHeaders = {
    'KG-RC': '1',
    'KG-THash': 'expand_search_manager.cpp:852736169:451',
    'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
  };

  static MusicInfo _parseItem(Map raw, {List<QualityOption>? qualities}) {
    return buildMusicInfo(
      name: decodeName(raw['SongName']),
      singer: decodeName(formatSingerName(raw['Singers'])),
      source: MusicSource.kg,
      songId: raw['Audioid'] ?? '',
      qualitys: qualities ?? parseKgSearchQualityOptions(raw),
      interval: formatPlayTime(
        num.tryParse(raw['Duration']?.toString() ?? '0') ?? 0,
      ),
      albumName: decodeName(raw['AlbumName']),
      albumId: raw['AlbumID'],
      hash: raw['FileHash']?.toString(),
      picUrl: _coverFromImage(raw['Image']?.toString()),
    );
  }

  // KG search returns Image like "http://imge.kugou.com/stdmusic/{size}/.../*.jpg"
  // — substitute a concrete size so the URL is directly usable in <img>.
  static String? _coverFromImage(String? template) {
    if (template == null || template.isEmpty) return null;
    return template.replaceAll('{size}', '480');
  }

  static Future<List<MusicInfo>> search(
    String keyword, {
    int page = 1,
    int limit = 30,
  }) async {
    final url =
        'https://songsearch.kugou.com/song_search_v2?keyword=${Uri.encodeComponent(keyword)}'
        '&page=$page&pagesize=$limit&userid=0&clientver=&platform=WebFilter'
        '&filter=2&iscorrection=1&privilege_filter=0&area_code=1';
    final body = await SdkHttp.getJson(url);
    if (body is! Map || body['error_code'] != 0) {
      throw Exception('kg search failed');
    }
    final ids = <String>{};
    final rawItems = <Map>[];
    for (final item in (body['data']?['lists'] as List? ?? const [])) {
      if (item is! Map) continue;
      final candidates = <Map>[
        item,
        ...((item['Grp'] as List? ?? const []).whereType<Map>()),
      ];
      for (final raw in candidates) {
        final key = '${raw['Audioid']}_${raw['FileHash']}';
        if (ids.contains(key)) continue;
        ids.add(key);
        rawItems.add(raw);
      }
    }
    final fallback = [for (final raw in rawItems) _parseItem(raw)];
    final details = await _getQualityDetails(rawItems);
    if (details.isEmpty) return fallback;

    return [
      for (var index = 0; index < rawItems.length; index++)
        _parseItem(
          rawItems[index],
          qualities: mergeKgQualityOptions(
            fallback[index].meta.qualitys,
            details[kgHashKey(rawItems[index]['FileHash'])] ?? const [],
          ),
        ),
    ];
  }

  static Future<Map<String, List<QualityOption>>> _getQualityDetails(
    List<Map> rawItems,
  ) async {
    final resources = <KgPrivilegeResource>[];
    final seen = <String>{};
    for (final raw in rawItems) {
      final hash = kgHashKey(raw['FileHash']);
      if (hash.isEmpty || !seen.add(hash)) continue;
      resources.add(KgPrivilegeResource(hash: hash, albumId: raw['AlbumID']));
    }
    if (resources.isEmpty) return const {};

    final result = <String, List<QualityOption>>{};
    for (
      var start = 0;
      start < resources.length;
      start += kgPrivilegeBatchLimit
    ) {
      final end = (start + kgPrivilegeBatchLimit).clamp(0, resources.length);
      final batch = resources.sublist(start, end);
      try {
        final clientTime = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        final query = <String, String>{
          'appid': '$kgPrivilegeAppId',
          'clientver': '$kgPrivilegeClientVersion',
          'dfid': '-',
          'uuid': '-',
          'mid': '0123456789abcdef0123456789abcdef',
          'clienttime': '$clientTime',
        };
        final body = encodeKgPrivilegeRequestBody(batch);
        final signature = buildKgPrivilegeSignature(query, body);
        final uri = Uri.https(
          'gateway.kugou.com',
          '/v2/get_res_privilege/lite',
          {...query, 'signature': signature},
        );
        final response = await SdkHttp.fetch<dynamic>(
          uri.toString(),
          method: 'POST',
          headers: const {
            'x-router': 'media.store.kugou.com',
            'User-Agent':
                'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
          },
          body: body,
        );
        result.addAll(parseKgPrivilegeQualityDetails(response.body));
      } catch (_) {
        // Quality metadata is an enhancement. Search must still return the
        // four formats embedded in the original search response.
      }
    }
    return result;
  }

  static Future<List<String>> tip(String keyword) async {
    final url =
        'https://searchtip.kugou.com/getSearchTip?MusicTipCount=10&keyword=${Uri.encodeComponent(keyword)}';
    final body = await SdkHttp.getJson(
      url,
      headers: const {'Referer': 'https://www.kugou.com/'},
    );
    final data = body is Map ? body['data'] : null;
    final first = data is List && data.isNotEmpty ? data[0] : null;
    final list = first is Map ? first['RecordDatas'] : null;
    if (list is! List) throw Exception('kg tip failed');
    return list
        .map((item) => item is Map ? (item['HintInfo']?.toString() ?? '') : '')
        .where((v) => v.isNotEmpty)
        .toList();
  }

  static Future<String?> getPicUrl(MusicInfo info) async {
    final response = await SdkHttp.fetch<dynamic>(
      'http://media.store.kugou.com/v1/get_res_privilege',
      method: 'POST',
      headers: _kgHeaders,
      body: {
        'appid': 1001,
        'area_code': '1',
        'behavior': 'play',
        'clientver': '9020',
        'need_hash_offset': 1,
        'relate': 1,
        'resource': [
          {
            'album_audio_id': info.meta.songId,
            'album_id': info.meta.albumId,
            'hash': info.meta.hash,
            'id': 0,
            'name': '${info.singer} - ${info.name}.mp3',
            'type': 'audio',
          },
        ],
        'token': '',
        'userid': 2626431536,
        'vip': 1,
      },
    );
    return parseKgPrivilegeCoverUrl(response.body);
  }

  static Future<LyricInfo> getLyric(MusicInfo info) async {
    final hash = info.meta.hash;
    if (hash == null || hash.isEmpty) throw Exception('kg lyric failed');
    final duration = _seconds(info.interval);
    final searchUrl =
        'http://lyrics.kugou.com/search?ver=1&man=yes&client=pc'
        '&keyword=${Uri.encodeComponent(info.name)}&hash=$hash'
        '&timelength=$duration&lrctxt=1';
    final searchBody = await SdkHttp.getJson(searchUrl, headers: _kgHeaders);
    final candidate = searchBody is Map
        ? (searchBody['candidates'] as List?)?.firstOrNull
        : null;
    if (candidate is! Map) throw Exception('kg lyric not found');

    // KG returns plain `lrc` (no translation) by default; only `krc` carries
    // translation + romaji as an embedded base64 JSON blob. Mirrors
    // the desktop source format's selection: krctype==1 && contenttype!=1 ⇒ krc.
    final krctype =
        (candidate['krctype'] as num?)?.toInt() ??
        int.tryParse(candidate['krctype']?.toString() ?? '0') ??
        0;
    final contenttype =
        (candidate['contenttype'] as num?)?.toInt() ??
        int.tryParse(candidate['contenttype']?.toString() ?? '0') ??
        0;
    final fmt = (krctype == 1 && contenttype != 1) ? 'krc' : 'lrc';

    final dl = await SdkHttp.getJson(
      'http://lyrics.kugou.com/download?ver=1&client=pc'
      '&id=${candidate['id']}&accesskey=${candidate['accesskey']}'
      '&fmt=$fmt&charset=utf8',
      headers: _kgHeaders,
    );
    final content = dl is Map ? dl['content'] : null;
    if (content is! String || content.isEmpty) {
      throw Exception('kg lyric empty');
    }
    if (fmt == 'krc') {
      try {
        return KgKrc.decodeBase64Content(content);
      } catch (_) {
        // If krc decoding fails for any reason, fall through to treating the
        // content as plain LRC — better some lyric than no lyric.
      }
    }
    return LyricInfo(lyric: utf8.decode(base64.decode(content)));
  }

  static int _seconds(String? interval) {
    if (interval == null || interval.isEmpty) return 0;
    var total = 0;
    for (final part in interval.split(':')) {
      total = total * 60 + (int.tryParse(part) ?? 0);
    }
    return total;
  }
}

extension _ListFirst<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
