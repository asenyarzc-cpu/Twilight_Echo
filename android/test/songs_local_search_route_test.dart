import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/shell/shell_toolbar_visibility.dart';
import 'package:twilight_echo/features/songs/songs_page.dart';
import 'package:twilight_echo/features/songs/widgets/songs_placeholders.dart';
import 'package:twilight_echo/router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('songs overflow opens the dedicated local search page', (
    tester,
  ) async {
    _useNarrowPhone(tester);
    final prefs = await SharedPreferences.getInstance();
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
          routerConfig: router,
        ),
      ),
    );
    await _pumpUi(tester);

    expect(find.byType(SongsSearchBar), findsNothing);
    await tester.tap(find.byTooltip('更多歌曲操作'));
    await _pumpUi(tester);
    expect(find.text('搜索本地歌曲'), findsOneWidget);
    expect(find.text('下载历史'), findsOneWidget);

    await tester.tap(find.text('搜索本地歌曲'));
    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/songs/search');
    expect(find.byType(SongsSearchBar), findsOneWidget);
    expect(tester.widget<SongsPage>(find.byType(SongsPage)).searchMode, isTrue);
    expect(find.byTooltip('返回歌曲列表'), findsNothing);
    expect(find.byIcon(Icons.arrow_back_ios_new_rounded), findsNothing);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(SongsPage)),
    );
    expect(
      tester.widget<SearchBar>(find.byType(SearchBar)).focusNode?.hasFocus,
      isTrue,
    );
    expect(container.read(shellToolbarVisibleProvider), isFalse);

    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    expect(container.read(shellToolbarVisibleProvider), isTrue);
    await tester.tap(find.byType(SongsSearchBar));
    await tester.pump();
    expect(container.read(shellToolbarVisibleProvider), isFalse);

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    _expectBackwardSongsSlide(tester);
    expect(container.read(shellToolbarVisibleProvider), isTrue);

    await _pumpUi(tester);
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    expect(find.byType(SongsSearchBar), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('downloads system back animates to the songs page', (
    tester,
  ) async {
    _useNarrowPhone(tester);
    final prefs = await SharedPreferences.getInstance();
    final audioHandler = PlayerAudioHandler();
    final router = createAppRouter(initialLocation: '/downloads');
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
          routerConfig: router,
        ),
      ),
    );
    await _pumpUi(tester);

    expect(find.byTooltip('返回歌曲列表'), findsNothing);
    expect(find.byIcon(Icons.arrow_back_ios_new_rounded), findsNothing);
    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(router.routeInformationProvider.value.uri.path, '/songs');
    _expectBackwardSongsSlide(tester);

    await _pumpUi(tester);
    expect(find.byType(SongsPage), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

void _expectBackwardSongsSlide(WidgetTester tester) {
  final songsPage = find.byWidgetPredicate(
    (widget) => widget is SongsPage && !widget.searchMode,
  );
  expect(songsPage, findsOneWidget);
  final slides = tester.widgetList<SlideTransition>(
    find.ancestor(of: songsPage, matching: find.byType(SlideTransition)),
  );
  expect(
    slides.any(
      (slide) =>
          slide.position.value.dx < 0 && slide.position.value.dx > -0.045,
    ),
    isTrue,
  );
}

Future<void> _pumpUi(WidgetTester tester) async {
  for (var index = 0; index < 12; index++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void _useNarrowPhone(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(360, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
