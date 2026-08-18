import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/songs/widgets/song_row.dart';

void main() {
  testWidgets(
    'song row keeps next-play direct and adds playlist swipe action',
    (tester) async {
      _useNarrowPhone(tester);
      final entry = _entry();
      var addNextCount = 0;
      var addToPlaylistCount = 0;
      var deleteCount = 0;

      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          ),
          home: Scaffold(
            body: SongRow(
              entry: entry,
              artworkVersion: null,
              playing: false,
              batchMode: false,
              selected: false,
              onToggleSelected: () {},
              onAddNext: () => addNextCount++,
              onAddToPlaylist: () => addToPlaylistCount++,
              onPlay: () {},
              onDelete: () => deleteCount++,
            ),
          ),
        ),
      );

      expect(find.byTooltip('添加到下一首播放'), findsOneWidget);
      expect(find.byType(MenuAnchor), findsNothing);
      expect(find.byType(SubmenuButton), findsNothing);
      await tester.tap(find.byTooltip('添加到下一首播放'));
      await tester.pumpAndSettle();
      expect(addNextCount, 1);

      final row = find.byKey(const ValueKey('song-slide-song-1'));
      await tester.drag(row, const Offset(-280, 0));
      await tester.pumpAndSettle();
      expect(find.text('歌单'), findsOneWidget);
      expect(find.text('删除'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('song-add-playlist-action')));
      await tester.pumpAndSettle();
      expect(addToPlaylistCount, 1);
      expect(deleteCount, 0);

      await tester.drag(row, const Offset(-280, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('song-delete-action')));
      await tester.pumpAndSettle();
      expect(deleteCount, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('playlist song row only exposes remove-from-playlist on swipe', (
    tester,
  ) async {
    _useNarrowPhone(tester);
    var removeCount = 0;

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        home: Scaffold(
          body: SongRow(
            entry: _entry(),
            artworkVersion: null,
            playing: false,
            batchMode: false,
            selected: false,
            onToggleSelected: () {},
            onAddNext: () {},
            onAddToPlaylist: () {},
            onPlay: () {},
            onDelete: () => removeCount++,
            playlistMode: true,
          ),
        ),
      ),
    );

    final row = find.byKey(const ValueKey('song-slide-song-1'));
    await tester.drag(row, const Offset(-280, 0));
    await tester.pumpAndSettle();

    expect(find.text('移出歌单'), findsOneWidget);
    expect(find.text('歌单'), findsNothing);
    expect(find.text('删除'), findsNothing);
    expect(
      find.byKey(const ValueKey('song-add-playlist-action')),
      findsNothing,
    );

    await tester.tap(find.byKey(const ValueKey('song-remove-playlist-action')));
    await tester.pumpAndSettle();
    expect(removeCount, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('current song equalizer is static while paused', (tester) async {
    _useNarrowPhone(tester);

    await tester.pumpWidget(_songRowApp(playingActive: false));
    await tester.pump();
    final pausedStart = _equalizerHeights(tester);
    await tester.pump(const Duration(milliseconds: 500));
    expect(_equalizerHeights(tester), pausedStart);

    await tester.pumpWidget(_songRowApp(playingActive: true));
    await tester.pump();
    final activeStart = _equalizerHeights(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(_equalizerHeights(tester), isNot(activeStart));
    expect(tester.takeException(), isNull);
  });
}

Widget _songRowApp({required bool playingActive}) {
  return MaterialApp(
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    ),
    home: Scaffold(
      body: SongRow(
        entry: _entry(),
        artworkVersion: null,
        playing: true,
        playingActive: playingActive,
        batchMode: false,
        selected: false,
        onToggleSelected: () {},
        onAddNext: () {},
        onAddToPlaylist: () {},
        onPlay: () {},
        onDelete: () {},
      ),
    ),
  );
}

List<double> _equalizerHeights(WidgetTester tester) {
  final equalizer = find.byKey(const ValueKey('song-playing-song-1'));
  final bars = find.descendant(of: equalizer, matching: find.byType(Container));
  return [
    for (final bar in bars.evaluate())
      tester.getSize(find.byWidget(bar.widget)).height,
  ];
}

DownloadHistoryEntry _entry() {
  return DownloadHistoryEntry(
    id: 'song-1',
    musicId: 'song-1',
    name: '夜曲',
    singer: '周杰伦',
    albumName: '十一月的萧邦',
    sourceCode: 'wy',
    qualityCode: 'flac',
    status: DownloadHistoryStatus.completed,
    createdAt: DateTime.utc(2026, 7, 24),
  );
}

void _useNarrowPhone(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(360, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
