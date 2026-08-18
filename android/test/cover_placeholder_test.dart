import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/ui/cover_placeholder.dart';

void main() {
  testWidgets('cover loading uses a text-free animated skeleton', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: CoverLoadingSkeleton()));

    expect(
      find.byKey(const ValueKey('cover-loading-skeleton')),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel('正在加载封面'), findsOneWidget);
    expect(find.textContaining('酷我'), findsNothing);
    expect(find.textContaining('酷狗'), findsNothing);
    expect(find.textContaining('网易'), findsNothing);

    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);
  });

  testWidgets('failed covers use a neutral icon without platform text', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: CoverUnavailablePlaceholder()),
    );

    expect(find.byIcon(Icons.album_rounded), findsOneWidget);
    expect(find.bySemanticsLabel('暂无封面'), findsOneWidget);
    expect(find.byKey(const ValueKey('cover-loading-skeleton')), findsNothing);
  });
}
