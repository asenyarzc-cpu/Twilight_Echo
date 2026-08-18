import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../theme/app_motion.dart';
import '../../player/player_controller.dart';
import '../../playlists/playlist_detail_toolbar_state.dart';
import '../../songs/songs_toolbar_state.dart';
import '../player_pull_scope.dart';
import '../shell_route_utils.dart';
import '../shell_toolbar_visibility.dart';
import '../tab_location_memory.dart';
import 'mini_player_bar.dart';
import 'playback_glyph.dart';
import 'toolbar_metrics.dart';

class BottomToolbar extends ConsumerWidget {
  const BottomToolbar({
    super.key,
    required this.location,
    required this.routeLocation,
    required this.reveal,
    required this.travelExtent,
  });

  final String location;
  final String routeLocation;
  final Animation<double> reveal;
  final double travelExtent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = shellSchemeFor(location, Theme.of(context).colorScheme);
    final shellVisible = ref.watch(shellToolbarVisibleProvider);
    final playerHasContent = ref.watch(
      playerControllerProvider.select(
        (state) => state.hasTrack || state.loading,
      ),
    );
    final songsBatchMode =
        isSongsLibraryLocation(location) &&
        ref.watch(songsToolbarStateProvider.select((state) => state.batchMode));
    final playlistBatchMode =
        isPlaylistDetailLocation(location) &&
        ref.watch(
          playlistDetailToolbarStateProvider.select((state) => state.batchMode),
        );
    final visible =
        shellVisible &&
        !songsBatchMode &&
        !playlistBatchMode &&
        (location != '/player' || !playerHasContent);
    final toolbar = SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(14, 0, 14, 10),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final viewport = MediaQuery.sizeOf(context);
          final actionWidth = math.max(
            toolbarMinActionWidth,
            math.min(
              toolbarMaxActionWidthFor(viewport),
              (constraints.maxWidth - toolbarHorizontalPadding) /
                  toolbarActionCount,
            ),
          );
          final scaledLabelHeight = MediaQuery.textScalerOf(
            context,
          ).scale(toolbarLabelFontSizeFor(viewport));
          final actionHeight = math.max(
            toolbarMinActionHeightFor(viewport),
            toolbarActionVerticalChromeFor(viewport) + scaledLabelHeight,
          );
          final toolbarHeight = actionHeight + 8;
          return Center(
            child: AnimatedSize(
              duration: AppMotion.medium,
              curve: AppMotion.emphasized,
              // The outer boundary keeps the animated progress border and
              // playback glyph from repainting the page behind the toolbar;
              // the inner one keeps the shadowed container itself cached
              // while only the border sweep redraws.
              child: RepaintBoundary(
                child: _ToolbarProgressBorder(
                  color: scheme.primary.withValues(
                    alpha: scheme.brightness == Brightness.light ? 0.72 : 0.86,
                  ),
                  child: RepaintBoundary(
                    child: AnimatedContainer(
                      duration: AppMotion.long,
                      curve: AppMotion.emphasized,
                      height: toolbarHeight,
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: Color.alphaBlend(
                          scheme.primary.withValues(
                            alpha: scheme.brightness == Brightness.light
                                ? 0.025
                                : 0.04,
                          ),
                          scheme.surfaceContainerHigh.withValues(alpha: 0.90),
                        ),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: scheme.outlineVariant.withValues(alpha: 0.52),
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: scheme.shadow.withValues(
                              alpha: scheme.brightness == Brightness.light
                                  ? 0.08
                                  : 0.18,
                            ),
                            blurRadius: 28,
                            offset: const Offset(0, 10),
                          ),
                        ],
                      ),
                      child: _ToolbarPager(
                        location: location,
                        routeLocation: routeLocation,
                        actionWidth: actionWidth,
                        actionHeight: actionHeight,
                        toolbarHeight: toolbarHeight,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );

    return IgnorePointer(
      ignoring: !visible,
      child: AnimatedSlide(
        offset: visible ? Offset.zero : const Offset(0, 1.25),
        duration: AppMotion.medium,
        curve: AppMotion.emphasized,
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: AppMotion.short,
          curve: AppMotion.emphasized,
          child: AnimatedBuilder(
            animation: reveal,
            child: toolbar,
            builder: (context, child) {
              final progress = reveal.value.clamp(0.0, 1.0).toDouble();
              final opacity = toolbarOpacityFor(progress);
              final translated = Transform.translate(
                offset: Offset(0, (1 - progress) * travelExtent),
                child: child,
              );
              return IgnorePointer(
                ignoring: progress <= toolbarHitTestRevealThreshold,
                // Kept unconditional: swapping this Opacity in and out re-slots
                // the whole capsule subtree, which would dispose the pager's
                // drag recognizers mid-gesture. RenderOpacity already skips the
                // layer at full opacity, so there is nothing to save here.
                child: Opacity(opacity: opacity, child: translated),
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Watches playback progress in a leaf so per-tick position updates rebuild
/// only this border wrapper — `child` stays the same instance and its whole
/// subtree is skipped.
class _ToolbarProgressBorder extends ConsumerWidget {
  const _ToolbarProgressBorder({required this.color, required this.child});

  final Color color;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final playbackProgress = ref.watch(
      playerControllerProvider.select((state) {
        final durationMs = state.duration.inMilliseconds;
        if (!state.hasTrack || durationMs <= 0) return 0.0;
        return (state.position.inMilliseconds / durationMs)
            .clamp(0.0, 1.0)
            .toDouble();
      }),
    );
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: playbackProgress),
      duration: AppMotion.short,
      curve: AppMotion.emphasized,
      child: child,
      builder: (context, progress, child) {
        return CustomPaint(
          foregroundPainter: _ToolbarProgressBorderPainter(
            progress: progress,
            color: color,
          ),
          child: child,
        );
      },
    );
  }
}

class _ToolbarProgressBorderPainter extends CustomPainter {
  const _ToolbarProgressBorderPainter({
    required this.progress,
    required this.color,
  });

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final clamped = progress.clamp(0.0, 1.0).toDouble();
    if (clamped <= 0 || size.isEmpty) return;

    final inset = toolbarProgressStrokeWidth / 2;
    final rect =
        Offset(inset, inset) &
        Size(
          size.width - toolbarProgressStrokeWidth,
          size.height - toolbarProgressStrokeWidth,
        );
    final radius = Radius.circular(rect.height / 2);
    final path = Path()
      ..moveTo(rect.left + rect.height / 2, rect.top)
      ..lineTo(rect.right - rect.height / 2, rect.top)
      ..arcToPoint(
        Offset(rect.right - rect.height / 2, rect.bottom),
        radius: radius,
      )
      ..lineTo(rect.left + rect.height / 2, rect.bottom)
      ..arcToPoint(
        Offset(rect.left + rect.height / 2, rect.top),
        radius: radius,
      )
      ..close();

    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = toolbarProgressStrokeWidth
      ..strokeCap = StrokeCap.round
      ..color = color;

    for (final metric in path.computeMetrics()) {
      canvas.drawPath(metric.extractPath(0, metric.length * clamped), paint);
      break;
    }
  }

  @override
  bool shouldRepaint(covariant _ToolbarProgressBorderPainter oldDelegate) {
    return progress != oldDelegate.progress || color != oldDelegate.color;
  }
}

/// Hosts the two capsule pages — nav toolbar and mini player bar — and pages
/// between them with a horizontal swipe: the drag scrubs a cross-fade
/// directly, release settles it with the same direction-biased thresholds and
/// timing as the AppShell scroll reveal state machine.
class _ToolbarPager extends StatefulWidget {
  const _ToolbarPager({
    required this.location,
    required this.routeLocation,
    required this.actionWidth,
    required this.actionHeight,
    required this.toolbarHeight,
  });

  final String location;
  final String routeLocation;
  final double actionWidth;
  final double actionHeight;
  final double toolbarHeight;

  @override
  State<_ToolbarPager> createState() => _ToolbarPagerState();
}

class _ToolbarPagerState extends State<_ToolbarPager>
    with SingleTickerProviderStateMixin {
  /// 0 shows [_page] fully, 1 shows the other page fully. Once a switch
  /// settles at 1 the pages are swapped and the value snaps back to 0.
  late final AnimationController _switch;
  int _page = 0; // 0 = nav toolbar, 1 = mini player bar.
  double _dragSign = 0;
  double _lastDragDelta = 0;

  @override
  void initState() {
    super.initState();
    _switch = AnimationController(vsync: this);
  }

  @override
  void dispose() {
    _switch.dispose();
    super.dispose();
  }

  void _handleDragStart(DragStartDetails details) {
    _switch.stop(canceled: false);
    _dragSign = 0;
    _lastDragDelta = 0;
  }

  void _handleDragUpdate(DragUpdateDetails details) {
    final dx = details.delta.dx;
    if (dx == 0) return;
    if (_dragSign == 0) _dragSign = dx.sign;
    _lastDragDelta = dx;
    final step =
        (dx.sign == _dragSign ? 1 : -1) * dx.abs() / toolbarPageDragExtent;
    _switch.value = (_switch.value + step).clamp(0.0, 1.0);
  }

  void _settleAfterDrag() {
    final value = _switch.value;
    // Positive = the last finger movement kept pushing towards the other
    // page; negative = it was heading back. Same direction bias as
    // _settleToolbarAfterScroll in app_shell.dart.
    final lastStep = _dragSign == 0 ? 0.0 : _lastDragDelta * _dragSign;
    final target = switch (lastStep) {
      > 0 => value >= toolbarShowDirectionThreshold ? 1.0 : 0.0,
      < 0 => value <= toolbarHideDirectionThreshold ? 0.0 : 1.0,
      _ => value >= 0.5 ? 1.0 : 0.0,
    };
    _lastDragDelta = 0;
    _animateSwitchTo(target);
  }

  void _animateSwitchTo(double target) {
    if ((_switch.value - target).abs() < 0.001 ||
        (MediaQuery.maybeDisableAnimationsOf(context) ?? false)) {
      _switch.value = target;
      _finishSwitchIfNeeded();
      return;
    }
    final remaining = (_switch.value - target).abs();
    _switch
        .animateTo(
          target,
          duration: Duration(milliseconds: (140 + 180 * remaining).round()),
          curve: AppMotion.emphasized,
        )
        .whenCompleteOrCancel(_finishSwitchIfNeeded);
  }

  void _finishSwitchIfNeeded() {
    if (!mounted || _switch.value != 1.0) return;
    setState(() {
      _page = 1 - _page;
      _switch.value = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final pageSize = Size(
      widget.actionWidth * toolbarActionCount,
      widget.toolbarHeight,
    );
    final navPage = _MainToolbar(
      location: widget.location,
      routeLocation: widget.routeLocation,
      actionWidth: widget.actionWidth,
      actionHeight: widget.actionHeight,
      toolbarHeight: widget.toolbarHeight,
    );
    final miniPage = SizedBox.fromSize(
      size: pageSize,
      child: MiniPlayerBar(
        width: pageSize.width,
        height: pageSize.height,
        onOpenPlayer: () => _go(context, widget.routeLocation, '/player'),
      ),
    );
    final pull = PlayerPullScope.maybeOf(context);
    return Listener(
      // Fires before the drag clears the touch slop, giving the player layer a
      // head start on mounting and rendering its backdrop off screen.
      onPointerDown: pull == null ? null : (_) => pull.onWarm(),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: _handleDragStart,
        onHorizontalDragUpdate: _handleDragUpdate,
        onHorizontalDragEnd: (_) => _settleAfterDrag(),
        onHorizontalDragCancel: _settleAfterDrag,
        // Vertical and horizontal recognizers share the arena: whichever axis
        // clears the slop first wins, and the vertical one is registered first
        // so a diagonal drag resolves to pulling the player up.
        onVerticalDragStart: pull == null ? null : (_) => pull.onStart(),
        onVerticalDragUpdate: pull == null
            ? null
            : (details) => pull.onUpdate(details.delta.dy),
        onVerticalDragEnd: pull == null
            ? null
            : (details) => pull.onEnd(details.velocity.pixelsPerSecond.dy),
        onVerticalDragCancel: pull?.onCancel,
        // Transform.translate paints outside the capsule during the switch;
        // Stack only clips layout overflow, so clip explicitly.
        child: ClipRect(
          child: AnimatedBuilder(
            animation: _switch,
            builder: (context, _) {
              final v = _switch.value;
              final sign = _dragSign == 0 ? -1.0 : _dragSign;
              final current = _page == 0 ? navPage : miniPage;
              final other = _page == 0 ? miniPage : navPage;
              return Stack(
                alignment: Alignment.center,
                children: [
                  if (v < 1)
                    IgnorePointer(
                      ignoring: v >= 0.5,
                      child: ExcludeSemantics(
                        excluding: v >= 0.5,
                        child: Opacity(
                          opacity: 1 - v,
                          child: Transform.translate(
                            offset: Offset(
                              sign * toolbarPageSlideExtent * v,
                              0,
                            ),
                            child: current,
                          ),
                        ),
                      ),
                    ),
                  if (v > 0)
                    IgnorePointer(
                      ignoring: v < 0.5,
                      child: ExcludeSemantics(
                        excluding: v < 0.5,
                        child: Opacity(
                          opacity: v,
                          child: Transform.translate(
                            offset: Offset(
                              -sign * toolbarPageSlideExtent * (1 - v),
                              0,
                            ),
                            child: other,
                          ),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _MainToolbar extends ConsumerWidget {
  const _MainToolbar({
    required this.location,
    required this.routeLocation,
    required this.actionWidth,
    required this.actionHeight,
    required this.toolbarHeight,
  });

  final String location;
  final String routeLocation;
  final double actionWidth;
  final double actionHeight;
  final double toolbarHeight;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedIndex = toolbarIndexFor(location);
    final playerPlaying = ref.watch(
      playerControllerProvider.select(
        (state) => state.hasTrack && state.playing,
      ),
    );
    return SizedBox(
      width: actionWidth * toolbarActionCount,
      height: toolbarHeight,
      child: Stack(
        alignment: Alignment.centerLeft,
        clipBehavior: Clip.none,
        children: [
          AnimatedPositioned(
            left: selectedIndex * actionWidth,
            top: (toolbarHeight - actionHeight) / 2,
            duration: AppMotion.medium,
            curve: AppMotion.emphasized,
            child: _ToolbarSlidingIndicator(
              width: actionWidth,
              height: actionHeight,
            ),
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _ToolbarAction(
                tooltip: '发现',
                label: '发现',
                icon: Icons.explore_rounded,
                selected: isDiscoveryLocation(location),
                width: actionWidth,
                height: actionHeight,
                onPressed: () =>
                    _goTab(context, ref, location, routeLocation, '/'),
              ),
              _ToolbarAction(
                tooltip: '歌曲',
                label: '歌曲',
                icon: Icons.library_music_rounded,
                selected:
                    isSongsLibraryLocation(location) ||
                    location == '/downloads' ||
                    isPlaylistLocation(location),
                width: actionWidth,
                height: actionHeight,
                onPressed: () =>
                    _goTab(context, ref, location, routeLocation, '/songs'),
              ),
              _ToolbarAction(
                tooltip: '播放页',
                label: '播放',
                icon: Icons.graphic_eq_rounded,
                selected: location == '/player',
                animatedPlayback: playerPlaying,
                width: actionWidth,
                height: actionHeight,
                onPressed: () => _go(context, routeLocation, '/player'),
              ),
              _ToolbarAction(
                tooltip: '设置',
                label: '设置',
                icon: Icons.tune_rounded,
                selected:
                    location.startsWith('/settings'),
                width: actionWidth,
                height: actionHeight,
                onPressed: () =>
                    _goTab(context, ref, location, routeLocation, '/settings'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ToolbarSlidingIndicator extends StatelessWidget {
  const _ToolbarSlidingIndicator({required this.width, required this.height});

  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return IgnorePointer(
      child: Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          color: scheme.secondaryContainer,
          borderRadius: BorderRadius.circular(999),
        ),
      ),
    );
  }
}

class _ToolbarAction extends StatefulWidget {
  const _ToolbarAction({
    required this.tooltip,
    required this.label,
    required this.icon,
    required this.onPressed,
    required this.width,
    required this.height,
    this.selected = false,
    this.animatedPlayback = false,
  });

  final String tooltip;
  final String label;
  final IconData icon;
  final VoidCallback? onPressed;
  final double width;
  final double height;
  final bool selected;
  final bool animatedPlayback;

  @override
  State<_ToolbarAction> createState() => _ToolbarActionState();
}

class _ToolbarActionState extends State<_ToolbarAction>
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
    _scale.animateWith(
      SpringSimulation(AppMotion.expressiveSpring, _scale.value, target, 0),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final viewport = MediaQuery.sizeOf(context);
    final iconExtent = toolbarIconExtentFor(viewport);
    final iconSize = toolbarIconSizeFor(viewport);
    final labelFontSize = toolbarLabelFontSizeFor(viewport);
    final enabled = widget.onPressed != null;
    final selected = widget.selected;
    final foregroundColor = selected
        ? scheme.onSecondaryContainer
        : scheme.onSurfaceVariant.withValues(alpha: enabled ? 1 : 0.72);

    final child = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: enabled ? widget.onPressed : null,
      onTapDown: enabled ? (_) => _springTo(0.92) : null,
      onTapUp: enabled ? (_) => _springTo(1) : null,
      onTapCancel: enabled ? () => _springTo(1) : null,
      child: AnimatedBuilder(
        animation: _scale,
        builder: (context, child) =>
            Transform.scale(scale: _scale.value, child: child),
        child: AnimatedContainer(
          duration: AppMotion.medium,
          curve: AppMotion.emphasized,
          width: widget.width,
          height: widget.height,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: iconExtent,
                  height: iconExtent,
                  child: Center(
                    child: widget.animatedPlayback
                        ? AnimatedPlaybackGlyph(color: foregroundColor)
                        : Icon(
                            widget.icon,
                            color: foregroundColor,
                            size: iconSize,
                          ),
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: selected
                        ? scheme.onSecondaryContainer
                        : scheme.onSurfaceVariant.withValues(
                            alpha: enabled ? 1 : 0.72,
                          ),
                    fontSize: labelFontSize,
                    fontWeight: FontWeight.w600,
                    height: 1,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    return Tooltip(message: widget.tooltip, child: child);
  }
}

void _go(BuildContext context, String currentLocation, String path) {
  _dismissTransientRoutes(context);
  if (currentLocation == path) return;
  if (path == '/player') {
    context.go(
      path,
      extra: normalizedPlayerReturnLocation(currentLocation, '/songs'),
    );
  } else {
    context.go(path);
  }
}

/// Tab-tap navigation with per-tab last-location memory. Tapping the already
/// selected tab returns to the tab root; switching tabs restores the last
/// remembered location (full URI, including query) for the target tab.
void _goTab(
  BuildContext context,
  WidgetRef ref,
  String location,
  String routeLocation,
  String path,
) {
  _dismissTransientRoutes(context);
  final targetIndex = toolbarIndexFor(path);
  final target = toolbarIndexFor(location) == targetIndex
      ? path
      : (ref.read(tabLocationMemoryProvider)[targetIndex] ?? path);
  if (target == routeLocation) return;
  context.go(target);
}

void _dismissTransientRoutes(BuildContext context) {
  FocusManager.instance.primaryFocus?.unfocus();
  Navigator.of(context, rootNavigator: true).popUntil((route) => route.isFirst);
}
