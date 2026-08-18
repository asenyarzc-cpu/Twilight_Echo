// Dump raw search response fields for KW and KG so we can find a usable
// cover field that is already in the search payload.
//
//   dart test test/diag_kw_kg_raw.dart -r expanded

import 'package:test/test.dart';

import 'package:twilight_echo/core/sdk/internal/sdk_http.dart';

void main() {
  test('KW search raw fields', () async {
    final body = await SdkHttp.getJson(
      'https://search.kuwo.cn/r.s?client=kt&all=${Uri.encodeComponent("Jay Chou")}'
      '&pn=0&rn=3&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1'
      '&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012'
      '&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1',
    );
    final list = body is Map ? body['abslist'] as List? : null;
    if (list == null || list.isEmpty) {
      print('[KW] empty result');
      return;
    }
    final first = list.first as Map;
    print('[KW] top keys=${first.keys.toList()}');
    for (final k in first.keys.where(
      (k) =>
          k.toString().toUpperCase().contains('PIC') ||
          k.toString().toUpperCase().contains('IMG') ||
          k.toString().toUpperCase().contains('ALBUM') ||
          k.toString().toUpperCase().contains('COVER'),
    )) {
      print('  $k = ${first[k]}');
    }
  });

  test('KG search raw fields', () async {
    final body = await SdkHttp.getJson(
      'https://songsearch.kugou.com/song_search_v2?keyword=${Uri.encodeComponent("Jay Chou")}'
      '&page=1&pagesize=3&userid=0&clientver=&platform=WebFilter'
      '&filter=2&iscorrection=1&privilege_filter=0&area_code=1',
    );
    final list = body is Map ? (body['data']?['lists'] as List?) : null;
    if (list == null || list.isEmpty) {
      print('[KG] empty result');
      return;
    }
    final first = list.first as Map;
    print('[KG] top keys count=${first.keys.length}');
    print('  Image = ${first['Image']}');
    print('  AlbumID = ${first['AlbumID']}');
    print('  Audioid = ${first['Audioid']}');
    print('  FileHash = ${first['FileHash']}');
  });
}

// ignore_for_file: avoid_print
