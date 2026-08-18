import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/playlists/playlist_detail_page.dart';
import 'package:twilight_echo/features/playlists/playlist_detail_toolbar_state.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/features/shell/shell_toolbar_visibility.dart';
import 'package:twilight_echo/features/songs/widgets/songs_placeholders.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('playlist search filters tracks and toggles off cleanly', (
    tester,
  ) async {
    await _useCompactViewport(tester);
    final container = await _pumpDetailPage(tester);

    final toolbar = container.read(playlistDetailToolbarStateProvider);
    expect(toolbar.attached, isTrue);
    expect(toolbar.searchMode, isFalse);
    expect(find.byType(SongsSearchBar), findsNothing);

    toolbar.onToggleSearch!();
    await tester.pumpAndSettle();
    expect(find.byType(SongsSearchBar), findsOneWidget);
    expect(
      container.read(playlistDetailToolbarStateProvider).searchMode,
      isTrue,
    );

    await tester.enterText(find.byType(SongsSearchBar), '第一首');
    await tester.pump();
    expect(find.text('第二首'), findsNothing);

    await tester.enterText(find.byType(SongsSearchBar), '不存在的歌');
    await tester.pump();
    expect(find.byType(EmptySongSearch), findsOneWidget);

    container.read(playlistDetailToolbarStateProvider).onToggleSearch!();
    await tester.pumpAndSettle();
    expect(find.byType(SongsSearchBar), findsNothing);
    expect(find.text('第一首'), findsOneWidget);
    expect(find.text('第二首'), findsOneWidget);
    expect(
      container.read(playlistDetailToolbarStateProvider).searchMode,
      isFalse,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('batch and search modes are mutually exclusive', (tester) async {
    await _useCompactViewport(tester);
    final container = await _pumpDetailPage(tester);

    container.read(playlistDetailToolbarStateProvider).onToggleSearch!();
    await tester.pumpAndSettle();
    expect(find.byType(SongsSearchBar), findsOneWidget);

    container.read(playlistDetailToolbarStateProvider).onToggleBatch!();
    await tester.pumpAndSettle();
    expect(
      container.read(playlistDetailToolbarStateProvider).searchMode,
      isFalse,
    );
    expect(
      container.read(playlistDetailToolbarStateProvider).batchMode,
      isTrue,
    );
    expect(find.byType(SongsSearchBar), findsNothing);
    expect(find.byType(Checkbox), findsNWidgets(2));

    container.read(playlistDetailToolbarStateProvider).onToggleSearch!();
    await tester.pumpAndSettle();
    expect(
      container.read(playlistDetailToolbarStateProvider).batchMode,
      isFalse,
    );
    expect(find.byType(Checkbox), findsNothing);
    expect(find.byType(SongsSearchBar), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('search focus hides the bottom toolbar and restores on unfocus', (
    tester,
  ) async {
    await _useCompactViewport(tester);
    final container = await _pumpDetailPage(tester);
    expect(container.read(shellToolbarVisibleProvider), isTrue);

    container.read(playlistDetailToolbarStateProvider).onToggleSearch!();
    await tester.pumpAndSettle();
    expect(container.read(shellToolbarVisibleProvider), isFalse);

    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    expect(container.read(shellToolbarVisibleProvider), isTrue);

    await tester.tap(find.byType(SongsSearchBar));
    await tester.pump();
    expect(container.read(shellToolbarVisibleProvider), isFalse);

    container.read(playlistDetailToolbarStateProvider).onToggleSearch!();
    await tester.pumpAndSettle();
    expect(container.read(shellToolbarVisibleProvider), isTrue);
    expect(tester.takeException(), isNull);
  });
}

Future<ProviderContainer> _pumpDetailPage(WidgetTester tester) async {
  final tracks = [
    PlaylistTrack.fromMusicInfo(_playlistMusic('track-1', '第一首')),
    PlaylistTrack.fromMusicInfo(_playlistMusic('track-2', '第二首')),
  ];
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [
      jsonEncode(
        LocalPlaylist(
          id: 'search',
          name: '搜索歌单',
          tracks: tracks,
          createdAt: DateTime.utc(2026, 7, 31),
          updatedAt: DateTime.utc(2026, 7, 31),
        ).toJson(),
      ),
    ],
  });
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        home: const PlaylistDetailPage(playlistId: 'search'),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

MusicInfo _playlistMusic(String id, String name) {
  return MusicInfo.fromJson({
    'id': id,
    'name': name,
    'singer': '在线歌手',
    'source': MusicSource.wy.code,
    'interval': '03:30',
    'meta': {
      'songId': id,
      'albumName': '在线专辑',
      'qualitys': [
        {'type': Quality.k320.code, 'size': '1024'},
      ],
    },
  });
}

Future<void> _useCompactViewport(
  WidgetTester tester, {
  Size size = const Size(390, 844),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(() {
    tester.view.resetDevicePixelRatio();
    tester.view.resetPhysicalSize();
  });
}
