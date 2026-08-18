import 'package:flutter/material.dart';

class AppScrollbar extends StatelessWidget {
  const AppScrollbar({
    super.key,
    required this.controller,
    required this.child,
  });

  final ScrollController controller;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ScrollbarTheme(
      data: ScrollbarTheme.of(context).copyWith(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          final opacity = states.contains(WidgetState.dragged) ? 0.96 : 0.72;
          return scheme.primary.withValues(alpha: opacity);
        }),
        trackColor: const WidgetStatePropertyAll(Colors.transparent),
        trackBorderColor: const WidgetStatePropertyAll(Colors.transparent),
        crossAxisMargin: 8,
      ),
      child: Scrollbar(
        controller: controller,
        thumbVisibility: false,
        trackVisibility: false,
        interactive: true,
        // Flutter keeps a 48dp touch target even though the painted thumb is
        // intentionally slimmer.
        thickness: 8,
        radius: const Radius.circular(99),
        child: child,
      ),
    );
  }
}
