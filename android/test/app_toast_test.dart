import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/ui/app_toast.dart';

void main() {
  testWidgets('toast stays on the stable root overlay during navigation', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(360, 800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        ),
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        routes: {
          '/next': (_) => const Scaffold(body: Center(child: Text('下一页'))),
        },
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  FilledButton(
                    onPressed: () => showAppToast(
                      context,
                      '操作失败',
                      type: AppToastType.error,
                      position: AppToastPosition.topCenter,
                      duration: const Duration(seconds: 10),
                    ),
                    child: const Text('显示 Toast'),
                  ),
                  TextButton(
                    onPressed: () => Navigator.of(context).pushNamed('/next'),
                    child: const Text('切换页面'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('显示 Toast'));
    await tester.pump();
    await tester.pumpAndSettle();

    final capsule = find.byKey(const ValueKey('app-toast-capsule'));
    expect(capsule, findsOneWidget);
    expect(find.text('操作失败'), findsOneWidget);
    expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);
    expect(tester.getSize(capsule).width, lessThan(200));
    expect(tester.getSize(capsule).height, lessThanOrEqualTo(52));
    expect(tester.getCenter(capsule).dy, lessThan(160));
    expect(
      find.ancestor(
        of: capsule,
        matching: find.byKey(const ValueKey('app-toast-root-overlay')),
      ),
      findsOneWidget,
    );
    final toastElement = tester.element(capsule);

    await tester.tap(find.text('切换页面'));
    await tester.pump();
    expect(capsule, findsOneWidget);
    expect(identical(tester.element(capsule), toastElement), isTrue);

    await tester.pump(const Duration(milliseconds: 150));
    expect(capsule, findsOneWidget);
    expect(identical(tester.element(capsule), toastElement), isTrue);

    await tester.pumpAndSettle();
    expect(find.text('下一页'), findsOneWidget);
    expect(capsule, findsOneWidget);
    expect(identical(tester.element(capsule), toastElement), isTrue);
    expect(tester.takeException(), isNull);

    await tester.pump(const Duration(seconds: 11));
    await tester.pumpAndSettle();
    expect(capsule, findsNothing);
    expect(find.text('操作失败'), findsNothing);
  });

  testWidgets('bottom toast does not block bottom navigation', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(360, 800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    var navigationCount = 0;

    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: FilledButton(
                onPressed: () => showAppToast(
                  context,
                  '已添加到歌单',
                  type: AppToastType.success,
                  duration: const Duration(seconds: 10),
                ),
                child: const Text('显示底部 Toast'),
              ),
            ),
          ),
          bottomNavigationBar: SizedBox(
            height: 80,
            child: TextButton(
              key: const ValueKey('bottom-navigation-action'),
              onPressed: () => navigationCount++,
              child: const Text('切换导航'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('显示底部 Toast'));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('app-toast-capsule')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('bottom-navigation-action')),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(navigationCount, 1);
    expect(find.byKey(const ValueKey('app-toast-capsule')), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pump(const Duration(seconds: 11));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('app-toast-capsule')), findsNothing);
    expect(find.text('已添加到歌单'), findsNothing);
  });

  testWidgets('a toast handle only dismisses its own notification', (
    tester,
  ) async {
    late BuildContext pageContext;
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        home: Builder(
          builder: (context) {
            pageContext = context;
            return const Scaffold(body: SizedBox.expand());
          },
        ),
      ),
    );

    final first = showAppToast(
      pageContext,
      '第一次错误',
      duration: const Duration(seconds: 10),
    );
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('第一次错误'), findsOneWidget);

    showAppToast(pageContext, '后续提示', duration: const Duration(seconds: 10));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('第一次错误'), findsNothing);
    expect(find.text('后续提示'), findsOneWidget);

    dismissAppToast(first, showRemoveAnimation: false);
    await tester.pump();
    expect(find.text('后续提示'), findsOneWidget);

    await tester.pump(const Duration(seconds: 11));
    await tester.pumpAndSettle();
  });

  testWidgets('a toast can be dismissed before its first overlay frame', (
    tester,
  ) async {
    late BuildContext pageContext;
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            AppToastOverlay(child: child ?? const SizedBox.shrink()),
        home: Builder(
          builder: (context) {
            pageContext = context;
            return const Scaffold(body: SizedBox.expand());
          },
        ),
      ),
    );

    final toast = showAppToast(
      pageContext,
      '不应残留',
      duration: const Duration(seconds: 10),
    );
    dismissAppToast(toast, showRemoveAnimation: false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));

    expect(find.text('不应残留'), findsNothing);
    expect(find.byKey(const ValueKey('app-toast-capsule')), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
