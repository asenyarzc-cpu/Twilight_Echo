import 'dart:async';
import 'dart:convert';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/api/music_api.dart';
import 'package:twilight_echo/core/models/download_capabilities.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/playlist_info.dart';
import 'package:twilight_echo/core/models/playlist_summary.dart';
import 'package:twilight_echo/core/models/search_response.dart';
import 'package:twilight_echo/core/music_sources/music_source_controller.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/core/ui/app_toast.dart';
import 'package:twilight_echo/core/ui/cover_placeholder.dart';
import 'package:twilight_echo/features/discovery/discovery_content.dart';
import 'package:twilight_echo/features/discovery/discovery_controller.dart';
import 'package:twilight_echo/features/discovery/online_playlist_detail_page.dart';
import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/player/player_controller.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';
import 'package:twilight_echo/features/playlists/widgets/immersive_playlist_chrome.dart';
import 'package:twilight_echo/features/search/search_controller.dart';
import 'package:twilight_echo/features/search/search_page.dart';
import 'package:twilight_echo/features/search/search_toolbar_state.dart';
import 'package:twilight_echo/features/shell/widgets/discovery_category_fab.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('discovery masonry uses two stable columns on phones', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryContent()),
    );
    await tester.pumpAndSettle();

    final before = _cardPositions(tester, MusicSource.kw, 9);
    expect(find.byType(CoverUnavailablePlaceholder), findsNWidgets(9));
    expect(
      tester
          .widgetList<Hero>(find.byType(Hero))
          .where(
            (hero) =>
                hero.tag == onlinePlaylistArtworkHeroTag(MusicSource.kw, '1'),
          ),
      hasLength(1),
    );
    expect(find.text('酷我'), findsOneWidget);
    expect(
      before.values.map((offset) => offset.dx.round()).toSet(),
      hasLength(2),
    );

    container.invalidate(featuredPlaylistsProvider(MusicSource.kw));
    await tester.pumpAndSettle();
    expect(_cardPositions(tester, MusicSource.kw, 9), before);
    expect(tester.takeException(), isNull);
  });

  testWidgets('opening an online playlist never fades through the shell', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi(delayDetail: true);
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
      ],
    );
    addTearDown(() {
      container.dispose();
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          ),
          builder: (context, child) =>
              AppToastOverlay(child: child ?? const SizedBox.shrink()),
          routerConfig: router,
        ),
      ),
    );
    for (var frame = 0; frame < 12; frame++) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    await tester.tap(find.byKey(const ValueKey('discovery-card-kw:1')));
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 1));
      if (find.byType(OnlinePlaylistDetailPage).evaluate().isNotEmpty) break;
    }
    await tester.pump();
    _expectOnlineDetailFullyOpaque(tester);

    await tester.pump(const Duration(milliseconds: 80));
    _expectOnlineDetailFullyOpaque(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('artwork theme reuses its resolved color after remounting', (
    tester,
  ) async {
    const probeKey = ValueKey('artwork-theme-color-probe');
    final baseScheme = ColorScheme.fromSeed(seedColor: Colors.teal);
    final artwork = MemoryImage(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAA'
        'AARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAASSURBVBhXY7ij'
        'rPsfhKEM3f8ATTgIrTbBk9sAAAAASUVORK5CYII=',
      ),
    );

    Widget app({required bool showArtworkTheme}) {
      return MaterialApp(
        theme: ThemeData(useMaterial3: true, colorScheme: baseScheme),
        home: showArtworkTheme
            ? PlaylistArtworkTheme(
                artworkProvider: artwork,
                cacheKey: 'test:resolved-artwork-remount',
                child: Builder(
                  builder: (context) => ColoredBox(
                    key: probeKey,
                    color: Theme.of(context).colorScheme.primary,
                    child: const SizedBox.expand(),
                  ),
                ),
              )
            : const SizedBox.shrink(),
      );
    }

    Color probeColor() => tester.widget<ColoredBox>(find.byKey(probeKey)).color;

    await tester.pumpWidget(app(showArtworkTheme: true));
    for (var frame = 0; frame < 20; frame++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump(const Duration(milliseconds: 100));
      if (probeColor() != baseScheme.primary) break;
    }
    await tester.pump(const Duration(milliseconds: 600));
    final artworkColor = probeColor();
    expect(artworkColor, isNot(baseScheme.primary));

    await tester.pumpWidget(app(showArtworkTheme: false));
    await tester.pump();
    await tester.pumpWidget(app(showArtworkTheme: true));

    expect(probeColor(), artworkColor);
    await tester.pump();
    expect(probeColor(), artworkColor);
    expect(tester.takeException(), isNull);
  });

  testWidgets('online detail remembers discovery artwork without route extra', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakeDiscoveryApi(delayDetail: true);
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);
    const coverUrl = 'https://img.test/discovery-cover.jpg';
    const page = OnlinePlaylistDetailPage(
      source: MusicSource.kw,
      playlistId: '1',
    );

    await tester.pumpWidget(
      _appWithContainer(
        container,
        const OnlinePlaylistDetailPage(
          source: MusicSource.kw,
          playlistId: '1',
          summary: PlaylistSummary(
            id: '1',
            name: '发现页歌单',
            source: MusicSource.kw,
            coverUrl: coverUrl,
          ),
        ),
      ),
    );
    await tester.pump();
    final firstProvider = tester
        .widget<PlaylistArtworkTheme>(find.byType(PlaylistArtworkTheme))
        .artworkProvider;
    expect(firstProvider, isA<CachedNetworkImageProvider>());

    await tester.pumpWidget(
      _appWithContainer(container, const SizedBox.shrink()),
    );
    await tester.pump();
    await tester.pumpWidget(_appWithContainer(container, page));
    await tester.pump();

    final restoredProvider = tester
        .widget<PlaylistArtworkTheme>(find.byType(PlaylistArtworkTheme))
        .artworkProvider;
    expect(restoredProvider, firstProvider);
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('discovery source pager swipes and tab taps stay in sync', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryContent()),
    );
    await tester.pumpAndSettle();

    expect(container.read(selectedDiscoverySourceProvider), MusicSource.kw);

    // 左滑：PageView 跟手翻到下一个音源。
    await tester.fling(
      find.byKey(const PageStorageKey('discovery-source-pager')),
      const Offset(-260, 0),
      1200,
    );
    await tester.pumpAndSettle();
    expect(container.read(selectedDiscoverySourceProvider), MusicSource.kg);

    // 首页右滑到边界：停在第一个音源，不越界。
    await tester.fling(
      find.byKey(const PageStorageKey('discovery-source-pager')),
      const Offset(260, 0),
      1200,
    );
    await tester.pumpAndSettle();
    await tester.fling(
      find.byKey(const PageStorageKey('discovery-source-pager')),
      const Offset(260, 0),
      1200,
    );
    await tester.pumpAndSettle();
    expect(container.read(selectedDiscoverySourceProvider), MusicSource.kw);

    // tab 点击：pager 动画跟过去。
    await tester.tap(find.byKey(const ValueKey('discovery-source-mg')));
    await tester.pumpAndSettle();
    expect(container.read(selectedDiscoverySourceProvider), MusicSource.mg);
    expect(find.text('咪咕'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('discovery masonry uses three columns on wide layouts', (
    tester,
  ) async {
    await _useViewport(tester, const Size(900, 760));
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryContent()),
    );
    await tester.pumpAndSettle();

    final positions = _cardPositions(tester, MusicSource.kw, 9);
    expect(
      positions.values.map((offset) => offset.dx.round()).toSet(),
      hasLength(3),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('discovery loads the next catalog page near the bottom', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakeDiscoveryApi(paginateFeatured: true);
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryContent()),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('discovery-card-kw:31')), findsNothing);

    final scrollable = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    );
    scrollable.position.jumpTo(scrollable.position.maxScrollExtent);
    await tester.pump();
    await tester.pumpAndSettle();

    expect(fake.featuredPages, contains(2));
    expect(find.byKey(const ValueKey('discovery-card-kw:31')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'discovery category FAB reloads sorting and hides when singular',
    (tester) async {
      await _useViewport(tester, const Size(390, 844));
      final fake = _FakeDiscoveryApi();
      final container = ProviderContainer(
        overrides: [musicApiProvider.overrideWithValue(fake)],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        _appWithContainer(
          container,
          const Stack(
            children: [
              DiscoveryContent(),
              Positioned.fill(child: DiscoveryCategoryFabLayer()),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('discovery-category-fab')),
        findsOneWidget,
      );
      expect(fake.featuredCategories.last, 'new');

      await tester.tap(find.byKey(const ValueKey('discovery-category-fab')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('discovery-category-hot')));
      await tester.pumpAndSettle();

      expect(
        container.read(selectedDiscoveryCategoryProvider(MusicSource.kw)),
        'hot',
      );
      expect(fake.featuredCategories.last, 'hot');

      container.read(selectedDiscoverySourceProvider.notifier).state =
          MusicSource.mg;
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('discovery-category-fab')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('discovery category FAB yields to search paging', (tester) async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.read(searchToolbarStateProvider.notifier).state =
        const SearchToolbarState(visible: true);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryCategoryFabLayer()),
    );

    expect(find.byKey(const ValueKey('discovery-category-fab')), findsNothing);
  });

  testWidgets('discovery source seeds the next search source', (tester) async {
    await _useViewport(tester, const Size(390, 844));
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(_appWithContainer(container, const SearchPage()));
    await tester.pumpAndSettle();
    expect(container.read(searchControllerProvider).source, MusicSource.kw);

    await tester.tap(find.byKey(const ValueKey('discovery-source-tx')));
    await tester.pumpAndSettle();

    expect(container.read(selectedDiscoverySourceProvider), MusicSource.tx);
    expect(container.read(searchControllerProvider).source, MusicSource.tx);
    expect(find.byKey(const ValueKey('discovery-card-tx:1')), findsOneWidget);

    await tester.tap(find.byType(SearchBar));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(EditableText).last, '周杰伦');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump(const Duration(milliseconds: 400));

    expect(fake.searchRequests, [
      const SearchQuery(keyword: '周杰伦', source: MusicSource.tx, page: 1),
    ]);
    expect(container.read(searchControllerProvider).source, MusicSource.tx);
  });

  testWidgets('long press preview lists only the first eight tracks', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(container, const DiscoveryContent()),
    );
    await tester.pumpAndSettle();
    await tester.longPress(find.byKey(const ValueKey('discovery-card-kw:1')));
    await tester.pumpAndSettle();

    expect(find.byType(Dialog), findsOneWidget);
    expect(find.text('预览歌曲 1'), findsOneWidget);
    expect(find.text('预览歌曲 8'), findsOneWidget);
    expect(find.text('预览歌曲 9'), findsNothing);
    expect(find.text('查看完整歌单'), findsOneWidget);
    expect(fake.detailRequests, 1);
  });

  test(
    'online playlist detail provider shares one completed request',
    () async {
      final fake = _FakeDiscoveryApi();
      final container = ProviderContainer(
        overrides: [musicApiProvider.overrideWithValue(fake)],
      );
      addTearDown(container.dispose);
      const key = OnlinePlaylistKey(source: MusicSource.kw, id: '1');

      await container.read(onlinePlaylistDetailProvider(key).future);
      await container.read(onlinePlaylistDetailProvider(key).future);

      expect(fake.detailRequests, 1);
      expect(fake.detailTrackLimits, [onlinePlaylistDetailInitialTrackLimit]);
    },
  );

  test('online song cover fallback bypasses a broken embedded URL', () async {
    final fake = _FakeDiscoveryApi(resolveCovers: true);
    final container = ProviderContainer(
      overrides: [musicApiProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);
    final music = _music(MusicSource.kg, 7, '需要补图的歌曲');

    final url = await container.read(
      onlineTrackCoverProvider(OnlineTrackCoverKey(music)).future,
    );

    expect(url, 'https://img.test/${music.id}.jpg');
    expect(fake.coverRequests, 1);
    expect(fake.lastCoverRequestPreferredCached, isFalse);
  });

  test('search controller reuses cached platform pages', () async {
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
      ],
    );
    addTearDown(container.dispose);
    final controller = container.read(searchControllerProvider.notifier);

    await controller.search(keyword: '缓存测试', source: MusicSource.tx, page: 1);
    await controller.search(keyword: '缓存测试', source: MusicSource.kg, page: 1);
    await controller.search(keyword: '缓存测试', source: MusicSource.tx, page: 1);
    await controller.search(keyword: '缓存测试', source: MusicSource.kg, page: 1);
    await controller.search(keyword: '缓存测试', source: MusicSource.kg, page: 2);
    await controller.search(keyword: '缓存测试', source: MusicSource.kg, page: 2);

    expect(fake.searchRequests, [
      const SearchQuery(keyword: '缓存测试', source: MusicSource.tx, page: 1),
      const SearchQuery(keyword: '缓存测试', source: MusicSource.kg, page: 1),
      const SearchQuery(keyword: '缓存测试', source: MusicSource.kg, page: 2),
    ]);
  });

  testWidgets(
    'search cancel restores discovery and rejects the stale response',
    (tester) async {
      await _useViewport(tester, const Size(390, 844));
      final prefs = await _freshPreferences();
      final fake = _FakeDiscoveryApi(delaySearch: true);
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          musicApiProvider.overrideWithValue(fake),
        ],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(_appWithContainer(container, const SearchPage()));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(SearchBar));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(EditableText).last, '慢搜索');
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pump(const Duration(milliseconds: 300));

      final cancelButton = find.byTooltip('取消搜索').hitTestable();
      expect(cancelButton, findsOneWidget);
      await tester.tap(cancelButton);
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        find.byKey(const ValueKey('discovery-source-filter')),
        findsOneWidget,
      );
      expect(container.read(searchControllerProvider).isSearchActive, isFalse);

      fake.completeSearch();
      await tester.pumpAndSettle();
      expect(container.read(searchControllerProvider).isSearchActive, isFalse);
      expect(find.text('迟到的搜索结果'), findsNothing);
    },
  );

  testWidgets(
    'online detail can favorite and unfavorite without leaving the page',
    (tester) async {
      await _useViewport(tester, const Size(390, 844));
      final prefs = await _freshPreferences();
      final fake = _FakeDiscoveryApi();
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          musicApiProvider.overrideWithValue(fake),
        ],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        _appWithContainer(
          container,
          const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('immersive-playlist-header')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('playlist-detail-info')),
        findsOneWidget,
      );
      expect(find.byType(BackdropFilter), findsNothing);
      expect(find.byTooltip('返回上一页'), findsNothing);
      expect(find.text('播放全部'), findsOneWidget);
      expect(find.byTooltip('选择音质下载'), findsWidgets);
      await tester.tap(find.text('收藏歌单'));
      await tester.pumpAndSettle();

      expect(container.read(localPlaylistsProvider), hasLength(1));
      expect(find.text('已收藏'), findsOneWidget);
      await tester.tap(find.text('已收藏'));
      await tester.pumpAndSettle();

      expect(container.read(localPlaylistsProvider), isEmpty);
      expect(find.text('收藏歌单'), findsOneWidget);
      expect(find.byType(OnlinePlaylistDetailPage), findsOneWidget);
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('online detail keeps header actions stable while data loads', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi(delayDetail: true);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
      ],
    );
    addTearDown(container.dispose);
    const description = '这是一段用于验证固定两行简介区域的完整歌单描述。';
    const summary = PlaylistSummary(
      id: '1',
      name: '酷我精选歌单 1',
      source: MusicSource.kw,
      creator: '酷我编辑',
      description: description,
      trackCount: 10,
      playCount: 5000,
    );

    await tester.pumpWidget(
      _appWithContainer(
        container,
        const OnlinePlaylistDetailPage(
          source: MusicSource.kw,
          playlistId: '1',
          summary: summary,
        ),
      ),
    );
    await tester.pump();

    final playButton = find.byKey(const ValueKey('playlist-play-all'));
    final saveButton = find.byKey(const ValueKey('playlist-favorite'));
    final descriptionSlot = find.byKey(
      const ValueKey('playlist-description-slot'),
    );
    final artworkHeader = find.byKey(
      const ValueKey('immersive-playlist-header'),
    );
    final detailInfo = find.byKey(const ValueKey('playlist-detail-info'));
    expect(playButton, findsOneWidget);
    expect(saveButton, findsOneWidget);
    expect(find.text('歌曲  10'), findsOneWidget);
    expect(tester.getSize(descriptionSlot).height, 40);
    final tooltip = tester.widget<Tooltip>(
      find.descendant(of: descriptionSlot, matching: find.byType(Tooltip)),
    );
    expect(tooltip.message, description);
    expect(tooltip.triggerMode, TooltipTriggerMode.manual);

    await tester.tap(find.byKey(const ValueKey('playlist-detail-title')));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text(description), findsOneWidget);

    await tester.longPress(find.text(description));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text(description), findsNWidgets(2));
    expect(Tooltip.dismissAllToolTips(), isTrue);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text(description), findsOneWidget);

    final loadingPlayTop = tester.getTopLeft(playButton).dy;
    final loadingSaveTop = tester.getTopLeft(saveButton).dy;
    final loadingHeadingTop = tester.getTopLeft(find.text('歌曲  10')).dy;
    final loadingDescriptionTop = tester.getTopLeft(descriptionSlot).dy;
    expect(tester.getSize(artworkHeader).height, closeTo(844 * 0.4, 0.1));
    expect(
      tester.getBottomLeft(artworkHeader).dy,
      closeTo(tester.getTopLeft(detailInfo).dy, 0.1),
    );
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('playlist-detail-title'))).dy,
      greaterThanOrEqualTo(tester.getBottomLeft(artworkHeader).dy),
    );

    fake.completeDetail();
    await tester.pumpAndSettle();

    expect(tester.getTopLeft(playButton).dy, loadingPlayTop);
    expect(tester.getTopLeft(saveButton).dy, loadingSaveTop);
    expect(tester.getTopLeft(find.text('歌曲  10')).dy, loadingHeadingTop);
    expect(tester.getTopLeft(descriptionSlot).dy, loadingDescriptionTop);
    expect(tester.getSize(descriptionSlot).height, 40);
    expect(
      tester.getBottomLeft(artworkHeader).dy,
      closeTo(tester.getTopLeft(detailInfo).dy, 0.1),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'online detail keeps and saves the discovery artwork after data loads',
    (tester) async {
      await _useViewport(tester, const Size(390, 844));
      final prefs = await _freshPreferences();
      final fake = _FakeDiscoveryApi(
        detailCoverUrl: 'https://img.test/detail-only-cover.jpg',
      );
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          musicApiProvider.overrideWithValue(fake),
        ],
      );
      addTearDown(container.dispose);
      const discoveryCover = 'http://p1.music.126.net/discovery-cover/test.jpg';
      const summary = PlaylistSummary(
        id: '1',
        name: '发现页歌单',
        source: MusicSource.kw,
        coverUrl: discoveryCover,
      );

      await tester.pumpWidget(
        _appWithContainer(
          container,
          const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
            summary: summary,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final artworkTheme = tester.widget<PlaylistArtworkTheme>(
        find.byType(PlaylistArtworkTheme),
      );
      final provider = artworkTheme.artworkProvider;
      expect(provider, isA<CachedNetworkImageProvider>());
      expect(
        (provider! as CachedNetworkImageProvider).url,
        'https://p1.music.126.net/discovery-cover/test.jpg?param=640y640',
      );
      expect(
        tester.widget<Hero>(find.byType(Hero)).tag,
        onlinePlaylistArtworkHeroTag(MusicSource.kw, '1'),
      );

      await tester.tap(find.text('收藏歌单'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(
        container.read(localPlaylistsProvider).single.coverUrl,
        discoveryCover,
      );
      await tester.pump(const Duration(seconds: 6));
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('online detail favorites the full playlist after shallow load', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi(detailTrackCount: 65);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _appWithContainer(
        container,
        const OnlinePlaylistDetailPage(source: MusicSource.kw, playlistId: '1'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('歌曲  40/65'), findsOneWidget);
    await tester.tap(find.text('收藏歌单'));
    await tester.pumpAndSettle();

    final saved = container.read(localPlaylistsProvider).single;
    expect(saved.tracks, hasLength(65));
    expect(fake.detailTrackLimits, [40, null]);
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('online detail plays immediately then expands the queue', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final prefs = await _freshPreferences();
    final fake = _FakeDiscoveryApi(detailTrackCount: 65);
    final audioHandler = PlayerAudioHandler();
    late _RecordingPlayerController player;
    final router = GoRouter(
      initialLocation: '/discover/playlists/kw/1',
      routes: [
        GoRoute(
          path: '/discover/playlists/:source/:id',
          builder: (_, _) => const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
        GoRoute(path: '/player', builder: (_, _) => const SizedBox.shrink()),
      ],
    );
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        musicApiProvider.overrideWithValue(fake),
        downloadCapabilitiesProvider.overrideWithValue(
          const AsyncData(
            DownloadCapabilities(
              sources: {
                MusicSource.kw: [Quality.k320],
              },
              availableSources: [MusicSource.kw],
            ),
          ),
        ),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
        playerControllerProvider.overrideWith(
          (ref) => player = _RecordingPlayerController(ref),
        ),
      ],
    );
    addTearDown(() {
      container.dispose();
      router.dispose();
      unawaited(audioHandler.disposeHandler());
    });

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
          ),
          builder: (context, child) =>
              AppToastOverlay(child: child ?? const SizedBox.shrink()),
          routerConfig: router,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('歌曲  40/65'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('playlist-play-all')));
    await tester.pumpAndSettle();

    expect(fake.detailTrackLimits, [40, null]);
    expect(player.events, ['play:40', 'expand:65']);
    expect(player.playedQueue, hasLength(40));
    expect(player.playedQueue.first.musicId, 'kw_1');
    expect(player.playedQueue.last.musicId, 'kw_40');
    expect(player.expandedQueue, hasLength(65));
    expect(player.expandedQueue.last.musicId, 'kw_65');
    expect(player.playedEntry?.musicId, 'kw_1');
    expect(router.routeInformationProvider.value.uri.path, '/player');
    expect(tester.takeException(), isNull);
  });
}

class _RecordingPlayerController extends PlayerController {
  _RecordingPlayerController(super.ref);

  List<DownloadHistoryEntry> playedQueue = const [];
  List<DownloadHistoryEntry> expandedQueue = const [];
  DownloadHistoryEntry? playedEntry;
  final List<String> events = <String>[];

  @override
  Future<void> playFromPlaylistQueue(
    DownloadHistoryEntry entry,
    List<DownloadHistoryEntry> queue,
  ) async {
    playedEntry = entry;
    playedQueue = List<DownloadHistoryEntry>.of(queue);
    events.add('play:${queue.length}');
  }

  @override
  bool expandPlaylistQueue({
    required List<DownloadHistoryEntry> expectedQueue,
    required List<DownloadHistoryEntry> expandedQueue,
  }) {
    this.expandedQueue = List<DownloadHistoryEntry>.of(expandedQueue);
    events.add('expand:${expandedQueue.length}');
    return true;
  }
}

class _FakeDiscoveryApi extends MusicApi {
  _FakeDiscoveryApi({
    this.delaySearch = false,
    this.delayDetail = false,
    this.resolveCovers = false,
    this.detailCoverUrl,
    this.paginateFeatured = false,
    this.detailTrackCount = 10,
  });

  final bool delaySearch;
  final bool delayDetail;
  final bool resolveCovers;
  final String? detailCoverUrl;
  final bool paginateFeatured;
  final int detailTrackCount;
  final Completer<SearchResponse> _search = Completer<SearchResponse>();
  final Completer<PlaylistInfo> _detail = Completer<PlaylistInfo>();
  int detailRequests = 0;
  int coverRequests = 0;
  bool? lastCoverRequestPreferredCached;
  final List<int> featuredPages = <int>[];
  final List<String?> featuredCategories = <String?>[];
  final List<int?> detailTrackLimits = <int?>[];
  final List<SearchQuery> searchRequests = <SearchQuery>[];

  @override
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) async {
    coverRequests++;
    lastCoverRequestPreferredCached = preferCached;
    return resolveCovers ? 'https://img.test/${musicInfo.id}.jpg' : null;
  }

  @override
  Future<List<PlaylistSummary>> featuredPlaylists({
    required MusicSource source,
    int page = 1,
    int limit = 20,
    String? categoryId,
  }) async {
    featuredPages.add(page);
    featuredCategories.add(categoryId);
    final start = paginateFeatured ? (page - 1) * limit + 1 : 1;
    final count = paginateFeatured ? (page == 1 ? limit : 5) : 9;
    return [
      for (var index = start; index < start + count; index++)
        PlaylistSummary(
          id: '$index',
          name: '${source.label}精选歌单 $index',
          source: source,
          creator: '${source.label}编辑',
          description: '固定发现页简介 $index',
          trackCount: 10,
          playCount: 1000 + index,
        ),
    ];
  }

  @override
  Future<PlaylistInfo> parsePlaylist({
    required String input,
    MusicSource source = MusicSource.all,
    int? maxTracks,
  }) {
    detailRequests++;
    detailTrackLimits.add(maxTracks);
    final loadedCount = maxTracks == null || maxTracks <= 0
        ? detailTrackCount
        : maxTracks.clamp(0, detailTrackCount).toInt();
    final playlist = PlaylistInfo(
      id: input,
      name: '${source.label}精选歌单 $input',
      source: source,
      creator: '${source.label}编辑',
      description: '固定歌单详情',
      coverUrl: detailCoverUrl,
      playCount: 5000,
      trackCount: detailTrackCount,
      tracks: [
        for (var index = 1; index <= loadedCount; index++)
          _music(source, index, '预览歌曲 $index'),
      ],
    );
    return delayDetail ? _detail.future : Future.value(playlist);
  }

  @override
  Future<SearchResponse> searchMusic({
    required String keyword,
    required MusicSource source,
    int page = 1,
    int limit = 30,
  }) {
    searchRequests.add(
      SearchQuery(keyword: keyword, source: source, page: page),
    );
    if (delaySearch) return _search.future;
    return Future.value(_searchResponse(source));
  }

  @override
  Future<List<String>> searchTip({
    required String keyword,
    required MusicSource source,
    int limit = 8,
  }) async => const [];

  void completeSearch() {
    if (!_search.isCompleted) {
      _search.complete(_searchResponse(MusicSource.all));
    }
  }

  void completeDetail() {
    if (_detail.isCompleted) return;
    _detail.complete(
      PlaylistInfo(
        id: '1',
        name: '酷我精选歌单 1',
        source: MusicSource.kw,
        creator: '酷我编辑',
        description: '这是一段用于验证固定两行简介区域的完整歌单描述。',
        playCount: 5000,
        trackCount: 10,
        tracks: [
          for (var index = 1; index <= 10; index++)
            _music(MusicSource.kw, index, '预览歌曲 $index'),
        ],
      ),
    );
  }
}

SearchResponse _searchResponse(MusicSource source) => SearchResponse(
  list: [_music(MusicSource.kw, 99, '迟到的搜索结果')],
  page: 1,
  limit: 30,
  allPage: 1,
  total: 1,
  source: source,
);

MusicInfo _music(MusicSource source, int id, String name) {
  return MusicInfo.fromJson({
    'id': '${source.code}_$id',
    'name': name,
    'singer': '测试歌手',
    'source': source.code,
    'interval': '03:20',
    'meta': {
      'songId': id,
      'albumName': '测试专辑',
      'qualitys': [
        {'type': Quality.k320.code, 'size': '8.00M'},
      ],
    },
  });
}

Map<String, Offset> _cardPositions(
  WidgetTester tester,
  MusicSource source,
  int count,
) {
  return {
    for (var index = 1; index <= count; index++)
      '$index': tester.getTopLeft(
        find.byKey(ValueKey('discovery-card-${source.code}:$index')),
      ),
  };
}

void _expectOnlineDetailFullyOpaque(WidgetTester tester) {
  final detail = find.byType(OnlinePlaylistDetailPage);
  expect(detail, findsOneWidget);
  final fades = find.ancestor(
    of: detail,
    matching: find.byType(FadeTransition),
  );
  for (final fade in tester.widgetList<FadeTransition>(fades)) {
    expect(fade.opacity.value, closeTo(1, 0.001));
  }
}

Future<SharedPreferences> _freshPreferences() async {
  SharedPreferences.setMockInitialValues({});
  return SharedPreferences.getInstance();
}

Future<void> _useViewport(WidgetTester tester, Size size) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(() {
    tester.view.resetDevicePixelRatio();
    tester.view.resetPhysicalSize();
  });
}

Widget _appWithContainer(ProviderContainer container, Widget home) {
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
      ),
      builder: (context, child) =>
          AppToastOverlay(child: child ?? const SizedBox.shrink()),
      home: Scaffold(body: home),
    ),
  );
}
