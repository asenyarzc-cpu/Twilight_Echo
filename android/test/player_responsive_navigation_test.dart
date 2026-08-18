import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:just_audio/just_audio.dart' show ProcessingState;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/core/ui/app_toast.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/player/player_controller.dart';
import 'package:twilight_echo/features/player/lyric_parser.dart';
import 'package:twilight_echo/features/player/player_page.dart';
import 'package:twilight_echo/features/player/widgets/album_cluster.dart';
import 'package:twilight_echo/features/player/widgets/karaoke_lyrics_view.dart';
import 'package:twilight_echo/features/player/widgets/lyrics_panel.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/features/shell/shell_route_utils.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('system back from debug returns to settings', (tester) async {
    final harness = await _pumpRoutedApp(tester, initialLocation: '/debug');

    expect(harness.router.routeInformationProvider.value.uri.path, '/debug');
    expect(await tester.binding.handlePopRoute(), isTrue);
    await _pumpUi(tester);

    expect(harness.router.routeInformationProvider.value.uri.path, '/settings');
    expect(tester.takeException(), isNull);
  });

  testWidgets('music sources remains a valid player return location', (
    tester,
  ) async {
    expect(
      normalizedPlayerReturnLocation('/settings/sources', '/songs'),
      '/settings/sources',
    );

    final harness = await _pumpRoutedApp(tester, initialLocation: '/songs');
    harness.router.go('/player', extra: '/settings/sources');
    await _pumpUi(tester);

    final player = tester.widget<PlayerPage>(find.byType(PlayerPage));
    expect(player.active, isTrue);
    expect(player.returnLocation, '/settings/sources');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'compact remote player moves quality and source into the cover menu',
    (tester) async {
      final controller = await _pumpPlayer(
        tester,
        size: const Size(390, 844),
        currentMusic: _remoteMusic(),
        track: const PlayerTrack(
          id: 'tx:remote-song',
          kind: PlayerTrackKind.remote,
          title: '窄屏在线歌曲',
          artist: '不应在封面下重复的歌手',
          album: '测试专辑',
          sourceLabel: 'QQ',
          qualityLabel: '320k',
          availableQualityOptions: [
            QualityOption(type: Quality.k320, size: '9.48 MB'),
            QualityOption(type: Quality.k192),
            QualityOption(type: Quality.k128, size: '3.82 MB'),
          ],
          remoteUrl: 'https://audio.example/remote-song.mp3',
        ),
      );
      final container = ProviderScope.containerOf(
        tester.element(find.byType(PlayerPage)),
      );
      final playlist = await container
          .read(localPlaylistsProvider.notifier)
          .create('在线收藏');
      final music = _remoteMusic();

      expect(
        find.byKey(const ValueKey('player-compact-pager')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('player-wide-layout')), findsNothing);
      expect(find.byType(PageView), findsOneWidget);
      final pager = find.byKey(const ValueKey('player-compact-pager'));
      expect(
        find.byKey(const ValueKey('player-compact-pager-edge-guard')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('player-compact-album-clip')),
        findsOneWidget,
      );
      expect(tester.widget<PageView>(pager).clipBehavior, Clip.hardEdge);
      final edgeNotification = OverscrollIndicatorNotification(leading: false);
      edgeNotification.dispatch(tester.element(pager));
      expect(edgeNotification.accepted, isFalse);

      // Track metadata belongs to the header on every compact page and must
      // not be repeated below the cover.
      expect(find.text('窄屏在线歌曲'), findsOneWidget);
      expect(find.text('不应在封面下重复的歌手'), findsOneWidget);
      final title = tester.widget<Text>(
        find.byKey(const ValueKey('player-header-title')),
      );
      final artist = tester.widget<Text>(
        find.byKey(const ValueKey('player-header-artist')),
      );
      expect(title.style?.fontWeight, FontWeight.w500);
      expect(artist.style?.fontSize, lessThan(title.style!.fontSize!));
      expect(artist.style?.fontWeight, FontWeight.w400);

      expect(find.byKey(const ValueKey('player-source-chip')), findsNothing);
      expect(find.byKey(const ValueKey('player-quality-tag')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('player-cover-menu-button')));
      await _pumpUi(tester);

      expect(
        find.byKey(const ValueKey('player-cover-actions-sheet')),
        findsOneWidget,
      );
      expect(find.text('窄屏在线歌曲'), findsNWidgets(2));
      expect(find.text('高品质 320K · QQ'), findsOneWidget);
      expect(
        tester
            .widget<ListTile>(
              find.byKey(const ValueKey('player-cover-action-download')),
            )
            .enabled,
        isTrue,
      );
      expect(
        tester
            .widget<ListTile>(
              find.byKey(const ValueKey('player-cover-action-playlist')),
            )
            .enabled,
        isTrue,
      );

      await tester.tap(
        find.byKey(const ValueKey('player-cover-action-playlist')),
      );
      await _pumpUi(tester);

      expect(find.text('添加歌曲到'), findsOneWidget);
      await tester.tap(find.text('在线收藏'));
      await _pumpUi(tester);

      final storedPlaylist = container
          .read(localPlaylistsProvider)
          .singleWhere((candidate) => candidate.id == playlist.id);
      expect(storedPlaylist.tracks, hasLength(1));
      final storedTrack = storedPlaylist.tracks.single;
      expect(storedTrack.musicId, music.id);
      expect(storedTrack.name, music.name);
      expect(storedTrack.singer, music.singer);
      expect(storedTrack.albumName, music.albumName);
      expect(storedTrack.source, music.source);
      expect(storedTrack.qualityCode, music.bestQuality.code);
      expect(storedTrack.localPath, isNull);
      expect(storedTrack.picUrl, music.meta.picUrl);
      expect(storedTrack.musicJson, music.toJson());
      expect(storedTrack.musicInfo?.toJson(), music.toJson());

      await tester.tap(find.byKey(const ValueKey('player-cover-menu-button')));
      await _pumpUi(tester);

      await tester.tap(
        find.byKey(const ValueKey('player-cover-action-quality')),
      );
      await _pumpUi(tester);

      expect(
        find.byKey(const ValueKey('player-quality-sheet')),
        findsOneWidget,
      );
      expect(find.text('文件大小 9.48 MB'), findsOneWidget);
      expect(find.text('文件大小未知'), findsNothing);
      expect(find.text('较高品质 192K'), findsNothing);
      expect(
        find.byKey(const ValueKey('player-quality-option-192k')),
        findsNothing,
      );
      expect(find.text('文件大小 3.82 MB'), findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('player-quality-option-128k')),
      );
      await _pumpUi(tester);

      expect(controller.switchedQuality, Quality.k128);
      expect(find.byKey(const ValueKey('player-quality-sheet')), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('compact local player disables inapplicable cover actions', (
    tester,
  ) async {
    await _pumpPlayer(
      tester,
      size: const Size(390, 844),
      track: const PlayerTrack(
        id: 'local:test-song',
        kind: PlayerTrackKind.localFile,
        title: '窄屏本地歌曲',
        artist: '本地歌手',
        album: '本地专辑',
        sourceLabel: 'QQ',
        qualityLabel: 'FLAC',
        localPath: 'test-song.flac',
      ),
    );

    expect(find.text('窄屏本地歌曲'), findsOneWidget);
    expect(find.text('本地歌手'), findsOneWidget);
    expect(find.byKey(const ValueKey('player-quality-button')), findsNothing);
    expect(find.byKey(const ValueKey('player-source-chip')), findsNothing);
    expect(find.byKey(const ValueKey('player-quality-tag')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('player-cover-menu-button')));
    await _pumpUi(tester);
    expect(find.text('FLAC · 本地'), findsOneWidget);
    expect(
      tester
          .widget<ListTile>(
            find.byKey(const ValueKey('player-cover-action-download')),
          )
          .enabled,
      isFalse,
    );
    expect(
      tester
          .widget<ListTile>(
            find.byKey(const ValueKey('player-cover-action-quality')),
          )
          .enabled,
      isFalse,
    );
    expect(
      tester
          .widget<ListTile>(
            find.byKey(const ValueKey('player-cover-action-playlist')),
          )
          .enabled,
      isFalse,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact mini lyrics show three lines, scroll, and open lyrics', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 0, endMs: 3000, text: '第一句歌词'),
      KaraokeLyricLine(startMs: 3000, endMs: 6000, text: '第二句歌词'),
      KaraokeLyricLine(startMs: 6000, endMs: 9000, text: '第三句歌词'),
      KaraokeLyricLine(startMs: 9000, endMs: 12000, text: '第四句歌词'),
    ]);
    final controller = await _pumpPlayer(
      tester,
      size: const Size(390, 844),
      track: const PlayerTrack(
        id: 'tx:mini-lyrics',
        kind: PlayerTrackKind.remote,
        title: '迷你歌词测试',
        artist: '测试歌手',
        album: '测试专辑',
        sourceLabel: 'QQ',
        qualityLabel: '320k',
      ),
      lyrics: lyrics,
      position: const Duration(milliseconds: 3500),
    );

    expect(find.byKey(const ValueKey('player-mini-lyrics')), findsOneWidget);
    expect(
      tester
          .widget<Material>(
            find.byKey(const ValueKey('player-mini-lyrics-surface')),
          )
          .color,
      Colors.transparent,
    );
    expect(
      find.byKey(const ValueKey('player-mini-lyric-line-0')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('player-mini-lyric-line-1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('player-mini-lyric-line-2')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('player-mini-lyric-line-3')),
      findsNothing,
    );
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('player-mini-lyric-line-1')))
          .style
          ?.fontWeight,
      FontWeight.w400,
    );
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('player-mini-lyric-line-1')))
          .style
          ?.fontSize,
      14,
    );
    expect(
      tester
          .widget<ImageFiltered>(
            find.byKey(const ValueKey('player-mini-lyric-blur-1')),
          )
          .enabled,
      isFalse,
    );
    expect(
      tester
          .widget<ImageFiltered>(
            find.byKey(const ValueKey('player-mini-lyric-blur-0')),
          )
          .enabled,
      isTrue,
    );

    final miniScroll = find.descendant(
      of: find.byKey(const ValueKey('player-mini-lyrics-scroll')),
      matching: find.byType(Scrollable),
    );
    final scrollState = tester.state<ScrollableState>(miniScroll);
    expect(scrollState.position.pixels, 0);

    controller.setStateForTest(
      controller.state.copyWith(position: const Duration(milliseconds: 6500)),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 190));
    expect(scrollState.position.pixels, inExclusiveRange(0, 22));
    await tester.pumpAndSettle();
    expect(scrollState.position.pixels, closeTo(22, 0.01));
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('player-mini-lyric-line-2')))
          .style
          ?.fontSize,
      14,
    );
    expect(
      tester
          .widget<ImageFiltered>(
            find.byKey(const ValueKey('player-mini-lyric-blur-2')),
          )
          .enabled,
      isFalse,
    );

    final pageView = tester.widget<PageView>(
      find.byKey(const ValueKey('player-compact-pager')),
    );
    await tester.tap(find.byKey(const ValueKey('player-mini-lyrics')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(pageView.controller!.page, inExclusiveRange(0, 1));
    await tester.pumpAndSettle();
    expect(pageView.controller!.page, 1);
    expect(find.byType(KaraokeLyricsView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('cover menu switch hides compact mini lyrics immediately', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 0, endMs: 3000, text: '第一句歌词'),
      KaraokeLyricLine(startMs: 3000, endMs: 6000, text: '第二句歌词'),
      KaraokeLyricLine(startMs: 6000, endMs: 9000, text: '第三句歌词'),
    ]);
    await _pumpPlayer(
      tester,
      size: const Size(390, 844),
      track: const PlayerTrack(
        id: 'tx:toggle-mini-lyrics',
        kind: PlayerTrackKind.remote,
        title: '开关测试',
        artist: '测试歌手',
        album: '测试专辑',
        sourceLabel: 'QQ',
        qualityLabel: '320k',
      ),
      lyrics: lyrics,
    );
    expect(find.byKey(const ValueKey('player-mini-lyrics')), findsOneWidget);
    final liftedCoverTop = tester.getTopLeft(
      find.byKey(const ValueKey('player-cover-menu-button')),
    );

    await tester.tap(find.byKey(const ValueKey('player-cover-menu-button')));
    await _pumpUi(tester);
    await tester.tap(
      find.byKey(const ValueKey('player-cover-action-mini-lyrics-switch')),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('player-mini-lyrics')), findsNothing);
    final centeredCoverTop = tester.getTopLeft(
      find.byKey(const ValueKey('player-cover-menu-button')),
    );
    expect(centeredCoverTop.dy - liftedCoverTop.dy, 36);
    expect(tester.takeException(), isNull);
  });

  testWidgets('late audio readiness does not remount loaded lyrics', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 0, endMs: 3000, text: '已经加载的歌词'),
    ]);
    final controller = await _pumpLyricsPanel(
      tester,
      const PlayerState(lyrics: lyrics),
    );
    final lyricsView = tester.element(find.byType(KaraokeLyricsView));

    controller.setStateForTest(
      const PlayerState(
        track: PlayerTrack(
          id: 'tx:late-audio:remote',
          kind: PlayerTrackKind.remote,
          title: '高音质歌曲',
          artist: '测试歌手',
          album: '测试专辑',
          sourceLabel: 'QQ',
          qualityLabel: 'hires',
          remoteUrl: 'https://audio.example/late.flac',
        ),
        lyrics: lyrics,
        duration: Duration(minutes: 4),
      ),
    );
    await tester.pump();

    expect(find.byType(KaraokeLyricsView), findsOneWidget);
    expect(tester.element(find.byType(KaraokeLyricsView)), same(lyricsView));
    expect(tester.takeException(), isNull);
  });

  testWidgets('lyrics keep their fade but drop it before a pager drag', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 0, endMs: 3000, text: '第一句歌词'),
      KaraokeLyricLine(startMs: 3000, endMs: 6000, text: '第二句歌词'),
      KaraokeLyricLine(startMs: 6000, endMs: 9000, text: '第三句歌词'),
    ]);
    final controller = await _pumpPlayer(
      tester,
      size: const Size(390, 844),
      track: const PlayerTrack(
        id: 'tx:lyrics-edge-fade',
        kind: PlayerTrackKind.remote,
        title: '歌词边缘测试',
        artist: '测试歌手',
        album: '测试专辑',
        sourceLabel: 'QQ',
        qualityLabel: '320k',
        remoteUrl: 'https://audio.example/lyrics-edge-fade.mp3',
      ),
      lyrics: lyrics,
    );
    await tester.drag(
      find.byKey(const ValueKey('player-compact-pager')),
      const Offset(-360, 0),
    );
    await _pumpUi(tester);

    final viewport = find.byType(KaraokeLyricsView);
    final edgeFade = find.byKey(const ValueKey('karaoke-lyrics-edge-fade'));
    final list = find.byKey(const ValueKey('karaoke-lyrics-list'));
    expect(
      find.byKey(const ValueKey('player-compact-lyrics-clip')),
      findsOneWidget,
    );
    expect(edgeFade, findsOneWidget);
    expect(list, findsOneWidget);
    expect(tester.getRect(edgeFade), tester.getRect(viewport));
    expect(tester.getRect(list), tester.getRect(viewport));
    final fadeRenderObject = tester.renderObject<RenderBox>(edgeFade);
    final lyricsListElement = tester.element(list);
    expect(
      tester.widget<LyricsPanel>(find.byType(LyricsPanel)).edgeFadeEnabled,
      isTrue,
    );
    expect(
      find.descendant(of: viewport, matching: find.byType(ImageFiltered)),
      findsWidgets,
    );

    final gesture = await tester.startGesture(tester.getCenter(viewport));
    await tester.pump();
    expect(edgeFade, findsOneWidget);
    await gesture.moveBy(const Offset(8, 0));
    await tester.pump();
    expect(edgeFade, findsOneWidget);
    expect(tester.renderObject<RenderBox>(edgeFade), same(fadeRenderObject));
    expect(tester.element(list), same(lyricsListElement));
    expect(
      tester.widget<LyricsPanel>(find.byType(LyricsPanel)).edgeFadeEnabled,
      isFalse,
    );
    await gesture.moveBy(const Offset(72, 0));
    await tester.pump();
    expect(tester.element(list), same(lyricsListElement));
    expect(
      tester.widget<LyricsPanel>(find.byType(LyricsPanel)).edgeFadeEnabled,
      isFalse,
    );
    controller.setStateForTest(
      controller.state.copyWith(position: const Duration(milliseconds: 3500)),
    );
    await tester.pump();
    expect(tester.element(list), same(lyricsListElement));
    expect(
      tester.widget<LyricsPanel>(find.byType(LyricsPanel)).edgeFadeEnabled,
      isFalse,
    );
    await gesture.up();
    await _pumpUi(tester);
    expect(edgeFade, findsOneWidget);
    expect(tester.renderObject<RenderBox>(edgeFade), same(fadeRenderObject));
    expect(tester.element(list), same(lyricsListElement));
    expect(
      tester.widget<LyricsPanel>(find.byType(LyricsPanel)).edgeFadeEnabled,
      isTrue,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'lyrics keep the current-line scroll position across page swipes',
    (tester) async {
      final lyrics = _timedLyrics(14);
      await _pumpPlayer(
        tester,
        size: const Size(390, 844),
        track: const PlayerTrack(
          id: 'tx:lyrics-page-position',
          kind: PlayerTrackKind.remote,
          title: '歌词位置测试',
          artist: '测试歌手',
          album: '测试专辑',
          sourceLabel: 'QQ',
          qualityLabel: '320k',
        ),
        lyrics: lyrics,
        position: const Duration(milliseconds: 18000),
      );
      final pager = find.byKey(const ValueKey('player-compact-pager'));
      await tester.drag(pager, const Offset(-360, 0));
      await _pumpUi(tester);

      final scrollPosition = _lyricsScrollPosition(tester);
      final initialOffset = scrollPosition.pixels;
      expect(initialOffset, greaterThan(0));

      await tester.drag(pager, const Offset(360, 0));
      await _pumpUi(tester);
      await tester.drag(pager, const Offset(-360, 0));
      await _pumpUi(tester);

      final restoredPosition = _lyricsScrollPosition(tester);
      expect(restoredPosition.pixels, greaterThan(0));
      expect(restoredPosition.pixels, closeTo(initialOffset, 0.01));
      expect(
        find.byKey(const ValueKey('lyric-focus-scale-18000')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('lyric stagger keeps the relocated scroll offset stable', (
    tester,
  ) async {
    final lyrics = _timedLyrics(14);
    final controller = await _pumpLyricsPanel(
      tester,
      PlayerState(
        lyrics: lyrics,
        position: const Duration(milliseconds: 15000),
      ),
    );
    final scrollPosition = _lyricsScrollPosition(tester);
    final initialOffset = scrollPosition.pixels;

    expect(_lyricFocusScale(tester, 15000), closeTo(1, 0.0001));
    expect(_lyricFocusScale(tester, 18000), closeTo(0.95, 0.0001));

    controller.setStateForTest(
      controller.state.copyWith(position: const Duration(milliseconds: 18000)),
    );
    await tester.pump();
    await tester.pump();

    final relocatedOffset = scrollPosition.pixels;
    expect(relocatedOffset, isNot(closeTo(initialOffset, 0.01)));

    for (final interval in const [
      Duration(milliseconds: 100),
      Duration(milliseconds: 150),
      Duration(milliseconds: 200),
      Duration(milliseconds: 250),
    ]) {
      await tester.pump(interval);
      expect(scrollPosition.pixels, closeTo(relocatedOffset, 0.001));
    }

    expect(_lyricFocusScale(tester, 15000), closeTo(0.95, 0.0001));
    expect(_lyricFocusScale(tester, 18000), closeTo(1, 0.0001));
    expect(tester.takeException(), isNull);
  });

  testWidgets('word-timed lyric keeps its layout height across focus changes', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    const longLine = KaraokeLyricLine(
      startMs: 3000,
      endMs: 6000,
      text: '春风穿过旧山河星光落在长街上我们走向晨曦里月色停在窗台前',
      words: [
        KaraokeWordTiming(text: '春风穿过旧山河', startMs: 3000, endMs: 3700),
        KaraokeWordTiming(text: '星光落在长街上', startMs: 3700, endMs: 4400),
        KaraokeWordTiming(text: '我们走向晨曦里', startMs: 4400, endMs: 5100),
        KaraokeWordTiming(text: '月色停在窗台前', startMs: 5100, endMs: 5800),
      ],
    );
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 0, endMs: 3000, text: '前一句'),
      longLine,
      KaraokeLyricLine(startMs: 6000, endMs: 9000, text: '后一句'),
    ]);
    final controller = await _pumpLyricsPanel(
      tester,
      const PlayerState(lyrics: lyrics),
    );
    final longLineFinder = find.byKey(const ValueKey('lyric-stagger-3000'));
    final inactiveHeight = tester.getSize(longLineFinder).height;
    expect(inactiveHeight, greaterThan(100));

    controller.setStateForTest(
      controller.state.copyWith(position: const Duration(milliseconds: 3500)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(
      tester.getSize(longLineFinder).height,
      closeTo(inactiveHeight, 0.001),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('word progress keeps elapsed time when a new line activates', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(
        startMs: 0,
        endMs: 1000,
        text: '前一句',
        words: [KaraokeWordTiming(text: '前一句', startMs: 0, endMs: 1000)],
      ),
      KaraokeLyricLine(
        startMs: 1000,
        endMs: 3000,
        text: '新一句',
        words: [KaraokeWordTiming(text: '新一句', startMs: 1000, endMs: 2000)],
      ),
    ]);
    final controller = await _pumpLyricsPanel(
      tester,
      const PlayerState(lyrics: lyrics, position: Duration(milliseconds: 990)),
    );

    controller.setStateForTest(controller.state.copyWith(playing: true));
    await tester.pump();
    // No position anchor is published here. The line-advance timer activates
    // the second row from wall-clock elapsed time after the 990 ms anchor.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 80)),
    );
    await tester.pump(const Duration(milliseconds: 10));
    await tester.pump();

    expect(_activeWordProgress(tester, 1000), greaterThan(0.02));
    expect(tester.takeException(), isNull);
  });

  testWidgets('word progress pauses while buffering and resumes afterwards', (
    tester,
  ) async {
    const lyrics = KaraokeLyrics([
      KaraokeLyricLine(
        startMs: 0,
        endMs: 6000,
        text: '缓冲中的逐字歌词',
        words: [KaraokeWordTiming(text: '缓冲中的逐字歌词', startMs: 0, endMs: 5000)],
      ),
    ]);
    final controller = await _pumpLyricsPanel(
      tester,
      const PlayerState(lyrics: lyrics, position: Duration(milliseconds: 1000)),
    );

    controller.setStateForTest(controller.state.copyWith(playing: true));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    controller.setStateForTest(
      controller.state.copyWith(
        position: const Duration(milliseconds: 1200),
        processingState: ProcessingState.buffering,
      ),
    );
    await tester.pump();

    final bufferedProgress = _activeWordProgress(tester, 0);
    expect(bufferedProgress, closeTo(0.24, 0.001));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    expect(_activeWordProgress(tester, 0), closeTo(bufferedProgress, 0.0001));

    controller.setStateForTest(
      controller.state.copyWith(processingState: ProcessingState.ready),
    );
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();

    expect(
      _activeWordProgress(tester, 0),
      greaterThan(bufferedProgress + 0.01),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('wide player renders album and lyrics together without pager', (
    tester,
  ) async {
    await _pumpPlayer(
      tester,
      size: const Size(1024, 600),
      track: const PlayerTrack(
        id: 'wy:wide-song',
        kind: PlayerTrackKind.remote,
        title: '宽屏歌曲',
        artist: '宽屏歌手',
        album: '宽屏专辑',
        sourceLabel: '网易',
        qualityLabel: '无损',
        remoteUrl: 'https://audio.example/wide-song.flac',
      ),
      lyrics: const KaraokeLyrics([
        KaraokeLyricLine(startMs: 0, endMs: 3000, text: '宽屏第一句'),
        KaraokeLyricLine(startMs: 3000, endMs: 6000, text: '宽屏第二句'),
        KaraokeLyricLine(startMs: 6000, endMs: 9000, text: '宽屏第三句'),
      ]),
    );

    expect(find.byKey(const ValueKey('player-wide-layout')), findsOneWidget);
    expect(find.byKey(const ValueKey('player-compact-pager')), findsNothing);
    expect(find.byType(PageView), findsNothing);
    expect(find.byType(VerticalDivider), findsNothing);
    expect(find.byType(AlbumPage), findsOneWidget);
    expect(find.byType(LyricsPanel), findsOneWidget);
    expect(find.text('宽屏歌曲'), findsOneWidget);
    expect(find.text('宽屏歌手'), findsOneWidget);
    expect(find.byKey(const ValueKey('player-mini-lyrics')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('player-cover-menu-button')));
    await _pumpUi(tester);
    expect(
      find.byKey(const ValueKey('player-cover-actions-sheet')),
      findsOneWidget,
    );
    expect(find.text('仅在手机播放封面页显示'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class _RouterHarness {
  const _RouterHarness({required this.router});

  final GoRouter router;
}

class _SeededPlayerController extends PlayerController {
  _SeededPlayerController(
    super.ref,
    PlayerState initialState, {
    this.seededCurrentMusic,
  }) {
    state = initialState;
  }

  Quality? switchedQuality;
  final MusicInfo? seededCurrentMusic;

  @override
  MusicInfo? get currentMusic => seededCurrentMusic ?? super.currentMusic;

  void setStateForTest(PlayerState next) => state = next;

  @override
  Future<bool> switchQuality(Quality quality) async {
    switchedQuality = quality;
    return true;
  }
}

Future<_SeededPlayerController> _pumpLyricsPanel(
  WidgetTester tester,
  PlayerState initialState,
) async {
  final preferences = await SharedPreferences.getInstance();
  final audioHandler = PlayerAudioHandler();
  addTearDown(() => unawaited(audioHandler.disposeHandler()));
  late _SeededPlayerController controller;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
        playerControllerProvider.overrideWith(
          (ref) => controller = _SeededPlayerController(ref, initialState),
        ),
      ],
      child: MaterialApp(
        theme: _theme(),
        home: const Scaffold(body: LyricsPanel()),
      ),
    ),
  );
  await _pumpUi(tester);
  controller.setStateForTest(initialState);
  await _pumpUi(tester);
  return controller;
}

Future<_RouterHarness> _pumpRoutedApp(
  WidgetTester tester, {
  required String initialLocation,
}) async {
  final preferences = await SharedPreferences.getInstance();
  final audioHandler = PlayerAudioHandler();
  final router = createAppRouter(initialLocation: initialLocation);
  addTearDown(router.dispose);
  addTearDown(() => unawaited(audioHandler.disposeHandler()));

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
        playerControllerProvider.overrideWith(
          (ref) => _SeededPlayerController(ref, const PlayerState()),
        ),
      ],
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: _theme(),
        routerConfig: router,
      ),
    ),
  );
  await _pumpUi(tester);
  return _RouterHarness(router: router);
}

Future<_SeededPlayerController> _pumpPlayer(
  WidgetTester tester, {
  required Size size,
  required PlayerTrack track,
  KaraokeLyrics lyrics = const KaraokeLyrics([]),
  Duration position = Duration.zero,
  MusicInfo? currentMusic,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(() {
    tester.view.resetDevicePixelRatio();
    tester.view.resetPhysicalSize();
  });

  final preferences = await SharedPreferences.getInstance();
  final audioHandler = PlayerAudioHandler();
  addTearDown(() => unawaited(audioHandler.disposeHandler()));
  final initialState = PlayerState(
    track: track,
    duration: const Duration(minutes: 3),
    lyrics: lyrics,
    position: position,
  );
  late _SeededPlayerController controller;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
        playerControllerProvider.overrideWith(
          (ref) => controller = _SeededPlayerController(
            ref,
            initialState,
            seededCurrentMusic: currentMusic,
          ),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: _theme(),
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        home: PlayerPage(
          returnLocation: '/songs',
          progress: const AlwaysStoppedAnimation<double>(1),
          active: true,
          onDismissRequested: _ignoreDismiss,
        ),
      ),
    ),
  );
  await _pumpUi(tester);
  controller.setStateForTest(initialState);
  await _pumpUi(tester);
  return controller;
}

KaraokeLyrics _timedLyrics(int count) {
  return KaraokeLyrics([
    for (var index = 0; index < count; index++)
      KaraokeLyricLine(
        startMs: index * 3000,
        endMs: (index + 1) * 3000,
        text: '第${index + 1}句歌词用于测试平稳切换',
      ),
  ]);
}

ScrollPosition _lyricsScrollPosition(WidgetTester tester) {
  final scrollable = find.descendant(
    of: find.byKey(const ValueKey('karaoke-lyrics-list')),
    matching: find.byType(Scrollable),
  );
  return tester.state<ScrollableState>(scrollable).position;
}

double _lyricFocusScale(WidgetTester tester, int startMs) {
  final transform = tester.widget<Transform>(
    find.byKey(ValueKey('lyric-focus-scale-$startMs')),
  );
  return transform.transform.storage.first;
}

double _activeWordProgress(WidgetTester tester, int lineStartMs) {
  final progressAlign = find.descendant(
    of: find.byKey(ValueKey('lyric-focus-scale-$lineStartMs')),
    matching: find.byWidgetPredicate(
      (widget) => widget is Align && widget.widthFactor != null,
    ),
  );
  return tester.widget<Align>(progressAlign).widthFactor!;
}

ThemeData _theme() {
  return ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
  );
}

void _ignoreDismiss([String? target]) {}

Future<void> _pumpUi(WidgetTester tester) async {
  for (var index = 0; index < 12; index++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

MusicInfo _remoteMusic() => MusicInfo.fromJson({
  'id': 'remote-song',
  'name': '窄屏在线歌曲',
  'singer': '不应在封面下重复的歌手',
  'source': MusicSource.tx.code,
  'meta': {
    'songId': 'remote-song',
    'albumName': '测试专辑',
    'qualitys': [
      {'type': Quality.k320.code, 'size': '9.48 MB'},
      {'type': Quality.k128.code, 'size': '3.82 MB'},
    ],
  },
});
