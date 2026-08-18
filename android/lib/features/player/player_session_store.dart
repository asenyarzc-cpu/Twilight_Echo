import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'player_session_snapshot.dart';

const String playerSessionSnapshotStorageKey = 'player_session_snapshot_v1';
const String playerSessionCheckpointStorageKey = 'player_session_checkpoint_v1';

class PlayerSessionStore {
  PlayerSessionStore(this._prefs);

  final SharedPreferences _prefs;

  PlayerSessionSnapshot? read() {
    final snapshot = _readSnapshot();
    if (snapshot == null) return null;

    final checkpoint = _readCheckpoint();
    return checkpoint == null ? snapshot : snapshot.applyCheckpoint(checkpoint);
  }

  Future<void> writeSnapshot(PlayerSessionSnapshot snapshot) async {
    // A checkpoint for the same track may be older than this structural save.
    // Remove it first so it cannot override the newly written position.
    await _prefs.remove(playerSessionCheckpointStorageKey);
    await _prefs.setString(
      playerSessionSnapshotStorageKey,
      jsonEncode(snapshot.toJson()),
    );
  }

  Future<void> writeCheckpoint(PlayerSessionCheckpoint checkpoint) async {
    await _prefs.setString(
      playerSessionCheckpointStorageKey,
      jsonEncode(checkpoint.toJson()),
    );
  }

  Future<void> clear() async {
    await _prefs.remove(playerSessionCheckpointStorageKey);
    await _prefs.remove(playerSessionSnapshotStorageKey);
  }

  PlayerSessionSnapshot? _readSnapshot() {
    try {
      final raw = _prefs.getString(playerSessionSnapshotStorageKey);
      if (raw == null || raw.trim().isEmpty) return null;
      return PlayerSessionSnapshot.tryFromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  PlayerSessionCheckpoint? _readCheckpoint() {
    try {
      final raw = _prefs.getString(playerSessionCheckpointStorageKey);
      if (raw == null || raw.trim().isEmpty) return null;
      return PlayerSessionCheckpoint.tryFromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }
}
