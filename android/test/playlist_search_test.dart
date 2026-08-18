import 'package:test/test.dart';

import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_search.dart';
import 'package:twilight_echo/features/playlists/resolved_playlist_track.dart';

void main() {
  group('filterResolvedTracksByQuery', () {
    final tracks = [
      _resolved(
        id: '1',
        name: '夜曲',
        singer: '周杰伦',
        album: '十一月的萧邦',
        localPath: r'D:\Music\track-one.flac',
      ),
      _resolved(id: '2', name: '晴天', singer: '周杰伦', album: '叶惠美'),
      _resolved(
        id: '3',
        name: 'Lemon',
        singer: 'Kenshi Yonezu',
        album: 'STRAY SHEEP',
        localEntrySavedPath: r'D:\Music\lemon-live.m4a',
      ),
    ];

    test('returns the original list for a blank query', () {
      expect(
        identical(filterResolvedTracksByQuery(tracks, '   '), tracks),
        isTrue,
      );
    });

    test('matches title, artist, album, and local filename', () {
      expect(
        filterResolvedTracksByQuery(tracks, '晴天').single.track.musicId,
        '2',
      );
      expect(
        filterResolvedTracksByQuery(tracks, 'Kenshi').single.track.musicId,
        '3',
      );
      expect(
        filterResolvedTracksByQuery(tracks, '萧邦').single.track.musicId,
        '1',
      );
      expect(
        filterResolvedTracksByQuery(tracks, 'track-one').single.track.musicId,
        '1',
      );
    });

    test('falls back to the resolved local entry path for the filename', () {
      expect(
        filterResolvedTracksByQuery(tracks, 'lemon-live').single.track.musicId,
        '3',
      );
    });

    test('requires every whitespace-separated term and ignores case', () {
      expect(
        filterResolvedTracksByQuery(
          tracks,
          'LEMON yonezu',
        ).single.track.musicId,
        '3',
      );
      expect(filterResolvedTracksByQuery(tracks, 'lemon 周杰伦'), isEmpty);
    });

    test('does not match across field boundaries', () {
      // '曲周' would only match if name and singer were joined without a
      // separator ('夜曲' + '周杰伦').
      expect(filterResolvedTracksByQuery(tracks, '曲周'), isEmpty);
    });
  });
}

ResolvedPlaylistTrack _resolved({
  required String id,
  required String name,
  required String singer,
  required String album,
  String? localPath,
  String? localEntrySavedPath,
}) {
  final track = PlaylistTrack(
    musicId: id,
    name: name,
    singer: singer,
    albumName: album,
    sourceCode: 'wy',
    qualityCode: '320k',
    localPath: localPath,
  );
  final localEntry = localEntrySavedPath == null
      ? null
      : DownloadHistoryEntry(
          id: id,
          musicId: id,
          name: name,
          singer: singer,
          albumName: album,
          sourceCode: 'wy',
          qualityCode: '320k',
          status: DownloadHistoryStatus.completed,
          createdAt: DateTime.utc(2026, 7, 31),
          savedPath: localEntrySavedPath,
        );
  return ResolvedPlaylistTrack(
    track: track,
    localEntry: localEntry,
    queueEntry: localEntry,
  );
}
