import '../../models/enums.dart';
import '../../models/music_info.dart';
import '../../models/playlist_info.dart';
import '../internal/builders.dart';
import '../internal/format.dart';
import '../internal/kw_quality.dart';
import '../internal/sdk_http.dart';

class KwPlaylistAdapter {
  const KwPlaylistAdapter._();

  static Future<PlaylistInfo> parse(
    String id, {
    SdkJsonLoader? jsonLoader,
    int? maxTracks,
  }) async {
    final load = jsonLoader ?? SdkHttp.getJson;
    const defaultPageSize = 500;
    final hardLimit = _trackLimit(maxTracks);
    final pageSize =
        maxTracks != null && maxTracks > 0 && maxTracks < defaultPageSize
        ? maxTracks
        : defaultPageSize;
    final songs = <Map>[];
    Map? firstPage;
    var expected = 0;

    for (var page = 0; songs.length < hardLimit; page++) {
      final body = await load(
        'http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=$id'
        '&pn=$page&rn=$pageSize&encode=utf8&keyset=pl2012&identity=kuwo'
        '&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1',
      );
      if (body is! Map || body['result'] != 'ok') {
        throw Exception('酷我歌单解析失败');
      }
      firstPage ??= body;
      expected = _int(body['total']) ?? expected;
      final pageSongs = (body['musiclist'] as List? ?? const [])
          .whereType<Map>()
          .toList(growable: false);
      songs.addAll(pageSongs.take(hardLimit - songs.length));
      if (pageSongs.isEmpty) break;
      if (expected > 0 && songs.length >= _targetCount(expected, hardLimit)) {
        break;
      }
    }

    final info = firstPage;
    if (info == null) throw Exception('酷我歌单为空或不可访问');
    final tracks = songs
        .take(expected > 0 ? expected : songs.length)
        .map(_parseSong)
        .whereType<MusicInfo>()
        .toList(growable: false);
    return PlaylistInfo(
      id: id,
      name: info['title']?.toString() ?? '酷我歌单 $id',
      source: MusicSource.kw,
      coverUrl: _image(info['pic'] ?? info['img']),
      creator: _text(info['uname']),
      description: _text(info['info'] ?? info['desc']),
      playCount: _int(info['playcnt'] ?? info['listencnt']),
      trackCount: expected > 0 ? expected : tracks.length,
      tracks: dedupeMusic(tracks),
    );
  }

  static MusicInfo? _parseSong(Map item) {
    final id = item['id'];
    if (id == null) return null;
    final qualities = parseKwQualityOptions(item['N_MINFO'] ?? item['MINFO']);
    return buildMusicInfo(
      name: item['name']?.toString() ?? item['SONGNAME']?.toString() ?? '',
      singer: formatSingerName(item['artist'] ?? item['ARTIST']),
      source: MusicSource.kw,
      songId: id,
      qualitys: qualities,
      interval: formatPlayTime(
        num.tryParse(item['duration']?.toString() ?? '0') ?? 0,
      ),
      albumName: item['album']?.toString() ?? '',
      albumId: item['albumid'],
      picUrl: _trackImage(item),
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
    final candidate = text.startsWith('//') ? 'http:$text' : text;
    final host = Uri.tryParse(candidate)?.host.toLowerCase() ?? '';
    final keepHttp = host == 'kwcdn.kuwo.cn' || host.endsWith('.kwcdn.kuwo.cn');
    if (text.startsWith('//')) {
      text = '${keepHttp ? 'http' : 'https'}:$text';
    } else if (text.startsWith('http://') && !keepHttp) {
      text = text.replaceFirst('http://', 'https://');
    }
    return text;
  }

  static String? _trackImage(Map item) {
    // pl.svc returns `musicPic: ""` (empty string, not null), so a `??` chain
    // would stop there and never reach the populated `albumpic` field. Walk
    // the candidates and take the first non-empty URL instead.
    for (final key in const [
      'musicPic',
      'MUSICPIC',
      'albumpic',
      'ALBUMPIC',
      'artistPic',
      'ARTISTPIC',
    ]) {
      final url = _image(item[key]);
      if (url != null) return _upscaleImage(url);
    }
    final short = _text(
      item['web_albumpic_short'] ?? item['WEB_ALBUMPIC_SHORT'],
    );
    return short == null
        ? null
        : _upscaleImage('https://img2.kuwo.cn/star/albumcover/$short');
  }

  // pl.svc only hands out 120px thumbnail paths; the same path exists in a
  // 500px variant on the image CDN.
  static String _upscaleImage(String url) {
    return url.replaceFirstMapped(
      RegExp(r'/star/(albumcover|starheads)/120/'),
      (match) => '/star/${match[1]}/500/',
    );
  }
}
