import 'dart:io';
import 'dart:async';

import 'package:twilight_echo/core/app_info.dart';
import 'package:twilight_echo/core/services/app_update_service.dart';
import 'package:twilight_echo/core/ui/app_toast.dart';
import 'package:twilight_echo/features/update/app_update_prompt.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:pub_semver/pub_semver.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          pathProviderChannel,
          (_) async => Directory.systemTemp.path,
        );
  });
  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProviderChannel, null);
  });

  const releaseUri =
      'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/v1.1.0';

  testWidgets('newer release shows dialog and later does not open GitHub', (
    tester,
  ) async {
    final service = _FakeAppUpdateService(
      release: _release(version: '1.1.0', pageUri: releaseUri),
    );
    final launchedUris = <Uri>[];
    AppUpdateCheckOutcome? outcome;
    await _pumpHarness(
      tester,
      service: service,
      launcher: (uri) async {
        launchedUris.add(uri);
        return true;
      },
      onOutcome: (value) => outcome = value,
    );

    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('app-update-dialog')), findsOneWidget);
    expect(find.text('发现新版本'), findsOneWidget);
    expect(find.textContaining('1.0.1  →  1.1.0'), findsOneWidget);
    expect(find.textContaining('Twilight Echo 1.1.0'), findsOneWidget);
    expect(outcome, isNull);

    await tester.tap(find.byKey(const ValueKey('app-update-later')));
    await tester.pumpAndSettle();

    expect(launchedUris, isEmpty);
    expect(outcome, AppUpdateCheckOutcome.updateAvailable);
    expect(service.callCount, 1);
  });

  testWidgets('download action opens the exact release URI', (tester) async {
    final service = _FakeAppUpdateService(
      release: _release(version: '1.1.0', pageUri: releaseUri),
    );
    final launchedUris = <Uri>[];
    AppUpdateCheckOutcome? outcome;
    await _pumpHarness(
      tester,
      service: service,
      launcher: (uri) async {
        launchedUris.add(uri);
        return true;
      },
      onOutcome: (value) => outcome = value,
    );

    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('app-update-open-release')));
    await tester.pumpAndSettle();

    expect(launchedUris, [Uri.parse(releaseUri)]);
    expect(outcome, AppUpdateCheckOutcome.updateAvailable);
  });

  testWidgets('same release reports that the app is up to date', (
    tester,
  ) async {
    final service = _FakeAppUpdateService(
      release: _release(
        version: '1.0.1',
        pageUri:
            'https://github.com/asenyarzc-cpu/Twilight_Echo/releases/tag/v1.0.1',
      ),
    );
    final launchedUris = <Uri>[];
    AppUpdateCheckOutcome? outcome;
    await _pumpHarness(
      tester,
      service: service,
      launcher: (uri) async {
        launchedUris.add(uri);
        return true;
      },
      onOutcome: (value) => outcome = value,
    );

    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pumpAndSettle();

    expect(find.text('已是最新版（1.0.1）'), findsOneWidget);
    expect(find.byKey(const ValueKey('app-update-dialog')), findsNothing);
    expect(launchedUris, isEmpty);
    expect(outcome, AppUpdateCheckOutcome.upToDate);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });

  testWidgets('service failure reports that the update check failed', (
    tester,
  ) async {
    final service = _FakeAppUpdateService(error: StateError('network down'));
    AppUpdateCheckOutcome? outcome;
    await _pumpHarness(
      tester,
      service: service,
      launcher: (_) async => true,
      onOutcome: (value) => outcome = value,
    );

    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pumpAndSettle();
    for (var attempt = 0; attempt < 10 && outcome == null; attempt += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(find.text('检查更新失败，请稍后重试'), findsOneWidget);
    expect(find.byKey(const ValueKey('app-update-dialog')), findsNothing);
    expect(outcome, AppUpdateCheckOutcome.failed);
    expect(service.callCount, 1);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });

  testWidgets('concurrent checks share one request and do not stack dialogs', (
    tester,
  ) async {
    final pendingRelease = Completer<AppRelease?>();
    final service = _FakeAppUpdateService(
      pendingRelease: pendingRelease.future,
    );
    final outcomes = <AppUpdateCheckOutcome>[];
    await _pumpHarness(
      tester,
      service: service,
      launcher: (_) async => true,
      onOutcome: outcomes.add,
    );

    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('check-update')));
    await tester.pump();

    expect(service.callCount, 1);
    expect(outcomes, contains(AppUpdateCheckOutcome.alreadyChecking));

    pendingRelease.complete(_release(version: '1.1.0', pageUri: releaseUri));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('app-update-dialog')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('app-update-later')));
    await tester.pumpAndSettle();
    expect(service.callCount, 1);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}

AppRelease _release({required String version, required String pageUri}) {
  return AppRelease(
    version: Version.parse(version),
    tagName: 'v$version',
    pageUri: Uri.parse(pageUri),
    title: 'Twilight Echo $version',
  );
}

Future<void> _pumpHarness(
  WidgetTester tester, {
  required AppUpdateService service,
  required ExternalUriLauncher launcher,
  required ValueChanged<AppUpdateCheckOutcome> onOutcome,
}) async {
  PackageInfo.setMockInitialValues(
    appName: appDisplayName,
    packageName: 'com.twilight.echo',
    version: '1.0.1',
    buildNumber: '2',
    buildSignature: '',
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        appUpdateServiceProvider.overrideWithValue(service),
        externalUriLauncherProvider.overrideWithValue(launcher),
      ],
      child: MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => Center(
              child: FilledButton(
                key: const ValueKey('check-update'),
                onPressed: () async {
                  onOutcome(
                    await checkForAppUpdate(context, ref, showFeedback: true),
                  );
                },
                child: const Text('检查更新'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _FakeAppUpdateService implements AppUpdateService {
  _FakeAppUpdateService({this.release, this.error, this.pendingRelease});

  final AppRelease? release;
  final Object? error;
  final Future<AppRelease?>? pendingRelease;
  int callCount = 0;

  @override
  Future<AppRelease?> fetchLatestRelease() async {
    callCount += 1;
    final failure = error;
    if (failure != null) throw failure;
    final pending = pendingRelease;
    if (pending != null) return pending;
    return release;
  }
}
