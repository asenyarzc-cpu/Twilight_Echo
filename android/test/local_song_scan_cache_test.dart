import 'package:test/test.dart';

import 'package:twilight_echo/features/songs/local_song_scan_cache.dart';

void main() {
  test('round-trips the persisted local song manifest', () {
    final snapshot = LocalSongScanSnapshot(
      directory: '/music/downloads',
      cachedAt: DateTime.utc(2026, 7, 21, 8, 30),
      files: [
        LocalSongFileSnapshot(
          path: '/music/downloads/artist - title.flac',
          fileName: 'artist - title.flac',
          extension: 'flac',
          createdAt: DateTime.utc(2026, 7, 20),
          modifiedAt: DateTime.utc(2026, 7, 21),
          sizeBytes: 1024,
        ),
      ],
      error: null,
    );

    final restored = LocalSongScanSnapshot.fromJson(snapshot.toJson());

    expect(restored.directory, snapshot.directory);
    expect(restored.cachedAt, snapshot.cachedAt);
    expect(restored.files, hasLength(1));
    expect(restored.files.single.path, snapshot.files.single.path);
    expect(restored.files.single.modifiedAt, snapshot.files.single.modifiedAt);
    expect(restored.files.single.sizeBytes, 1024);
  });

  test('ignores malformed manifest rows without failing the cache', () {
    final restored = LocalSongScanSnapshot.fromJson({
      'directory': '/music/downloads',
      'cachedAt': '2026-07-21T08:30:00Z',
      'files': [
        {'path': '', 'fileName': ''},
        {'path': '/music/downloads/song.mp3', 'fileName': 'song.mp3'},
      ],
    });

    expect(restored.files, hasLength(1));
    expect(restored.files.single.path, '/music/downloads/song.mp3');
  });
}
