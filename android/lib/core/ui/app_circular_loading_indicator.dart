import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:material_new_shapes/material_new_shapes.dart';

/// The app-wide Material 3 Expressive indeterminate loading indicator.
class AppCircularLoadingIndicator extends StatefulWidget {
  const AppCircularLoadingIndicator({
    super.key,
    this.dimension = 42,
    this.color,
  });

  final double dimension;
  final Color? color;

  @override
  State<AppCircularLoadingIndicator> createState() =>
      _AppCircularLoadingIndicatorState();
}

class _AppCircularLoadingIndicatorState
    extends State<AppCircularLoadingIndicator>
    with TickerProviderStateMixin {
  static const _morphDuration = Duration(milliseconds: 650);
  static const _rotationDuration = Duration(milliseconds: 4666);

  late final AnimationController _morphController;
  late final AnimationController _rotationController;
  final Path _path = Path();

  int _morphIndex = 0;
  double _morphRotation = 90;

  @override
  void initState() {
    super.initState();
    _morphController =
        AnimationController(vsync: this, duration: _morphDuration)
          ..addStatusListener(_handleMorphStatus)
          ..forward();
    _rotationController = AnimationController(
      vsync: this,
      duration: _rotationDuration,
    )..repeat();
  }

  void _handleMorphStatus(AnimationStatus status) {
    if (status != AnimationStatus.completed || !mounted) return;
    _morphIndex = (_morphIndex + 1) % _LoadingGeometry.morphs.length;
    _morphRotation = (_morphRotation + 90) % 360;
    _morphController.forward(from: 0);
  }

  @override
  void dispose() {
    _morphController.dispose();
    _rotationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animationsDisabled = MediaQuery.disableAnimationsOf(context);
    final color = widget.color ?? Theme.of(context).colorScheme.primary;

    return TickerMode(
      enabled: !animationsDisabled,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: widget.dimension,
          child: RepaintBoundary(
            child: AnimatedBuilder(
              animation: Listenable.merge([
                _morphController,
                _rotationController,
              ]),
              builder: (context, child) {
                final morphProgress = _LoadingGeometry.spring.transform(
                  _morphController.value,
                );
                return CustomPaint(
                  painter: _ExpressiveLoadingPainter(
                    morphIndex: _morphIndex,
                    morphProgress: morphProgress,
                    rotationDegrees:
                        _morphRotation +
                        morphProgress * 90 +
                        _rotationController.value * 360,
                    color: color,
                    path: _path,
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

abstract final class _LoadingGeometry {
  static final spring = _LoadingSpringCurve(
    period: _AppCircularLoadingIndicatorState._morphDuration,
  );

  static final _polygons = <RoundedPolygon>[
    MaterialShapes.softBurst,
    MaterialShapes.cookie9Sided,
    MaterialShapes.pentagon,
    MaterialShapes.pill,
    MaterialShapes.sunny,
    MaterialShapes.cookie4Sided,
    MaterialShapes.oval,
  ];

  static final morphs = <Morph>[
    for (var index = 0; index < _polygons.length; index++)
      Morph(
        _polygons[index].normalized(),
        _polygons[(index + 1) % _polygons.length].normalized(),
      ),
  ];

  // Reserve enough room for both rotation and the spring's small overshoot.
  static final scaleFactor = 0.96 / (_maximumSpan * spring.peakValue);

  static double get _maximumSpan {
    var maximum = 1.0;
    for (final morph in morphs) {
      final bounds = morph.calculateMaxBounds();
      maximum = math.max(maximum, bounds[2] - bounds[0]);
      maximum = math.max(maximum, bounds[3] - bounds[1]);
    }
    return maximum;
  }
}

/// The underdamped spring used by Material 3's indeterminate loader.
class _LoadingSpringCurve extends Curve {
  _LoadingSpringCurve({required this.period}) {
    const dampingRatio = 0.6;
    const stiffness = 200.0;
    const visibilityThreshold = 0.1;
    final remaining = math.sqrt(1 - dampingRatio * dampingRatio);

    _omega = math.sqrt(stiffness);
    _dampedOmega = _omega * remaining;
    _sineCoefficient = dampingRatio / remaining;
    _settleSeconds =
        math.log(1 / (remaining * visibilityThreshold)) /
        (dampingRatio * _omega);
    peakValue = 1 + math.exp(-dampingRatio * math.pi / remaining);
  }

  final Duration period;
  late final double peakValue;
  late final double _omega;
  late final double _dampedOmega;
  late final double _sineCoefficient;
  late final double _settleSeconds;

  @override
  double transformInternal(double t) {
    final seconds = t * period.inMicroseconds / Duration.microsecondsPerSecond;
    if (seconds >= _settleSeconds) return 1;

    const dampingRatio = 0.6;
    final envelope = math.exp(-dampingRatio * _omega * seconds);
    return 1 -
        envelope *
            (math.cos(_dampedOmega * seconds) +
                _sineCoefficient * math.sin(_dampedOmega * seconds));
  }
}

class _ExpressiveLoadingPainter extends CustomPainter {
  const _ExpressiveLoadingPainter({
    required this.morphIndex,
    required this.morphProgress,
    required this.rotationDegrees,
    required this.color,
    required this.path,
  });

  final int morphIndex;
  final double morphProgress;
  final double rotationDegrees;
  final Color color;
  final Path path;

  static final Paint _paint = Paint()..isAntiAlias = true;

  @override
  void paint(Canvas canvas, Size size) {
    _LoadingGeometry.morphs[morphIndex].toPath(
      progress: morphProgress,
      path: path,
    );

    final center = size.center(Offset.zero);
    final pathCenter = path.getBounds().center;
    final scale = size.shortestSide * _LoadingGeometry.scaleFactor;
    _paint.color = color;

    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(rotationDegrees * math.pi / 180);
    canvas.translate(-pathCenter.dx * scale, -pathCenter.dy * scale);
    canvas.scale(scale);
    canvas.drawPath(path, _paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _ExpressiveLoadingPainter oldDelegate) {
    return oldDelegate.morphIndex != morphIndex ||
        oldDelegate.morphProgress != morphProgress ||
        oldDelegate.rotationDegrees != rotationDegrees ||
        oldDelegate.color != color;
  }
}
