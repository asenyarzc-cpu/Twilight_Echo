import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/api/api_client.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/music_url.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_url_resolver.dart';
import 'package:twilight_echo/core/services/download_service.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/downloads/download_progress.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a CDN 404 retries the next enabled source and completes', () async {
    final root = await Directory.systemTemp.createTemp(
      'twilight_echo-download-fallback-',
    );
    final downloads = Directory('${root.path}${Platform.pathSeparator}music');
    final cache = Directory('${root.path}${Platform.pathSeparator}cache');
    await downloads.create(recursive: true);
    await cache.create(recursive: true);
    addTearDown(() async {
      if (root.existsSync()) await root.delete(recursive: true);
    });

    const pathProviderChannel = MethodChannel(
      'plugins.flutter.io/path_provider',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProviderChannel, (call) async {
          if (call.method == 'getTemporaryDirectory') return cache.path;
          return null;
        });
    addTearDown(() async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pathProviderChannel, null);
    });

    SharedPreferences.setMockInitialValues({'download_dir': downloads.path});
    final preferences = await SharedPreferences.getInstance();
    final adapter = _DownloadAdapter();
    final dio = Dio()..httpClientAdapter = adapter;
    addTearDown(() => dio.close(force: true));
    final resolver = _FallbackResolver([
      _record('broken', '失效源', 'https://audio.test/broken.mp3'),
      _record('working', '可用源', 'https://audio.test/working.mp3'),
    ]);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        apiClientProvider.overrideWithValue(dio),
        musicUrlResolverProvider.overrideWithValue(resolver),
      ],
    );
    addTearDown(container.dispose);

    final result = await container
        .read(downloadServiceProvider)
        .downloadOne(
          music: _music(),
          quality: Quality.k128,
          embed: const EmbedRequest(
            embedCover: false,
            embedLyric: false,
            embedTranslatedLyric: false,
            embedRomanLyric: false,
          ),
        );

    expect(adapter.urls, [
      'https://audio.test/broken.mp3',
      'https://audio.test/working.mp3',
    ]);
    expect(resolver.attemptedIds, ['broken', 'working']);
    expect(resolver.resolveCalled, isFalse);
    expect(File(result.path).readAsBytesSync(), _DownloadAdapter.audioBytes);
    expect(result.path, endsWith('working.mp3'));
    expect(cache.listSync(), isEmpty);
    expect(
      container.read(downloadProgressProvider).tasks.single.stage,
      DownloadStage.done,
    );
  });
}

class _DownloadAdapter implements HttpClientAdapter {
  static const audioBytes = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00];

  final List<String> urls = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final url = options.uri.toString();
    urls.add(url);
    if (url.endsWith('/broken.mp3')) {
      return ResponseBody.fromString(
        'not found',
        404,
        headers: {
          Headers.contentTypeHeader: ['text/plain'],
        },
      );
    }
    return ResponseBody.fromBytes(
      audioBytes,
      200,
      headers: {
        Headers.contentTypeHeader: ['audio/mpeg'],
        Headers.contentLengthHeader: ['${audioBytes.length}'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _FallbackResolver implements MusicUrlResolver {
  _FallbackResolver(this.sources);

  final List<({MusicSourceRecord record, MusicUrl url})> sources;
  final List<String> attemptedIds = [];
  bool resolveCalled = false;

  @override
  Future<Quality> highestQualityFor(MusicInfo music) async => Quality.k128;

  @override
  Future<MusicUrl> resolve({
    required MusicInfo music,
    required Quality quality,
  }) async {
    resolveCalled = true;
    throw StateError('download should use useFirstAvailable');
  }

  @override
  Future<MusicSourceFallbackResult<T>> useFirstAvailable<T>({
    required MusicInfo music,
    required Quality quality,
    required MusicSourceUrlConsumer<T> use,
    Set<String> excludedSourceIds = const <String>{},
    bool Function()? isCancelled,
    bool Function(Object error)? shouldFallbackOnConsumerError,
  }) async {
    final failures = <MusicSourceAttemptFailure>[];
    final attempted = <String>[];
    for (final candidate in sources) {
      final source = candidate.record;
      if (excludedSourceIds.contains(source.id)) continue;
      attempted.add(source.id);
      attemptedIds.add(source.id);
      try {
        final value = await use(source, candidate.url);
        return MusicSourceFallbackResult(
          source: source,
          value: value,
          attemptedSourceIds: List.unmodifiable(attempted),
        );
      } catch (error) {
        if (shouldFallbackOnConsumerError != null &&
            !shouldFallbackOnConsumerError(error)) {
          rethrow;
        }
        failures.add(MusicSourceAttemptFailure(source: source, error: error));
      }
    }
    throw MusicSourceFallbackException(failures);
  }
}

({MusicSourceRecord record, MusicUrl url}) _record(
  String id,
  String name,
  String url,
) {
  return (
    record: MusicSourceRecord(
      id: id,
      name: name,
      description: '',
      author: 'test',
      homepage: '',
      version: '1',
      origin: 'test',
      importedAt: DateTime.utc(2026, 8, 11),
      updatedAt: DateTime.utc(2026, 8, 11),
      capabilities: const {
        MusicSource.wy: [Quality.k128],
      },
    ),
    url: MusicUrl(url: url, type: Quality.k128, fileName: '$id.mp3'),
  );
}

MusicInfo _music() {
  return MusicInfo.fromJson({
    'id': 'fallback-song',
    'name': 'Fallback Song',
    'singer': 'Tester',
    'source': MusicSource.wy.code,
    'interval': '03:00',
    'meta': {
      'songId': 'fallback-song',
      'albumName': 'Test Album',
      'qualitys': [
        {'type': Quality.k128.code, 'size': '6'},
      ],
    },
  });
}
