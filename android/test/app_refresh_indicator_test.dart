import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/ui/app_refresh_indicator.dart';

void main() {
  testWidgets('a short pull only reveals part of the indicator', (
    tester,
  ) async {
    var refreshCount = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppRefreshIndicator(
            onRefresh: () async => refreshCount++,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: const [SizedBox(height: 80)],
            ),
          ),
        ),
      ),
    );

    final gesture = await tester.startGesture(const Offset(200, 100));
    await gesture.moveBy(const Offset(0, 40));
    await tester.pump();

    final reveal = tester.widget<Align>(
      find.byKey(const ValueKey('app-refresh-indicator-reveal')),
    );
    expect(reveal.heightFactor, greaterThan(0));
    expect(reveal.heightFactor, lessThan(1));
    expect(find.bySemanticsLabel('下拉刷新'), findsOneWidget);

    await gesture.up();
    await tester.pumpAndSettle();

    expect(refreshCount, 0);
    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('pull gesture uses the expressive refresh indicator', (
    tester,
  ) async {
    final refresh = Completer<void>();
    var refreshCount = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppRefreshIndicator(
            onRefresh: () {
              refreshCount++;
              return refresh.future;
            },
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: const [SizedBox(height: 80)],
            ),
          ),
        ),
      ),
    );

    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsNothing,
    );

    final gesture = await tester.startGesture(const Offset(200, 80));
    for (var step = 0; step < 8; step++) {
      await gesture.moveBy(const Offset(0, 60));
      await tester.pump(const Duration(milliseconds: 16));
    }

    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel('松开刷新'), findsOneWidget);

    await gesture.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(refreshCount, 1);
    expect(find.bySemanticsLabel('正在刷新'), findsOneWidget);

    refresh.complete();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump(const Duration(milliseconds: 250));

    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('an immediate refresh still snaps and scales out', (
    tester,
  ) async {
    var refreshCount = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppRefreshIndicator(
            onRefresh: () async => refreshCount++,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: const [SizedBox(height: 80)],
            ),
          ),
        ),
      ),
    );

    final gesture = await tester.startGesture(const Offset(200, 80));
    for (var step = 0; step < 8; step++) {
      await gesture.moveBy(const Offset(0, 60));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump();

    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsOneWidget,
    );

    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(refreshCount, 1);
    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsOneWidget,
    );

    await tester.pump(const Duration(milliseconds: 100));
    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsOneWidget,
    );

    await tester.pump(const Duration(milliseconds: 120));
    expect(
      find.byKey(const ValueKey('app-refresh-indicator-visible')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
}
