// Try common KW album cover URL patterns to find one that returns 200.
//
//   dart test test/diag_kw_pic.dart -r expanded

import 'package:dio/dio.dart';
import 'package:test/test.dart';

void main() {
  test('KW pic URL patterns', () async {
    const short = '120/s3s94/93/211513640.jpg';
    final candidates = [
      'https://img1.kuwo.cn/star/albumcover/$short',
      'https://img2.kuwo.cn/star/albumcover/$short',
      'https://img3.kuwo.cn/star/albumcover/$short',
      'https://img4.kuwo.cn/star/albumcover/$short',
      'http://img2.kuwo.cn/star/albumcover/$short',
    ];
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 8),
        followRedirects: true,
        validateStatus: (s) => true,
      ),
    );
    for (final url in candidates) {
      try {
        final r = await dio.head(url);
        print('[$url] -> ${r.statusCode} ${r.headers.value("content-type")}');
      } catch (e) {
        print('[$url] -> FAILED $e');
      }
    }
  });

  test('KG pic with size replacement', () async {
    const template =
        'http://imge.kugou.com/stdmusic/{size}/20230920/20230920142503632013.jpg';
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 8),
        followRedirects: true,
        validateStatus: (s) => true,
      ),
    );
    for (final size in ['150', '240', '400', '480']) {
      final url = template.replaceAll('{size}', size);
      try {
        final r = await dio.head(url);
        print('[$size] $url -> ${r.statusCode}');
      } catch (e) {
        print('[$size] $url -> FAILED $e');
      }
    }
  });
}

// ignore_for_file: avoid_print
