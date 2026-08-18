import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/shell/widgets/horizontal_page_swipe.dart';
import 'package:twilight_echo/features/songs/widgets/song_row.dart';

void main() {
  testWidgets('song row slide gestures do not trigger page navigation', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var pageSwipes = 0;

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        home: Scaffold(
          body: HorizontalPageSwipe(
            onSwipeLeft: () => pageSwipes += 1,
            onSwipeRight: () => pageSwipes += 1,
            child: Align(
              alignment: Alignment.topCenter,
              child: SongRow(
                entry: _entry(),
                artworkVersion: null,
                playing: false,
                batchMode: false,
                selected: false,
                onToggleSelected: () {},
                onAddNext: () {},
                onAddToPlaylist: () {},
                onPlay: () {},
                onDelete: () {},
              ),
            ),
          ),
        ),
      ),
    );

    final row = find.byKey(const ValueKey('song-slide-song-swipe-test'));
    await tester.drag(row, const Offset(-180, 0));
    await tester.pumpAndSettle();

    expect(find.text('歌单'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
    expect(pageSwipes, 0);

    await tester.drag(row, const Offset(180, 0));
    await tester.pumpAndSettle();

    expect(pageSwipes, 0);
    expect(tester.takeException(), isNull);
  });
}

DownloadHistoryEntry _entry() {
  return DownloadHistoryEntry(
    id: 'song-swipe-test',
    musicId: 'song-swipe-test',
    name: '手势测试歌曲',
    singer: '测试歌手',
    albumName: '测试专辑',
    sourceCode: 'wy',
    qualityCode: 'flac',
    status: DownloadHistoryStatus.completed,
    createdAt: DateTime.utc(2026, 8, 5),
  );
}
