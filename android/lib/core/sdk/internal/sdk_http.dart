import 'dart:convert';

import 'package:dio/dio.dart';

import '../../api/dio_factory.dart';

typedef SdkJsonLoader =
    Future<dynamic> Function(String url, {Map<String, String>? headers});

class SdkHttp {
  SdkHttp._();

  static final Dio _dio = createDio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      sendTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      headers: const {'User-Agent': kMobileUserAgent},
      responseType: ResponseType.json,
    ),
  );
  static NetworkAdapterMode _configuredAdapterMode =
      NetworkAdapterPreference.current;

  static Future<HttpResult<T>> fetch<T>(
    String url, {
    String method = 'GET',
    Map<String, String>? headers,
    Object? body,
    Map<String, Object?>? form,
    ResponseType responseType = ResponseType.json,
    CancelToken? cancelToken,
    bool? followRedirects,
    ValidateStatus? validateStatus,
  }) async {
    final mergedHeaders = <String, String>{...?headers};
    dynamic payload;
    if (form != null) {
      mergedHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = form.entries
          .where((e) => e.value != null)
          .map(
            (e) =>
                '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value.toString())}',
          )
          .join('&');
    } else if (body != null) {
      mergedHeaders['Content-Type'] = 'application/json';
      payload = body is String ? body : jsonEncode(body);
    }

    _syncAdapterPreference();
    final response = await _dio.request<dynamic>(
      url,
      data: payload,
      cancelToken: cancelToken,
      options: Options(
        method: method,
        headers: mergedHeaders,
        responseType: responseType,
        followRedirects: followRedirects,
        validateStatus: validateStatus,
      ),
    );

    return HttpResult(
      body: response.data as T,
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      realUri: response.realUri,
    );
  }

  // Convenience: GET and try to parse JSON; if not JSON, returns string body.
  static Future<dynamic> getJson(
    String url, {
    Map<String, String>? headers,
    CancelToken? cancelToken,
  }) async {
    final result = await fetch<dynamic>(
      url,
      headers: headers,
      cancelToken: cancelToken,
      responseType: ResponseType.plain,
    );
    final raw = result.body;
    if (raw is String) {
      try {
        return jsonDecode(raw);
      } catch (_) {
        return raw;
      }
    }
    return raw;
  }

  static Future<String> getText(
    String url, {
    Map<String, String>? headers,
    CancelToken? cancelToken,
  }) async {
    final result = await fetch<dynamic>(
      url,
      headers: headers,
      cancelToken: cancelToken,
      responseType: ResponseType.plain,
    );
    return result.body?.toString() ?? '';
  }

  static Future<Uri?> resolveRedirectLocation(
    String url, {
    Map<String, String>? headers,
    CancelToken? cancelToken,
  }) async {
    final result = await fetch<dynamic>(
      url,
      headers: headers,
      cancelToken: cancelToken,
      followRedirects: false,
      validateStatus: (status) => status != null && status < 400,
      responseType: ResponseType.plain,
    );
    final location = result.headers.value('location');
    if (location == null || location.trim().isEmpty) {
      return result.realUri;
    }
    return result.realUri.resolve(location);
  }

  static void _syncAdapterPreference() {
    final next = NetworkAdapterPreference.current;
    if (_configuredAdapterMode == next) return;
    _dio.httpClientAdapter.close(force: false);
    configurePlatformAdapter(_dio, adapterMode: next);
    _configuredAdapterMode = next;
  }
}

class HttpResult<T> {
  HttpResult({
    required this.body,
    required this.statusCode,
    required this.headers,
    required this.realUri,
  });
  final T body;
  final int statusCode;
  final Headers headers;
  final Uri realUri;
}
