import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api/dio_factory.dart';
import '../../core/storage/settings_store.dart';

const String _kJinrishiciBaseUrl = 'https://v2.jinrishici.com';
const String _kJinrishiciTokenKey = 'startup_jinrishici_token';

@immutable
class StartupPoem {
  const StartupPoem({
    required this.content,
    this.title,
    this.dynasty,
    this.author,
  });

  final String content;
  final String? title;
  final String? dynasty;
  final String? author;
}

const List<StartupPoem> kFallbackStartupPoems = [
  StartupPoem(
    content: '海上生明月，天涯共此时。',
    title: '望月怀远',
    dynasty: '唐代',
    author: '张九龄',
  ),
  StartupPoem(
    content: '行到水穷处，坐看云起时。',
    title: '终南别业',
    dynasty: '唐代',
    author: '王维',
  ),
  StartupPoem(
    content: '春江潮水连海平，海上明月共潮生。',
    title: '春江花月夜',
    dynasty: '唐代',
    author: '张若虚',
  ),
  StartupPoem(
    content: '月落乌啼霜满天，江枫渔火对愁眠。',
    title: '枫桥夜泊',
    dynasty: '唐代',
    author: '张继',
  ),
  StartupPoem(
    content: '醉后不知天在水，满船清梦压星河。',
    title: '题龙阳县青草湖',
    dynasty: '元代',
    author: '唐珙',
  ),
  StartupPoem(
    content: '不畏浮云遮望眼，自缘身在最高层。',
    title: '登飞来峰',
    dynasty: '宋代',
    author: '王安石',
  ),
];

StartupPoem randomFallbackStartupPoem([Random? random]) {
  final source = random ?? Random();
  return kFallbackStartupPoems[source.nextInt(kFallbackStartupPoems.length)];
}

class JinrishiciClient {
  const JinrishiciClient({required Dio dio, required SharedPreferences prefs})
    : _dio = dio,
      _prefs = prefs;

  final Dio _dio;
  final SharedPreferences _prefs;

  Future<StartupPoem> fetchOneSentence() async {
    final token = await _ensureToken();
    final response = await _dio.get<dynamic>(
      '/sentence',
      options: Options(headers: {'X-User-Token': token}),
    );
    final payload = _mapFrom(response.data);
    if (_text(payload['status']) != 'success') {
      throw const FormatException('jinrishici sentence request failed');
    }

    final data = _mapFrom(payload['data']);
    final content = _text(data['content']);
    if (content == null) {
      throw const FormatException('jinrishici sentence content is empty');
    }

    final returnedToken = _text(payload['token']);
    if (returnedToken != null && returnedToken != token) {
      await _prefs.setString(_kJinrishiciTokenKey, returnedToken);
    }

    final origin = _mapFrom(data['origin'], allowEmpty: true);
    return StartupPoem(
      content: content,
      title: _text(origin['title']),
      dynasty: _text(origin['dynasty']),
      author: _text(origin['author']),
    );
  }

  Future<String> _ensureToken() async {
    final savedToken = _text(_prefs.getString(_kJinrishiciTokenKey));
    if (savedToken != null) return savedToken;

    final response = await _dio.get<dynamic>('/token');
    final payload = _mapFrom(response.data);
    if (_text(payload['status']) != 'success') {
      throw const FormatException('jinrishici token request failed');
    }

    final token = _text(payload['data']);
    if (token == null) {
      throw const FormatException('jinrishici token is empty');
    }
    await _prefs.setString(_kJinrishiciTokenKey, token);
    return token;
  }
}

final jinrishiciClientProvider = Provider<JinrishiciClient>((ref) {
  final adapterMode = ref.watch(
    settingsProvider.select((settings) => settings.networkAdapterMode),
  );
  final dio = createDio(
    BaseOptions(
      baseUrl: _kJinrishiciBaseUrl,
      connectTimeout: const Duration(seconds: 4),
      sendTimeout: const Duration(seconds: 4),
      receiveTimeout: const Duration(seconds: 5),
      headers: const {
        'Accept': 'application/json',
        'User-Agent': kMobileUserAgent,
      },
      responseType: ResponseType.json,
    ),
    adapterMode: adapterMode,
  );
  ref.onDispose(dio.close);
  return JinrishiciClient(
    dio: dio,
    prefs: ref.watch(sharedPreferencesProvider),
  );
});

Map<String, dynamic> _mapFrom(Object? value, {bool allowEmpty = false}) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, value) => MapEntry(key.toString(), value));
  }
  if (allowEmpty && value == null) return const {};
  throw const FormatException('expected JSON object');
}

String? _text(Object? value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}
