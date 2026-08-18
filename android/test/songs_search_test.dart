import 'package:test/test.dart';

import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/songs/song_search.dart';

void main() {
  group('filterSongsByQuery', () {
    final songs = [
      _entry(
        id: '1',
        name: '夜曲',
        singer: '周杰伦',
        album: '十一月的萧邦',
        savedPath: r'D:\Music\track-one.flac',
      ),
      _entry(
        id: '2',
        name: '晴天',
        singer: '周杰伦',
        album: '叶惠美',
        savedPath: r'D:\Music\sunny-day.mp3',
      ),
      _entry(
        id: '3',
        name: 'Lemon',
        singer: 'Kenshi Yonezu',
        album: 'STRAY SHEEP',
        savedPath: r'D:\Music\lemon-live.m4a',
      ),
    ];

    test('returns the original list for a blank query', () {
      expect(identical(filterSongsByQuery(songs, '   '), songs), isTrue);
    });

    test('matches title, artist, album, and saved filename', () {
      expect(filterSongsByQuery(songs, '晴天').single.id, '2');
      expect(filterSongsByQuery(songs, 'Kenshi').single.id, '3');
      expect(filterSongsByQuery(songs, '萧邦').single.id, '1');
      expect(filterSongsByQuery(songs, 'sunny-day').single.id, '2');
    });

    test('requires every whitespace-separated term and ignores case', () {
      expect(filterSongsByQuery(songs, 'LEMON yonezu').single.id, '3');
      expect(filterSongsByQuery(songs, 'lemon 周杰伦'), isEmpty);
    });
  });
}

DownloadHistoryEntry _entry({
  required String id,
  required String name,
  required String singer,
  required String album,
  required String savedPath,
}) {
  return DownloadHistoryEntry(
    id: id,
    musicId: id,
    name: name,
    singer: singer,
    albumName: album,
    sourceCode: 'all',
    qualityCode: '320k',
    status: DownloadHistoryStatus.completed,
    createdAt: DateTime.utc(2026, 7, 24),
    savedPath: savedPath,
  );
}
