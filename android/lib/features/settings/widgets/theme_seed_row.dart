import 'package:flutter/material.dart';

import 'seed_swatch_row.dart';
import 'settings_style.dart';

class ThemeSeedRow extends StatelessWidget {
  const ThemeSeedRow({
    super.key,
    required this.value,
    required this.onPick,
    required this.onCustomize,
  });

  final Color value;
  final ValueChanged<Color> onPick;
  final VoidCallback onCustomize;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            _ColorBubble(color: value),
            const SizedBox(width: 18),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '主题颜色',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.onSurface,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      height: 1.16,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    '用于生成应用的静态 Material 3 配色',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.outline,
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      height: 1.2,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            FilledButton.tonalIcon(
              onPressed: onCustomize,
              icon: const Icon(Icons.palette_outlined, size: 18),
              label: const Text('调色'),
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 40),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                shape: const StadiumBorder(),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SeedSwatchRow(selected: value, onPick: onPick),
      ],
    );
  }
}

class _ColorBubble extends StatelessWidget {
  const _ColorBubble({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 42,
      height: 42,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Icon(
        Icons.check_rounded,
        color: ThemeData.estimateBrightnessForColor(color) == Brightness.dark
            ? Colors.white
            : Colors.black,
        size: 20,
      ),
    );
  }
}

class DynamicColorRow extends StatelessWidget {
  const DynamicColorRow({
    super.key,
    required this.value,
    required this.available,
    required this.onChanged,
  });

  final bool value;
  final bool available;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        const SettingsSymbolBubble(icon: Icons.auto_awesome_outlined),
        const SizedBox(width: 18),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Material You 动态色',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: scheme.onSurface,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  height: 1.16,
                ),
              ),
              const SizedBox(height: 5),
              Text(
                available ? '用系统壁纸/强调色生成完整主题' : '系统未返回动态色，使用主题色',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: scheme.outline,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  height: 1.2,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Switch(value: value, onChanged: onChanged),
      ],
    );
  }
}
