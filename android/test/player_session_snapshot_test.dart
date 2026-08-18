import 'dart:convert';

import 'package:test/test.dart';

import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/player/player_session_snapshot.dart';

void main() {
  group('PlayerSessionSnapshot', () {
    test('round-trips the complete persisted player state', () {
      final mutableMusic = _musicJson('song-1');
      final snapshot = PlayerSessionSnapshot(
        track: const PersistedPlayerTrack(
          id: 'wy:song-1:remote',
          kindCode: PersistedPlayerTrack.remoteKindCode,
          title: '当前歌曲',
          artist: '当前歌手',
          album: '当前专辑',
          sourceLabel: '网易云',
          qualityLabel: 'flac',
          coverUrl: 'https://example.com/cover.jpg',
        ),
        music: MusicInfo.fromJson(mutableMusic),
        qualityCode: 'flac',
        position: const Duration(seconds: 37),
        duration: const Duration(minutes: 4),
        queue: [_queueEntry('queue-1'), _queueEntry('queue-2')],
        queueIndex: 1,
        playbackModeCode: PlayerSessionSnapshot.shufflePlaybackModeCode,
      );

      (mutableMusic['meta'] as Map<String, dynamic>)['albumName'] = '已修改';
      final restored = PlayerSessionSnapshot.tryFromJson(
        jsonDecode(jsonEncode(snapshot.toJson())),
      );

      expect(restored, isNotNull);
      expect(restored!.version, PlayerSessionSnapshot.currentVersion);
      expect(restored.track.id, 'wy:song-1:remote');
      expect(restored.music?.id, 'song-1');
      expect(restored.music?.meta.albumName, '测试专辑');
      expect(restored.qualityCode, 'flac');
      expect(restored.position, const Duration(seconds: 37));
      expect(restored.duration, const Duration(minutes: 4));
      expect(restored.queue.map((entry) => entry.id), ['queue-1', 'queue-2']);
      expect(restored.queueIndex, 1);
      expect(
        restored.playbackModeCode,
        PlayerSessionSnapshot.shufflePlaybackModeCode,
      );
    });

    test('rejects unknown versions and malformed current tracks', () {
      expect(
        PlayerSessionSnapshot.tryFromJson({
          'version': PlayerSessionSnapshot.currentVersion + 1,
          'track': _trackJson(),
        }),
        isNull,
      );
      expect(
        PlayerSessionSnapshot.tryFromJson({
          'version': PlayerSessionSnapshot.currentVersion,
          'track': {'id': '', 'kindCode': 'remote'},
        }),
        isNull,
      );
      expect(
        PlayerSessionSnapshot.tryFromJson({
          'version': PlayerSessionSnapshot.currentVersion,
          'track': {..._trackJson(), 'kindCode': 'unknown'},
        }),
        isNull,
      );
    });

    test('sanitizes transient numbers, modes, and corrupt queue rows', () {
      final restored = PlayerSessionSnapshot.tryFromJson({
        'version': PlayerSessionSnapshot.currentVersion,
        'track': _trackJson(),
        'music': {'id': 'song-1', 'unsupported': DateTime.utc(2026, 7, 27)},
        'positionMs': -200,
        'durationMs': 1000,
        'queue': [
          null,
          'not-a-map',
          {'id': ''},
          _queueEntry('valid').toJson(),
          {..._queueEntry('bad-size').toJson(), 'sizeBytes': 'invalid'},
        ],
        'queueIndex': 99,
        'playbackModeCode': 'future-mode',
      });

      expect(restored, isNotNull);
      expect(restored!.music, isNull);
      expect(restored.position, Duration.zero);
      expect(restored.duration, const Duration(seconds: 1));
      expect(restored.queue.map((entry) => entry.id), ['valid']);
      expect(restored.queueIndex, -1);
      expect(
        restored.playbackModeCode,
        PlayerSessionSnapshot.sequencePlaybackModeCode,
      );
    });

    test('applies a checkpoint only to its matching track', () {
      final snapshot = PlayerSessionSnapshot(
        track: const PersistedPlayerTrack(
          id: 'track-a',
          kindCode: PersistedPlayerTrack.remoteKindCode,
          title: 'A',
          artist: '',
          album: '',
          sourceLabel: '',
          qualityLabel: '',
        ),
        position: const Duration(seconds: 5),
        duration: const Duration(seconds: 30),
      );
      final matching = PlayerSessionCheckpoint(
        trackId: 'track-a',
        position: const Duration(seconds: 19),
        duration: const Duration(seconds: 30),
      );
      final stale = PlayerSessionCheckpoint(
        trackId: 'track-b',
        position: const Duration(seconds: 25),
        duration: const Duration(seconds: 30),
      );

      expect(snapshot.applyCheckpoint(matching).position.inSeconds, 19);
      expect(snapshot.applyCheckpoint(stale).position.inSeconds, 5);
    });
  });

  group('PlayerSessionCheckpoint', () {
    test('rejects unknown versions and clamps position to duration', () {
      expect(
        PlayerSessionCheckpoint.tryFromJson({
          'version': PlayerSessionCheckpoint.currentVersion + 1,
          'trackId': 'track-a',
        }),
        isNull,
      );

      final checkpoint = PlayerSessionCheckpoint.tryFromJson({
        'version': PlayerSessionCheckpoint.currentVersion,
        'trackId': 'track-a',
        'positionMs': 9000,
        'durationMs': 4000,
      });
      expect(checkpoint?.position, const Duration(seconds: 4));
    });
  });
}

Map<String, dynamic> _trackJson() => const PersistedPlayerTrack(
  id: 'track-a',
  kindCode: PersistedPlayerTrack.remoteKindCode,
  title: 'A',
  artist: 'Artist',
  album: 'Album',
  sourceLabel: 'Source',
  qualityLabel: 'flac',
).toJson();

Map<String, dynamic> _musicJson(String id) => {
  'id': id,
  'name': '测试歌曲',
  'singer': '测试歌手',
  'source': 'wy',
  'interval': '04:00',
  'meta': {
    'songId': id,
    'albumName': '测试专辑',
    'qualitys': [
      {'type': 'flac'},
    ],
  },
};

DownloadHistoryEntry _queueEntry(String id) => DownloadHistoryEntry(
  id: id,
  musicId: id,
  name: '歌曲 $id',
  singer: '歌手',
  albumName: '专辑',
  sourceCode: 'wy',
  qualityCode: 'flac',
  status: DownloadHistoryStatus.completed,
  createdAt: DateTime.utc(2026, 7, 27),
  musicJson: _musicJson(id),
);
