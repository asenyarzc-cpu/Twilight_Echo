import 'package:flutter/material.dart';

import '../../../core/ui/radio_menu.dart';
import 'settings_action.dart';

class SettingsMenuOption extends RadioMenuOption {
  const SettingsMenuOption({
    required super.id,
    required super.label,
    required super.selected,
    required super.onSelected,
    super.enabled,
  });
}

class SettingsMenuAction extends StatelessWidget {
  const SettingsMenuAction({
    super.key,
    required this.menuId,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.options,
    this.multiSelect = false,
  });

  final String menuId;
  final IconData icon;
  final String title;
  final String subtitle;
  final List<SettingsMenuOption> options;
  final bool multiSelect;

  @override
  Widget build(BuildContext context) {
    return RadioMenuAnchor(
      menuId: menuId,
      optionsBuilder: () => options,
      multiSelect: multiSelect,
      anchorBuilder: (context, expanded, onTapDown, onTap) {
        return Semantics(
          expanded: expanded,
          child: SettingsAction(
            interactionKey: ValueKey('$menuId-anchor'),
            icon: icon,
            title: title,
            subtitle: subtitle,
            trailing: Icons.chevron_right_rounded,
            onTapDown: onTapDown,
            onTap: onTap,
          ),
        );
      },
    );
  }
}
