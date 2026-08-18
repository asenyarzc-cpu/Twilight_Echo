import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/features/player/player_session_snapshot.dart';
import 'package:twilight_echo/features/player/player_session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'restores a matching lightweight checkpoint over the full snapshot',
    () async {
      final prefs = await SharedPreferences.getInstance();
      final store = PlayerSessionStore(prefs);
      final snapshot = _snapshot(
        position: const Duration(seconds: 4),
        duration: const Duration(minutes: 3),
      );

      await store.writeSnapshot(snapshot);
      await store.writeCheckpoint(
        PlayerSessionCheckpoint(
          trackId: snapshot.track.id,
          position: const Duration(seconds: 42),
          duration: const Duration(minutes: 3),
        ),
      );

      final restored = PlayerSessionStore(prefs).read();
      expect(restored?.track.id, snapshot.track.id);
      expect(restored?.position, const Duration(seconds: 42));
      expect(restored?.duration, const Duration(minutes: 3));
    },
  );

  test('ignores stale or corrupt checkpoints', () async {
    final prefs = await SharedPreferences.getInstance();
    final store = PlayerSessionStore(prefs);
    final snapshot = _snapshot(position: const Duration(seconds: 7));
    await store.writeSnapshot(snapshot);
    await store.writeCheckpoint(
      PlayerSessionCheckpoint(
        trackId: 'another-track',
        position: const Duration(seconds: 50),
      ),
    );

    expect(store.read()?.position, const Duration(seconds: 7));

    await prefs.setString(playerSessionCheckpointStorageKey, '{broken-json');
    expect(store.read()?.position, const Duration(seconds: 7));
  });

  test(
    'a structural write clears an older checkpoint for the same track',
    () async {
      final prefs = await SharedPreferences.getInstance();
      final store = PlayerSessionStore(prefs);
      await store.writeSnapshot(
        _snapshot(position: const Duration(seconds: 5)),
      );
      await store.writeCheckpoint(
        PlayerSessionCheckpoint(
          trackId: 'track-a',
          position: const Duration(seconds: 9),
        ),
      );
      await store.writeSnapshot(
        _snapshot(position: const Duration(seconds: 12)),
      );

      expect(store.read()?.position, const Duration(seconds: 12));
      expect(prefs.getString(playerSessionCheckpointStorageKey), isNull);
    },
  );

  test('returns null for bad JSON and unknown snapshot versions', () async {
    final prefs = await SharedPreferences.getInstance();
    final store = PlayerSessionStore(prefs);

    await prefs.setString(playerSessionSnapshotStorageKey, '{broken-json');
    expect(store.read(), isNull);

    await prefs.setString(
      playerSessionSnapshotStorageKey,
      jsonEncode({
        ..._snapshot().toJson(),
        'version': PlayerSessionSnapshot.currentVersion + 1,
      }),
    );
    expect(store.read(), isNull);
  });

  test('clear removes both persisted records', () async {
    final prefs = await SharedPreferences.getInstance();
    final store = PlayerSessionStore(prefs);
    final snapshot = _snapshot();
    await store.writeSnapshot(snapshot);
    await store.writeCheckpoint(
      PlayerSessionCheckpoint(trackId: snapshot.track.id),
    );

    await store.clear();

    expect(prefs.getString(playerSessionSnapshotStorageKey), isNull);
    expect(prefs.getString(playerSessionCheckpointStorageKey), isNull);
    expect(store.read(), isNull);
  });
}

PlayerSessionSnapshot _snapshot({
  Duration position = Duration.zero,
  Duration duration = const Duration(minutes: 3),
}) {
  return PlayerSessionSnapshot(
    track: const PersistedPlayerTrack(
      id: 'track-a',
      kindCode: PersistedPlayerTrack.remoteKindCode,
      title: '当前歌曲',
      artist: '当前歌手',
      album: '当前专辑',
      sourceLabel: '网易云',
      qualityLabel: 'flac',
    ),
    music: MusicInfo.fromJson(const {
      'id': 'song-a',
      'name': '当前歌曲',
      'singer': '当前歌手',
      'source': 'wy',
      'interval': '03:00',
      'meta': {
        'songId': 'song-a',
        'albumName': '当前专辑',
        'qualitys': [
          {'type': 'flac'},
        ],
      },
    }),
    qualityCode: 'flac',
    position: position,
    duration: duration,
  );
}
