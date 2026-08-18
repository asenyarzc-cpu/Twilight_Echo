import 'package:flutter/material.dart';

import '../../../theme/seed_palette.dart';
import '../../shell/widgets/horizontal_page_swipe.dart';

class SeedSwatchRow extends StatelessWidget {
  const SeedSwatchRow({
    super.key,
    required this.selected,
    required this.onPick,
  });

  final Color selected;
  final ValueChanged<Color> onPick;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return HorizontalPageSwipeExclusion(
      child: SizedBox(
        key: const ValueKey('theme-seed-swatch-row'),
        height: 56,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          itemCount: SeedPalette.presets.length,
          separatorBuilder: (_, _) => const SizedBox(width: 10),
          itemBuilder: (context, index) {
            final seed = SeedPalette.presets[index];
            final selectedColor = selected.toARGB32() == seed.color.toARGB32();
            return GestureDetector(
              onTap: () => onPick(seed.color),
              child: Tooltip(
                message: seed.name,
                child: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: seed.color,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: selectedColor
                          ? scheme.primary
                          : scheme.outlineVariant,
                      width: selectedColor ? 3 : 1,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: selectedColor
                      ? Icon(
                          Icons.check,
                          color:
                              ThemeData.estimateBrightnessForColor(
                                    seed.color,
                                  ) ==
                                  Brightness.dark
                              ? Colors.white
                              : Colors.black,
                          size: 20,
                        )
                      : null,
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
