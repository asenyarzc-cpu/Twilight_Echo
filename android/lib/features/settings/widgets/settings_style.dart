import 'package:flutter/material.dart';
import 'package:material_symbols_icons/symbols.dart';

Color selectedFill(ColorScheme scheme) => scheme.secondaryContainer;

Color selectedOnFill(ColorScheme scheme) => scheme.onSecondaryContainer;

Color choiceFill(ColorScheme scheme, bool selected) => selected
    ? selectedFill(scheme)
    : scheme.surfaceContainerHighest.withValues(alpha: 0.44);

WidgetStateProperty<Color?> choiceOverlay(ColorScheme scheme) {
  return WidgetStateProperty.resolveWith((states) {
    if (states.contains(WidgetState.pressed)) {
      return scheme.secondaryContainer.withValues(alpha: 0.30);
    }
    if (states.contains(WidgetState.hovered) ||
        states.contains(WidgetState.focused)) {
      return scheme.secondaryContainer.withValues(alpha: 0.22);
    }
    return null;
  });
}

class SettingsSymbolBubble extends StatelessWidget {
  const SettingsSymbolBubble({super.key, required this.icon});

  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 42,
      height: 42,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLowest,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: icon.fontFamily?.startsWith('MaterialSymbols') == true
          ? VariedIcon.varied(
              icon,
              size: 24,
              weight: 300,
              color: scheme.primary,
            )
          : Icon(icon, size: 24, color: scheme.primary),
    );
  }
}
