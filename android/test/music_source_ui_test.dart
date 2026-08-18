import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/core/ui/app_toast.dart';
import 'package:twilight_echo/features/startup/startup_gate.dart';
import 'package:twilight_echo/features/music_sources/widgets/music_source_card.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/shell/widgets/shell_header.dart';
import 'package:twilight_echo/router.dart';
import 'package:twilight_echo/theme/app_theme.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets(
    'music source page uses one shell header and returns to settings',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(() {
        tester.view.resetDevicePixelRatio();
        tester.view.resetPhysicalSize();
      });
      final prefs = await SharedPreferences.getInstance();
      final audioHandler = PlayerAudioHandler();
      final router = createAppRouter(initialLocation: '/settings/sources');
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
            theme: AppTheme.light(),
            routerConfig: router,
          ),
        ),
      );
      await _pumpUi(tester);

      expect(find.text('音源管理'), findsOneWidget);
      expect(find.byType(SliverAppBar), findsNothing);
      expect(find.byIcon(Icons.arrow_back_rounded), findsNothing);
      expect(find.byIcon(Icons.arrow_back_ios_new_rounded), findsNothing);
      final localImport = find.widgetWithText(FilledButton, '本地导入');
      final buttonTheme = FilledButtonTheme.of(
        tester.element(localImport),
      ).style;
      expect(buttonTheme?.shape?.resolve({}), isA<StadiumBorder>());

      expect(await tester.binding.handlePopRoute(), isTrue);
      await _pumpUi(tester);
      expect(router.routeInformationProvider.value.uri.path, '/settings');
      expect(
        find.descendant(
          of: find.byType(ShellHeader),
          matching: find.text('设置'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'URL import hands off between dialogs without duplicating router',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(() {
        tester.view.resetDevicePixelRatio();
        tester.view.resetPhysicalSize();
      });
      final prefs = await SharedPreferences.getInstance();
      final audioHandler = PlayerAudioHandler();
      final router = createAppRouter(initialLocation: '/settings/sources');
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
            theme: AppTheme.light(),
            routerConfig: router,
            builder: (context, child) => AppToastOverlay(
              child: StartupGate(child: child ?? const SizedBox.shrink()),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 700));

      await tester.tap(find.widgetWithText(OutlinedButton, 'URL 导入'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField),
        'https://example.com/music-source.js',
      );
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, '导入'));
      await tester.pumpAndSettle();

      expect(find.text('运行第三方音源'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.widgetWithText(TextButton, '取消'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('source rows tap to activate and only swipe left to delete', (
    tester,
  ) async {
    var activationCount = 0;
    var deleteCount = 0;
    final record = MusicSourceRecord(
      id: 'source-test',
      name: '测试音源',
      description: '',
      author: 'Tester',
      homepage: '',
      version: 'v27',
      origin: 'test',
      importedAt: DateTime.utc(2026, 7, 30),
      updatedAt: DateTime.utc(2026, 7, 30),
      capabilities: const {
        MusicSource.kw: [Quality.k128, Quality.flac],
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: MusicSourceCard(
            record: record,
            enabled: false,
            priority: null,
            busy: false,
            activating: false,
            onToggle: (enabled) {
              if (enabled) activationCount++;
            },
            onDelete: () => deleteCount++,
          ),
        ),
      ),
    );

    expect(find.byType(ListTile), findsOneWidget);
    expect(find.text('v27'), findsOneWidget);
    expect(find.text('vv27'), findsNothing);
    expect(find.byType(MenuAnchor), findsNothing);
    expect(find.byType(PopupMenuButton<String>), findsNothing);
    final slidable = tester.widget<Slidable>(find.byType(Slidable));
    expect(slidable.startActionPane, isNull);
    expect(slidable.endActionPane, isNotNull);

    await tester.tap(find.byType(ListTile));
    expect(activationCount, 1);
    await tester.drag(find.byType(ListTile), const Offset(-180, 0));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('music-source-delete-action')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('music-source-delete-action')));
    expect(deleteCount, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('enabled source shows fallback priority and can be disabled', (
    tester,
  ) async {
    bool? toggledValue;
    final record = MusicSourceRecord(
      id: 'backup-source',
      name: '备用音源',
      description: '',
      author: 'Tester',
      homepage: '',
      version: '1.0',
      origin: 'test',
      importedAt: DateTime.utc(2026, 7, 31),
      updatedAt: DateTime.utc(2026, 7, 31),
      capabilities: const {
        MusicSource.kw: [Quality.k128],
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: MusicSourceCard(
            record: record,
            enabled: true,
            priority: 2,
            busy: false,
            activating: false,
            onToggle: (enabled) => toggledValue = enabled,
            onDelete: () {},
          ),
        ),
      ),
    );

    expect(find.text('备用 1'), findsOneWidget);
    final toggle = tester.widget<Switch>(find.byType(Switch));
    expect(toggle.value, isTrue);
    await tester.tap(find.byType(ListTile));
    expect(toggledValue, isFalse);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pumpUi(WidgetTester tester) async {
  for (var index = 0; index < 12; index++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
