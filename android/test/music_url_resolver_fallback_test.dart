import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/music_url.dart';
import 'package:twilight_echo/core/music_sources/music_source_controller.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_source_runtime.dart';
import 'package:twilight_echo/core/music_sources/music_source_store.dart';
import 'package:twilight_echo/core/music_sources/music_url_resolver.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'resolver tries every source at requested quality before downgrade',
    () async {
      final first = _record(
        'first',
        qualities: const [Quality.flac, Quality.k128],
      );
      final second = _record(
        'second',
        qualities: const [Quality.flac, Quality.k128],
      );
      final runtime = _FakeRuntime({
        'first:flac': StateError('first source failed'),
        'second:flac': const MusicUrl(
          url: 'https://audio.test/second.flac',
          type: Quality.flac,
        ),
      });
      final container = await _container(
        records: [first, second],
        runtime: runtime,
      );
      addTearDown(container.dispose);

      final result = await container
          .read(musicUrlResolverProvider)
          .resolve(music: _music(), quality: Quality.flac);

      expect(result.url, 'https://audio.test/second.flac');
      expect(runtime.calls, ['first:flac', 'second:flac']);
    },
  );

  test(
    'resolver downgrades after all sources fail the current quality',
    () async {
      final first = _record(
        'first',
        qualities: const [Quality.master, Quality.atmosPlus, Quality.flac],
      );
      final second = _record(
        'second',
        qualities: const [Quality.master, Quality.atmosPlus, Quality.flac],
      );
      final runtime = _FakeRuntime({
        'first:master': StateError('first master failed'),
        'second:master': StateError('second master failed'),
        'first:atmos_plus': const MusicUrl(
          url: 'https://audio.test/first-atmos.flac',
          type: Quality.atmosPlus,
        ),
      });
      final container = await _container(
        records: [first, second],
        runtime: runtime,
      );
      addTearDown(container.dispose);

      final result = await container
          .read(musicUrlResolverProvider)
          .resolve(music: _music(), quality: Quality.master);

      expect(result.type, Quality.atmosPlus);
      expect(runtime.calls, [
        'first:master',
        'second:master',
        'first:atmos_plus',
      ]);
    },
  );

  test('highest quality is selected across all enabled sources', () async {
    final first = _record('first', qualities: const [Quality.k128]);
    final second = _record('second', qualities: const [Quality.master]);
    final container = await _container(
      records: [first, second],
      runtime: _FakeRuntime(const {}),
    );
    addTearDown(container.dispose);

    expect(
      await container
          .read(musicUrlResolverProvider)
          .highestQualityFor(_music()),
      Quality.master,
    );
  });

  test(
    'consumer failure also falls back and intermediate errors stay internal',
    () async {
      final first = _record('first');
      final second = _record('second');
      final runtime = _FakeRuntime({
        first.id: const MusicUrl(url: 'https://audio.test/broken.mp3'),
        second.id: const MusicUrl(url: 'https://audio.test/working.mp3'),
      });
      final container = await _container(
        records: [first, second],
        runtime: runtime,
      );
      addTearDown(container.dispose);
      final loaded = <String>[];

      final result = await container
          .read(musicUrlResolverProvider)
          .useFirstAvailable<String>(
            music: _music(),
            quality: Quality.k128,
            use: (source, url) async {
              loaded.add(source.id);
              if (source.id == first.id) throw StateError('audio load failed');
              return url.url;
            },
          );

      expect(result.source.id, second.id);
      expect(result.value, 'https://audio.test/working.mp3');
      expect(result.attemptedSourceIds, ['first', 'second']);
      expect(loaded, ['first', 'second']);
    },
  );

  test('consumer failures also keep quality before source order', () async {
    final first = _record(
      'first',
      qualities: const [Quality.master, Quality.atmosPlus],
    );
    final second = _record(
      'second',
      qualities: const [Quality.master, Quality.atmosPlus],
    );
    final runtime = _FakeRuntime({
      'first:master': const MusicUrl(
        url: 'https://audio.test/first-master.flac',
        type: Quality.master,
      ),
      'second:master': const MusicUrl(
        url: 'https://audio.test/second-master.flac',
        type: Quality.master,
      ),
      'first:atmos_plus': const MusicUrl(
        url: 'https://audio.test/first-atmos.flac',
        type: Quality.atmosPlus,
      ),
    });
    final container = await _container(
      records: [first, second],
      runtime: runtime,
    );
    addTearDown(container.dispose);
    final consumed = <String>[];

    final result = await container
        .read(musicUrlResolverProvider)
        .useFirstAvailable<Quality>(
          music: _music(),
          quality: Quality.master,
          use: (source, url) async {
            consumed.add('${source.id}:${url.type?.code}');
            if (url.type == Quality.master) {
              throw StateError('audio transfer failed');
            }
            return url.type!;
          },
        );

    expect(result.value, Quality.atmosPlus);
    expect(consumed, ['first:master', 'second:master', 'first:atmos_plus']);
  });

  test(
    'resolver skips unsupported sources and aggregates final failure',
    () async {
      final unsupported = _record('unsupported', source: MusicSource.tx);
      final first = _record('first');
      final second = _record('second');
      final runtime = _FakeRuntime({
        first.id: StateError('resolve failed'),
        second.id: const MusicUrl(url: 'https://audio.test/broken.mp3'),
      });
      final container = await _container(
        records: [unsupported, first, second],
        runtime: runtime,
      );
      addTearDown(container.dispose);

      Object? thrown;
      try {
        await container
            .read(musicUrlResolverProvider)
            .useFirstAvailable<void>(
              music: _music(),
              quality: Quality.k128,
              use: (_, _) async => throw StateError('audio load failed'),
            );
      } catch (error) {
        thrown = error;
      }

      expect(thrown, isA<MusicSourceFallbackException>());
      final failure = thrown! as MusicSourceFallbackException;
      expect(failure.failures.map((item) => item.source.id), [
        'first',
        'second',
      ]);
      expect(runtime.calls, ['first:128k', 'second:128k']);
    },
  );

  test('consumer can stop fallback for a non-source failure', () async {
    final first = _record('first');
    final second = _record('second');
    final runtime = _FakeRuntime({
      first.id: const MusicUrl(url: 'https://audio.test/first.mp3'),
      second.id: const MusicUrl(url: 'https://audio.test/second.mp3'),
    });
    final container = await _container(
      records: [first, second],
      runtime: runtime,
    );
    addTearDown(container.dispose);

    await expectLater(
      container
          .read(musicUrlResolverProvider)
          .useFirstAvailable<void>(
            music: _music(),
            quality: Quality.k128,
            shouldFallbackOnConsumerError: (error) =>
                error is! FileSystemException,
            use: (_, _) async =>
                throw const FileSystemException('disk write failed'),
          ),
      throwsA(isA<FileSystemException>()),
    );

    expect(runtime.calls, ['first:128k']);
  });

  test('runtime serializes source load and resolve as one operation', () async {
    const channel = MethodChannel('test/music-source-serialized');
    final events = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          switch (call.method) {
            case 'load':
              final arguments = Map<String, dynamic>.from(
                call.arguments as Map,
              );
              events.add('load:${arguments['id']}');
              await Future<void>.delayed(const Duration(milliseconds: 10));
              return {
                'sources': {
                  'kw': {
                    'actions': ['musicUrl'],
                    'qualitys': ['128k'],
                  },
                },
              };
            case 'resolve':
              final marker = events.last.startsWith('load:first')
                  ? 'first'
                  : 'second';
              events.add('resolve:$marker');
              await Future<void>.delayed(const Duration(milliseconds: 10));
              return {'url': 'https://audio.test/$marker.mp3'};
            case 'dispose':
              return null;
          }
          return null;
        });
    addTearDown(() async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });
    final runtime = MusicSourceRuntime(Dio(), channel: channel);
    final first = _record('first');
    final second = _record('second');

    final results = await Future.wait([
      runtime.resolveWithSource(
        record: first,
        script: 'first script',
        music: _music(),
        quality: Quality.k128,
      ),
      runtime.resolveWithSource(
        record: second,
        script: 'second script',
        music: _music(),
        quality: Quality.k128,
      ),
    ]);

    expect(results.map((item) => item.url), [
      'https://audio.test/first.mp3',
      'https://audio.test/second.mp3',
    ]);
    expect(events, [
      'load:first',
      'resolve:first',
      'load:second',
      'resolve:second',
    ]);
    await runtime.disposeRuntime();
  });
}

Future<ProviderContainer> _container({
  required List<MusicSourceRecord> records,
  required MusicSourceRuntime runtime,
}) async {
  final preferences = await SharedPreferences.getInstance();
  final state = MusicSourceState(
    records: List.unmodifiable(records),
    enabledIds: List.unmodifiable(records.map((record) => record.id)),
  );
  return ProviderContainer(
    overrides: [
      musicSourceControllerProvider.overrideWith(
        () => _StaticSourceController(state),
      ),
      musicSourceStoreProvider.overrideWithValue(
        _MemorySourceStore(preferences),
      ),
      musicSourceRuntimeProvider.overrideWithValue(runtime),
    ],
  );
}

class _StaticSourceController extends MusicSourceController {
  _StaticSourceController(this.initialState);

  final MusicSourceState initialState;

  @override
  Future<MusicSourceState> build() async => initialState;
}

class _MemorySourceStore extends MusicSourceStore {
  _MemorySourceStore(super.preferences);

  @override
  Future<String> readScript(String id) async => 'script:$id';
}

class _FakeRuntime extends MusicSourceRuntime {
  _FakeRuntime(this.responses)
    : super(Dio(), channel: const MethodChannel('test/fake-source-runtime'));

  final Map<String, Object> responses;
  final List<String> calls = [];

  @override
  Future<MusicUrl> resolveWithSource({
    required MusicSourceRecord record,
    required String script,
    required MusicInfo music,
    required Quality quality,
  }) async {
    calls.add('${record.id}:${quality.code}');
    final response =
        responses['${record.id}:${quality.code}'] ?? responses[record.id];
    if (response is MusicUrl) return response;
    throw response ?? StateError('missing response');
  }

  @override
  Future<void> disposeRuntime() async {}
}

MusicSourceRecord _record(
  String id, {
  MusicSource source = MusicSource.kw,
  List<Quality> qualities = const [Quality.k128],
}) {
  return MusicSourceRecord(
    id: id,
    name: id,
    description: '',
    author: 'test',
    homepage: '',
    version: '1',
    origin: 'test',
    importedAt: DateTime.utc(2026, 7, 31),
    updatedAt: DateTime.utc(2026, 7, 31),
    capabilities: {source: qualities},
  );
}

MusicInfo _music() {
  const qualities = [
    QualityOption(type: Quality.flac),
    QualityOption(type: Quality.k128),
  ];
  return MusicInfo(
    id: 'song-1',
    name: 'Test Song',
    singer: 'Test Singer',
    source: MusicSource.kw,
    interval: '03:00',
    meta: const MusicMeta(
      songId: 'song-1',
      albumName: 'Test Album',
      qualitys: qualities,
      raw: {},
    ),
    raw: const {},
  );
}
