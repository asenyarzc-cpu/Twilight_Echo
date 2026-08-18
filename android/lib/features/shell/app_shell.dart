import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/enums.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/app_toast.dart';
import '../../theme/app_motion.dart';
import '../../theme/app_theme.dart';
import '../discovery/discovery_controller.dart';
import '../player/player_page.dart';
import '../playlists/playlist_detail_toolbar_state.dart';
import '../search/search_controller.dart' as search;
import '../songs/songs_toolbar_state.dart';
import 'player_pull_scope.dart';
import 'shell_route_utils.dart';
import 'shell_toolbar_visibility.dart';
import 'tab_location_memory.dart';
import 'widgets/bottom_toolbar.dart';
import 'widgets/discovery_category_fab.dart';
import 'widgets/horizontal_page_swipe.dart';
import 'widgets/search_paging_fab.dart';
import 'widgets/shell_header.dart';
import 'widgets/toolbar_metrics.dart';

class AppShell extends ConsumerStatefulWidget {
  const AppShell({
    super.key,
    required this.child,
    required this.location,
    required this.routeLocation,
    required this.playerReturnLocation,
    required this.playlistBackLocation,
  });

  final Widget child;
  final String location;
  final String routeLocation;
  final String playerReturnLocation;
  final String playlistBackLocation;

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell>
    with TickerProviderStateMixin {
  _ShellRouteMotion _routeMotion = _ShellRouteMotion.forward;
  String _playerReturnLocation = '/songs';
  late final AnimationController _toolbarRevealController;

  /// Player reveal progress: 0 parks the player layer below the screen, 1
  /// seats it. This is the single source of truth for entering, leaving and
  /// dragging the player — the page itself never animates.
  late final AnimationController _pull;
  late final PlayerPullGestures _pullGestures;

  /// Mounted lazily on first pull and never torn down again, so the backdrop's
  /// async blur pipeline only ever runs its cold start once.
  bool _playerLayerMounted = false;
  bool _pullActive = false;
  bool _dismissing = false;
  Timer? _returnToDesktopTimer;
  AppToastHandle? _returnToDesktopToast;
  double _lastPullDelta = 0;

  bool _toolbarScrollSequenceActive = false;
  double _lastToolbarScrollDelta = 0;
  double _toolbarTravelExtent = toolbarDefaultTravelExtent;

  @override
  void initState() {
    super.initState();
    _toolbarRevealController = AnimationController(
      vsync: this,
      value: 1,
      duration: AppMotion.medium,
    );
    final startsOnPlayer = widget.location == '/player';
    _pull = AnimationController(
      vsync: this,
      value: startsOnPlayer ? 1 : 0,
      duration: AppMotion.medium,
    );
    _playerLayerMounted = startsOnPlayer;
    // Built once: the tear-offs below are stable across builds, so dependents
    // of PlayerPullScope never rebuild.
    _pullGestures = PlayerPullGestures(
      onWarm: _handlePullWarm,
      onStart: _handlePullStart,
      onUpdate: _handlePullUpdate,
      onEnd: _handlePullEnd,
      onCancel: _handlePullCancel,
    );
    _rememberTabLocation();
  }

  @override
  void dispose() {
    _resetTopLevelBack();
    _toolbarRevealController.dispose();
    _pull.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant AppShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.routeLocation != widget.routeLocation) {
      _rememberTabLocation();
    }
    if (oldWidget.location != widget.location) {
      _resetTopLevelBack();
      _routeMotion = _motionFor(oldWidget.location, widget.location);
      _toolbarScrollSequenceActive = false;
      _lastToolbarScrollDelta = 0;
      // A drag that just committed already faded the toolbar out; resetting
      // reveal here would flash the capsule back in for one frame.
      if (!_pullActive && _pull.value == 0) {
        _toolbarRevealController.value = 1;
      }
      if (widget.location == '/player') {
        _playerReturnLocation = normalizedPlayerReturnLocation(
          widget.playerReturnLocation,
          oldWidget.location,
        );
        _playerLayerMounted = true;
        if (_pull.value < 1) {
          _animatePullTo(1, curve: AppMotion.emphasizedDecelerate);
        }
      } else {
        if (oldWidget.location == '/player') {
          // The dismiss animation has already parked it off screen; this is
          // just a backstop for navigation that bypassed _dismissPlayer.
          _pull.stop(canceled: false);
          _pull.value = 0;
          _animateToolbarTo(1);
        } else if (oldWidget.location != '/player') {
          _playerReturnLocation = normalizedPlayerReturnLocation(
            widget.location,
            _playerReturnLocation,
          );
        }
      }
      if (widget.location == '/songs/search') {
        FocusManager.instance.primaryFocus?.unfocus();
      } else {
        _releaseRouteFocus();
      }
    }
  }

  double get _pullExtent => MediaQuery.sizeOf(context).height;

  void _handlePullWarm() {
    if (_playerLayerMounted || widget.location == '/player') return;
    setState(() => _playerLayerMounted = true);
  }

  /// 手势落指时发现页所处的音源，用来区分"这次滑动被 PageView 消费翻页
  /// 了"与"已在边界页、应该升级为路由切换"。
  MusicSource? _swipeStartDiscoverySource;

  void _handlePageSwipeStart() {
    _swipeStartDiscoverySource = widget.location == '/'
        ? ref.read(selectedDiscoverySourceProvider)
        : null;
  }

  void _handlePageSwipeLeft() {
    switch (widget.location) {
      case '/':
        _moveDiscoverySource(1);
        return;
      case '/settings':
        _navigateBySwipe('/');
        return;
    }
  }

  void _handlePageSwipeRight() {
    switch (widget.location) {
      case '/':
        _moveDiscoverySource(-1);
        return;
      case '/songs':
      case '/songs/search':
        _navigateBySwipe('/');
        return;
    }
  }

  void _moveDiscoverySource(int step) {
    final searchState = ref.read(search.searchControllerProvider);
    if (searchState.isSearchActive) {
      final enabled = ref.read(settingsProvider).enabledSearchSources;
      final sources = <MusicSource>[
        MusicSource.all,
        for (final source in kManageableSearchSources)
          if (enabled.contains(source)) source,
      ];
      final index = sources.indexOf(searchState.source);
      final next = (index < 0 ? 0 : index) + step;
      if (next >= 0 && next < sources.length) {
        ref
            .read(search.searchControllerProvider.notifier)
            .setSource(sources[next]);
        return;
      }
    } else {
      // 非搜索态的音源翻页由发现页自己的 PageView 跟手接管；这里只在
      // 落指时已处于边界页、且 PageView 没有翻页时升级为路由切换。
      final MusicSource source =
          _swipeStartDiscoverySource ??
          ref.read(selectedDiscoverySourceProvider);
      final index = kDiscoverySources.indexOf(source);
      final next = (index < 0 ? 0 : index) + step;
      if (next >= 0 && next < kDiscoverySources.length) return;
    }
    _navigateBySwipe(step > 0 ? '/songs' : '/settings');
  }

  void _navigateBySwipe(String location) {
    FocusManager.instance.primaryFocus?.unfocus();
    context.go(location);
  }

  void _handlePullStart() {
    _pullActive = true;
    _lastPullDelta = 0;
    _pull.stop(canceled: false);
    _toolbarRevealController.stop(canceled: false);
    _releaseRouteFocus();
  }

  void _handlePullUpdate(double dy) {
    if (dy == 0) return;
    _lastPullDelta = dy;
    // 1:1 with the finger: the page tracks exactly where it is dragged.
    _pull.value = (_pull.value - dy / _pullExtent).clamp(0.0, 1.0).toDouble();
    _syncToolbarToPull();
  }

  void _syncToolbarToPull() {
    if (widget.location == '/player') return;
    _toolbarRevealController.value = (1 - _pull.value / playerPullToolbarFade)
        .clamp(0.0, 1.0)
        .toDouble();
  }

  void _handlePullEnd(double velocityDy) {
    if (!_pullActive) return;
    _pullActive = false;
    final progress = _pull.value;
    final lastDelta = _lastPullDelta;
    _lastPullDelta = 0;

    final bool reveal;
    if (velocityDy.abs() > playerPullFlingVelocity) {
      reveal = velocityDy < 0;
    } else {
      // Direction-biased thresholds, same shape as the toolbar scroll settle.
      reveal = switch (lastDelta) {
        < 0 => progress >= toolbarShowDirectionThreshold,
        > 0 => progress > toolbarHideDirectionThreshold,
        _ => progress >= 0.5,
      };
    }

    if (widget.location == '/player') {
      if (reveal) {
        _animatePullTo(1, curve: AppMotion.emphasizedDecelerate);
      } else {
        _dismissPlayer();
      }
      return;
    }

    if (reveal) {
      _commitPull();
    } else {
      _animatePullTo(0);
      _animateToolbarTo(1);
    }
  }

  void _handlePullCancel() {
    if (!_pullActive) return;
    _handlePullEnd(0);
  }

  /// Seats the player fully *before* navigating: the route swap discards the
  /// outgoing page in the same frame, so committing early would expose the
  /// bare shell surface beneath a still-rising player.
  void _commitPull() {
    _animatePullTo(1, curve: AppMotion.emphasizedDecelerate).whenComplete(() {
      if (!mounted || widget.location == '/player') return;
      context.go(
        '/player',
        extra: normalizedPlayerReturnLocation(
          widget.routeLocation,
          _playerReturnLocation,
        ),
      );
    });
  }

  Future<void> _dismissPlayer([String? target]) async {
    if (_dismissing) return;
    _dismissing = true;
    final destination = target ?? _playerReturnLocation;
    try {
      await _animatePullTo(0, curve: AppMotion.emphasizedAccelerate);
    } finally {
      _dismissing = false;
    }
    if (!mounted || _pull.value != 0) return;
    context.go(destination);
  }

  TickerFuture _animatePullTo(double target, {Curve? curve}) {
    if ((_pull.value - target).abs() < 0.001 ||
        (MediaQuery.maybeDisableAnimationsOf(context) ?? false)) {
      _pull.value = target;
      return TickerFuture.complete();
    }
    final remaining = (_pull.value - target).abs();
    return _pull.animateTo(
      target,
      duration: Duration(milliseconds: (140 + 180 * remaining).round()),
      curve: curve ?? AppMotion.emphasized,
    );
  }

  /// Records the current route (full URI including query) as the last visited
  /// location of its bottom-toolbar tab, so tab taps can restore it later.
  void _rememberTabLocation() {
    final location = widget.location;
    final routeLocation = widget.routeLocation;
    if (location == '/player') return;
    final index = toolbarIndexFor(location);
    if (index == 2) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final memory = ref.read(tabLocationMemoryProvider);
      if (memory[index] == routeLocation) return;
      ref.read(tabLocationMemoryProvider.notifier).state = {
        ...memory,
        index: routeLocation,
      };
    });
  }

  Future<bool> _handleBackButton() async {
    final navigator = Navigator.of(context, rootNavigator: true);
    if (navigator.canPop()) {
      await navigator.maybePop();
      return true;
    }
    // Mid-pull: put the player back where it came from instead of navigating.
    if (_pullActive || (_pull.value > 0 && widget.location != '/player')) {
      _pullActive = false;
      _lastPullDelta = 0;
      _animatePullTo(0);
      _animateToolbarTo(1);
      return true;
    }
    if (isSongsLibraryLocation(widget.location)) {
      final songsToolbar = ref.read(songsToolbarStateProvider);
      if (songsToolbar.batchMode && songsToolbar.onToggleBatch != null) {
        songsToolbar.onToggleBatch!();
        return true;
      }
    }
    if (isPlaylistDetailLocation(widget.location)) {
      final playlistToolbar = ref.read(playlistDetailToolbarStateProvider);
      if (playlistToolbar.searchMode &&
          playlistToolbar.onToggleSearch != null) {
        playlistToolbar.onToggleSearch!();
        return true;
      }
      if (playlistToolbar.batchMode && playlistToolbar.onToggleBatch != null) {
        playlistToolbar.onToggleBatch!();
        return true;
      }
    }

    _releaseRouteFocus();
    if (_isTopLevelMenuLocation(widget.location)) {
      await _handleTopLevelBack();
    } else if (widget.location == '/downloads' ||
        widget.location == '/songs/search') {
      context.go('/songs');
    } else if (widget.location == '/settings/sources') {
      context.go('/settings');
    } else if (context.canPop()) {
      context.pop();
    } else if (widget.location == '/player') {
      unawaited(_dismissPlayer());
    } else if (isDiscoveryLocation(widget.location) && widget.location != '/') {
      context.go('/');
    } else if (isPlaylistLocation(widget.location)) {
      context.go(widget.playlistBackLocation);
    } else {
      unawaited(_moveAppTaskToBack());
    }
    return true;
  }

  Future<void> _handleTopLevelBack() async {
    if (_returnToDesktopTimer?.isActive ?? false) {
      _resetTopLevelBack();
      await _moveAppTaskToBack();
      return;
    }

    _resetTopLevelBack();
    _returnToDesktopToast = showAppToast(
      context,
      '再次点击返回键切换到桌面',
      duration: _doubleBackExitWindow,
    );
    _returnToDesktopTimer = Timer(_doubleBackExitWindow, () {
      _returnToDesktopTimer = null;
      _returnToDesktopToast = null;
    });
  }

  void _resetTopLevelBack() {
    _returnToDesktopTimer?.cancel();
    _returnToDesktopTimer = null;
    dismissAppToast(_returnToDesktopToast, showRemoveAnimation: false);
    _returnToDesktopToast = null;
  }

  void _releaseRouteFocus() {
    FocusManager.instance.primaryFocus?.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      FocusManager.instance.primaryFocus?.unfocus();
    });
  }

  bool _handleToolbarScrollNotification(ScrollNotification notification) {
    // While a player pull owns the toolbar reveal, scrolling must not fight it.
    if (_pullActive) return false;
    final songsBatchMode =
        isSongsLibraryLocation(widget.location) &&
        ref.read(songsToolbarStateProvider).batchMode;
    final playlistBatchMode =
        isPlaylistDetailLocation(widget.location) &&
        ref.read(playlistDetailToolbarStateProvider).batchMode;
    if (!ref.read(shellToolbarVisibleProvider) ||
        songsBatchMode ||
        playlistBatchMode) {
      _toolbarScrollSequenceActive = false;
      _lastToolbarScrollDelta = 0;
      _toolbarRevealController.stop(canceled: false);
      return false;
    }
    if (widget.location == '/player' ||
        notification.depth != 0 ||
        notification.metrics.axis != Axis.vertical) {
      return false;
    }

    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      _toolbarScrollSequenceActive = true;
      _lastToolbarScrollDelta = 0;
      _toolbarRevealController.stop(canceled: false);
      return false;
    }

    if (notification is ScrollUpdateNotification &&
        notification.dragDetails != null) {
      _toolbarScrollSequenceActive = true;
      _applyToolbarScrollDelta(notification.scrollDelta ?? 0);
      return false;
    }

    if (notification is OverscrollNotification &&
        notification.dragDetails != null) {
      _toolbarScrollSequenceActive = true;
      _applyToolbarScrollDelta(notification.overscroll);
      return false;
    }

    if (notification is ScrollEndNotification) {
      _finishToolbarScrollSequence();
    }
    return false;
  }

  void _finishToolbarScrollSequence() {
    if (!_toolbarScrollSequenceActive) return;
    _toolbarScrollSequenceActive = false;
    _settleToolbarAfterScroll();
  }

  void _applyToolbarScrollDelta(double delta) {
    if (delta.abs() < toolbarScrollDeltaEpsilon) return;
    _lastToolbarScrollDelta = delta;
    _toolbarRevealController.stop(canceled: false);
    _toolbarRevealController.value =
        (_toolbarRevealController.value - delta / _toolbarTravelExtent)
            .clamp(0.0, 1.0)
            .toDouble();
  }

  void _settleToolbarAfterScroll() {
    final reveal = _toolbarRevealController.value;
    final target = switch (_lastToolbarScrollDelta) {
      > toolbarScrollDeltaEpsilon =>
        reveal <= toolbarHideDirectionThreshold ? 0.0 : 1.0,
      < -toolbarScrollDeltaEpsilon =>
        reveal >= toolbarShowDirectionThreshold ? 1.0 : 0.0,
      _ => reveal >= 0.5 ? 1.0 : 0.0,
    };
    _lastToolbarScrollDelta = 0;
    _animateToolbarTo(target);
  }

  void _animateToolbarTo(double target) {
    if (_pullActive) return;
    if ((_toolbarRevealController.value - target).abs() < 0.001) {
      _toolbarRevealController.value = target;
      return;
    }
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      _toolbarRevealController.value = target;
      return;
    }
    final remaining = (_toolbarRevealController.value - target).abs();
    _toolbarRevealController.animateTo(
      target,
      duration: Duration(milliseconds: (140 + 180 * remaining).round()),
      curve: AppMotion.emphasized,
    );
  }

  @override
  Widget build(BuildContext context) {
    final baseScheme = Theme.of(context).colorScheme;
    final scheme = shellSchemeFor(widget.location, baseScheme);
    final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
    final isPlayer = widget.location == '/player';
    final isImmersivePlaylist = isImmersivePlaylistDetailLocation(
      widget.location,
    );
    final toolbarTravelExtent = _bottomToolbarTravelExtent(context);
    _toolbarTravelExtent = toolbarTravelExtent;

    ref.listen<bool>(shellToolbarVisibleProvider, (previous, next) {
      if (next && previous == false) _animateToolbarTo(1);
    });
    ref.listen<SongsToolbarState>(songsToolbarStateProvider, (previous, next) {
      if (!isSongsLibraryLocation(widget.location)) return;
      if (next.batchMode) {
        _toolbarScrollSequenceActive = false;
        _lastToolbarScrollDelta = 0;
        _toolbarRevealController.stop(canceled: false);
      } else if (previous?.batchMode == true) {
        _animateToolbarTo(1);
      }
    });
    ref.listen<PlaylistDetailToolbarState>(playlistDetailToolbarStateProvider, (
      previous,
      next,
    ) {
      if (!isPlaylistDetailLocation(widget.location)) return;
      if (next.batchMode) {
        _toolbarScrollSequenceActive = false;
        _lastToolbarScrollDelta = 0;
        _toolbarRevealController.stop(canceled: false);
      } else if (previous?.batchMode == true) {
        _animateToolbarTo(1);
      }
    });

    return BackButtonListener(
      onBackButtonPressed: _handleBackButton,
      child: PlayerPullScope(
        gestures: _pullGestures,
        child: Scaffold(
          extendBody: true,
          resizeToAvoidBottomInset: true,
          backgroundColor: scheme.appSurface,
          body: Stack(
            // Every child carries an explicit key so element matching never
            // falls back to list position. The player layer slot below appears
            // and disappears, and without keys that index shift would rebuild
            // the toolbar subtree — killing any in-flight drag recognizer.
            children: [
              Positioned.fill(
                key: const ValueKey('shell-content'),
                child: ColoredBox(
                  color: scheme.appSurface,
                  child: Padding(
                    // The immersive player page fills the whole screen and
                    // handles its own bottom safe area internally.
                    padding: EdgeInsets.only(
                      bottom: isPlayer ? 0 : math.max(bottomInset, 12),
                    ),
                    child: Column(
                      children: [
                        if (isPlayer || isImmersivePlaylist)
                          const SizedBox.shrink()
                        else
                          AnimatedSize(
                            duration: AppMotion.short,
                            curve: AppMotion.emphasized,
                            alignment: Alignment.topCenter,
                            child: ShellHeader(
                              location: widget.location,
                              playlistBackLocation: widget.playlistBackLocation,
                            ),
                          ),
                        Expanded(
                          child: RepaintBoundary(
                            child: ClipRect(
                              child: AnimatedSwitcher(
                                duration:
                                    isPlayer ||
                                        _routeMotion ==
                                            _ShellRouteMotion.playerExit
                                    ? AppMotion.medium
                                    : AppMotion.long,
                                switchInCurve: AppMotion.emphasizedDecelerate,
                                switchOutCurve: AppMotion.emphasizedAccelerate,
                                // A pushed GoRouter route can reuse GlobalKeys
                                // from the shell child below it. Keeping both
                                // route trees mounted during the transition
                                // would therefore trigger duplicate-key errors.
                                layoutBuilder: (currentChild, _) =>
                                    currentChild ?? const SizedBox.shrink(),
                                transitionBuilder: _buildRouteTransition,
                                child: KeyedSubtree(
                                  key: ValueKey(
                                    _shellContentAnimationKey(widget.location),
                                  ),
                                  child: Listener(
                                    behavior: HitTestBehavior.translucent,
                                    onPointerUp: (_) =>
                                        _finishToolbarScrollSequence(),
                                    onPointerCancel: (_) =>
                                        _finishToolbarScrollSequence(),
                                    child: NotificationListener<ScrollNotification>(
                                      onNotification:
                                          _handleToolbarScrollNotification,
                                      child: HorizontalPageSwipe(
                                        key: ValueKey(
                                          'shell-page-swipe-${widget.location}',
                                        ),
                                        // 发现页由自己的 PageView 跟手翻页。
                                        trackDrag: widget.location != '/',
                                        onDragStart: _handlePageSwipeStart,
                                        onSwipeLeft: switch (widget.location) {
                                          '/' ||
                                          '/settings' => _handlePageSwipeLeft,
                                          _ => null,
                                        },
                                        onSwipeRight: switch (widget.location) {
                                          '/' || '/songs' || '/songs/search' =>
                                            _handlePageSwipeRight,
                                          _ => null,
                                        },
                                        child: widget.child,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              _buildPlayerLayer(isPlayer),
              Positioned(
                key: const ValueKey('shell-toolbar'),
                left: 0,
                right: 0,
                bottom: 0,
                child: BottomToolbar(
                  location: widget.location,
                  routeLocation: widget.routeLocation,
                  reveal: _toolbarRevealController,
                  travelExtent: toolbarTravelExtent,
                ),
              ),
              if (widget.location == '/')
                Positioned.fill(
                  key: ValueKey('shell-fab'),
                  child: const Stack(
                    children: [
                      DiscoveryCategoryFabLayer(),
                      SearchPagingFabLayer(),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// The player layer sits above the route content but below the floating
  /// toolbar, so the capsule keeps hovering over an empty player exactly as it
  /// did when the player was a route child.
  ///
  /// Every wrapper here is unconditional and only flips parameters: inserting
  /// or removing one would re-slot the subtree and restart the backdrop's blur
  /// render, which reads as a flash of flat colour.
  Widget _buildPlayerLayer(bool isPlayer) {
    if (!_playerLayerMounted) {
      // Zero-sized but still positioned: a non-positioned child would make the
      // Stack size itself to this placeholder instead of the incoming
      // constraints, collapsing every Positioned.fill sibling.
      return const Positioned(
        key: ValueKey('shell-player'),
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        child: SizedBox.shrink(),
      );
    }
    return Positioned(
      key: const ValueKey('shell-player'),
      left: 0,
      right: 0,
      top: 0,
      // Pinned to the full screen height and translated during the pull. A
      // height that tracked the drag — or shrank for the keyboard — would
      // re-run the backdrop's blur pipeline on every frame.
      height: MediaQuery.sizeOf(context).height,
      child: MediaQuery.removeViewInsets(
        context: context,
        removeBottom: true,
        child: AnimatedBuilder(
          animation: _pull,
          // Passed as `child` so the player's element subtree is untouched by
          // these rebuilds; the page's own SlideTransition listens to _pull
          // and only repaints.
          child: PlayerPage(
            returnLocation: _playerReturnLocation,
            progress: _pull,
            active: isPlayer,
            onDismissRequested: _dismissPlayer,
          ),
          builder: (context, child) {
            final progress = _pull.value;
            final visible = progress > 0 || isPlayer;
            return AbsorbPointer(
              // Mid-pull the page is visible but not the route: swallow taps
              // instead of letting them reach the page underneath.
              absorbing: progress > 0 && !isPlayer,
              child: ExcludeSemantics(
                excluding: !visible,
                child: TickerMode(
                  enabled: visible,
                  child: Opacity(opacity: visible ? 1 : 0, child: child!),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildRouteTransition(Widget child, Animation<double> animation) {
    final incoming =
        child.key == ValueKey(_shellContentAnimationKey(widget.location));
    // Entering the player slides the whole page up from the bottom edge —
    // the mirror of the player's own downward exit animation. A fade here
    // would read as a flicker, so the page slides in fully opaque.
    if (_routeMotion == _ShellRouteMotion.playerEnter && incoming) {
      return SlideTransition(
        position: Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
            .animate(
              CurvedAnimation(
                parent: animation,
                curve: AppMotion.emphasizedDecelerate,
              ),
            ),
        child: child,
      );
    }
    final offset =
        Tween<Offset>(begin: _routeOffset(incoming), end: Offset.zero).animate(
          CurvedAnimation(
            parent: animation,
            curve: incoming
                ? AppMotion.emphasizedDecelerate
                : AppMotion.emphasizedAccelerate,
          ),
        );
    final animateScale =
        _routeMotion != _ShellRouteMotion.playerEnter &&
        _routeMotion != _ShellRouteMotion.playerExit;
    final scale = Tween<double>(
      begin: incoming && animateScale ? 0.992 : 1,
      end: 1,
    ).animate(CurvedAnimation(parent: animation, curve: AppMotion.emphasized));

    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: offset,
        child: ScaleTransition(scale: scale, child: child),
      ),
    );
  }

  Offset _routeOffset(bool incoming) {
    return switch (_routeMotion) {
      _ShellRouteMotion.playerEnter =>
        incoming ? const Offset(0, 0.055) : const Offset(0, -0.025),
      _ShellRouteMotion.playerExit =>
        incoming ? const Offset(0, -0.035) : const Offset(0, 0.08),
      _ShellRouteMotion.forward =>
        incoming ? const Offset(0.045, 0) : const Offset(-0.032, 0),
      _ShellRouteMotion.backward =>
        incoming ? const Offset(-0.045, 0) : const Offset(0.032, 0),
    };
  }
}

enum _ShellRouteMotion { forward, backward, playerEnter, playerExit }

const _doubleBackExitWindow = Duration(seconds: 2);

bool _isTopLevelMenuLocation(String location) {
  return location == '/' ||
      location == '/songs' ||
      location == '/settings';
}

_ShellRouteMotion _motionFor(String from, String to) {
  if (to == '/player') return _ShellRouteMotion.playerEnter;
  if (from == '/player') return _ShellRouteMotion.playerExit;
  return _routeOrder(to) >= _routeOrder(from)
      ? _ShellRouteMotion.forward
      : _ShellRouteMotion.backward;
}

int _routeOrder(String location) {
  if (isPlaylistLocation(location)) return 2;
  if (location.startsWith('/settings')) return 4;
  return switch (location) {
    '/' => 0,
    '/songs' => 1,
    '/songs/search' => 2,
    '/downloads' => 2,
    '/player' => 3,
    _ => 0,
  };
}

String _shellContentAnimationKey(String location) {
  return isDiscoveryLocation(location) ? '/' : location;
}

const _appTaskChannel = MethodChannel('twilight_echo/app_task');

Future<void> _moveAppTaskToBack() async {
  try {
    await _appTaskChannel.invokeMethod<bool>('moveToBack');
  } catch (_) {
    // If the native channel is unavailable, still consume back so Android does
    // not destroy the Flutter route stack.
  }
}

double _bottomToolbarTravelExtent(BuildContext context) {
  final viewport = MediaQuery.sizeOf(context);
  final scaledLabelHeight = MediaQuery.textScalerOf(
    context,
  ).scale(toolbarLabelFontSizeFor(viewport));
  final actionHeight = math.max(
    toolbarMinActionHeightFor(viewport),
    toolbarActionVerticalChromeFor(viewport) + scaledLabelHeight,
  );
  final toolbarHeight = actionHeight + 8;
  final safeBottom = math.max(
    MediaQuery.paddingOf(context).bottom,
    toolbarMinimumBottomInset,
  );
  return toolbarHeight + safeBottom;
}
