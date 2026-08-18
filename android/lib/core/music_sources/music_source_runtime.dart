import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../models/enums.dart';
import '../models/music_info.dart';
import '../models/music_url.dart';
import '../sdk/internal/builders.dart';
import '../services/app_logger.dart';
import 'music_source_models.dart';

class MusicSourceRuntimeException implements Exception {
  const MusicSourceRuntimeException(this.message);

  final String message;

  @override
  String toString() => message;
}

class MusicSourceRuntime {
  MusicSourceRuntime(this._dio, {MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(_channelName) {
    _channel.setMethodCallHandler(_handleNativeEvent);
  }

  static const String _channelName = 'twilight_echo/music_source_runtime';
  final Dio _dio;
  final MethodChannel _channel;
  final Map<String, CancelToken> _httpRequests = {};
  Future<void> _operationTail = Future<void>.value();
  String? _loadedSourceKey;

  Future<Map<MusicSource, List<Quality>>> load(
    MusicSourceRecord record,
    String script,
  ) {
    return _runSerialized(() => _load(record, script));
  }

  Future<MusicUrl> resolveWithSource({
    required MusicSourceRecord record,
    required String script,
    required MusicInfo music,
    required Quality quality,
  }) {
    return _runSerialized(() async {
      final sourceKey = _sourceKey(record);
      if (_loadedSourceKey != sourceKey) {
        await _load(record, script);
      }
      return _resolve(music: music, quality: quality);
    });
  }

  Future<Map<MusicSource, List<Quality>>> _load(
    MusicSourceRecord record,
    String script,
  ) async {
    _cancelHttpRequests('music source switched');
    _loadedSourceKey = null;
    try {
      final result = await _channel
          .invokeMapMethod<String, dynamic>('load', {
            'id': record.id,
            'name': record.name,
            'description': record.description,
            'author': record.author,
            'homepage': record.homepage,
            'version': record.version,
            'script': script,
          })
          .timeout(const Duration(seconds: 12));
      if (result == null) {
        throw const MusicSourceRuntimeException('音源没有返回初始化信息');
      }
      final capabilities = MusicSourceRecord.parseRuntimeCapabilities(result);
      _loadedSourceKey = _sourceKey(record);
      return capabilities;
    } on TimeoutException {
      await _disposeRuntime();
      throw const MusicSourceRuntimeException('音源初始化超时');
    } on PlatformException catch (error) {
      _loadedSourceKey = null;
      throw MusicSourceRuntimeException(error.message ?? '音源初始化失败');
    } on MissingPluginException {
      _loadedSourceKey = null;
      throw const MusicSourceRuntimeException('当前平台不支持本地 JS 音源');
    }
  }

  Future<MusicUrl> resolve({
    required MusicInfo music,
    required Quality quality,
  }) {
    return _runSerialized(() => _resolve(music: music, quality: quality));
  }

  Future<MusicUrl> _resolve({
    required MusicInfo music,
    required Quality quality,
  }) async {
    try {
      final result = await _channel
          .invokeMapMethod<String, dynamic>('resolve', {
            'source': music.source.code,
            'quality': quality.code,
            'musicInfo': toOldMusicInfoJson(music, quality: quality),
          })
          .timeout(const Duration(seconds: 35));
      if (result == null || (result['url'] as String? ?? '').trim().isEmpty) {
        throw const MusicSourceRuntimeException('音源没有返回播放地址');
      }
      return MusicUrl(
        url: (result['url'] as String).trim(),
        type: quality,
        fileName: normalizeResolvedFileName(result['fileName']),
      );
    } on TimeoutException {
      throw const MusicSourceRuntimeException('音源解析超时');
    } on PlatformException catch (error) {
      throw MusicSourceRuntimeException(error.message ?? '音源解析失败');
    }
  }

  Future<void> disposeRuntime() {
    return _runSerialized(_disposeRuntime);
  }

  Future<void> _disposeRuntime() async {
    _cancelHttpRequests('music source runtime disposed');
    _loadedSourceKey = null;
    try {
      await _channel.invokeMethod<void>('dispose');
    } on MissingPluginException {
      // Flutter tests and non-Android hosts do not install the native bridge.
    }
  }

  Future<T> _runSerialized<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    _operationTail = _operationTail.then((_) async {
      try {
        result.complete(await operation());
      } catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    });
    return result.future;
  }

  String _sourceKey(MusicSourceRecord record) =>
      '${record.id}:${record.updatedAt.microsecondsSinceEpoch}';

  void _cancelHttpRequests(String reason) {
    for (final token in _httpRequests.values) {
      token.cancel(reason);
    }
    _httpRequests.clear();
  }

  Future<dynamic> _handleNativeEvent(MethodCall call) async {
    if (call.method != 'event' || call.arguments is! Map) return null;
    final event = Map<String, dynamic>.from(call.arguments as Map);
    switch (event['type']) {
      case 'httpRequest':
        unawaited(_handleHttpRequest(event));
      case 'httpCancel':
        _httpRequests.remove(event['requestId'])?.cancel('script canceled');
      case 'log':
        final level = event['level']?.toString() ?? 'log';
        final message = event['message']?.toString() ?? '';
        unawaited(AppLogger.write('music-source', '[$level] $message'));
    }
    return null;
  }

  Future<void> _handleHttpRequest(Map<String, dynamic> event) async {
    final requestId = event['requestId']?.toString() ?? '';
    final rawUrl = event['url']?.toString() ?? '';
    if (requestId.isEmpty) return;
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https')) {
      await _respondHttp(requestId, error: '仅允许 HTTP/HTTPS 请求');
      return;
    }
    final options = event['options'] is Map
        ? Map<String, dynamic>.from(event['options'] as Map)
        : <String, dynamic>{};
    final token = CancelToken();
    _httpRequests[requestId] = token;
    try {
      final binary = options['binary'] == true;
      final timeoutMs = _boundedTimeout(options['timeout']);
      final headers = _headers(options['headers']);
      if (options['form'] is Map && !_hasContentType(headers)) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      final response = await _dio.request<dynamic>(
        rawUrl,
        data: _requestBody(options),
        cancelToken: token,
        options: Options(
          method: options['method']?.toString().toUpperCase() ?? 'GET',
          headers: headers,
          responseType: binary ? ResponseType.bytes : ResponseType.plain,
          sendTimeout: Duration(milliseconds: timeoutMs),
          receiveTimeout: Duration(milliseconds: timeoutMs),
          validateStatus: (_) => true,
        ),
      );
      final body = binary
          ? base64Encode(List<int>.from(response.data as List))
          : _decodeTextBody(response.data?.toString() ?? '');
      await _respondHttp(
        requestId,
        response: {
          'statusCode': response.statusCode ?? 0,
          'statusMessage': response.statusMessage ?? '',
          'headers': response.headers.map.map(
            (key, value) => MapEntry(key, value.join(', ')),
          ),
          'body': body,
          'binary': binary,
          'url': response.realUri.toString(),
          'ok':
              (response.statusCode ?? 0) >= 200 &&
              (response.statusCode ?? 0) < 300,
        },
      );
    } on DioException catch (error) {
      if (!CancelToken.isCancel(error)) {
        await _respondHttp(requestId, error: error.message ?? '网络请求失败');
      }
    } catch (error) {
      await _respondHttp(requestId, error: error.toString());
    } finally {
      _httpRequests.remove(requestId);
    }
  }

  Future<void> _respondHttp(
    String requestId, {
    Map<String, dynamic>? response,
    String? error,
  }) async {
    try {
      await _channel.invokeMethod<void>('httpResponse', {
        'requestId': requestId,
        'response': response,
        'error': error,
      });
    } on MissingPluginException {
      // Runtime was disposed while the request was in flight.
    }
  }

  Object? _requestBody(Map<String, dynamic> options) {
    final bodyBase64 = options['bodyBase64'];
    if (bodyBase64 is String && bodyBase64.isNotEmpty) {
      return base64Decode(bodyBase64);
    }
    if (options['body'] != null) return options['body'];
    final form = options['form'];
    if (form is Map) {
      return form.entries
          .map(
            (entry) =>
                '${Uri.encodeQueryComponent(entry.key.toString())}='
                '${Uri.encodeQueryComponent(entry.value.toString())}',
          )
          .join('&');
    }
    final formData = options['formData'];
    if (formData is Map) {
      return FormData.fromMap(Map<String, dynamic>.from(formData));
    }
    return null;
  }

  Map<String, String> _headers(Object? raw) {
    final result = <String, String>{};
    if (raw is Map) {
      raw.forEach((key, value) => result[key.toString()] = value.toString());
    }
    return result;
  }

  bool _hasContentType(Map<String, String> headers) =>
      headers.keys.any((key) => key.toLowerCase() == 'content-type');

  int _boundedTimeout(Object? raw) {
    final value = raw is num ? raw.toInt() : 15000;
    return value.clamp(1000, 60000);
  }

  Object _decodeTextBody(String body) {
    if (body.length > 4 * 1024 * 1024) {
      throw const MusicSourceRuntimeException('音源网络响应超过 4 MB');
    }
    try {
      return jsonDecode(body) as Object;
    } catch (_) {
      return body;
    }
  }
}

final musicSourceRuntimeProvider = Provider<MusicSourceRuntime>((ref) {
  final runtime = MusicSourceRuntime(ref.watch(apiClientProvider));
  ref.onDispose(() => unawaited(runtime.disposeRuntime()));
  return runtime;
});
