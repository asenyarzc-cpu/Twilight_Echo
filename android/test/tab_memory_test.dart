import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('songs tab remembers the playlist view and re-tap goes to root', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final router = await _pumpApp(tester, initialLocation: '/playlists/night');

    // 记录初始位置后切到设置。
    await tester.tap(find.byTooltip('设置'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/settings');

    // 点歌曲 tab 回到记忆中的歌单视图，而不是 /songs。
    await tester.tap(find.byTooltip('歌曲'));
    await _pumpUi(tester);
    expect(
      router.routeInformationProvider.value.uri.toString(),
      '/playlists/night',
    );

    // 已在歌曲 tab 内再点一次 → 回 tab 根。
    await tester.tap(find.byTooltip('歌曲'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    expect(tester.takeException(), isNull);
  });

  testWidgets('tab memory keeps the query string of the remembered location', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final router = await _pumpApp(tester, initialLocation: '/songs');

    // 经歌单管理进入详情，路由带 ?from=manage。
    await tester.tap(find.byTooltip('歌单'));
    await _pumpUi(tester);
    await tester.tap(find.text('歌单管理'));
    await _pumpUi(tester);
    await tester.tap(find.text('夜晚循环'));
    await _pumpUi(tester);
    expect(
      router.routeInformationProvider.value.uri.toString(),
      '/playlists/night?from=manage',
    );

    await tester.tap(find.byTooltip('设置'));
    await _pumpUi(tester);
    await tester.tap(find.byTooltip('歌曲'));
    await _pumpUi(tester);
    expect(
      router.routeInformationProvider.value.uri.toString(),
      '/playlists/night?from=manage',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('player round trip does not disturb the songs tab memory', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final router = await _pumpApp(tester, initialLocation: '/playlists/night');

    await tester.tap(find.byTooltip('播放页'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/player');

    await tester.binding.handlePopRoute();
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/playlists/night');

    await tester.tap(find.byTooltip('设置'));
    await _pumpUi(tester);
    await tester.tap(find.byTooltip('歌曲'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/playlists/night');
    expect(tester.takeException(), isNull);
  });
}

Future<GoRouter> _pumpApp(
  WidgetTester tester, {
  required String initialLocation,
}) async {
  final prefs = await _prefsWithPlaylist();
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

Future<SharedPreferences> _prefsWithPlaylist() async {
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [
      jsonEncode(
        LocalPlaylist(
          id: 'night',
          name: '夜晚循环',
          tracks: const [],
          createdAt: DateTime.utc(2026, 7, 31),
          updatedAt: DateTime.utc(2026, 7, 31),
        ).toJson(),
      ),
    ],
  });
  return SharedPreferences.getInstance();
}
