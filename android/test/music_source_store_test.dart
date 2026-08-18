import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_source_store.dart';

const _recordsKey = 'music_source_records_v1';
const _legacyActiveIdKey = 'active_music_source_id_v1';
const _enabledIdsKey = 'enabled_music_source_ids_v2';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory scriptsDirectory;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    scriptsDirectory = await Directory.systemTemp.createTemp(
      'twilight_echo_music_source_store_test_',
    );
  });

  tearDown(() async {
    if (await scriptsDirectory.exists()) {
      await scriptsDirectory.delete(recursive: true);
    }
  });

  test('migrates the legacy active source to enabledIds v2', () async {
    final records = [_record('source-a'), _record('source-b')];
    SharedPreferences.setMockInitialValues({
      _recordsKey: _encodeRecords(records),
      _legacyActiveIdKey: 'source-b',
    });
    final preferences = await SharedPreferences.getInstance();
    final store = _TestMusicSourceStore(preferences, scriptsDirectory);
    await _writeScripts(store, records.map((record) => record.id));

    final state = await store.load();

    expect(state.enabledIds, ['source-b']);
    expect(preferences.getStringList(_enabledIdsKey), ['source-b']);
    expect(preferences.getString(_legacyActiveIdKey), 'source-b');
  });

  test('an explicit empty v2 list does not revive the legacy source', () async {
    final records = [_record('source-a')];
    SharedPreferences.setMockInitialValues({
      _recordsKey: _encodeRecords(records),
      _legacyActiveIdKey: 'source-a',
      _enabledIdsKey: <String>[],
    });
    final preferences = await SharedPreferences.getInstance();
    final store = _TestMusicSourceStore(preferences, scriptsDirectory);
    await _writeScripts(store, records.map((record) => record.id));

    final state = await store.load();

    expect(state.enabledIds, isEmpty);
    expect(preferences.getStringList(_enabledIdsKey), isEmpty);
    expect(preferences.containsKey(_legacyActiveIdKey), isFalse);
  });

  test('normalizes v2 ids while preserving fallback order', () async {
    final records = [
      for (var index = 1; index <= 6; index++) _record('source-$index'),
      _record('source-without-script'),
    ];
    SharedPreferences.setMockInitialValues({
      _recordsKey: _encodeRecords(records),
      _enabledIdsKey: <String>[
        'source-3',
        'missing-source',
        'source-without-script',
        'source-2',
        'source-3',
        'source-6',
        'source-1',
        'source-5',
        'source-4',
      ],
    });
    final preferences = await SharedPreferences.getInstance();
    final store = _TestMusicSourceStore(preferences, scriptsDirectory);
    await _writeScripts(
      store,
      records
          .map((record) => record.id)
          .where((id) => id != 'source-without-script'),
    );

    final state = await store.load();

    expect(state.enabledIds, [
      'source-3',
      'source-2',
      'source-6',
      'source-1',
      'source-5',
    ]);
    expect(
      state.records.map((record) => record.id),
      isNot(contains('source-without-script')),
    );
    expect(preferences.getStringList(_enabledIdsKey), state.enabledIds);
    expect(preferences.getString(_legacyActiveIdKey), 'source-3');
  });

  test('MusicSourceState merges enabled capabilities in priority order', () {
    final first = _record(
      'source-a',
      capabilities: const {
        MusicSource.kw: [Quality.k128, Quality.flac],
        MusicSource.tx: [Quality.k320],
      },
    );
    final second = _record(
      'source-b',
      capabilities: const {
        MusicSource.kw: [Quality.flac, Quality.hires],
        MusicSource.mg: [Quality.k128],
      },
    );
    final disabled = _record(
      'source-c',
      capabilities: const {
        MusicSource.wy: [Quality.k320],
      },
    );
    final state = MusicSourceState(
      records: [second, disabled, first],
      enabledIds: const ['source-a', 'source-b'],
    );

    expect(state.enabledRecords.map((record) => record.id), [
      'source-a',
      'source-b',
    ]);
    expect(state.primary?.id, 'source-a');
    expect(state.priorityOf('source-a'), 1);
    expect(state.priorityOf('source-b'), 2);
    expect(state.priorityOf('source-c'), isNull);
    expect(state.enabledFor(MusicSource.kw).map((record) => record.id), [
      'source-a',
      'source-b',
    ]);

    final capabilities = state.downloadCapabilities;
    expect(capabilities.sources.keys, [
      MusicSource.kw,
      MusicSource.tx,
      MusicSource.mg,
    ]);
    expect(capabilities.sources[MusicSource.kw], [
      Quality.k128,
      Quality.flac,
      Quality.hires,
    ]);
    expect(capabilities.sources[MusicSource.tx], [Quality.k320]);
    expect(capabilities.sources[MusicSource.mg], [Quality.k128]);
    expect(capabilities.sources.containsKey(MusicSource.wy), isFalse);
    expect(capabilities.availableSources, [
      MusicSource.kw,
      MusicSource.tx,
      MusicSource.mg,
    ]);
  });
}

class _TestMusicSourceStore extends MusicSourceStore {
  _TestMusicSourceStore(super.preferences, this.scriptsDirectory);

  final Directory scriptsDirectory;

  @override
  Future<File> scriptFile(String id) async {
    return File('${scriptsDirectory.path}${Platform.pathSeparator}$id.js');
  }
}

Future<void> _writeScripts(MusicSourceStore store, Iterable<String> ids) async {
  for (final id in ids) {
    await store.writeScript(id, '// $id');
  }
}

String _encodeRecords(Iterable<MusicSourceRecord> records) {
  return jsonEncode(records.map((record) => record.toJson()).toList());
}

MusicSourceRecord _record(
  String id, {
  Map<MusicSource, List<Quality>> capabilities = const {},
}) {
  final importedAt = DateTime.utc(2026, 7, 31);
  return MusicSourceRecord(
    id: id,
    name: id,
    description: '',
    author: 'Test',
    homepage: '',
    version: '1.0.0',
    origin: 'test',
    importedAt: importedAt,
    updatedAt: importedAt,
    capabilities: capabilities,
  );
}
