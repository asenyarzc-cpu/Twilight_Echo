import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../storage/settings_store.dart';
import 'music_source_models.dart';

const String _recordsKey = 'music_source_records_v1';
const String _activeIdKey = 'active_music_source_id_v1';
const String _enabledIdsKey = 'enabled_music_source_ids_v2';

class MusicSourceStore {
  MusicSourceStore(this._preferences);

  final SharedPreferences _preferences;

  Future<MusicSourceState> load() async {
    final records = <MusicSourceRecord>[];
    final raw = _preferences.getString(_recordsKey);
    if (raw != null && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          for (final item in decoded) {
            if (item is Map) {
              final record = MusicSourceRecord.fromJson(
                Map<String, dynamic>.from(item),
              );
              final file = await scriptFile(record.id);
              if (record.id.isNotEmpty && await file.exists()) {
                records.add(record);
              }
            }
          }
        }
      } catch (_) {
        // A corrupt index must not prevent the app from starting.
      }
    }
    final availableIds = records.map((record) => record.id).toSet();
    final storedEnabledIds = _preferences.getStringList(_enabledIdsKey);
    final enabledIds = <String>[];
    if (storedEnabledIds == null) {
      final storedActiveId = _preferences.getString(_activeIdKey);
      if (storedActiveId != null && availableIds.contains(storedActiveId)) {
        enabledIds.add(storedActiveId);
      }
    } else {
      for (final id in storedEnabledIds) {
        if (availableIds.contains(id) &&
            !enabledIds.contains(id) &&
            enabledIds.length < kMaxEnabledMusicSourceCount) {
          enabledIds.add(id);
        }
      }
    }
    final state = MusicSourceState(
      records: List.unmodifiable(records),
      enabledIds: List.unmodifiable(enabledIds),
    );
    await save(state);
    return state;
  }

  Future<void> save(MusicSourceState state) async {
    await _preferences.setString(
      _recordsKey,
      jsonEncode(state.records.map((record) => record.toJson()).toList()),
    );
    await _preferences.setStringList(_enabledIdsKey, state.enabledIds);
    final primaryId = state.enabledIds.isEmpty ? null : state.enabledIds.first;
    if (primaryId == null) {
      await _preferences.remove(_activeIdKey);
    } else {
      await _preferences.setString(_activeIdKey, primaryId);
    }
  }

  Future<void> writeScript(String id, String script) async {
    final target = await scriptFile(id);
    await target.parent.create(recursive: true);
    final temporary = File('${target.path}.tmp');
    await temporary.writeAsString(script, flush: true);
    if (await target.exists()) await target.delete();
    await temporary.rename(target.path);
  }

  Future<String> readScript(String id) async {
    final file = await scriptFile(id);
    if (!await file.exists()) throw const FileSystemException('音源脚本文件不存在');
    return file.readAsString();
  }

  Future<void> deleteScript(String id) async {
    final file = await scriptFile(id);
    if (await file.exists()) await file.delete();
  }

  Future<File> scriptFile(String id) async {
    final support = await getApplicationSupportDirectory();
    return File(p.join(support.path, 'music_sources', '$id.js'));
  }
}

final musicSourceStoreProvider = Provider<MusicSourceStore>((ref) {
  return MusicSourceStore(ref.watch(sharedPreferencesProvider));
});
