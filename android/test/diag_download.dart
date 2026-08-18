// Diagnostic: exercises the full download path from desktop Dart:
//   1) TX search -> take 1st song
//   2) POST /api/download/resolve to user's server -> get CDN URL
//   3) HEAD the CDN URL to verify it is reachable
//
// Run:
//   dart test test/diag_download.dart -r expanded

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:test/test.dart';

import 'package:twilight_echo/core/sdk/tx_sdk.dart';

const _baseUrl = 'https://example.com';

void main() {
  test('Server /health', () async {
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 15),
      ),
    );
    try {
      final r = await dio.get('$_baseUrl/health');
      print('[health] status=${r.statusCode} body=${r.data}');
    } catch (e) {
      print('[health] FAIL: $e');
      if (e is DioException) {
        print('[health] type=${e.type} message=${e.message}');
        print(
          '[health] response status=${e.response?.statusCode} '
          'body=${e.response?.data}',
        );
      }
      rethrow;
    }
  });

  test(
    'Full download path: TX song -> /api/download/resolve -> CDN HEAD',
    () async {
      final dio = Dio(
        BaseOptions(
          baseUrl: _baseUrl,
          connectTimeout: const Duration(seconds: 15),
          sendTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 60),
          headers: const {'Accept': 'application/json'},
          contentType: 'application/json',
        ),
      );

      const keyword = 'Jay Chou';
      print('[step1] TX search $keyword');
      final songs = await TxSdk.search(keyword);
      expect(songs, isNotEmpty);
      final song = songs.first;
      print('  picked: ${song.name} - ${song.singer} (id=${song.id})');
      print(
        '  qualitys: ${song.meta.qualitys.map((q) => q.type.code).toList()}',
      );
      print(
        '  meta.songId=${song.meta.songId} meta.albumMid=${song.meta.albumMid}',
      );

      final quality = song.bestQuality;
      print('[step2] POST /api/download/resolve quality=${quality.code}');
      final reqBody = {'musicInfo': song.toJson(), 'quality': quality.code};
      final encoded = jsonEncode(reqBody);
      print(
        '  req body (truncated)='
        '${encoded.substring(0, encoded.length < 400 ? encoded.length : 400)}...',
      );

      try {
        final resp = await dio.post<dynamic>(
          '/api/download/resolve',
          data: reqBody,
        );
        print('  status=${resp.statusCode}');
        print('  body=${resp.data}');
        final url = (resp.data is Map ? resp.data['url'] : null) as String?;
        if (url == null || url.isEmpty) {
          fail('server returned empty url; body=${resp.data}');
        }
        print('[step3] HEAD CDN url');
        print('  cdn=$url');
        try {
          final head = await Dio().head(
            url,
            options: Options(
              headers: const {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            ),
          );
          print(
            '  head status=${head.statusCode} '
            'content-length=${head.headers.value('content-length')} '
            'content-type=${head.headers.value('content-type')}',
          );
        } catch (e) {
          print('  HEAD FAILED: $e');
          if (e is DioException) {
            print('  type=${e.type} message=${e.message}');
            print('  response=${e.response?.statusCode} ${e.response?.data}');
          }
        }
      } on DioException catch (e) {
        print(
          '  /api/download/resolve FAILED: '
          'type=${e.type} message=${e.message}',
        );
        print('  response status=${e.response?.statusCode}');
        print('  response body=${e.response?.data}');
        rethrow;
      }
    },
  );
}

// ignore_for_file: avoid_print
