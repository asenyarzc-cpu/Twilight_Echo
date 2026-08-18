import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/playlist_category.dart';
import '../../../theme/app_motion.dart';
import '../../discovery/discovery_controller.dart';
import '../../search/search_toolbar_state.dart';
import 'shell_fab_menu_action.dart';
import 'toolbar_metrics.dart';

class DiscoveryCategoryFabLayer extends ConsumerStatefulWidget {
  const DiscoveryCategoryFabLayer({super.key});

  @override
  ConsumerState<DiscoveryCategoryFabLayer> createState() =>
      _DiscoveryCategoryFabLayerState();
}

class _DiscoveryCategoryFabLayerState
    extends ConsumerState<DiscoveryCategoryFabLayer> {
  bool _expanded = false;

  void _setExpanded(bool value) {
    if (_expanded == value) return;
    setState(() => _expanded = value);
  }

  @override
  Widget build(BuildContext context) {
    final source = ref.watch(selectedDiscoverySourceProvider);
    final categories = playlistCatalogCategoriesFor(source);
    final searchVisible = ref.watch(
      searchToolbarStateProvider.select((state) => state.visible),
    );
    if (categories.length <= 1 || searchVisible) {
      if (_expanded) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _setExpanded(false);
        });
      }
      return const SizedBox.shrink();
    }

    final selectedId = ref.watch(selectedDiscoveryCategoryProvider(source));
    final selected = categories.firstWhere(
      (category) => category.id == selectedId,
      orElse: () => categories.first,
    );
    final wideLayout = toolbarUsesWideMetrics(MediaQuery.sizeOf(context));
    final fabPadding = EdgeInsets.only(
      right: wideLayout ? 104 : 18,
      bottom: 82,
    );

    return Stack(
      children: [
        if (_expanded)
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTap: () => _setExpanded(false),
              child: const SizedBox.expand(),
            ),
          ),
        SafeArea(
          top: false,
          child: Align(
            alignment: Alignment.bottomRight,
            child: Padding(
              padding: fabPadding,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  AnimatedSwitcher(
                    duration: AppMotion.medium,
                    switchInCurve: AppMotion.emphasizedDecelerate,
                    switchOutCurve: AppMotion.emphasizedAccelerate,
                    transitionBuilder: (child, animation) {
                      final offset = Tween<Offset>(
                        begin: const Offset(0, 0.14),
                        end: Offset.zero,
                      ).animate(animation);
                      return FadeTransition(
                        opacity: animation,
                        child: SlideTransition(position: offset, child: child),
                      );
                    },
                    child: _expanded
                        ? Column(
                            key: const ValueKey('discovery-category-menu-open'),
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              for (
                                var index = 0;
                                index < categories.length;
                                index++
                              ) ...[
                                if (index > 0) const SizedBox(height: 10),
                                ShellFabMenuAction(
                                  key: ValueKey(
                                    'discovery-category-${categories[index].id}',
                                  ),
                                  icon: categories[index].id == selected.id
                                      ? Icons.check_rounded
                                      : _categoryIcon(categories[index].label),
                                  label: categories[index].label,
                                  enabled: categories[index].id != selected.id,
                                  onPressed: () {
                                    ref
                                            .read(
                                              selectedDiscoveryCategoryProvider(
                                                source,
                                              ).notifier,
                                            )
                                            .state =
                                        categories[index].id;
                                    _setExpanded(false);
                                  },
                                ),
                              ],
                            ],
                          )
                        : const SizedBox.shrink(
                            key: ValueKey('discovery-category-menu-closed'),
                          ),
                  ),
                  const SizedBox(height: 10),
                  FloatingActionButton.extended(
                    key: const ValueKey('discovery-category-fab'),
                    heroTag: 'discovery-category-fab',
                    tooltip: _expanded ? '收起分类菜单' : '切换歌单分类',
                    elevation: 3,
                    highlightElevation: 4,
                    icon: AnimatedSwitcher(
                      duration: AppMotion.short,
                      child: Icon(
                        _expanded
                            ? Icons.close_rounded
                            : Icons.filter_list_rounded,
                        key: ValueKey(_expanded),
                      ),
                    ),
                    label: Text(
                      selected.label,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    onPressed: () => _setExpanded(!_expanded),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

IconData _categoryIcon(String label) => switch (label) {
  '推荐' => Icons.auto_awesome_rounded,
  '最热' => Icons.local_fire_department_rounded,
  '最新' => Icons.fiber_new_rounded,
  '热藏' => Icons.favorite_rounded,
  '飙升' => Icons.trending_up_rounded,
  _ => Icons.filter_list_rounded,
};
