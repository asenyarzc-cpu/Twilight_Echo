import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/ui/app_circular_loading_indicator.dart';

void main() {
  testWidgets('expressive loader morphs without changing its layout size', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: AppCircularLoadingIndicator(dimension: 56)),
        ),
      ),
    );

    final loader = find.byType(AppCircularLoadingIndicator);
    expect(loader, findsOneWidget);
    expect(tester.getSize(loader), const Size.square(56));
    expect(
      find.descendant(of: loader, matching: find.byType(CustomPaint)),
      findsOneWidget,
    );

    await tester.pump(const Duration(milliseconds: 325));
    await tester.pump(const Duration(milliseconds: 325));
    await tester.pump(const Duration(milliseconds: 650));

    expect(tester.takeException(), isNull);
    expect(tester.getSize(loader), const Size.square(56));
  });

  testWidgets('expressive loader honors reduced motion', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: AppCircularLoadingIndicator(),
        ),
      ),
    );

    final tickerMode = tester.widget<TickerMode>(
      find.descendant(
        of: find.byType(AppCircularLoadingIndicator),
        matching: find.byType(TickerMode),
      ),
    );
    expect(tickerMode.enabled, isFalse);

    await tester.pump(const Duration(seconds: 2));
    expect(tester.takeException(), isNull);
  });
}
