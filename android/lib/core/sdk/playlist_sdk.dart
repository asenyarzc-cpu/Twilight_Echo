import 'dart:convert';

import '../models/enums.dart';
import '../models/music_info.dart';
import '../models/playlist_info.dart';
import 'internal/builders.dart';
import 'internal/format.dart';
import 'internal/sdk_http.dart';
import 'internal/tx_quality.dart';
import 'playlist_adapters/kg_playlist_adapter.dart';
import 'playlist_adapters/kw_playlist_adapter.dart';
import 'playlist_adapters/mg_playlist_adapter.dart';

class PlaylistSdk {
  const PlaylistSdk._();

  static Future<PlaylistInfo> parse({
    required String input,
    MusicSource source = MusicSource.all,
    int? maxTracks,
  }) async {
    final target =
        parseTarget(input, source: source) ??
        await _parseRedirectTarget(input, source: source);
    if (target == null) {
      throw Exception('无法识别歌单链接或 ID');
    }
    switch (target.source) {
      case MusicSource.wy:
        return _parseWy(target.id, maxTracks: maxTracks);
      case MusicSource.tx:
        return _parseTx(target.id, maxTracks: maxTracks);
      case MusicSource.kw:
        return KwPlaylistAdapter.parse(target.id, maxTracks: maxTracks);
      case MusicSource.kg:
        return KgPlaylistAdapter.parse(target.id, maxTracks: maxTracks);
      case MusicSource.mg:
        return MgPlaylistAdapter.parse(target.id, maxTracks: maxTracks);
      case MusicSource.all:
        throw Exception('无法识别歌单来源');
    }
  }

  static ParsedPlaylistTarget? parseTarget(
    String input, {
    MusicSource source = MusicSource.all,
  }) {
    final text = input.trim();
    if (text.isEmpty) return null;
    if (source == MusicSource.kg) {
      final kgId = _parseKgText(text);
      if (kgId != null) {
        return ParsedPlaylistTarget(id: kgId, source: MusicSource.kg);
      }
    }
    if (RegExp(r'^\d{4,}$').hasMatch(text)) {
      return source != MusicSource.all
          ? ParsedPlaylistTarget(id: text, source: source)
          : null;
    }

    for (final uri in _extractWebUris(text)) {
      final target = _parseUriTarget(uri, source);
      if (target != null) return target;
    }
    return null;
  }

  static Future<ParsedPlaylistTarget?> _parseRedirectTarget(
    String input, {
    required MusicSource source,
  }) async {
    for (final uri in _extractWebUris(input)) {
      try {
        final redirected = await SdkHttp.resolveRedirectLocation(
          uri.toString(),
          headers: const {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                'Chrome/120.0.0.0 Safari/537.36',
          },
        );
        if (redirected == null || redirected == uri) continue;
        final target = _parseUriTarget(redirected, source);
        if (target != null) return target;
      } catch (_) {
        // Share short links are best-effort; fall through to the normal error.
      }
    }
    return null;
  }

  static ParsedPlaylistTarget? _parseUriTarget(Uri uri, MusicSource source) {
    if ((source == MusicSource.wy || source == MusicSource.all) &&
        _isHost(uri.host, 'music.163.com')) {
      final id = _parseWyId(uri);
      if (id != null) {
        return ParsedPlaylistTarget(id: id, source: MusicSource.wy);
      }
    }

    if ((source == MusicSource.tx || source == MusicSource.all) &&
        _isHost(uri.host, 'y.qq.com')) {
      final id = _parseTxId(uri);
      if (id != null) {
        return ParsedPlaylistTarget(id: id, source: MusicSource.tx);
      }
    }

    if ((source == MusicSource.kw || source == MusicSource.all) &&
        _isHost(uri.host, 'kuwo.cn')) {
      final id = _parseKwId(uri);
      if (id != null) {
        return ParsedPlaylistTarget(id: id, source: MusicSource.kw);
      }
    }

    if ((source == MusicSource.kg || source == MusicSource.all) &&
        _isHost(uri.host, 'kugou.com')) {
      final id = _parseKgId(uri);
      if (id != null) {
        return ParsedPlaylistTarget(id: id, source: MusicSource.kg);
      }
    }

    if ((source == MusicSource.mg || source == MusicSource.all) &&
        _isHost(uri.host, 'migu.cn')) {
      final id = _parseMgId(uri);
      if (id != null) {
        return ParsedPlaylistTarget(id: id, source: MusicSource.mg);
      }
    }
    return null;
  }

  static Iterable<Uri> _extractWebUris(String input) sync* {
    final seen = <String>{};

    final direct = _tryParseWebUri(_stripTrailingUrlPunctuation(input));
    if (direct != null && seen.add(direct.toString())) yield direct;

    final matches = RegExp(
      r'''https?://[^\s<>"',;()\[\]{}，。；：！？、（）【】《》「」『』]+''',
      caseSensitive: false,
    ).allMatches(input);
    for (final match in matches) {
      final raw = match.group(0);
      if (raw == null) continue;
      final uri = _tryParseWebUri(_stripTrailingUrlPunctuation(raw));
      if (uri != null && seen.add(uri.toString())) yield uri;
    }
  }

  static String _stripTrailingUrlPunctuation(String input) {
    var value = input.trim();
    const trailing = '.,;:!?)]}>，。；：！？、）】》」』';
    while (value.isNotEmpty && trailing.contains(value[value.length - 1])) {
      value = value.substring(0, value.length - 1);
    }
    return value;
  }

  static Uri? _tryParseWebUri(String input) {
    try {
      final uri = Uri.tryParse(input);
      if (uri == null ||
          (uri.scheme != 'http' && uri.scheme != 'https') ||
          uri.host.isEmpty) {
        return null;
      }
      return uri;
    } on FormatException {
      return null;
    }
  }

  static bool _isHost(String host, String root) {
    final normalized = host.toLowerCase();
    return normalized == root || normalized.endsWith('.$root');
  }

  static String? _parseWyId(Uri uri) {
    final direct =
        _playlistPathId(uri.path) ??
        (_hasPlaylistPath(uri.path)
            ? _numeric(uri.queryParameters['id'])
            : null);
    if (direct != null) return direct;

    final fragment = uri.fragment;
    if (fragment.isEmpty) return null;
    final fragmentUri = Uri.tryParse(
      fragment.startsWith('/') ? fragment : '/$fragment',
    );
    if (fragmentUri == null) return null;
    return _playlistPathId(fragmentUri.path) ??
        (_hasPlaylistPath(fragmentUri.path)
            ? _numeric(fragmentUri.queryParameters['id'])
            : null);
  }

  static String? _parseTxId(Uri uri) {
    final pathId = _playlistPathId(uri.path);
    if (pathId != null) return pathId;
    if (!_hasPlaylistPath(uri.path) && !_isTxSharePath(uri.path)) return null;
    return _numeric(uri.queryParameters['disstid']) ??
        _numeric(uri.queryParameters['id']);
  }

  static String? _parseKwId(Uri uri) {
    final match = RegExp(
      r'(?:^|/)(?:playlist_detail|playlist)/(\d+)(?:/|$)',
      caseSensitive: false,
    ).firstMatch(uri.path);
    return _numeric(match?.group(1));
  }

  static String? _parseKgId(Uri uri) {
    final fromText = _parseKgText(uri.toString());
    if (fromText != null) return fromText;

    final match = RegExp(
      r'(?:^|/)(?:special/single|plist/list)/(\d+)(?:[-./]|$)',
      caseSensitive: false,
    ).firstMatch(uri.path);
    return _numeric(match?.group(1));
  }

  static String? _parseKgText(String input) {
    final text = input.trim();
    if (text.isEmpty) return null;
    if (RegExp(r'^collection_\w+', caseSensitive: false).hasMatch(text)) {
      return 'global:$text';
    }
    if (RegExp(r'^gcid_\w+', caseSensitive: false).hasMatch(text)) {
      return 'gcid:$text';
    }
    if (text.startsWith('global:') ||
        text.startsWith('chain:') ||
        text.startsWith('gcid:')) {
      return text;
    }

    final uri = Uri.tryParse(text);
    if (uri != null && uri.host.isNotEmpty) {
      final global = _queryValue(uri, const {
        'global_specialid',
        'global_collection_id',
      });
      if (global != null && global.trim().isNotEmpty) {
        return 'global:${global.trim()}';
      }

      final chain = _queryValue(uri, const {'chain'});
      if (chain != null && chain.trim().isNotEmpty) {
        return 'chain:${chain.trim()}';
      }

      final special = _numeric(_queryValue(uri, const {'specialid'}));
      if (special != null) return special;

      final share = RegExp(
        r'(?:^|/)share/([A-Za-z0-9_]+)\.html(?:/|$)',
        caseSensitive: false,
      ).firstMatch(uri.path);
      if (share != null) return 'chain:${share.group(1)}';

      final songList = RegExp(
        r'(?:^|/)songlist/([^/?#]+)(?:/|$)',
        caseSensitive: false,
      ).firstMatch(uri.path);
      final songListId = songList?.group(1)?.trim();
      if (songListId != null && songListId.isNotEmpty) {
        if (RegExp(r'^\d{4,}$').hasMatch(songListId)) return songListId;
        return RegExp(r'^gcid_\w+', caseSensitive: false).hasMatch(songListId)
            ? 'gcid:$songListId'
            : 'chain:$songListId';
      }
    }

    final global = RegExp(
      r'(?:global_specialid|global_collection_id)=([A-Za-z0-9_]+)',
      caseSensitive: false,
    ).firstMatch(text);
    if (global != null) return 'global:${global.group(1)}';

    final chain = RegExp(
      r'(?:^|[?&])chain=([A-Za-z0-9_]+)',
      caseSensitive: false,
    ).firstMatch(text);
    if (chain != null) return 'chain:${chain.group(1)}';

    final gcid = RegExp(r'gcid_\w+', caseSensitive: false).firstMatch(text);
    if (gcid != null) return 'gcid:${gcid.group(0)}';

    return null;
  }

  static String? _parseMgId(Uri uri) {
    String? fromUri(Uri value) {
      if (!value.path.toLowerCase().contains('playlist')) return null;
      return _playlistPathId(value.path) ??
          _numeric(_queryValue(value, const {'playlistid', 'musiclistid'})) ??
          _numeric(_queryValue(value, const {'id'}));
    }

    final direct = fromUri(uri);
    if (direct != null || uri.fragment.isEmpty) return direct;
    final fragment = Uri.tryParse(
      uri.fragment.startsWith('/') ? uri.fragment : '/${uri.fragment}',
    );
    return fragment == null ? null : fromUri(fragment);
  }

  static String? _queryValue(Uri uri, Set<String> names) {
    for (final entry in uri.queryParameters.entries) {
      if (names.contains(entry.key.toLowerCase())) return entry.value;
    }
    return null;
  }

  static bool _isTxSharePath(String path) {
    final normalized = path.toLowerCase();
    return normalized.endsWith('/details/taoge.html') ||
        normalized.endsWith('/details/playlist.html');
  }

  static bool _hasPlaylistPath(String path) =>
      path.split('/').any((segment) => segment.toLowerCase() == 'playlist');

  static String? _playlistPathId(String path) {
    final match = RegExp(
      r'(?:^|/)playlist/(\d+)(?:/|$)',
      caseSensitive: false,
    ).firstMatch(path);
    return _numeric(match?.group(1));
  }

  static String? _numeric(String? value) {
    if (value == null || !RegExp(r'^\d{4,}$').hasMatch(value)) return null;
    return value;
  }

  static Future<PlaylistInfo> _parseWy(String id, {int? maxTracks}) async {
    final requestLimit = maxTracks != null && maxTracks > 0
        ? maxTracks
        : 100000;
    final detail = await SdkHttp.getJson(
      'https://music.163.com/api/v6/playlist/detail?id=$id'
      '&n=$requestLimit&s=0',
      headers: const {
        'Referer': 'https://music.163.com/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            'Chrome/120.0.0.0 Safari/537.36',
      },
    );
    if (detail is! Map || detail['code'] != 200 || detail['playlist'] is! Map) {
      throw Exception('网易云歌单解析失败');
    }
    final playlist = detail['playlist'] as Map;
    final songs = (playlist['tracks'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final trackIds = (playlist['trackIds'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => item['id']?.toString())
        .whereType<String>()
        .toList();
    final limitedTrackIds = _takePlaylistMaps(trackIds, maxTracks);
    final completedSongs = trackIds.isEmpty
        ? _takePlaylistMaps(songs, maxTracks)
        : await _completeWySongs(limitedTrackIds, songs);
    final tracks = completedSongs
        .map(_parseWySong)
        .whereType<MusicInfo>()
        .toList();
    return PlaylistInfo(
      id: id,
      name: playlist['name']?.toString() ?? '网易云歌单 $id',
      source: MusicSource.wy,
      coverUrl: _normalizeWyPic(playlist['coverImgUrl']?.toString()),
      creator: (playlist['creator'] as Map?)?['nickname']?.toString(),
      description: playlist['description']?.toString(),
      playCount: (playlist['playCount'] as num?)?.toInt(),
      trackCount: trackIds.length,
      tracks: dedupeMusic(tracks),
    );
  }

  static Future<List<Map>> _completeWySongs(
    List<String> trackIds,
    List<Map> initialSongs,
  ) async {
    if (trackIds.isEmpty) return initialSongs;

    final songsById = <String, Map>{};
    for (final song in initialSongs) {
      final songId = song['id']?.toString();
      if (songId != null) songsById[songId] = song;
    }

    final missingIds = trackIds
        .where((trackId) => !songsById.containsKey(trackId))
        .toList();
    if (missingIds.isNotEmpty) {
      for (final song in await _fetchWySongs(missingIds)) {
        final songId = song['id']?.toString();
        if (songId != null) songsById[songId] = song;
      }
    }

    return trackIds
        .map((trackId) => songsById[trackId])
        .whereType<Map>()
        .toList();
  }

  static Future<List<Map>> _fetchWySongs(List<String> ids) async {
    final out = <Map>[];
    for (var i = 0; i < ids.length; i += 200) {
      final chunk = ids.skip(i).take(200).toList();
      final body = await SdkHttp.getJson(
        Uri.https('music.163.com', '/api/song/detail', {
          'ids': jsonEncode(chunk.map(int.parse).toList()),
        }).toString(),
        headers: const {
          'Referer': 'https://music.163.com/',
          'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              'Chrome/120.0.0.0 Safari/537.36',
        },
      );
      final songs = body is Map ? body['songs'] : null;
      if (songs is! List) continue;

      final returnedById = <String, Map>{};
      for (final song in songs.whereType<Map>()) {
        final songId = song['id']?.toString();
        if (songId != null) returnedById[songId] = song;
      }
      for (final id in chunk) {
        final song = returnedById[id];
        if (song != null) out.add(song);
      }
    }
    return out;
  }

  static MusicInfo? _parseWySong(Map item) {
    final id = item['id'];
    if (id == null) return null;
    final qualities = <QualityOption>[];
    void add(Quality type, Object? size) {
      final fmt = sizeFormat(size);
      if (fmt == null) return;
      qualities.add(QualityOption(type: type, size: fmt));
    }

    add(Quality.flac24bit, (item['hr'] as Map?)?['size']);
    add(Quality.flac, (item['sq'] as Map?)?['size']);
    add(
      Quality.k320,
      (item['h'] as Map?)?['size'] ?? (item['hMusic'] as Map?)?['size'],
    );
    add(
      Quality.k192,
      (item['m'] as Map?)?['size'] ?? (item['mMusic'] as Map?)?['size'],
    );
    add(
      Quality.k128,
      (item['l'] as Map?)?['size'] ??
          (item['lMusic'] as Map?)?['size'] ??
          (item['bMusic'] as Map?)?['size'],
    );
    return buildMusicInfo(
      name: item['name']?.toString() ?? '',
      singer: _wySinger(item['ar'] as List? ?? item['artists'] as List?),
      source: MusicSource.wy,
      songId: id,
      qualitys: qualities,
      interval: formatPlayTime(
        (num.tryParse((item['dt'] ?? item['duration'])?.toString() ?? '0') ??
                0) /
            1000,
      ),
      albumName:
          (item['al'] as Map?)?['name']?.toString() ??
          (item['album'] as Map?)?['name']?.toString() ??
          '',
      albumId: (item['al'] as Map?)?['id'] ?? (item['album'] as Map?)?['id'],
      picUrl: _normalizeWyPic(
        (item['al'] as Map?)?['picUrl']?.toString() ??
            (item['album'] as Map?)?['picUrl']?.toString(),
      ),
    );
  }

  static String _wySinger(List? list) {
    if (list == null) return '';
    return list
        .map((item) => item is Map ? item['name']?.toString() : null)
        .where((item) => item != null && item.isNotEmpty)
        .join('、');
  }

  static String? _normalizeWyPic(String? raw) {
    if (raw == null || raw.isEmpty) return raw;
    return raw.startsWith('http://')
        ? raw.replaceFirst('http://', 'https://')
        : raw;
  }

  static Future<PlaylistInfo> _parseTx(String id, {int? maxTracks}) async {
    try {
      return await _parseTxMusicu(id, maxTracks: maxTracks);
    } catch (_) {
      return _parseTxQzone(id, maxTracks: maxTracks);
    }
  }

  static Future<PlaylistInfo> _parseTxMusicu(
    String id, {
    int? maxTracks,
  }) async {
    const pageSize = 30;
    final hardLimit = _playlistTrackLimit(maxTracks);
    final songs = <Map>[];
    Map? dirInfo;
    int? expectedCount;

    for (var begin = 0; songs.length < hardLimit; begin += pageSize) {
      final result = await SdkHttp.fetch<dynamic>(
        'https://u.y.qq.com/cgi-bin/musicu.fcg',
        method: 'POST',
        headers: const {
          'Referer': 'https://y.qq.com/',
          'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              'Chrome/120.0.0.0 Safari/537.36',
        },
        body: {
          'req_0': {
            'module': 'music.srfDissInfo.aiDissInfo',
            'method': 'uniform_get_Dissinfo',
            'param': {
              'disstid': int.parse(id),
              'enc_host_uin': '',
              'tag': 1,
              'userinfo': 1,
              'song_begin': begin,
              'song_num': pageSize,
            },
          },
          'comm': {'g_tk': 5381, 'uin': 0, 'format': 'json', 'platform': 'h5'},
        },
      );
      final decoded = _decodeJson(result.body);
      final request = decoded is Map ? decoded['req_0'] : null;
      final data = request is Map ? request['data'] : null;
      if (decoded is! Map ||
          decoded['code'] != 0 ||
          request is! Map ||
          request['code'] != 0 ||
          data is! Map ||
          data['code'] != 0) {
        throw Exception('QQ 歌单分页解析失败');
      }

      dirInfo ??= data['dirinfo'] as Map?;
      expectedCount ??= int.tryParse(dirInfo?['songnum']?.toString() ?? '');
      final page = (data['songlist'] as List? ?? const [])
          .whereType<Map>()
          .toList();
      songs.addAll(page.take(hardLimit - songs.length));

      final targetCount = _playlistTargetCount(expectedCount, hardLimit);
      if (songs.length >= targetCount) break;
      if (page.isEmpty && expectedCount == null) break;
      if (page.isEmpty || begin + pageSize >= targetCount) {
        throw Exception('QQ 歌单分页内容不完整');
      }
    }

    if (dirInfo == null) throw Exception('QQ 歌单为空或不可访问');
    final targetCount = _playlistTargetCount(expectedCount, hardLimit);
    final tracks = songs
        .take(targetCount)
        .map(_parseTxSong)
        .whereType<MusicInfo>()
        .toList();
    final creator = dirInfo['creator'] as Map?;
    return PlaylistInfo(
      id: id,
      name: dirInfo['title']?.toString() ?? 'QQ 歌单 $id',
      source: MusicSource.tx,
      coverUrl: _normalizeTxPic(dirInfo['picurl']?.toString()),
      creator: creator?['nick']?.toString() ?? dirInfo['host_nick']?.toString(),
      description: dirInfo['desc']?.toString(),
      playCount: (dirInfo['visitnum'] as num?)?.toInt(),
      trackCount: expectedCount,
      tracks: dedupeMusic(tracks),
    );
  }

  static dynamic _decodeJson(dynamic body) {
    if (body is! String) return body;
    return jsonDecode(body);
  }

  static Future<PlaylistInfo> _parseTxQzone(String id, {int? maxTracks}) async {
    final body = await SdkHttp.getJson(
      'https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
      '?type=1&json=1&utf8=1&onlysong=0&disstid=$id&format=json'
      '&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8'
      '&notice=0&platform=yqq&needNewCode=0',
      headers: const {
        'Referer': 'https://y.qq.com/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            'Chrome/120.0.0.0 Safari/537.36',
      },
    );
    final decoded = body is String ? jsonDecode(body) : body;
    if (decoded is! Map || decoded['code'] != 0) {
      throw Exception('QQ 歌单解析失败');
    }
    final cd = (decoded['cdlist'] as List?)?.whereType<Map>().firstOrNull;
    if (cd == null) throw Exception('QQ 歌单为空或不可访问');
    final rawSongs = (cd['songlist'] as List? ?? const []).whereType<Map>();
    final tracks = _takePlaylistMaps(
      rawSongs,
      maxTracks,
    ).whereType<Map>().map(_parseTxSong).whereType<MusicInfo>().toList();
    return PlaylistInfo(
      id: id,
      name: cd['dissname']?.toString() ?? 'QQ 歌单 $id',
      source: MusicSource.tx,
      coverUrl: _normalizeTxPic(cd['logo']?.toString()),
      creator: cd['nickname']?.toString(),
      description: cd['desc']?.toString(),
      playCount: (cd['visitnum'] as num?)?.toInt(),
      trackCount: (cd['songlist'] as List?)?.length ?? tracks.length,
      tracks: dedupeMusic(tracks),
    );
  }

  static int _playlistTrackLimit(int? maxTracks) {
    const hardLimit = 10000;
    if (maxTracks == null || maxTracks <= 0 || maxTracks > hardLimit) {
      return hardLimit;
    }
    return maxTracks;
  }

  static int _playlistTargetCount(int? expectedCount, int hardLimit) {
    final expected = expectedCount ?? 0;
    if (expected <= 0) return hardLimit;
    return expected < hardLimit ? expected : hardLimit;
  }

  static List<T> _takePlaylistMaps<T>(Iterable<T> values, int? maxTracks) {
    if (maxTracks == null || maxTracks <= 0) return values.toList();
    return values.take(maxTracks).toList();
  }

  static MusicInfo? _parseTxSong(Map item) {
    final file = item['file'] is Map ? item['file'] as Map : item;
    final mediaMid = file['media_mid'] ?? item['strMediaMid'];
    if (mediaMid == null) return null;
    final songMid = item['mid'] ?? item['songmid'];
    if (songMid == null) return null;
    final qualities = parseTxQualityOptions(
      fileData: file,
      versions: item['vs'],
      legacyData: item,
    );
    final album = item['album'] as Map?;
    final albumMid =
        album?['mid']?.toString() ?? item['albummid']?.toString() ?? '';
    return buildMusicInfo(
      name:
          (item['title'] ?? item['name'] ?? item['songname'])?.toString() ?? '',
      singer: formatSingerName(item['singer']),
      source: MusicSource.tx,
      songId: songMid,
      qualitys: qualities,
      interval: formatPlayTime(
        num.tryParse(item['interval']?.toString() ?? '0') ?? 0,
      ),
      albumName:
          album?['name']?.toString() ?? item['albumname']?.toString() ?? '',
      albumId: albumMid,
      picUrl: albumMid.isNotEmpty
          ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000$albumMid.jpg'
          : null,
      strMediaMid: mediaMid.toString(),
      metaId: item['id'] ?? item['songid'],
      albumMid: albumMid,
    );
  }

  static String? _normalizeTxPic(String? raw) {
    if (raw == null || raw.isEmpty) return raw;
    if (raw.startsWith('//')) return 'https:$raw';
    return raw.startsWith('http://')
        ? raw.replaceFirst('http://', 'https://')
        : raw;
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
