import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/music_sources/music_source_controller.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_source_runtime.dart';
import 'package:twilight_echo/core/music_sources/music_source_store.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'controller enables at most five sources without changing their order',
    () async {
      final records = [
        for (var index = 1; index <= 6; index++) _record('s$index'),
      ];
      final harness = await _Harness.create(
        MusicSourceState(records: records, enabledIds: const []),
      );
      addTearDown(harness.container.dispose);
      final controller = harness.container.read(
        musicSourceControllerProvider.notifier,
      );

      for (var index = 1; index <= 5; index++) {
        await controller.activate('s$index');
      }
      expect(
        harness.container
            .read(musicSourceControllerProvider)
            .requireValue
            .enabledIds,
        ['s1', 's2', 's3', 's4', 's5'],
      );

      await expectLater(
        controller.activate('s6'),
        throwsA(
          isA<MusicSourceRuntimeException>().having(
            (error) => error.message,
            'message',
            contains('5'),
          ),
        ),
      );
      expect(
        harness.container
            .read(musicSourceControllerProvider)
            .requireValue
            .enabledIds,
        ['s1', 's2', 's3', 's4', 's5'],
      );
    },
  );

  test(
    'one source validation failure does not disable healthy sources',
    () async {
      final records = [_record('first'), _record('broken'), _record('third')];
      final harness = await _Harness.create(
        MusicSourceState(
          records: records,
          enabledIds: const ['first', 'broken', 'third'],
        ),
        failingIds: const {'broken'},
      );
      addTearDown(harness.container.dispose);
      final controller = harness.container.read(
        musicSourceControllerProvider.notifier,
      );

      await expectLater(
        controller.activate('broken'),
        throwsA(isA<MusicSourceRuntimeException>()),
      );
      final state = harness.container
          .read(musicSourceControllerProvider)
          .requireValue;

      expect(state.enabledIds, ['first', 'third']);
      expect(
        state.records.firstWhere((record) => record.id == 'broken').lastError,
        contains('初始化失败'),
      );
    },
  );

  test('deactivating a middle source preserves fallback priority', () async {
    final records = [_record('first'), _record('second'), _record('third')];
    final harness = await _Harness.create(
      MusicSourceState(
        records: records,
        enabledIds: const ['first', 'second', 'third'],
      ),
    );
    addTearDown(harness.container.dispose);
    final controller = harness.container.read(
      musicSourceControllerProvider.notifier,
    );

    await controller.deactivate('second');

    expect(
      harness.container
          .read(musicSourceControllerProvider)
          .requireValue
          .enabledIds,
      ['first', 'third'],
    );
  });
}

class _Harness {
  _Harness(this.container);

  final ProviderContainer container;

  static Future<_Harness> create(
    MusicSourceState initialState, {
    Set<String> failingIds = const <String>{},
  }) async {
    final preferences = await SharedPreferences.getInstance();
    final store = _MemoryStore(preferences, initialState);
    final runtime = _ValidationRuntime(failingIds);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        musicSourceStoreProvider.overrideWithValue(store),
        musicSourceRuntimeProvider.overrideWithValue(runtime),
      ],
    );
    await container.read(musicSourceControllerProvider.future);
    return _Harness(container);
  }
}

class _MemoryStore extends MusicSourceStore {
  _MemoryStore(super.preferences, this.current);

  MusicSourceState current;

  @override
  Future<MusicSourceState> load() async => current;

  @override
  Future<void> save(MusicSourceState state) async {
    current = state;
  }

  @override
  Future<String> readScript(String id) async => 'script:$id';
}

class _ValidationRuntime extends MusicSourceRuntime {
  _ValidationRuntime(this.failingIds)
    : super(Dio(), channel: const MethodChannel('test/controller-runtime'));

  final Set<String> failingIds;

  @override
  Future<Map<MusicSource, List<Quality>>> load(
    MusicSourceRecord record,
    String script,
  ) async {
    if (failingIds.contains(record.id)) {
      throw const MusicSourceRuntimeException('初始化失败');
    }
    return const {
      MusicSource.kw: [Quality.k128],
    };
  }

  @override
  Future<void> disposeRuntime() async {}
}

MusicSourceRecord _record(String id) {
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
    capabilities: const {
      MusicSource.kw: [Quality.k128],
    },
  );
}
