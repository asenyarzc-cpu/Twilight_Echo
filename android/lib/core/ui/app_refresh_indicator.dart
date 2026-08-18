import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_circular_loading_indicator.dart';

const _dragExtentPercentage = 0.25;
const _dragSizeLimit = 1.5;
const _snapDuration = Duration(milliseconds: 150);
const _exitDuration = Duration(milliseconds: 200);
const _badgeSize = 44.0;
const _badgeShadowMargin = 6.0;

/// Pull-to-refresh behavior with the app's expressive loading animation.
class AppRefreshIndicator extends StatefulWidget {
  const AppRefreshIndicator({
    super.key,
    required this.onRefresh,
    required this.child,
    this.notificationPredicate = defaultScrollNotificationPredicate,
    this.displacement = 40,
    this.edgeOffset = 0,
  });

  final RefreshCallback onRefresh;
  final Widget child;
  final ScrollNotificationPredicate notificationPredicate;
  final double displacement;
  final double edgeOffset;

  @override
  State<AppRefreshIndicator> createState() => _AppRefreshIndicatorState();
}

// The gesture state machine follows Flutter's RefreshIndicator behavior. The
// SDK spinner layer is replaced with the expressive badge below.
class _AppRefreshIndicatorState extends State<AppRefreshIndicator>
    with TickerProviderStateMixin {
  late final AnimationController _positionController;
  late final AnimationController _exitController;
  late final Animation<double> _positionFactor;
  late final Animation<double> _opacity;
  late final Animation<double> _exitScale;

  RefreshIndicatorStatus? _status;
  bool? _indicatorAtTop;
  double? _dragOffset;

  @override
  void initState() {
    super.initState();
    _positionController = AnimationController(vsync: this);
    _positionFactor = _positionController.drive(
      Tween<double>(begin: 0, end: _dragSizeLimit),
    );
    _opacity = _positionController.drive(
      CurveTween(curve: const Interval(0, 1 / _dragSizeLimit)),
    );
    _exitController = AnimationController(vsync: this);
    _exitScale = _exitController.drive(Tween<double>(begin: 1, end: 0));
  }

  @override
  void dispose() {
    _positionController.dispose();
    _exitController.dispose();
    super.dispose();
  }

  bool _shouldStart(ScrollNotification notification) {
    return notification is ScrollStartNotification &&
        notification.dragDetails != null &&
        ((notification.metrics.axisDirection == AxisDirection.up &&
                notification.metrics.extentAfter == 0) ||
            (notification.metrics.axisDirection == AxisDirection.down &&
                notification.metrics.extentBefore == 0)) &&
        _status == null &&
        _start(notification.metrics.axisDirection);
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (!widget.notificationPredicate(notification)) return false;

    if (_shouldStart(notification)) {
      setState(() => _status = RefreshIndicatorStatus.drag);
      return false;
    }

    final atTop = switch (notification.metrics.axisDirection) {
      AxisDirection.down || AxisDirection.up => true,
      AxisDirection.left || AxisDirection.right => null,
    };
    if (atTop != _indicatorAtTop) {
      if (_status == RefreshIndicatorStatus.drag ||
          _status == RefreshIndicatorStatus.armed) {
        unawaited(_dismiss(RefreshIndicatorStatus.canceled));
      }
      return false;
    }

    if (notification is ScrollUpdateNotification) {
      if (_isDragging) {
        _dragOffset = notification.metrics.axisDirection == AxisDirection.down
            ? _dragOffset! - notification.scrollDelta!
            : _dragOffset! + notification.scrollDelta!;
        _updateDragProgress(notification.metrics.viewportDimension);
      }
      if (_status == RefreshIndicatorStatus.armed &&
          notification.dragDetails == null) {
        _show();
      }
    } else if (notification is OverscrollNotification && _isDragging) {
      _dragOffset = notification.metrics.axisDirection == AxisDirection.down
          ? _dragOffset! - notification.overscroll
          : _dragOffset! + notification.overscroll;
      _updateDragProgress(notification.metrics.viewportDimension);
    } else if (notification is ScrollEndNotification) {
      if (_status == RefreshIndicatorStatus.armed) {
        if (_positionController.value < 1) {
          unawaited(_dismiss(RefreshIndicatorStatus.canceled));
        } else {
          _show();
        }
      } else if (_status == RefreshIndicatorStatus.drag) {
        unawaited(_dismiss(RefreshIndicatorStatus.canceled));
      }
    }
    return false;
  }

  bool get _isDragging =>
      _status == RefreshIndicatorStatus.drag ||
      _status == RefreshIndicatorStatus.armed;

  bool _handleOverscrollIndicator(
    OverscrollIndicatorNotification notification,
  ) {
    if (notification.depth == 0 &&
        notification.leading &&
        _status == RefreshIndicatorStatus.drag) {
      notification.disallowIndicator();
      return true;
    }
    return false;
  }

  bool _start(AxisDirection direction) {
    if (direction == AxisDirection.left || direction == AxisDirection.right) {
      return false;
    }
    _indicatorAtTop = true;
    _dragOffset = 0;
    _exitController.value = 0;
    _positionController.value = 0;
    return true;
  }

  void _updateDragProgress(double viewportExtent) {
    var value = _dragOffset! / (viewportExtent * _dragExtentPercentage);
    if (_status == RefreshIndicatorStatus.armed) {
      value = value.clamp(1 / _dragSizeLimit, double.infinity);
    }
    _positionController.value = value.clamp(0, 1);

    if (_status == RefreshIndicatorStatus.drag &&
        _positionController.value >= 1 / _dragSizeLimit) {
      setState(() => _status = RefreshIndicatorStatus.armed);
      unawaited(HapticFeedback.lightImpact());
    }
  }

  Future<void> _dismiss(RefreshIndicatorStatus status) async {
    await Future<void>.value();
    if (!mounted) return;
    setState(() => _status = status);

    if (status == RefreshIndicatorStatus.done) {
      await _exitController.animateTo(1, duration: _exitDuration);
    } else {
      await _positionController.animateTo(0, duration: _exitDuration);
    }

    if (!mounted || _status != status) return;
    _dragOffset = null;
    _indicatorAtTop = null;
    setState(() => _status = null);
  }

  void _show() {
    if (_status == RefreshIndicatorStatus.refresh ||
        _status == RefreshIndicatorStatus.snap) {
      return;
    }

    setState(() => _status = RefreshIndicatorStatus.snap);
    _positionController
        .animateTo(1 / _dragSizeLimit, duration: _snapDuration)
        .then<void>((_) {
          if (!mounted || _status != RefreshIndicatorStatus.snap) return;
          setState(() => _status = RefreshIndicatorStatus.refresh);
          unawaited(_runRefresh());
        });
  }

  Future<void> _runRefresh() async {
    Object? refreshError;
    StackTrace? refreshStackTrace;
    try {
      await widget.onRefresh();
    } catch (error, stackTrace) {
      refreshError = error;
      refreshStackTrace = stackTrace;
    } finally {
      if (mounted && _status == RefreshIndicatorStatus.refresh) {
        await _dismiss(RefreshIndicatorStatus.done);
      }
    }
    if (refreshError != null) {
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: refreshError,
          stack: refreshStackTrace,
          library: 'Twilight Echo refresh indicator',
          context: ErrorDescription('while refreshing scrollable content'),
        ),
      );
    }
  }

  String get _semanticsLabel => switch (_status) {
    RefreshIndicatorStatus.armed => '松开刷新',
    RefreshIndicatorStatus.snap ||
    RefreshIndicatorStatus.refresh ||
    RefreshIndicatorStatus.done => '正在刷新',
    _ => '下拉刷新',
  };

  @override
  Widget build(BuildContext context) {
    final child = NotificationListener<ScrollNotification>(
      onNotification: _handleScrollNotification,
      child: NotificationListener<OverscrollIndicatorNotification>(
        onNotification: _handleOverscrollIndicator,
        child: widget.child,
      ),
    );

    return Stack(
      fit: StackFit.passthrough,
      children: [
        child,
        if (_status != null)
          Positioned(
            top: _indicatorAtTop! ? widget.edgeOffset : null,
            bottom: !_indicatorAtTop! ? widget.edgeOffset : null,
            left: 0,
            right: 0,
            child: _RefreshIndicatorSizeTransition(
              alignment: _indicatorAtTop!
                  ? AlignmentDirectional.bottomStart
                  : AlignmentDirectional.topStart,
              sizeFactor: _positionFactor,
              child: Padding(
                padding: _indicatorAtTop!
                    ? EdgeInsets.only(
                        top: (widget.displacement - _badgeShadowMargin).clamp(
                          0,
                          double.infinity,
                        ),
                      )
                    : EdgeInsets.only(
                        bottom: (widget.displacement - _badgeShadowMargin)
                            .clamp(0, double.infinity),
                      ),
                child: Align(
                  alignment: _indicatorAtTop!
                      ? Alignment.topCenter
                      : Alignment.bottomCenter,
                  child: ScaleTransition(
                    scale: _exitScale,
                    child: FadeTransition(
                      opacity: _opacity,
                      child: Semantics(
                        key: const ValueKey('app-refresh-indicator-visible'),
                        liveRegion: true,
                        label: _semanticsLabel,
                        child: const _ExpressiveRefreshBadge(),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _RefreshIndicatorSizeTransition extends AnimatedWidget {
  const _RefreshIndicatorSizeTransition({
    required Animation<double> sizeFactor,
    required this.alignment,
    required this.child,
  }) : super(listenable: sizeFactor);

  Animation<double> get sizeFactor => listenable as Animation<double>;

  final AlignmentGeometry alignment;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: Align(
        key: const ValueKey('app-refresh-indicator-reveal'),
        alignment: alignment,
        heightFactor: sizeFactor.value < 0.0 ? 0.0 : sizeFactor.value,
        child: child,
      ),
    );
  }
}

class _ExpressiveRefreshBadge extends StatelessWidget {
  const _ExpressiveRefreshBadge();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(_badgeShadowMargin),
      child: Material(
        elevation: 3,
        shape: const CircleBorder(),
        color: scheme.surfaceContainerHigh,
        shadowColor: scheme.shadow.withValues(alpha: 0.6),
        child: const SizedBox.square(
          dimension: _badgeSize,
          child: Center(child: AppCircularLoadingIndicator(dimension: 26)),
        ),
      ),
    );
  }
}
