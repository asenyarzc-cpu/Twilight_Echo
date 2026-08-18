import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/settings_store.dart';
import '../../../theme/app_motion.dart';
import 'settings_style.dart';

class ThemeModeRow extends ConsumerWidget {
  const ThemeModeRow({super.key, required this.value});

  final ThemeMode value;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final selectedIndex = switch (value) {
      ThemeMode.system => 0,
      ThemeMode.light => 1,
      ThemeMode.dark => 2,
    };

    return Row(
      children: [
        const SettingsSymbolBubble(icon: Icons.dark_mode_outlined),
        const SizedBox(width: 18),
        Expanded(
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(
                color: scheme.outlineVariant.withValues(alpha: 0.55),
              ),
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final itemWidth = constraints.maxWidth / 3;
                return SizedBox(
                  height: 38,
                  child: Stack(
                    children: [
                      AnimatedPositioned(
                        left: selectedIndex * itemWidth,
                        top: 0,
                        bottom: 0,
                        width: itemWidth,
                        duration: AppMotion.medium,
                        curve: AppMotion.emphasized,
                        child: const _ModeSlidingIndicator(),
                      ),
                      Row(
                        children: [
                          _ModePill(
                            label: '跟随系统',
                            selected: value == ThemeMode.system,
                            onTap: () => ref
                                .read(settingsProvider.notifier)
                                .setThemeMode(ThemeMode.system),
                          ),
                          _ModePill(
                            label: '浅色',
                            selected: value == ThemeMode.light,
                            onTap: () => ref
                                .read(settingsProvider.notifier)
                                .setThemeMode(ThemeMode.light),
                          ),
                          _ModePill(
                            label: '深色',
                            selected: value == ThemeMode.dark,
                            onTap: () => ref
                                .read(settingsProvider.notifier)
                                .setThemeMode(ThemeMode.dark),
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class _ModeSlidingIndicator extends StatelessWidget {
  const _ModeSlidingIndicator();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return IgnorePointer(
      child: Container(
        decoration: BoxDecoration(
          color: selectedFill(scheme),
          borderRadius: BorderRadius.circular(999),
          boxShadow: [
            BoxShadow(
              color: scheme.shadow.withValues(alpha: 0.08),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
      ),
    );
  }
}

class _ModePill extends StatelessWidget {
  const _ModePill({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Expanded(
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        overlayColor: choiceOverlay(scheme),
        onTap: onTap,
        child: SizedBox(
          height: 38,
          child: Center(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: selected ? selectedOnFill(scheme) : scheme.outline,
                fontSize: 12,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
