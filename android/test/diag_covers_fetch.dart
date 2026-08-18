// Try fetching each platform's cover URL with default headers to see who
// 403s without referer. Run:
//   dart test test/diag_covers_fetch.dart -r expanded

import 'package:dio/dio.dart';
import 'package:test/test.dart';

const _urls = {
  'MG webp':
      'http://d.musicapp.migu.cn/data/oss/resource/00/4t/9y/679feb591df148ddbc1e98110cd108de.webp',
  'WY jpg ':
      'http://p1.music.126.net/rM6PP_YrU0HjFes4jggIOw==/109951172445882513.jpg',
  'TX jpg ':
      'https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg',
};

Future<void> probe(String label, String url, {String? referer}) async {
  final dio = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
      followRedirects: true,
      validateStatus: (s) => true,
    ),
  );
  try {
    final headers = <String, String>{
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel)',
    };
    if (referer != null) headers['Referer'] = referer;
    final r = await dio.get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes, headers: headers),
    );
    print(
      '[$label] ref=${referer ?? "-"} status=${r.statusCode} bytes=${r.data?.length} ct=${r.headers.value("content-type")}',
    );
  } catch (e) {
    print('[$label] FAILED: $e');
  }
}

void main() {
  test('Plain GET (no referer)', () async {
    for (final e in _urls.entries) {
      await probe(e.key, e.value);
    }
  });
  test('With music.163.com referer for WY', () async {
    await probe(
      'WY jpg ',
      _urls['WY jpg ']!,
      referer: 'https://music.163.com/',
    );
  });
}

// ignore_for_file: avoid_print
