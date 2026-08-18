import 'package:flutter/material.dart';

import '../../../theme/app_motion.dart';

class ShellFabMenuAction extends StatelessWidget {
  const ShellFabMenuAction({
    super.key,
    required this.icon,
    required this.label,
    required this.enabled,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final foreground = enabled
        ? scheme.onSecondaryContainer
        : scheme.onSurfaceVariant.withValues(alpha: 0.38);
    return AnimatedOpacity(
      duration: AppMotion.short,
      opacity: enabled ? 1 : 0.62,
      child: Material(
        color: enabled
            ? scheme.secondaryContainer
            : scheme.surfaceContainerHighest,
        elevation: 3,
        shadowColor: scheme.shadow.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: enabled ? onPressed : null,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48, minWidth: 124),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, color: foreground, size: 22),
                  const SizedBox(width: 8),
                  Text(
                    label,
                    style: TextStyle(
                      color: foreground,
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
