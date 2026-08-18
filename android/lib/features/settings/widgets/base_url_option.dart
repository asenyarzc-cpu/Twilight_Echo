import 'package:flutter/material.dart';

import '../../../core/storage/base_url.dart';
import 'settings_style.dart';

enum BaseUrlChoice { primary, custom }

BaseUrlChoice baseUrlChoiceFor(String url) {
  final normalized = normalizeBaseUrl(url);
  if (normalized == kPrimaryBaseUrl) return BaseUrlChoice.primary;
  return BaseUrlChoice.custom;
}

bool isPresetBaseUrl(String url) {
  return baseUrlChoiceFor(url) == BaseUrlChoice.primary;
}

class BaseUrlOptionTile extends StatelessWidget {
  const BaseUrlOptionTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: choiceFill(scheme, selected),
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        overlayColor: choiceOverlay(scheme),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
          child: Row(
            children: [
              Icon(
                selected
                    ? Icons.radio_button_checked_rounded
                    : Icons.radio_button_unchecked_rounded,
                color: selected
                    ? selectedOnFill(scheme)
                    : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        color: selected
                            ? selectedOnFill(scheme)
                            : scheme.onSurface,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: selected
                            ? selectedOnFill(scheme).withValues(alpha: 0.76)
                            : scheme.onSurfaceVariant,
                        fontSize: 12,
                        height: 1.25,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
