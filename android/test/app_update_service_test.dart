import 'dart:convert';

import 'package:twilight_echo/core/services/app_update_service.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pub_semver/pub_semver.dart';

void main() {
  group('app version comparison', () {
    test('accepts a v-prefixed semantic version', () {
      expect(parseAppVersion('v1.2.3'), Version(1, 2, 3));
      expect(parseAppVersion('V2.0.0'), Version(2, 0, 0));
    });

    test('compares semantic components instead of version text', () {
      expect(
        isNewerAppVersion(currentVersion: '1.9.9', latestVersion: '1.10.0'),
        isTrue,
      );
    });

    test('does not report an equal version as newer', () {
      expect(
        isNewerAppVersion(currentVersion: '1.10.0', latestVersion: 'v1.10.0'),
        isFalse,
      );
    });

    test('ignores build metadata when comparing app versions', () {
      expect(parseAppVersion('1.2.3+42'), Version(1, 2, 3));
      expect(
        isNewerAppVersion(currentVersion: '1.2.3+1', latestVersion: '1.2.3+99'),
        isFalse,
      );
    });

    test('rejects invalid versions without throwing', () {
      expect(parseAppVersion('not-a-version'), isNull);
      expect(parseAppVersion('v'), isNull);
      expect(
        isNewerAppVersion(currentVersion: 'invalid', latestVersion: '2.0.0'),
        isFalse,
      );
      expect(
        isNewerAppVersion(currentVersion: '1.0.0', latestVersion: 'invalid'),
        isFalse,
      );
    });
  });

  group('AppUpdateService', () {
    test('parses a valid latest release response', () async {
      final dio = _dioReturning({
        'tag_name': 'v1.10.0',
        'html_url':
            'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/v1.10.0',
        'name': 'Twilight Echo 1.10.0',
        'draft': false,
        'prerelease': false,
      });
      addTearDown(dio.close);

      final release = await AppUpdateService(dio: dio).fetchLatestRelease();

      expect(release, isNotNull);
      expect(release!.version, Version(1, 10, 0));
      expect(release.tagName, 'v1.10.0');
      expect(release.title, 'Twilight Echo 1.10.0');
      expect(
        release.pageUri,
        Uri.parse(
          'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/v1.10.0',
        ),
      );
    });

    for (final field in ['draft', 'prerelease']) {
      test('ignores a $field release', () async {
        final dio = _dioReturning({
          'tag_name': 'v2.0.0',
          'html_url':
              'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/v2.0.0',
          field: true,
        });
        addTearDown(dio.close);

        expect(await AppUpdateService(dio: dio).fetchLatestRelease(), isNull);
      });
    }

    test('rejects a response that is not a JSON object', () async {
      final dio = _dioReturning(['v2.0.0']);
      addTearDown(dio.close);

      await expectLater(
        AppUpdateService(dio: dio).fetchLatestRelease(),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects invalid release fields', () async {
      final dio = _dioReturning({
        'tag_name': 'invalid',
        'html_url':
            'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/invalid',
      });
      addTearDown(dio.close);

      await expectLater(
        AppUpdateService(dio: dio).fetchLatestRelease(),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects a release URL outside the project GitHub releases', () async {
      final dio = _dioReturning({
        'tag_name': 'v2.0.0',
        'html_url': 'https://example.com/releases/tag/v2.0.0',
      });
      addTearDown(dio.close);

      await expectLater(
        AppUpdateService(dio: dio).fetchLatestRelease(),
        throwsA(isA<FormatException>()),
      );
    });
  });
}

Dio _dioReturning(Object? responseData) {
  return Dio(BaseOptions(baseUrl: 'https://api.github.com'))
    ..httpClientAdapter = _FakeAdapter(responseData);
}

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.responseData);

  final Object? responseData;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    expect(
      options.uri,
      Uri.parse(
        'https://api.github.com/repos/asenyarzc-cpu/Twilight_Echo/releases/latest',
      ),
    );
    return ResponseBody.fromString(
      jsonEncode(responseData),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
