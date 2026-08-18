import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../theme/app_motion.dart';
import '../../search/search_toolbar_state.dart';
import 'shell_fab_menu_action.dart';
import 'toolbar_metrics.dart';

class SearchPagingFabLayer extends ConsumerStatefulWidget {
  const SearchPagingFabLayer({super.key});

  @override
  ConsumerState<SearchPagingFabLayer> createState() =>
      _SearchPagingFabLayerState();
}

class _SearchPagingFabLayerState extends ConsumerState<SearchPagingFabLayer> {
  bool _expanded = false;

  void _setExpanded(bool value) {
    if (_expanded == value) return;
    setState(() => _expanded = value);
  }

  void _runPageAction(VoidCallback? action) {
    if (action == null) return;
    action();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(searchToolbarStateProvider);
    if (!state.visible) {
      if (_expanded) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _setExpanded(false);
        });
      }
      return const SizedBox.shrink();
    }

    final wideLayout = toolbarUsesWideMetrics(MediaQuery.sizeOf(context));
    final fabPadding = EdgeInsets.only(
      right: wideLayout ? 104 : 18,
      bottom: wideLayout ? 82 : 82,
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
              child: _SearchPagingFabMenu(
                state: state,
                expanded: _expanded,
                onToggle: () => _setExpanded(!_expanded),
                onPrev: () => _runPageAction(state.onPrev),
                onNext: () => _runPageAction(state.onNext),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SearchPagingFabMenu extends StatelessWidget {
  const _SearchPagingFabMenu({
    required this.state,
    required this.expanded,
    required this.onToggle,
    required this.onPrev,
    required this.onNext,
  });

  final SearchToolbarState state;
  final bool expanded;
  final VoidCallback onToggle;
  final VoidCallback onPrev;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
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
          child: expanded
              ? Column(
                  key: const ValueKey('paging-fab-menu-open'),
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    ShellFabMenuAction(
                      icon: Icons.chevron_left_rounded,
                      label: '上一页',
                      enabled: !state.loading && state.canPrev,
                      onPressed: onPrev,
                    ),
                    const SizedBox(height: 10),
                    ShellFabMenuAction(
                      icon: Icons.chevron_right_rounded,
                      label: '下一页',
                      enabled: !state.loading && state.canNext,
                      onPressed: onNext,
                    ),
                  ],
                )
              : const SizedBox.shrink(key: ValueKey('paging-fab-menu-closed')),
        ),
        const SizedBox(height: 10),
        FloatingActionButton.extended(
          heroTag: 'search-paging-fab',
          tooltip: expanded ? '收起翻页菜单' : '展开翻页菜单',
          elevation: 3,
          highlightElevation: 4,
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          icon: AnimatedSwitcher(
            duration: AppMotion.short,
            child: state.loading
                ? SizedBox.square(
                    key: const ValueKey('paging-loading'),
                    dimension: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: scheme.onPrimary,
                    ),
                  )
                : Icon(
                    expanded
                        ? Icons.close_rounded
                        : Icons.keyboard_arrow_up_rounded,
                    key: ValueKey(expanded),
                  ),
          ),
          label: Text(
            '第 ${state.page} 页',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          onPressed: onToggle,
        ),
      ],
    );
  }
}
