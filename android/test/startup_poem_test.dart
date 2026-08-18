import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/startup/jinrishici_client.dart';
import 'package:twilight_echo/features/startup/startup_gate.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('fetchOneSentence generates and caches token', () async {
    final prefs = await SharedPreferences.getInstance();
    final requests = <RequestOptions>[];
    final dio =
        Dio(
            BaseOptions(
              baseUrl: 'https://v2.jinrishici.com',
              responseType: ResponseType.json,
            ),
          )
          ..httpClientAdapter = _FakeAdapter((options) {
            requests.add(options);
            if (options.path == '/token') {
              return {'status': 'success', 'data': 'token-a'};
            }
            expect(options.path, '/sentence');
            expect(options.headers['X-User-Token'], 'token-a');
            return {
              'status': 'success',
              'token': 'token-a',
              'data': {
                'content': '海上生明月，天涯共此时。',
                'origin': {'title': '望月怀远', 'dynasty': '唐代', 'author': '张九龄'},
              },
            };
          });

    final poem = await JinrishiciClient(
      dio: dio,
      prefs: prefs,
    ).fetchOneSentence();

    expect(poem.content, '海上生明月，天涯共此时。');
    expect(poem.title, '望月怀远');
    expect(prefs.getString('startup_jinrishici_token'), 'token-a');
    expect(requests.map((request) => request.path), ['/token', '/sentence']);
  });

  test('fetchOneSentence reuses cached token', () async {
    SharedPreferences.setMockInitialValues({
      'startup_jinrishici_token': 'cached-token',
    });
    final prefs = await SharedPreferences.getInstance();
    final requests = <RequestOptions>[];
    final dio =
        Dio(
            BaseOptions(
              baseUrl: 'https://v2.jinrishici.com',
              responseType: ResponseType.json,
            ),
          )
          ..httpClientAdapter = _FakeAdapter((options) {
            requests.add(options);
            expect(options.path, '/sentence');
            expect(options.headers['X-User-Token'], 'cached-token');
            return {
              'status': 'success',
              'token': 'cached-token',
              'data': {'content': '行到水穷处，坐看云起时。'},
            };
          });

    final poem = await JinrishiciClient(
      dio: dio,
      prefs: prefs,
    ).fetchOneSentence();

    expect(poem.content, '行到水穷处，坐看云起时。');
    expect(requests.map((request) => request.path), ['/sentence']);
  });

  testWidgets('StartupGate shows poem instead of old music download subtitle', (
    tester,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    final dio =
        Dio(
            BaseOptions(
              baseUrl: 'https://v2.jinrishici.com',
              responseType: ResponseType.json,
            ),
          )
          ..httpClientAdapter = _FakeAdapter((options) {
            if (options.path == '/token') {
              return {'status': 'success', 'data': 'token-b'};
            }
            return {
              'status': 'success',
              'token': 'token-b',
              'data': {
                'content': '春江潮水连海平，海上明月共潮生。',
                'origin': {'author': '张若虚'},
              },
            };
          });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          jinrishiciClientProvider.overrideWithValue(
            JinrishiciClient(dio: dio, prefs: prefs),
          ),
        ],
        child: const MaterialApp(home: StartupGate(child: SizedBox.shrink())),
      ),
    );
    await tester.pump();

    expect(find.text('音乐下载'), findsNothing);
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('春江潮水连海平，海上明月共潮生。'), findsOneWidget);
    expect(find.text('-- 张若虚'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pump(const Duration(milliseconds: 700));
  });
}

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this._handler);

  final Object? Function(RequestOptions options) _handler;
  bool _closed = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (_closed) throw StateError('adapter closed');
    return ResponseBody.fromString(
      jsonEncode(_handler(options)),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {
    _closed = true;
  }
}
