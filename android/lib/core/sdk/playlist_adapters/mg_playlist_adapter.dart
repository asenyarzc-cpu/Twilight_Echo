import '../../models/enums.dart';
import '../../models/music_info.dart';
import '../../models/playlist_info.dart';
import '../internal/builders.dart';
import '../internal/format.dart';
import '../internal/sdk_http.dart';

class MgPlaylistAdapter {
  const MgPlaylistAdapter._();

  static const _headers = {
    'Referer': 'https://m.music.migu.cn/',
    'User-Agent':
        'Mozilla/5.0 (Linux; Android 11.0.0) AppleWebKit/537.36 Mobile Safari/537.36',
  };

  static const _qualityMap = {
    'PQ': Quality.k128,
    'HQ': Quality.k320,
    'SQ': Quality.flac,
    'ZQ': Quality.flac24bit,
    'ZQ24': Quality.flac24bit,
  };

  static Future<PlaylistInfo> parse(
    String id, {
    SdkJsonLoader? jsonLoader,
    int? maxTracks,
  }) async {
    final load = jsonLoader ?? SdkHttp.getJson;
    final infoBody = await load(
      'https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0'
      '?playlistId=$id',
      headers: _headers,
    );
    final info = infoBody is Map ? infoBody['data'] : null;
    if (infoBody is! Map || infoBody['code'] != '000000' || info is! Map) {
      throw Exception('咪咕歌单信息加载失败');
    }

    const defaultPageSize = 50;
    final hardLimit = _trackLimit(maxTracks);
    final pageSize =
        maxTracks != null && maxTracks > 0 && maxTracks < defaultPageSize
        ? maxTracks
        : defaultPageSize;
    final songs = <Map>[];
    var expected = 0;
    for (var page = 1; songs.length < hardLimit; page++) {
      final body = await load(
        'https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0'
        '?pageNo=$page&pageSize=$pageSize&playlistId=$id',
        headers: _headers,
      );
      final data = body is Map ? body['data'] : null;
      if (body is! Map || body['code'] != '000000' || data is! Map) {
        throw Exception('咪咕歌单歌曲加载失败');
      }
      expected = _int(data['totalCount']) ?? expected;
      final pageSongs = (data['songList'] as List? ?? const [])
          .whereType<Map>()
          .toList(growable: false);
      songs.addAll(pageSongs.take(hardLimit - songs.length));
      if (pageSongs.isEmpty) break;
      if (expected > 0 && songs.length >= _targetCount(expected, hardLimit)) {
        break;
      }
    }

    final tracks = songs
        .take(expected > 0 ? expected : songs.length)
        .map(_parseSong)
        .whereType<MusicInfo>()
        .toList(growable: false);
    final image = info['imgItem'] as Map?;
    final operations = info['opNumItem'] as Map?;
    return PlaylistInfo(
      id: id,
      name: info['title']?.toString() ?? '咪咕歌单 $id',
      source: MusicSource.mg,
      coverUrl: _image(image?['img']),
      creator: _text(info['ownerName']),
      description: _text(info['summary']),
      playCount: _int(operations?['playNum']),
      trackCount: expected > 0 ? expected : tracks.length,
      tracks: dedupeMusic(tracks),
    );
  }

  static MusicInfo? _parseSong(Map item) {
    final songId = item['songId'];
    final copyrightId = _text(item['copyrightId']);
    if (songId == null || copyrightId == null) return null;
    final qualities = <QualityOption>[];
    for (final format in (item['audioFormats'] as List? ?? const [])) {
      if (format is! Map) continue;
      final quality = _qualityMap[format['formatType']?.toString()];
      if (quality == null) continue;
      qualities.add(
        QualityOption(
          type: quality,
          size: sizeFormat(
            format['size'] ??
                format['androidSize'] ??
                format['asize'] ??
                format['isize'],
          ),
        ),
      );
    }
    return buildMusicInfo(
      name: item['songName']?.toString() ?? item['name']?.toString() ?? '',
      singer: formatSingerName(item['singerList']),
      source: MusicSource.mg,
      songId: songId,
      qualitys: qualities,
      interval: formatPlayTime(
        num.tryParse(item['duration']?.toString() ?? '0') ?? 0,
      ),
      albumName: item['album']?.toString() ?? '',
      albumId: item['albumId'],
      picUrl: _image(item['img3'] ?? item['img2'] ?? item['img1']),
      copyrightId: copyrightId,
      lrcUrl: _text(item['lrcUrl']),
      mrcUrl: _text(item['mrcUrl'] ?? item['mrcurl']),
      trcUrl: _text(item['trcUrl']),
    );
  }

  static int? _int(Object? value) =>
      value is num ? value.toInt() : int.tryParse(value?.toString() ?? '');

  static int _trackLimit(int? maxTracks) {
    const hardLimit = 10000;
    if (maxTracks == null || maxTracks <= 0 || maxTracks > hardLimit) {
      return hardLimit;
    }
    return maxTracks;
  }

  static int _targetCount(int expected, int hardLimit) =>
      expected < hardLimit ? expected : hardLimit;

  static String? _text(Object? value) {
    final text = value?.toString().trim();
    return text == null || text.isEmpty ? null : text;
  }

  static String? _image(Object? value) {
    var text = _text(value);
    if (text == null) return null;
    if (text.startsWith('//')) text = 'https:$text';
    if (!RegExp(r'^https?://').hasMatch(text)) {
      text = 'https://d.musicapp.migu.cn$text';
    } else if (text.startsWith('http://')) {
      text = text.replaceFirst('http://', 'https://');
    }
    return text;
  }
}
