import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/settings/widgets/theme_seed_row.dart';
import 'package:twilight_echo/features/shell/widgets/horizontal_page_swipe.dart';
import 'package:twilight_echo/theme/seed_palette.dart';

void main() {
  testWidgets('theme swatches keep horizontal drags out of page navigation', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var pageSwipes = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HorizontalPageSwipe(
            onSwipeLeft: () => pageSwipes += 1,
            child: Column(
              children: [
                ThemeSeedRow(
                  value: SeedPalette.presets.first.color,
                  onPick: (_) {},
                  onCustomize: () {},
                ),
                Expanded(
                  child: Listener(
                    key: ValueKey('regular-page-area'),
                    behavior: HitTestBehavior.opaque,
                    child: const SizedBox.expand(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    final swatches = find.byKey(const ValueKey('theme-seed-swatch-row'));
    final scrollable = find.descendant(
      of: swatches,
      matching: find.byType(Scrollable),
    );
    expect(tester.state<ScrollableState>(scrollable).position.pixels, 0);

    await tester.drag(swatches, const Offset(-150, 0));
    await tester.pumpAndSettle();

    expect(pageSwipes, 0);
    expect(
      tester.state<ScrollableState>(scrollable).position.pixels,
      greaterThan(0),
    );

    await tester.drag(
      find.byKey(const ValueKey('regular-page-area')),
      const Offset(-150, 0),
    );
    await tester.pumpAndSettle();

    expect(pageSwipes, 1);
    expect(tester.takeException(), isNull);
  });
}
