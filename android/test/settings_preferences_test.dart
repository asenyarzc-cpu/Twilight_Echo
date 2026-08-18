import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/api/dio_factory.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/search/widgets/source_filter_chips.dart';
import 'package:twilight_echo/features/settings/settings_page.dart';
import 'package:twilight_echo/features/settings/widgets/settings_action.dart';
import 'package:twilight_echo/features/settings/widgets/settings_style.dart';
import 'package:twilight_echo/theme/app_theme.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'settings default to four search sources and highest quality preferences',
    () async {
      final prefs = await SharedPreferences.getInstance();
      final container = _settingsContainer(prefs);
      addTearDown(container.dispose);

      final settings = container.read(settingsProvider);

      expect(settings.enabledSearchSources, kDefaultEnabledSearchSources);
      expect(settings.enabledSearchSources, isNot(contains(MusicSource.mg)));
      expect(settings.onlinePlaybackQuality, OnlinePlaybackQuality.highest);
      expect(settings.batchDownloadQuality, OnlinePlaybackQuality.highest);
      expect(settings.showMiniLyrics, isTrue);
      expect(settings.bluetoothLyricEnabled, isFalse);
      expect(settings.bluetoothFullLyricEnabled, isFalse);
      expect(settings.bluetoothLyricNoticeSeen, isFalse);
      expect(settings.localMusicDir, settings.downloadDir);
    },
  );

  test('player lyric preferences persist', () async {
    final prefs = await SharedPreferences.getInstance();
    final container = _settingsContainer(prefs);
    final notifier = container.read(settingsProvider.notifier);

    await notifier.setShowMiniLyrics(false);
    await notifier.setBluetoothLyricEnabled(true);
    await notifier.setBluetoothFullLyricEnabled(true);
    await notifier.markBluetoothLyricNoticeSeen();
    container.dispose();

    final restored = _settingsContainer(prefs);
    addTearDown(restored.dispose);
    final settings = restored.read(settingsProvider);
    expect(settings.showMiniLyrics, isFalse);
    expect(settings.bluetoothLyricEnabled, isTrue);
    expect(settings.bluetoothFullLyricEnabled, isTrue);
    expect(settings.bluetoothLyricNoticeSeen, isTrue);
  });

  testWidgets('bluetooth lyric warning is shown only on first enable', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final prefs = await SharedPreferences.getInstance();
    final container = _settingsContainer(prefs);
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: AppTheme.light(), home: const SettingsPage()),
      ),
    );
    await tester.pumpAndSettle();

    final row = find.byKey(const ValueKey('bluetooth-lyric-setting'));
    final toggle = find.descendant(of: row, matching: find.byType(Switch));
    await tester.ensureVisible(toggle);
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(find.text('蓝牙歌词提示'), findsOneWidget);
    await tester.tap(find.text('我知道了'));
    await tester.pumpAndSettle();
    expect(container.read(settingsProvider).bluetoothLyricEnabled, isTrue);
    expect(container.read(settingsProvider).bluetoothLyricNoticeSeen, isTrue);

    await tester.tap(toggle);
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(find.text('蓝牙歌词提示'), findsNothing);
    expect(container.read(settingsProvider).bluetoothLyricEnabled, isTrue);
  });

  testWidgets('switch settings align with actions and keep vertical spacing', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SettingsAction(
                key: const ValueKey('reference-setting-action'),
                icon: Icons.search_rounded,
                title: '参考设置项',
                subtitle: '参考说明',
                onTap: () {},
              ),
              SettingsSwitchAction(
                key: const ValueKey('first-switch-setting'),
                icon: Icons.bluetooth_audio_rounded,
                title: '显示蓝牙歌词',
                subtitle: '蓝牙歌词说明',
                value: false,
                onChanged: (_) {},
              ),
              SettingsSwitchAction(
                key: const ValueKey('second-switch-setting'),
                icon: Icons.lyrics_rounded,
                title: '显示完整蓝牙歌词',
                subtitle: '完整歌词说明',
                value: false,
                onChanged: (_) {},
              ),
            ],
          ),
        ),
      ),
    );

    Finder bubbleWithin(Key key) => find.descendant(
      of: find.byKey(key),
      matching: find.byType(SettingsSymbolBubble),
    );

    final referenceRect = tester.getRect(
      bubbleWithin(const ValueKey('reference-setting-action')),
    );
    final firstRect = tester.getRect(
      bubbleWithin(const ValueKey('first-switch-setting')),
    );
    final secondRect = tester.getRect(
      bubbleWithin(const ValueKey('second-switch-setting')),
    );
    expect(firstRect.left, referenceRect.left);
    expect(secondRect.left, referenceRect.left);
    expect(secondRect.top - firstRect.bottom, greaterThanOrEqualTo(24));
    expect(tester.takeException(), isNull);
  });

  test('legacy resolver setting is removed', () async {
    SharedPreferences.setMockInitialValues({
      'base_url': 'https://legacy.example.com',
    });
    final prefs = await SharedPreferences.getInstance();
    final container = _settingsContainer(prefs);
    addTearDown(container.dispose);

    container.read(settingsProvider);
    await Future<void>.delayed(Duration.zero);
    expect(prefs.getString('base_url'), isNull);
  });

  testWidgets('settings exposes music source management instead of resolver', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final prefs = await SharedPreferences.getInstance();
    final container = _settingsContainer(prefs);
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: AppTheme.light(), home: const SettingsPage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('音源管理'), findsOneWidget);
    expect(find.text('批量下载音质'), findsOneWidget);
    expect(find.text('扫描文件夹'), findsOneWidget);
    expect(find.text('浏览U盘'), findsNWidgets(2));
    expect(find.text('检查更新'), findsOneWidget);
    expect(find.byIcon(Icons.folder_outlined), findsOneWidget);
    expect(find.text('URL 解析服务器'), findsNothing);
    expect(find.text('解析服务器健康检查'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test(
    'search sources and playback quality persist and reject an empty set',
    () async {
      final prefs = await SharedPreferences.getInstance();
      final container = _settingsContainer(prefs);
      final notifier = container.read(settingsProvider.notifier);

      expect(
        await notifier.setSearchSourceEnabled(MusicSource.mg, true),
        isTrue,
      );
      await notifier.setOnlinePlaybackQuality(OnlinePlaybackQuality.lossless);
      await notifier.setBatchDownloadQuality(OnlinePlaybackQuality.high);
      for (final source in [MusicSource.kg, MusicSource.tx, MusicSource.wy]) {
        expect(await notifier.setSearchSourceEnabled(source, false), isTrue);
      }
      expect(
        await notifier.setSearchSourceEnabled(MusicSource.kw, false),
        isTrue,
      );
      expect(
        await notifier.setSearchSourceEnabled(MusicSource.mg, false),
        isFalse,
      );

      expect(container.read(settingsProvider).enabledSearchSources, {
        MusicSource.mg,
      });
      container.dispose();

      final restored = _settingsContainer(prefs);
      addTearDown(restored.dispose);
      expect(restored.read(settingsProvider).enabledSearchSources, {
        MusicSource.mg,
      });
      expect(
        restored.read(settingsProvider).onlinePlaybackQuality,
        OnlinePlaybackQuality.lossless,
      );
      expect(
        restored.read(settingsProvider).batchDownloadQuality,
        OnlinePlaybackQuality.high,
      );
    },
  );

  test(
    'local music scan folder follows download folder until customized',
    () async {
      final prefs = await SharedPreferences.getInstance();
      final container = _settingsContainer(prefs);
      final notifier = container.read(settingsProvider.notifier);

      await notifier.setDownloadDir('/storage/emulated/0/Music/Downloads');
      expect(
        container.read(settingsProvider).localMusicDir,
        '/storage/emulated/0/Music/Downloads',
      );

      await notifier.setLocalMusicDir('/storage/1234-5678/Music');
      await notifier.setDownloadDir('/storage/emulated/0/Music/NewDownloads');

      expect(
        container.read(settingsProvider).downloadDir,
        '/storage/emulated/0/Music/NewDownloads',
      );
      expect(
        container.read(settingsProvider).localMusicDir,
        '/storage/1234-5678/Music',
      );
      container.dispose();

      final restored = _settingsContainer(prefs);
      addTearDown(restored.dispose);
      expect(
        restored.read(settingsProvider).localMusicDir,
        '/storage/1234-5678/Music',
      );
    },
  );

  test(
    'saved search source codes are ordered, deduplicated, and sanitized',
    () {
      expect(decodeEnabledSearchSources(['mg', 'unknown', 'mg', 'all', 'kw']), {
        MusicSource.kw,
        MusicSource.mg,
      });
      expect(decodeEnabledSearchSources([]), kDefaultEnabledSearchSources);
    },
  );

  group('online playback quality resolution', () {
    test('keeps highest behavior and honors an exact preference', () {
      final music = _musicWithQualities([
        Quality.k128,
        Quality.flac,
        Quality.k320,
      ]);

      expect(
        music.playbackQualityFor(OnlinePlaybackQuality.highest),
        Quality.flac,
      );
      expect(
        music.playbackQualityFor(OnlinePlaybackQuality.high),
        Quality.k320,
      );
    });

    test(
      'falls down first, then up when the preferred quality is unavailable',
      () {
        expect(
          _musicWithQualities([
            Quality.hires,
            Quality.k320,
            Quality.k128,
          ]).playbackQualityFor(OnlinePlaybackQuality.lossless),
          Quality.k320,
        );
        expect(
          _musicWithQualities([
            Quality.flac,
          ]).playbackQualityFor(OnlinePlaybackQuality.high),
          Quality.flac,
        );
      },
    );

    test('uses 128K when a track has no advertised qualities', () {
      expect(
        _musicWithQualities(
          const [],
        ).playbackQualityFor(OnlinePlaybackQuality.hires),
        Quality.k128,
      );
    });
  });

  testWidgets(
    'source filter stays full width and slides smoothly between sources',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final prefs = await SharedPreferences.getInstance();
      final container = _settingsContainer(prefs);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const Scaffold(body: SourceFilterChips()),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('咪咕'), findsNothing);
      final defaultWidth = tester
          .getSize(find.byKey(const ValueKey('search-source-filter')))
          .width;
      final scaffoldWidth = tester.getSize(find.byType(Scaffold)).width;
      expect(defaultWidth, closeTo(scaffoldWidth - 24, 0.01));

      final indicator = find.byKey(const ValueKey('search-source-indicator'));
      final initialLeft = tester.getTopLeft(indicator).dx;
      await tester.tap(find.byKey(const ValueKey('search-source-wy')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      final middleLeft = tester.getTopLeft(indicator).dx;
      expect(middleLeft, greaterThan(initialLeft));
      await tester.pumpAndSettle();
      final finalLeft = tester.getTopLeft(indicator).dx;
      expect(middleLeft, lessThan(finalLeft));

      await container
          .read(settingsProvider.notifier)
          .setSearchSourceEnabled(MusicSource.mg, true);
      await tester.pumpAndSettle();

      expect(find.text('咪咕'), findsOneWidget);
      final expandedWidth = tester
          .getSize(find.byKey(const ValueKey('search-source-filter')))
          .width;
      expect(expandedWidth, closeTo(defaultWidth, 0.01));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'anchored menu uses the staggered Material radio menu animation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final prefs = await SharedPreferences.getInstance();
      final container = _settingsContainer(prefs);
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.light(),
            home: const SettingsPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.cable_rounded), findsOneWidget);
      expect(find.byIcon(Icons.manage_search_rounded), findsOneWidget);
      expect(find.byIcon(Icons.high_quality_rounded), findsOneWidget);
      expect(Icons.cable_rounded.fontFamily, 'MaterialIcons');
      expect(Icons.manage_search_rounded.fontFamily, 'MaterialIcons');
      expect(Icons.high_quality_rounded.fontFamily, 'MaterialIcons');

      final anchor = find.byKey(const ValueKey('network-adapter-menu-anchor'));
      final anchorRect = tester.getRect(anchor);
      final leftTouch = Offset(anchorRect.left + 12, anchorRect.center.dy);
      await tester.tapAt(leftTouch);
      await tester.pump();

      final panel = find.byKey(const ValueKey('network-adapter-menu-panel'));
      final fade = find.byKey(const ValueKey('network-adapter-menu-fade'));
      final reveal = find.byKey(const ValueKey('network-adapter-menu-reveal'));
      final firstOptionFade = find.byKey(
        const ValueKey('network-adapter-menu-option-system-fade'),
      );
      final middleOptionFade = find.byKey(
        const ValueKey('network-adapter-menu-option-io-fade'),
      );
      final lastOptionFade = find.byKey(
        const ValueKey('network-adapter-menu-option-native-fade'),
      );
      expect(panel, findsOneWidget);
      final initialPanelRect = tester.getRect(panel);
      expect(
        tester.widget<FadeTransition>(fade).opacity.value,
        closeTo(0, 0.001),
      );
      expect(tester.widget<Align>(reveal).heightFactor, closeTo(0, 0.001));
      expect(
        tester.widget<FadeTransition>(firstOptionFade).opacity.value,
        closeTo(0, 0.001),
      );

      await tester.pump(const Duration(milliseconds: 50));
      expect(
        tester.widget<FadeTransition>(fade).opacity.value,
        closeTo(1, 0.001),
      );
      expect(tester.widget<Align>(reveal).heightFactor, inExclusiveRange(0, 1));

      await tester.pump(const Duration(milliseconds: 75));
      expect(
        tester.widget<FadeTransition>(firstOptionFade).opacity.value,
        closeTo(0.5, 0.001),
      );
      expect(
        tester.widget<FadeTransition>(middleOptionFade).opacity.value,
        closeTo(0, 0.001),
      );
      expect(
        tester.widget<FadeTransition>(lastOptionFade).opacity.value,
        closeTo(0, 0.001),
      );

      await tester.pump(const Duration(milliseconds: 125));
      expect(
        tester.widget<FadeTransition>(firstOptionFade).opacity.value,
        closeTo(1, 0.001),
      );
      expect(
        tester.widget<FadeTransition>(middleOptionFade).opacity.value,
        closeTo(0.5, 0.001),
      );
      expect(
        tester.widget<FadeTransition>(lastOptionFade).opacity.value,
        closeTo(0, 0.001),
      );

      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(
        tester.widget<FadeTransition>(fade).opacity.value,
        closeTo(1, 0.001),
      );
      expect(tester.widget<Align>(reveal).heightFactor, closeTo(1, 0.001));
      expect(
        tester.widget<FadeTransition>(lastOptionFade).opacity.value,
        closeTo(1, 0.001),
      );
      final leftPanelRect = tester.getRect(panel);
      expect(leftPanelRect.width, closeTo(initialPanelRect.width, 0.01));
      expect(leftPanelRect.top, closeTo(initialPanelRect.top, 0.01));
      expect(leftPanelRect.left, greaterThanOrEqualTo(leftTouch.dx));
      expect(leftPanelRect.width, lessThanOrEqualTo(184.01));

      await tester.tapAt(const Offset(420, 880));
      await tester.pumpAndSettle();
      expect(panel, findsNothing);

      final rightTouch = Offset(anchorRect.right - 12, anchorRect.center.dy);
      await tester.tapAt(rightTouch);
      await tester.pumpAndSettle();
      final rightPanelRect = tester.getRect(panel);
      expect(rightPanelRect.right, lessThanOrEqualTo(rightTouch.dx));
      await tester.tap(
        find.byKey(const ValueKey('network-adapter-menu-option-io')),
      );
      await tester.pumpAndSettle();
      expect(
        container.read(settingsProvider).networkAdapterMode,
        NetworkAdapterMode.io,
      );
      expect(panel, findsNothing);
      await tester.pump(const Duration(seconds: 4));

      final qualityAnchor = find.byKey(
        const ValueKey('online-quality-menu-anchor'),
      );
      await tester.tap(qualityAnchor);
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      final qualityPanel = find.byKey(
        const ValueKey('online-quality-menu-panel'),
      );
      expect(qualityPanel, findsOneWidget);
      expect(tester.getSize(qualityPanel).width, lessThanOrEqualTo(184.01));
      await tester.tap(
        find.byKey(const ValueKey('online-quality-menu-option-flac')),
      );
      await tester.pumpAndSettle();
      expect(
        container.read(settingsProvider).onlinePlaybackQuality,
        OnlinePlaybackQuality.lossless,
      );
      expect(qualityPanel, findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(seconds: 4));
    },
  );

  testWidgets('search source management stays open for multi-selection', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final prefs = await SharedPreferences.getInstance();
    final container = _settingsContainer(prefs);
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: AppTheme.light(), home: const SettingsPage()),
      ),
    );
    await tester.pumpAndSettle();

    final anchor = find.byKey(const ValueKey('search-source-menu-anchor'));
    await tester.tap(anchor);
    await tester.pumpAndSettle();
    final panel = find.byKey(const ValueKey('search-source-menu-panel'));
    final miguOption = find.byKey(
      const ValueKey('search-source-menu-option-mg'),
    );
    expect(panel, findsOneWidget);
    expect(tester.getSize(panel).width, lessThanOrEqualTo(184.01));
    expect(tester.getSize(miguOption).height, closeTo(48, 0.01));
    await tester.tap(miguOption);
    await tester.pumpAndSettle();

    expect(
      container.read(settingsProvider).enabledSearchSources,
      contains(MusicSource.mg),
    );
    expect(panel, findsOneWidget);
    expect(miguOption, findsOneWidget);
    expect(
      find.descendant(
        of: miguOption,
        matching: find.byIcon(Icons.check_box_rounded),
      ),
      findsOneWidget,
    );
    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();
    expect(panel, findsNothing);
    expect(tester.takeException(), isNull);
  });
}

ProviderContainer _settingsContainer(SharedPreferences prefs) {
  return ProviderContainer(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
  );
}

MusicInfo _musicWithQualities(List<Quality> qualities) {
  return MusicInfo(
    id: 'quality-test',
    name: 'Quality test',
    singer: 'Tester',
    source: MusicSource.wy,
    interval: '03:00',
    meta: MusicMeta(
      songId: 'quality-test',
      albumName: 'Test album',
      qualitys: [for (final quality in qualities) QualityOption(type: quality)],
      raw: const {},
    ),
    raw: const {},
  );
}
