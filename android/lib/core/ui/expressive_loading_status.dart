import 'package:flutter/material.dart';

import 'app_circular_loading_indicator.dart';

class ExpressiveLoadingStatus extends StatelessWidget {
  const ExpressiveLoadingStatus({
    super.key,
    required this.title,
    this.subtitle,
    this.alignment = const Alignment(0, -0.3),
    this.bottomPadding = 0,
  });

  final String title;
  final String? subtitle;
  final Alignment alignment;
  final double bottomPadding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final description = subtitle == null ? title : '$title，$subtitle';
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final gap = reduceMotion ? 14.0 : 18.0;

    return Semantics(
      container: true,
      liveRegion: true,
      label: description,
      child: Align(
        alignment: alignment,
        child: Padding(
          padding: EdgeInsets.fromLTRB(28, 24, 28, bottomPadding),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const AppCircularLoadingIndicator(),
              SizedBox(height: gap),
              Text(
                title,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: scheme.onSurface,
                  fontWeight: FontWeight.w600,
                  fontSize: 18,
                  height: 1.16,
                ),
              ),
              if (subtitle != null) ...[
                const SizedBox(height: 7),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 330),
                  child: Text(
                    subtitle!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      height: 1.45,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
