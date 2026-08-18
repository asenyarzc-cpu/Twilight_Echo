import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/features/songs/widgets/songs_placeholders.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('playlist view search opens in place and backs out in steps', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWithPlaylist();
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/playlists/night');
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

    // 歌单详情使用自己的沉浸式搜索入口，不复用歌曲页三点菜单。
    expect(find.byTooltip('更多歌曲操作'), findsNothing);
    expect(find.byTooltip('搜索歌单歌曲'), findsOneWidget);

    // 进入搜索：路由不变、搜索条与搜索态顶栏出现。
    await tester.tap(find.byTooltip('搜索歌单歌曲'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/playlists/night');
    expect(find.byType(SongsSearchBar), findsOneWidget);
    expect(find.byTooltip('退出搜索'), findsOneWidget);

    // 第一次返回键：关闭搜索，仍在歌单页。
    expect(await tester.binding.handlePopRoute(), isTrue);
    await _pumpUi(tester);
    expect(find.byType(SongsSearchBar), findsNothing);
    expect(router.routeInformationProvider.value.uri.path, '/playlists/night');

    // 第二次返回键：离开歌单页回歌曲首页。
    expect(await tester.binding.handlePopRoute(), isTrue);
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    expect(tester.takeException(), isNull);
  });
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
  final tracks = [
    PlaylistTrack.fromMusicInfo(_playlistMusic('track-1', '第一首')),
    PlaylistTrack.fromMusicInfo(_playlistMusic('track-2', '第二首')),
  ];
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [
      jsonEncode(
        LocalPlaylist(
          id: 'night',
          name: '夜晚循环',
          tracks: tracks,
          createdAt: DateTime.utc(2026, 7, 31),
          updatedAt: DateTime.utc(2026, 7, 31),
        ).toJson(),
      ),
    ],
  });
  return SharedPreferences.getInstance();
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
