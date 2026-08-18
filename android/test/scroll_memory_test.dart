import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/playlists/playlist_management_page.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/features/settings/settings_page.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('settings keeps its scroll offset across tab switches', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final router = await _pumpApp(tester, initialLocation: '/settings');

    await tester.drag(find.byType(SettingsPage), const Offset(0, -260));
    await _pumpUi(tester);
    final offset = _offsetOf(tester, find.byType(SettingsPage));
    expect(offset, greaterThan(0));

    // 直接走路由切换（滚动后底部胶囊会自动隐藏，点不到 tab 按钮）。
    router.go('/');
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/');

    router.go('/settings');
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/settings');
    expect(
      _offsetOf(tester, find.byType(SettingsPage)),
      moreOrLessEquals(offset, epsilon: 1),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('playlist management keeps its scroll offset across tabs', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final router = await _pumpApp(tester, initialLocation: '/playlists');

    await tester.drag(
      find.byType(PlaylistManagementPage),
      const Offset(0, -320),
    );
    await _pumpUi(tester);
    final offset = _offsetOf(tester, find.byType(PlaylistManagementPage));
    expect(offset, greaterThan(0));

    router.go('/settings');
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/settings');

    router.go('/playlists');
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/playlists');
    expect(
      _offsetOf(tester, find.byType(PlaylistManagementPage)),
      moreOrLessEquals(offset, epsilon: 1),
    );
    expect(tester.takeException(), isNull);
  });
}

double _offsetOf(WidgetTester tester, Finder page) {
  final scrollable = find.descendant(
    of: page,
    matching: find.byType(Scrollable),
  );
  return tester.state<ScrollableState>(scrollable.first).position.pixels;
}

Future<GoRouter> _pumpApp(
  WidgetTester tester, {
  required String initialLocation,
}) async {
  final prefs = await _prefsWithPlaylists();
  final audioHandler = PlayerAudioHandler();
  final router = createAppRouter(initialLocation: initialLocation);
  addTearDown(() {
    router.dispose();
    unawaited(audioHandler.disposeHandler());
  });

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
      ],
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        routerConfig: router,
      ),
    ),
  );
  await _pumpUi(tester);
  return router;
}

Future<void> _pumpUi(WidgetTester tester) async {
  for (var index = 0; index < 12; index++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _usePhoneViewport(
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

Future<SharedPreferences> _prefsWithPlaylists() async {
  final now = DateTime.utc(2026, 7, 31);
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [
      for (var index = 0; index < 30; index++)
        jsonEncode(
          LocalPlaylist(
            id: 'list-$index',
            name: '歌单 $index',
            tracks: const [],
            createdAt: now,
            updatedAt: now,
          ).toJson(),
        ),
    ],
  });
  return SharedPreferences.getInstance();
}
