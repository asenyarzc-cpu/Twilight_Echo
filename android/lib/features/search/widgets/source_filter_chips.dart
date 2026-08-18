import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/storage/settings_store.dart';
import '../../../theme/app_motion.dart';
import '../search_controller.dart';

class SourceFilterChips extends ConsumerWidget {
  const SourceFilterChips({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final selected = ref.watch(searchControllerProvider).source;
    final enabled = ref.watch(
      settingsProvider.select((settings) => settings.enabledSearchSources),
    );
    final sources = [
      MusicSource.all,
      for (final source in kManageableSearchSources)
        if (enabled.contains(source)) source,
    ];
    final selectedIndex = sources.indexOf(selected);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final duration = reduceMotion ? Duration.zero : AppMotion.medium;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Container(
        key: const ValueKey('search-source-filter'),
        height: 36,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: scheme.surfaceContainer,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: scheme.outlineVariant.withValues(alpha: 0.2),
          ),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final itemWidth = constraints.maxWidth / sources.length;
            return Stack(
              children: [
                AnimatedPositioned(
                  left: (selectedIndex < 0 ? 0 : selectedIndex) * itemWidth,
                  top: 0,
                  bottom: 0,
                  width: itemWidth,
                  duration: duration,
                  curve: AppMotion.emphasized,
                  child: const _SourceSlidingIndicator(
                    key: ValueKey('search-source-indicator'),
                  ),
                ),
                Row(
                  children: [
                    for (final source in sources)
                      Expanded(
                        child: _SourceChip(
                          key: ValueKey('search-source-${source.code}'),
                          source: source,
                          selected: selected == source,
                          onTap: () => ref
                              .read(searchControllerProvider.notifier)
                              .setSource(source),
                        ),
                      ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SourceSlidingIndicator extends StatelessWidget {
  const _SourceSlidingIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return IgnorePointer(
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: scheme.secondaryContainer,
          borderRadius: BorderRadius.circular(9),
        ),
      ),
    );
  }
}

class _SourceChip extends StatefulWidget {
  const _SourceChip({
    super.key,
    required this.source,
    required this.selected,
    required this.onTap,
  });

  final MusicSource source;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_SourceChip> createState() => _SourceChipState();
}

class _SourceChipState extends State<_SourceChip>
    with SingleTickerProviderStateMixin {
  late final AnimationController _scale;

  @override
  void initState() {
    super.initState();
    _scale = AnimationController.unbounded(vsync: this, value: 1);
  }

  @override
  void dispose() {
    _scale.dispose();
    super.dispose();
  }

  void _springTo(double target) {
    if (MediaQuery.disableAnimationsOf(context)) {
      _scale.value = target;
      return;
    }
    _scale.animateWith(
      SpringSimulation(AppMotion.expressiveSpring, _scale.value, target, 0),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final duration = reduceMotion ? Duration.zero : AppMotion.medium;
    final foreground = widget.selected
        ? scheme.onSecondaryContainer
        : scheme.onSurfaceVariant;

    return SizedBox.expand(
      child: Semantics(
        button: true,
        selected: widget.selected,
        label: '${widget.source.label}音乐来源',
        excludeSemantics: true,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          clipBehavior: Clip.antiAlias,
          child: AnimatedBuilder(
            animation: _scale,
            builder: (context, child) =>
                Transform.scale(scale: _scale.value, child: child),
            child: InkWell(
              onTap: widget.onTap,
              onHighlightChanged: (highlighted) =>
                  _springTo(highlighted ? 0.94 : 1),
              borderRadius: BorderRadius.circular(9),
              overlayColor: WidgetStateProperty.resolveWith((states) {
                if (states.contains(WidgetState.pressed)) {
                  return scheme.primary.withValues(alpha: 0.12);
                }
                if (states.contains(WidgetState.hovered) ||
                    states.contains(WidgetState.focused)) {
                  return scheme.primary.withValues(alpha: 0.08);
                }
                return null;
              }),
              child: AnimatedDefaultTextStyle(
                duration: duration,
                curve: AppMotion.emphasized,
                style: TextStyle(
                  color: foreground,
                  fontSize: 11.5,
                  fontWeight: widget.selected
                      ? FontWeight.w600
                      : FontWeight.w500,
                  height: 1,
                  letterSpacing: 0,
                ),
                child: Center(
                  child: Text(
                    widget.source.label,
                    maxLines: 1,
                    overflow: TextOverflow.fade,
                    softWrap: false,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
