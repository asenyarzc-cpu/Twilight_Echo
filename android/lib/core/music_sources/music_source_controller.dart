import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/download_capabilities.dart';
import 'music_source_metadata_parser.dart';
import 'music_source_models.dart';
import 'music_source_runtime.dart';
import 'music_source_store.dart';

class MusicSourceController extends AsyncNotifier<MusicSourceState> {
  MusicSourceStore get _store => ref.read(musicSourceStoreProvider);
  MusicSourceRuntime get _runtime => ref.read(musicSourceRuntimeProvider);

  @override
  Future<MusicSourceState> build() async {
    // Imported scripts were validated before they were enabled. Loading them
    // lazily avoids initializing up to five QuickJS contexts during startup.
    return _store.load();
  }

  Future<MusicSourceRecord> importScript({
    required String script,
    required String origin,
  }) async {
    final current = await future;
    final metadata = parseMusicSourceMetadata(script);
    final id = musicSourceId(metadata);
    MusicSourceRecord? previous;
    for (final record in current.records) {
      if (record.id == id) previous = record;
    }
    if (previous == null && current.records.length >= kMaxMusicSourceCount) {
      throw const MusicSourceRuntimeException('最多只能保存 20 个音源');
    }
    final now = DateTime.now();
    final record = MusicSourceRecord(
      id: id,
      name: metadata.name,
      description: metadata.description,
      author: metadata.author,
      homepage: metadata.homepage,
      version: metadata.version,
      origin: origin,
      importedAt: previous?.importedAt ?? now,
      updatedAt: now,
      capabilities: previous?.capabilities ?? const {},
    );
    await _store.writeScript(id, script);
    final records = previous == null
        ? [...current.records, record]
        : _replace(current.records, record);
    final next = current.copyWith(records: List.unmodifiable(records));
    state = AsyncData(next);
    await _store.save(next);
    if (current.isEnabled(id) ||
        current.enabledIds.length < kMaxEnabledMusicSourceCount) {
      await activate(id);
    } else {
      await _validateInactive(record);
    }
    return state.requireValue.records.firstWhere((item) => item.id == id);
  }

  Future<void> activate(String id) async {
    final current = await future;
    final record = current.records.firstWhere(
      (item) => item.id == id,
      orElse: () => throw const MusicSourceRuntimeException('音源不存在'),
    );
    final alreadyEnabled = current.isEnabled(id);
    if (!alreadyEnabled &&
        current.enabledIds.length >= kMaxEnabledMusicSourceCount) {
      throw const MusicSourceRuntimeException('最多同时启用 5 个音源');
    }
    state = AsyncData(current.copyWith(activatingId: id));
    try {
      final script = await _store.readScript(id);
      final ready = await _validate(record, script);
      final next = current.copyWith(
        records: _replace(current.records, ready),
        enabledIds: alreadyEnabled
            ? current.enabledIds
            : List.unmodifiable([...current.enabledIds, id]),
        clearActivating: true,
      );
      state = AsyncData(next);
      await _store.save(next);
    } catch (error) {
      await _runtime.disposeRuntime();
      final failed = record.copyWith(lastError: error.toString());
      final next = current.copyWith(
        records: _replace(current.records, failed),
        enabledIds: List.unmodifiable(
          current.enabledIds.where((enabledId) => enabledId != id),
        ),
        clearActivating: true,
      );
      state = AsyncData(next);
      await _store.save(next);
      rethrow;
    }
  }

  Future<void> _validateInactive(MusicSourceRecord record) async {
    final current = await future;
    state = AsyncData(current.copyWith(activatingId: record.id));
    try {
      final script = await _store.readScript(record.id);
      final ready = await _validate(record, script);
      final next = current.copyWith(
        records: _replace(current.records, ready),
        clearActivating: true,
      );
      state = AsyncData(next);
      await _store.save(next);
    } catch (error) {
      final failed = record.copyWith(lastError: error.toString());
      final next = current.copyWith(
        records: _replace(current.records, failed),
        clearActivating: true,
      );
      state = AsyncData(next);
      await _store.save(next);
      rethrow;
    }
  }

  Future<MusicSourceRecord> _validate(
    MusicSourceRecord record,
    String script,
  ) async {
    final capabilities = await _runtime.load(record, script);
    if (capabilities.isEmpty) {
      throw const MusicSourceRuntimeException('音源没有声明可用的 musicUrl 能力');
    }
    return record.copyWith(capabilities: capabilities, clearLastError: true);
  }

  Future<void> deactivate(String id) async {
    final current = await future;
    if (!current.isEnabled(id)) return;
    await _runtime.disposeRuntime();
    final next = current.copyWith(
      enabledIds: List.unmodifiable(
        current.enabledIds.where((enabledId) => enabledId != id),
      ),
      clearActivating: current.activatingId == id,
    );
    state = AsyncData(next);
    await _store.save(next);
  }

  Future<void> remove(String id) async {
    final current = await future;
    if (current.isEnabled(id)) await _runtime.disposeRuntime();
    await _store.deleteScript(id);
    final next = current.copyWith(
      records: List.unmodifiable(
        current.records.where((record) => record.id != id),
      ),
      enabledIds: List.unmodifiable(
        current.enabledIds.where((enabledId) => enabledId != id),
      ),
      clearActivating: current.activatingId == id,
    );
    state = AsyncData(next);
    await _store.save(next);
  }

  List<MusicSourceRecord> _replace(
    List<MusicSourceRecord> records,
    MusicSourceRecord replacement,
  ) {
    return List.unmodifiable([
      for (final record in records)
        if (record.id == replacement.id) replacement else record,
    ]);
  }
}

final musicSourceControllerProvider =
    AsyncNotifierProvider<MusicSourceController, MusicSourceState>(
      MusicSourceController.new,
    );

final downloadCapabilitiesProvider = Provider<AsyncValue<DownloadCapabilities>>(
  (ref) {
    return ref
        .watch(musicSourceControllerProvider)
        .whenData((state) => state.downloadCapabilities);
  },
);
