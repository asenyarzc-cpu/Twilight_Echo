import 'dart:convert';

import '../models/enums.dart';
import '../models/playlist_category.dart';
import '../models/playlist_summary.dart';
import 'internal/sdk_http.dart';

class PlaylistCatalogSdk {
  const PlaylistCatalogSdk._();

  static const _desktopHeaders = {
    'Referer': 'https://y.qq.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        'Chrome/120.0.0.0 Safari/537.36',
  };

  static const _miguHeaders = {
    'Referer': 'https://m.music.migu.cn/',
    'User-Agent':
        'Mozilla/5.0 (Linux; Android 11.0.0) AppleWebKit/537.36 Mobile Safari/537.36',
  };

  static Future<List<PlaylistSummary>> featured(
    MusicSource source, {
    int page = 1,
    int limit = 20,
    String? categoryId,
    SdkJsonLoader? jsonLoader,
  }) async {
    if (source == MusicSource.all) {
      throw ArgumentError.value(source, 'source', '必须指定发现页平台');
    }
    final requestedPage = page < 1 ? 1 : page;
    final requestedCategory =
        categoryId ?? defaultPlaylistCatalogCategoryFor(source).id;
    final load = jsonLoader ?? SdkHttp.getJson;
    final list = switch (source) {
      MusicSource.kw => await _featuredKw(
        requestedPage,
        limit,
        requestedCategory,
        load,
      ),
      MusicSource.kg => await _featuredKg(
        requestedPage,
        limit,
        requestedCategory,
        load,
      ),
      MusicSource.tx => await _featuredTx(
        requestedPage,
        limit,
        requestedCategory,
        load,
      ),
      MusicSource.wy => await _featuredWy(
        requestedPage,
        limit,
        requestedCategory,
        load,
      ),
      MusicSource.mg => await _featuredMg(
        requestedPage,
        limit,
        requestedCategory,
        load,
      ),
      MusicSource.all => const <PlaylistSummary>[],
    };
    final seen = <String>{};
    return [
      for (final item in list)
        if (item.id.isNotEmpty && item.name.isNotEmpty && seen.add(item.key))
          item,
    ].take(limit).toList(growable: false);
  }

  static Future<List<PlaylistSummary>> _featuredKw(
    int page,
    int limit,
    String categoryId,
    SdkJsonLoader load,
  ) async {
    final body = await load(
      'http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList'
      '?loginUid=0&loginSid=0&appUid=76039576&pn=$page&rn=$limit'
      '&order=$categoryId',
    );
    final data = body is Map ? body['data'] : null;
    final items = data is Map ? data['data'] : null;
    if (body is! Map || body['code'] != 200 || items is! List) {
      throw Exception('酷我精选歌单加载失败');
    }
    return [
      for (final item in items.whereType<Map>())
        PlaylistSummary(
          id: item['id']?.toString() ?? '',
          name: item['name']?.toString() ?? '',
          source: MusicSource.kw,
          coverUrl: _image(item['img']),
          creator: _text(item['uname']),
          description: _text(item['desc']),
          trackCount: _int(item['total']),
          playCount: _int(item['listencnt']),
        ),
    ];
  }

  static Future<List<PlaylistSummary>> _featuredKg(
    int page,
    int limit,
    String categoryId,
    SdkJsonLoader load,
  ) async {
    final body = await load(
      'http://www2.kugou.kugou.com/yueku/v9/special/getSpecial'
      '?is_ajax=1&cdn=cdn&t=$categoryId&c=&p=$page',
      headers: _desktopHeaders,
    );
    final items = body is Map ? body['special_db'] : null;
    if (body is! Map || body['status'] != 1 || items is! List) {
      throw Exception('酷狗精选歌单加载失败');
    }
    return [
      for (final item in items.whereType<Map>())
        PlaylistSummary(
          id: item['specialid']?.toString() ?? '',
          name: item['specialname']?.toString() ?? '',
          source: MusicSource.kg,
          coverUrl: _image(item['img'] ?? item['imgurl']),
          creator: _text(item['nickname']),
          description: _text(item['intro']),
          trackCount: _int(item['songcount']),
          playCount: _int(item['playcount'] ?? item['play_count']),
        ),
    ].take(limit).toList(growable: false);
  }

  static Future<List<PlaylistSummary>> _featuredTx(
    int page,
    int limit,
    String categoryId,
    SdkJsonLoader load,
  ) async {
    final request = {
      'comm': {'cv': 1602, 'ct': 20},
      'playlist': {
        'method': 'get_playlist_by_tag',
        'param': {
          'id': 10000000,
          'sin': (page - 1) * limit,
          'size': limit,
          'order': int.tryParse(categoryId) ?? 5,
          'cur_page': page,
        },
        'module': 'playlist.PlayListPlazaServer',
      },
    };
    final uri = Uri.https('u.y.qq.com', '/cgi-bin/musicu.fcg', {
      'loginUin': '0',
      'hostUin': '0',
      'format': 'json',
      'inCharset': 'utf-8',
      'outCharset': 'utf-8',
      'notice': '0',
      'platform': 'wk_v15.json',
      'needNewCode': '0',
      'data': jsonEncode(request),
    });
    final body = await load(uri.toString(), headers: _desktopHeaders);
    final playlist = body is Map ? body['playlist'] : null;
    final data = playlist is Map ? playlist['data'] : null;
    final items = data is Map ? data['v_playlist'] : null;
    if (body is! Map ||
        body['code'] != 0 ||
        playlist is! Map ||
        playlist['code'] != 0 ||
        items is! List) {
      throw Exception('QQ 精选歌单加载失败');
    }
    return [
      for (final item in items.whereType<Map>())
        PlaylistSummary(
          id: item['tid']?.toString() ?? '',
          name: item['title']?.toString() ?? '',
          source: MusicSource.tx,
          coverUrl: _image(item['cover_url_medium']),
          creator: _text((item['creator_info'] as Map?)?['nick']),
          description: _text(item['desc']),
          trackCount: (item['song_ids'] as List?)?.length,
          playCount: _int(item['access_num']),
        ),
    ];
  }

  static Future<List<PlaylistSummary>> _featuredWy(
    int page,
    int limit,
    String categoryId,
    SdkJsonLoader load,
  ) async {
    final uri = Uri.https('music.163.com', '/api/playlist/list', {
      'cat': '全部',
      'order': categoryId,
      'limit': '$limit',
      'offset': '${(page - 1) * limit}',
    });
    final body = await load(
      uri.toString(),
      headers: const {
        'Referer': 'https://music.163.com/',
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    );
    final items = body is Map ? body['playlists'] : null;
    if (body is! Map || body['code'] != 200 || items is! List) {
      throw Exception('网易云精品歌单加载失败');
    }
    return [
      for (final item in items.whereType<Map>())
        PlaylistSummary(
          id: item['id']?.toString() ?? '',
          name: item['name']?.toString() ?? '',
          source: MusicSource.wy,
          coverUrl: _image(item['coverImgUrl']),
          creator: _text((item['creator'] as Map?)?['nickname']),
          description: _text(item['description']),
          trackCount: _int(item['trackCount']),
          playCount: _int(item['playCount']),
        ),
    ];
  }

  static Future<List<PlaylistSummary>> _featuredMg(
    int page,
    int limit,
    String categoryId,
    SdkJsonLoader load,
  ) async {
    final body = await load(
      'https://app.c.nf.migu.cn/pc/bmw/page-data/'
      'playlist-square-recommend/v1.0?templateVersion=2&pageNo=$page',
      headers: _miguHeaders,
    );
    final data = body is Map ? body['data'] : null;
    if (body is! Map || body['code'] != '000000' || data is! Map) {
      throw Exception('咪咕精选歌单加载失败');
    }
    final out = <PlaylistSummary>[];
    void visit(Object? node) {
      if (out.length >= limit) return;
      if (node is List) {
        for (final child in node) {
          visit(child);
          if (out.length >= limit) break;
        }
        return;
      }
      if (node is! Map) return;
      if (node['resType']?.toString() == '2021') {
        out.add(
          PlaylistSummary(
            id: node['resId']?.toString() ?? '',
            name: node['txt']?.toString() ?? '',
            source: MusicSource.mg,
            coverUrl: _image(node['img']),
            description: _text(node['txt2']),
          ),
        );
      }
      visit(node['contents']);
    }

    visit(data['contents']);
    return out;
  }

  static String? _text(Object? raw) {
    final value = raw?.toString().trim();
    return value == null || value.isEmpty ? null : value;
  }

  static int? _int(Object? raw) => raw is num
      ? raw.toInt()
      : int.tryParse(raw?.toString().replaceAll(RegExp(r'[^0-9]'), '') ?? '');

  static String? _image(Object? raw) {
    var value = _text(raw);
    if (value == null) return null;
    value = value.replaceAll('{size}', '480');
    final candidate = value.startsWith('//') ? 'http:$value' : value;
    final host = Uri.tryParse(candidate)?.host.toLowerCase() ?? '';
    final keepHttp = host == 'kwcdn.kuwo.cn' || host.endsWith('.kwcdn.kuwo.cn');
    if (value.startsWith('//')) {
      value = '${keepHttp ? 'http' : 'https'}:$value';
    } else if (value.startsWith('http://') && !keepHttp) {
      value = value.replaceFirst('http://', 'https://');
    }
    return value;
  }
}
