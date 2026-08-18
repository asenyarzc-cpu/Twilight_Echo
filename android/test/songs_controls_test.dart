import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/songs/songs_toolbar_state.dart';
import 'package:twilight_echo/features/songs/widgets/songs_placeholders.dart';
import 'package:twilight_echo/features/songs/widgets/songs_sort_sheet.dart';

void main() {
  testWidgets('songs summary exposes icon-only sort and batch actions', (
    tester,
  ) async {
    _useNarrowPhone(tester);
    var sortPressed = false;
    var batchPressed = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SongsListSummary(
            count: 12,
            totalCount: 12,
            searching: false,
            sortMode: SongSortMode.title,
            ascending: true,
            batchMode: false,
            onOpenSort: () => sortPressed = true,
            onToggleBatch: () => batchPressed = true,
          ),
        ),
      ),
    );

    expect(find.text('12 首本地歌曲'), findsOneWidget);
    expect(find.byTooltip('排序：标题（升序）'), findsOneWidget);
    expect(find.byTooltip('批量操作'), findsOneWidget);
    expect(find.text('标题 · 升序'), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('songs-sort-button')),
        matching: find.byIcon(Icons.sort_rounded),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('songs-sort-button')));
    await tester.tap(find.byKey(const ValueKey('songs-batch-button')));
    expect(sortPressed, isTrue);
    expect(batchPressed, isTrue);
  });

  testWidgets('songs sorting is configured in a modal bottom sheet', (
    tester,
  ) async {
    _useNarrowPhone(tester);
    SongSortMode? selectedMode;
    bool? selectedAscending;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => FilledButton(
              onPressed: () => showSongsSortSheet(
                context: context,
                initialMode: SongSortMode.title,
                initialAscending: true,
                onChanged: (mode, ascending) {
                  selectedMode = mode;
                  selectedAscending = ascending;
                },
              ),
              child: const Text('打开排序'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('打开排序'));
    await tester.pumpAndSettle();
    expect(find.text('歌曲排序'), findsOneWidget);
    expect(find.text('标题'), findsOneWidget);
    expect(find.text('歌手'), findsOneWidget);
    expect(find.text('添加时间'), findsOneWidget);
    expect(find.text('升序'), findsOneWidget);
    expect(find.text('降序'), findsOneWidget);

    await tester.tap(find.text('添加时间'));
    await tester.pumpAndSettle();
    expect(selectedMode, SongSortMode.added);
    expect(selectedAscending, isFalse);

    await tester.tap(find.text('升序'));
    await tester.pumpAndSettle();
    expect(selectedMode, SongSortMode.added);
    expect(selectedAscending, isTrue);
  });
}

void _useNarrowPhone(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(360, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
