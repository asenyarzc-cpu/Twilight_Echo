import 'package:audio_service/audio_service.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/player/bluetooth_lyric_metadata.dart';
import 'package:twilight_echo/features/player/player_models.dart';

void main() {
  const track = PlayerTrack(
    id: 'wy:test:remote',
    kind: PlayerTrackKind.remote,
    title: '测试歌曲',
    artist: '测试歌手',
    album: '测试专辑',
    sourceLabel: '网易',
    qualityLabel: 'flac',
  );
  final artwork = Uri.parse('https://example.com/cover.jpg');
  const artworkHeaders = {
    'User-Agent': 'Twilight Echo test',
    'Referer': 'https://music.163.com/',
  };
  final base = MediaItem(
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: const Duration(minutes: 3),
    artUri: artwork,
    artHeaders: artworkHeaders,
    displayTitle: track.title,
    displaySubtitle: track.artist,
    extras: const {'trackKind': 'remote', 'source': '网易'},
  );

  test('line and full lyrics preserve base media metadata', () {
    final item = BluetoothLyricMetadata.build(
      current: base,
      track: track,
      lineLyricEnabled: true,
      fullLyricEnabled: true,
      activeLine: '正在播放的歌词',
      fullLyric: '[00:00.00]完整歌词',
    );

    expect(item.title, '正在播放的歌词');
    expect(item.displayTitle, '正在播放的歌词');
    expect(item.artist, '测试歌曲 - 测试歌手');
    expect(item.displaySubtitle, '测试歌曲 - 测试歌手');
    expect(item.album, '测试专辑');
    expect(item.duration, const Duration(minutes: 3));
    expect(item.artUri, artwork);
    expect(item.artHeaders, artworkHeaders);
    expect(item.extras?['trackKind'], 'remote');
    expect(item.extras?[androidBluetoothLyricsMetadataKey], '[00:00.00]完整歌词');
  });

  test(
    'pause restores song information while keeping independent full lyric',
    () {
      final playing = BluetoothLyricMetadata.build(
        current: base,
        track: track,
        lineLyricEnabled: true,
        fullLyricEnabled: true,
        activeLine: '最后一句',
        fullLyric: '[00:00.00]完整歌词',
      );
      final paused = BluetoothLyricMetadata.build(
        current: playing,
        track: track,
        lineLyricEnabled: true,
        fullLyricEnabled: true,
        fullLyric: '[00:00.00]完整歌词',
      );

      expect(paused.title, '测试歌曲');
      expect(paused.artist, '测试歌手');
      expect(paused.displayTitle, '测试歌曲');
      expect(paused.displaySubtitle, '测试歌手');
      expect(
        paused.extras?[androidBluetoothLyricsMetadataKey],
        '[00:00.00]完整歌词',
      );
    },
  );

  test('disabling full lyrics removes the Android metadata key', () {
    final withLyrics = base.copyWith(
      extras: {
        ...?base.extras,
        androidBluetoothLyricsMetadataKey: '[00:00.00]旧歌词',
      },
    );
    final item = BluetoothLyricMetadata.build(
      current: withLyrics,
      track: track,
      lineLyricEnabled: false,
      fullLyricEnabled: false,
    );

    expect(item.extras, isNot(contains(androidBluetoothLyricsMetadataKey)));
    expect(item.extras?['source'], '网易');
  });

  test('coordinator suppresses duplicate line publications', () {
    final coordinator = BluetoothLyricMetadataCoordinator();
    MediaItem? next(int lineIndex, String line) => coordinator.next(
      current: base,
      track: track,
      lineIndex: lineIndex,
      lineLyricEnabled: true,
      fullLyricEnabled: false,
      activeLine: line,
    );

    expect(next(0, '第一句'), isNotNull);
    expect(next(0, '第一句'), isNull);
    expect(next(1, '第二句')?.title, '第二句');
    coordinator.reset();
    expect(next(1, '第二句'), isNotNull);
  });
}
