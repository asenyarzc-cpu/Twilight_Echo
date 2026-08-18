import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_symbols_icons/symbols.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/core/api/music_api.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/playlist_info.dart';
import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/player/lyric_parser.dart';
import 'package:twilight_echo/features/player/player_controller.dart';
import 'package:twilight_echo/features/player/player_page.dart';
import 'package:twilight_echo/features/player/flowing_light_background.dart';
import 'package:twilight_echo/features/playlists/playlist_detail_page.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets(
    'songs playlist entry preserves management source through player return',
    (tester) async {
      await _usePhoneViewport(tester);
      final prefs = await _prefsWith([_playlist(id: 'night', name: '夜晚循环')]);
      final audioHandler = PlayerAudioHandler();
      final router = createAppRouter(initialLocation: '/songs');
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

      expect(router.routeInformationProvider.value.uri.path, '/songs');
      await tester.tap(find.byTooltip('歌单'));
      await _pumpUi(tester);
      expect(find.text('歌单管理'), findsOneWidget);

      await tester.tap(find.text('歌单管理'));
      await _pumpUi(tester);
      expect(find.byType(DraggableScrollableSheet), findsNothing);
      expect(router.routeInformationProvider.value.uri.path, '/playlists');
      expect(find.text('夜晚循环'), findsOneWidget);
      expect(find.byTooltip('返回上一页'), findsNothing);

      await tester.tap(find.text('夜晚循环'));
      await _pumpUi(tester);
      expect(
        router.routeInformationProvider.value.uri.toString(),
        '/playlists/night?from=manage',
      );

      final detail = tester.widget<PlaylistDetailPage>(
        find.byType(PlaylistDetailPage),
      );
      expect(detail.returnLocation, '/playlists/night?from=manage');
      expect(find.byTooltip('返回上一页'), findsNothing);

      await tester.tap(find.byTooltip('播放页'));
      await _pumpUi(tester);
      expect(find.byType(PlayerPage), findsOneWidget);
      expect(router.routeInformationProvider.value.uri.path, '/player');
      expect(find.byTooltip('返回'), findsNothing);
      expect(find.byIcon(Icons.keyboard_arrow_down_rounded), findsNothing);

      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));
      expect(router.routeInformationProvider.value.uri.path, '/player');
      final exitSlide = tester.widget<SlideTransition>(
        find.byKey(const ValueKey('player-exit-slide')),
      );
      expect(exitSlide.position.value.dy, greaterThan(0));
      expect(exitSlide.position.value.dy, lessThan(1));

      await tester.pump(const Duration(milliseconds: 220));
      await tester.pump();
      expect(
        router.routeInformationProvider.value.uri.toString(),
        '/playlists/night?from=manage',
      );
      await _pumpUi(tester);

      expect(await tester.binding.handlePopRoute(), isTrue);
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/playlists');
      expect(find.text('夜晚循环'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'library view menu fills songs in place and keeps management button',
    (tester) async {
      await _usePhoneViewport(tester);
      final prefs = await _prefsWith([
        _playlist(
          id: 'night',
          name: '夜晚循环',
          tracks: const [
            PlaylistTrack(
              musicId: 'track-1',
              name: '夜曲',
              singer: '周杰伦',
              albumName: '十一月的萧邦',
              sourceCode: 'wy',
              qualityCode: 'flac',
            ),
          ],
        ),
      ]);
      final audioHandler = PlayerAudioHandler();
      final router = createAppRouter(initialLocation: '/songs');
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

      // 首页标题下拉：列出本地歌曲与歌单。
      await tester.tap(find.byIcon(Icons.arrow_drop_down_rounded));
      await _pumpUi(tester);
      expect(find.text('本地歌曲'), findsOneWidget);
      expect(find.text('夜晚循环'), findsOneWidget);

      // 选歌单只在 Songs 页原地换入歌单曲目。
      await tester.tap(find.text('夜晚循环'));
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/songs');
      expect(find.text('夜曲'), findsOneWidget);
      expect(find.text('1 首歌单歌曲'), findsOneWidget);
      expect(
        find.byKey(
          const ValueKey('song-playing-playlist:night:music:wy:track-1'),
        ),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('immersive-playlist-header')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('songs-sort-button')), findsNothing);

      await tester.tap(find.byTooltip('更多歌曲操作'));
      await _pumpUi(tester);
      expect(find.text('搜索歌单歌曲'), findsOneWidget);
      expect(find.text('搜索本地歌曲'), findsNothing);
      await tester.tap(find.text('搜索歌单歌曲'));
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/songs/search');
      expect(find.text('搜索歌单歌曲'), findsOneWidget);
      expect(await tester.binding.handlePopRoute(), isTrue);
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/songs');

      await tester.tap(find.byKey(const ValueKey('songs-batch-button')));
      await _pumpUi(tester);
      expect(find.text('移出歌单'), findsOneWidget);
      expect(find.text('加入歌单'), findsNothing);
      expect(find.text('永久删除'), findsNothing);
      await tester.tap(find.byTooltip('退出批量管理'));
      await _pumpUi(tester);

      // 切换到歌单后，右侧按钮仍保持默认的歌单管理入口。
      await tester.tap(find.byTooltip('歌单'));
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/songs');
      expect(find.text('歌单管理'), findsOneWidget);
      await tester.tap(find.text('歌单管理'));
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/playlists');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('songs playlist overflow updates online playlists only', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final online = _playlist(
      id: 'online',
      name: '在线收藏',
      tracks: [PlaylistTrack.fromMusicInfo(_playlistMusic('old', '旧歌曲'))],
      originPlaylistId: '3778678',
      originSourceCode: MusicSource.wy.code,
    );
    final local = _playlist(id: 'local', name: '本地新建');
    final prefs = await _prefsWith([online, local]);
    final audioHandler = PlayerAudioHandler();
    final api = _PlaylistRefreshMusicApi(
      PlaylistInfo(
        id: '3778678',
        name: '线上榜单',
        source: MusicSource.wy,
        tracks: [_playlistMusic('old', '新歌名'), _playlistMusic('new', '新歌曲')],
      ),
    );
    final router = createAppRouter(initialLocation: '/songs');
    addTearDown(() {
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          playerAudioHandlerProvider.overrideWithValue(audioHandler),
          musicApiProvider.overrideWithValue(api),
        ],
        child: MaterialApp.router(
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          ),
          routerConfig: router,
        ),
      ),
    );
    await _pumpUi(tester);

    await tester.tap(find.byIcon(Icons.arrow_drop_down_rounded));
    await _pumpUi(tester);
    await tester.tap(find.text('在线收藏'));
    await _pumpUi(tester);
    await tester.tap(find.byTooltip('更多歌曲操作'));
    await _pumpUi(tester);
    expect(find.text('更新歌单'), findsOneWidget);
    await tester.tap(find.text('更新歌单'));
    await _pumpUi(tester);
    expect(api.inputs, ['3778678']);
    expect(find.text('新歌曲'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.arrow_drop_down_rounded));
    await _pumpUi(tester);
    await tester.tap(find.text('本地新建'));
    await _pumpUi(tester);
    await tester.tap(find.byTooltip('更多歌曲操作'));
    await _pumpUi(tester);
    expect(find.text('更新歌单'), findsNothing);
    await tester.tapAt(const Offset(1, 1));
    await tester.pump(const Duration(seconds: 4));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'library radio menu limits long names and scrolls many playlists',
    (tester) async {
      await _usePhoneViewport(tester);
      const longName = '这是一个长度明显超过菜单宽度限制的测试歌单名称';
      final playlists = [
        for (var index = 0; index < 12; index++)
          _playlist(
            id: 'list-$index',
            name: index == 0 ? longName : '歌单 $index',
          ),
      ];
      final prefs = await _prefsWith(playlists);
      final audioHandler = PlayerAudioHandler();
      final router = createAppRouter(initialLocation: '/songs');
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

      await tester.tap(find.byKey(const ValueKey('library-view-menu-anchor')));
      await _pumpUi(tester);

      final panel = find.byKey(const ValueKey('library-view-menu-panel'));
      final scroll = find.byKey(const ValueKey('library-view-menu-scroll'));
      final localOption = find.byKey(
        const ValueKey('library-view-menu-option-local'),
      );
      final longOption = find.byKey(
        const ValueKey('library-view-menu-option-playlist-list-0'),
      );
      final lastOption = find.byKey(
        const ValueKey('library-view-menu-option-playlist-list-11'),
      );
      expect(panel, findsOneWidget);
      expect(scroll, findsOneWidget);
      expect(tester.getSize(panel).height, closeTo(300, 0.01));
      expect(tester.getSize(panel).width, lessThanOrEqualTo(240.01));
      expect(
        find.descendant(
          of: localOption,
          matching: find.byIcon(Icons.radio_button_checked_rounded),
        ),
        findsOneWidget,
      );
      final longLabel = tester.widget<Text>(
        find.descendant(of: longOption, matching: find.text(longName)),
      );
      expect(longLabel.maxLines, 1);
      expect(longLabel.overflow, TextOverflow.ellipsis);

      final initialLastTop = tester.getTopLeft(lastOption).dy;
      await tester.drag(scroll, const Offset(0, -220));
      await _pumpUi(tester);
      expect(tester.getTopLeft(lastOption).dy, lessThan(initialLastTop));

      expect(await tester.binding.handlePopRoute(), isTrue);
      await _pumpUi(tester);
      expect(panel, findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('player back closes playback queue before leaving the player', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/player');
    addTearDown(() {
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          playerAudioHandlerProvider.overrideWithValue(audioHandler),
          playerControllerProvider.overrideWith(_TestPlayerController.new),
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

    final container = ProviderScope.containerOf(
      tester.element(find.byType(PlayerPage)),
    );
    final controller =
        container.read(playerControllerProvider.notifier)
            as _TestPlayerController;
    controller.seedPlayingTrack();
    await tester.pump();

    await tester.tap(find.byTooltip('播放列表，共 1 首'));
    await _pumpUi(tester);

    expect(find.text('播放列表'), findsOneWidget);
    final bottomSheet = tester.widget<BottomSheet>(find.byType(BottomSheet));
    expect(bottomSheet.showDragHandle, isFalse);

    final playingBars = find.byKey(const ValueKey('playing-bars'));
    expect(playingBars, findsOneWidget);
    final firstBar = find
        .descendant(of: playingBars, matching: find.byType(Transform))
        .first;
    final scaleBefore = tester.widget<Transform>(firstBar).transform.storage[5];
    await tester.pump(const Duration(milliseconds: 140));
    final scaleAfter = tester.widget<Transform>(firstBar).transform.storage[5];
    expect(scaleAfter, isNot(closeTo(scaleBefore, 0.0001)));

    expect(await tester.binding.handlePopRoute(), isTrue);
    await _pumpUi(tester);

    expect(find.text('播放列表'), findsNothing);
    expect(router.routeInformationProvider.value.uri.path, '/player');

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(router.routeInformationProvider.value.uri.path, '/player');
    final exitSlide = tester.widget<SlideTransition>(
      find.byKey(const ValueKey('player-exit-slide')),
    );
    expect(exitSlide.position.value.dy, greaterThan(0));
    await tester.pump(const Duration(milliseconds: 220));
    await tester.pump();
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    await _pumpUi(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('playback queue opens centered on the current track', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/player');
    addTearDown(() {
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          playerAudioHandlerProvider.overrideWithValue(audioHandler),
          playerControllerProvider.overrideWith(_TestPlayerController.new),
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

    final container = ProviderScope.containerOf(
      tester.element(find.byType(PlayerPage)),
    );
    final controller =
        container.read(playerControllerProvider.notifier)
            as _TestPlayerController;
    controller.seedPlayingQueue(count: 30, currentIndex: 20);
    await tester.pump();

    await tester.tap(find.byTooltip('播放列表，共 30 首'));
    await _pumpUi(tester);

    final list = find.byKey(const ValueKey('playback-queue-list'));
    final current = find.byKey(const ValueKey('playback-queue-entry-20'));
    expect(list, findsOneWidget);
    expect(current, findsOneWidget);
    expect(tester.getCenter(current).dy, closeTo(tester.getCenter(list).dy, 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('player applies dark backdrop and dark-theme foreground', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/player');
    final darkScheme = ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    );
    addTearDown(() {
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          playerAudioHandlerProvider.overrideWithValue(audioHandler),
          playerControllerProvider.overrideWith(_TestPlayerController.new),
        ],
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          themeMode: ThemeMode.dark,
          theme: ThemeData(useMaterial3: true, colorScheme: darkScheme),
          darkTheme: ThemeData(useMaterial3: true, colorScheme: darkScheme),
          routerConfig: router,
        ),
      ),
    );
    await _pumpUi(tester);

    final container = ProviderScope.containerOf(
      tester.element(find.byType(PlayerPage)),
    );
    final controller =
        container.read(playerControllerProvider.notifier)
            as _TestPlayerController;
    controller.seedLyricsTrack();
    await tester.pump();

    expect(
      tester
          .widget<FlowingLightBackground>(find.byType(FlowingLightBackground))
          .brightness,
      Brightness.dark,
    );
    expect(
      find.descendant(
        of: find.byType(FlowingLightBackground),
        matching: find.byType(Transform),
      ),
      findsNothing,
    );
    final topQueueIcon = find.descendant(
      of: find.byTooltip('本地歌曲'),
      matching: find.byIcon(Symbols.library_music_rounded),
    );
    expect(tester.widget<Icon>(topQueueIcon).color, darkScheme.onSurface);
    expect(tester.takeException(), isNull);
  });

  testWidgets('shell toolbar follows a drag continuously before settling', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/songs');
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

    final initialTop = tester.getTopLeft(find.byTooltip('发现')).dy;
    final gesture = await tester.startGesture(const Offset(195, 380));
    await gesture.moveBy(const Offset(0, -34));
    await tester.pump();

    final draggedTop = tester.getTopLeft(find.byTooltip('发现')).dy;
    expect(draggedTop, greaterThan(initialTop));
    expect(draggedTop, lessThan(initialTop + 68));

    await gesture.up();
    await tester.pump(const Duration(milliseconds: 80));
    final settlingTop = tester.getTopLeft(find.byTooltip('发现')).dy;
    expect(settlingTop, greaterThanOrEqualTo(draggedTop));
    await _pumpUi(tester);
    final hiddenTop = tester.getTopLeft(find.byTooltip('发现')).dy;
    expect(hiddenTop, greaterThan(initialTop));

    final reverseGesture = await tester.startGesture(const Offset(195, 380));
    await reverseGesture.moveBy(const Offset(0, 34));
    await tester.pump();
    final restoredPartiallyTop = tester.getTopLeft(find.byTooltip('发现')).dy;
    expect(restoredPartiallyTop, lessThan(hiddenTop));
    expect(restoredPartiallyTop, greaterThan(initialTop));

    await reverseGesture.up();
    await _pumpUi(tester);
    expect(tester.getTopLeft(find.byTooltip('发现')).dy, lessThan(hiddenTop));
    expect(tester.takeException(), isNull);
  });

  testWidgets('shell toolbar fits compact width with large text', (
    tester,
  ) async {
    await _usePhoneViewport(tester, size: const Size(320, 720));
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/songs');
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
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          ),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(1.6)),
            child: child!,
          ),
          routerConfig: router,
        ),
      ),
    );
    await _pumpUi(tester);

    for (final tooltip in ['发现', '歌曲', '播放页', '设置']) {
      final size = tester.getSize(find.byTooltip(tooltip));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a short toolbar pull tracks the finger then settles back', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/songs');
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

    final gesture = await tester.startGesture(
      tester.getCenter(find.byTooltip('发现')),
    );
    // Pointer-down mounts the player layer before the drag clears the slop.
    await tester.pump();
    // The first move only crosses the touch slop — DragStartBehavior.start
    // absorbs it — so the tracked distance comes from the moves after it.
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump();
    await gesture.moveBy(const Offset(0, -130));
    await tester.pump();

    final dragged = tester.widget<SlideTransition>(
      find.byKey(const ValueKey('player-exit-slide')),
    );
    expect(dragged.position.value.dy, greaterThan(0));
    expect(dragged.position.value.dy, lessThan(1));
    expect(router.routeInformationProvider.value.uri.path, '/songs');

    await gesture.up();
    await _pumpUi(tester);

    // 150 of 844 logical pixels is short of the reveal threshold: the player
    // parks itself again and the route never changes.
    final settled = tester.widget<SlideTransition>(
      find.byKey(const ValueKey('player-exit-slide')),
    );
    expect(settled.position.value.dy, 1);
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a long toolbar pull commits and remembers the return route', (
    tester,
  ) async {
    await _usePhoneViewport(tester);
    final prefs = await _prefsWith(const []);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/settings');
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

    final gesture = await tester.startGesture(
      tester.getCenter(find.byTooltip('发现')),
    );
    await tester.pump();
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump();
    await gesture.moveBy(const Offset(0, -500));
    await tester.pump();
    await gesture.up();
    await _pumpUi(tester);

    expect(router.routeInformationProvider.value.uri.path, '/player');
    final page = tester.widget<PlayerPage>(find.byType(PlayerPage));
    expect(page.active, isTrue);
    // The pull carries the origin route through, so leaving the player goes
    // back to settings rather than the '/songs' default.
    expect(page.returnLocation, '/settings');
    expect(
      tester
          .widget<SlideTransition>(
            find.byKey(const ValueKey('player-exit-slide')),
          )
          .position
          .value
          .dy,
      0,
    );
    expect(tester.takeException(), isNull);
  });
}

class _TestPlayerController extends PlayerController {
  _TestPlayerController(super.ref);

  void seedPlayingTrack() {
    state = const PlayerState(
      track: PlayerTrack(
        id: 'test:queue-track',
        kind: PlayerTrackKind.localFile,
        title: '测试歌曲',
        artist: '测试歌手',
        album: '测试专辑',
        sourceLabel: '本地',
        qualityLabel: 'FLAC',
        localPath: 'test-song.flac',
      ),
      playing: true,
      duration: Duration(minutes: 3),
    );
  }

  void seedPlayingQueue({required int count, required int currentIndex}) {
    final queue = List<DownloadHistoryEntry>.generate(
      count,
      (index) => DownloadHistoryEntry(
        id: 'queue-$index',
        musicId: 'queue-$index',
        name: '队列歌曲 ${index + 1}',
        singer: '测试歌手',
        albumName: '测试专辑',
        sourceCode: 'wy',
        qualityCode: 'flac',
        status: DownloadHistoryStatus.completed,
        createdAt: DateTime.utc(2026, 8, 10),
      ),
    );
    final current = queue[currentIndex];
    state = PlayerState(
      track: PlayerTrack(
        id: current.id,
        kind: PlayerTrackKind.remote,
        title: current.name,
        artist: current.singer,
        album: current.albumName,
        sourceLabel: '网易云音乐',
        qualityLabel: 'FLAC',
      ),
      playing: true,
      duration: const Duration(minutes: 3),
      queue: queue,
      queueIndex: currentIndex,
      canPlayPrevious: true,
      canPlayNext: true,
    );
  }

  void seedLyricsTrack() {
    final lines = List<KaraokeLyricLine>.generate(18, (index) {
      final startMs = index * 3000;
      return KaraokeLyricLine(
        startMs: startMs,
        endMs: startMs + 3000,
        text: '第 ${index + 1} 行测试歌词',
        translation: index.isEven ? 'Test lyric line ${index + 1}' : null,
      );
    });
    state = PlayerState(
      track: const PlayerTrack(
        id: 'test:lyrics-track',
        kind: PlayerTrackKind.localFile,
        title: '歌词测试歌曲',
        artist: '测试歌手',
        album: '测试专辑',
        sourceLabel: '本地',
        qualityLabel: 'FLAC',
        coverUrl: 'https://example.com/lyrics-cover.jpg',
        localPath: 'lyrics-test.flac',
      ),
      lyrics: KaraokeLyrics(lines),
      playing: true,
      position: const Duration(seconds: 9),
      duration: const Duration(minutes: 3),
    );
  }

  @override
  Future<void> seek(Duration position) {
    state = state.copyWith(position: position);
    return Future<void>.value();
  }

  void advanceLyrics(Duration position) {
    state = state.copyWith(position: position);
  }
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

Future<SharedPreferences> _prefsWith(List<LocalPlaylist> playlists) async {
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [
      for (final playlist in playlists) jsonEncode(playlist.toJson()),
    ],
  });
  return SharedPreferences.getInstance();
}

LocalPlaylist _playlist({
  required String id,
  required String name,
  List<PlaylistTrack> tracks = const [],
  String? originPlaylistId,
  String? originSourceCode,
}) {
  final now = DateTime.utc(2026, 7, 20);
  return LocalPlaylist(
    id: id,
    name: name,
    tracks: tracks,
    createdAt: now,
    updatedAt: now,
    originPlaylistId: originPlaylistId,
    originSourceCode: originSourceCode,
  );
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

class _PlaylistRefreshMusicApi extends MusicApi {
  _PlaylistRefreshMusicApi(this.result);

  final PlaylistInfo result;
  final List<String> inputs = <String>[];

  @override
  Future<PlaylistInfo> parsePlaylist({
    required String input,
    MusicSource source = MusicSource.all,
    int? maxTracks,
  }) async {
    inputs.add(input);
    return result;
  }
}
