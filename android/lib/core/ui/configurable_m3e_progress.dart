import 'dart:math' as math;

import 'package:flutter/material.dart';

class ConfigurableCircularProgressIndicatorM3E extends StatefulWidget {
  const ConfigurableCircularProgressIndicatorM3E({
    super.key,
    this.value,
    required this.size,
    required this.trackThickness,
    required this.activeColor,
    required this.trackColor,
    this.waveAmplitude,
    this.rotation = 0,
  });

  final double? value;
  final double size;
  final double trackThickness;
  final Color activeColor;
  final Color trackColor;
  final double? waveAmplitude;
  final double rotation;

  @override
  State<ConfigurableCircularProgressIndicatorM3E> createState() =>
      _ConfigurableCircularProgressIndicatorM3EState();
}

class _ConfigurableCircularProgressIndicatorM3EState
    extends State<ConfigurableCircularProgressIndicatorM3E>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  bool get _shouldAnimate {
    final value = widget.value;
    return (value == null || value >= 1) && widget.rotation == 0;
  }

  @override
  void initState() {
    super.initState();
    _controller =
        AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 3600),
        )..addListener(() {
          if (mounted && _shouldAnimate) setState(() {});
        });
    if (_shouldAnimate) _controller.repeat();
  }

  @override
  void didUpdateWidget(
    covariant ConfigurableCircularProgressIndicatorM3E oldWidget,
  ) {
    super.didUpdateWidget(oldWidget);
    if (_shouldAnimate) {
      if (!_controller.isAnimating) _controller.repeat();
    } else if (_controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rotation = widget.rotation != 0
        ? widget.rotation
        : (_shouldAnimate ? _controller.value * 2 * math.pi : 0.0);
    return RepaintBoundary(
      child: SizedBox.square(
        dimension: widget.size,
        child: CustomPaint(
          painter: _ConfigurableCircularM3EPainter(
            value: widget.value,
            activeColor: widget.activeColor,
            trackColor: widget.trackColor,
            rotation: rotation,
            trackThickness: widget.trackThickness,
            waveAmplitude: widget.waveAmplitude ?? widget.trackThickness * 0.5,
          ),
        ),
      ),
    );
  }
}

class _ConfigurableCircularM3EPainter extends CustomPainter {
  const _ConfigurableCircularM3EPainter({
    required this.value,
    required this.activeColor,
    required this.trackColor,
    required this.rotation,
    required this.trackThickness,
    required this.waveAmplitude,
  });

  final double? value;
  final Color activeColor;
  final Color trackColor;
  final double rotation;
  final double trackThickness;
  final double waveAmplitude;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final baseRadius =
        (math.min(size.width, size.height) -
            trackThickness -
            waveAmplitude * 2) /
        2;
    final activeSweep = value == null
        ? math.pi * 2
        : value!.clamp(0.0, 1.0) * math.pi * 2;
    final start = -math.pi / 2 + rotation;
    final end = start + activeSweep;

    final waveOnly = value == null || value! >= 1;
    if (!waveOnly) {
      final trackPaint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = trackThickness
        ..strokeCap = StrokeCap.round
        ..isAntiAlias = true
        ..color = trackColor;
      final gapAngle = math.max(1.6, trackThickness) / baseRadius;
      final rect = Rect.fromCircle(center: center, radius: baseRadius);
      const total = math.pi * 2;
      final trackStart = end + gapAngle;
      final trackEnd = start - gapAngle;
      var trackSweep = trackEnd - trackStart;
      while (trackSweep <= 0) {
        trackSweep += total;
      }
      canvas.drawArc(rect, trackStart, trackSweep, false, trackPaint);
    }

    final steps = math.max(48, (size.width * 1.4).round());
    final path = Path();
    final wavePeriod = math.max(12.0, size.width * 0.36);
    final taperLength = wavePeriod / 2;
    for (var i = 0; i <= steps; i++) {
      final t = i / steps;
      final angle = start + (end - start) * t;
      final arcLength = baseRadius * (angle - start);
      final arcToEnd = baseRadius * (end - angle);
      var taper = 1.0;
      if (arcToEnd < taperLength) {
        final endT = (arcToEnd / taperLength).clamp(0.0, 1.0);
        taper = math.sin(endT * math.pi / 2);
      }
      final radius =
          baseRadius +
          waveAmplitude *
              taper *
              math.sin(arcLength / wavePeriod * 2 * math.pi);
      final point = Offset(
        center.dx + radius * math.cos(angle),
        center.dy + radius * math.sin(angle),
      );
      if (i == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }

    final activePaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = trackThickness
      ..strokeCap = StrokeCap.round
      ..isAntiAlias = true
      ..color = activeColor;
    canvas.drawPath(path, activePaint);
  }

  @override
  bool shouldRepaint(covariant _ConfigurableCircularM3EPainter oldDelegate) {
    return value != oldDelegate.value ||
        activeColor != oldDelegate.activeColor ||
        trackColor != oldDelegate.trackColor ||
        rotation != oldDelegate.rotation ||
        trackThickness != oldDelegate.trackThickness ||
        waveAmplitude != oldDelegate.waveAmplitude;
  }
}

class ConfigurableLinearProgressIndicatorM3E extends StatefulWidget {
  const ConfigurableLinearProgressIndicatorM3E({
    super.key,
    this.value,
    required this.trackThickness,
    required this.activeColor,
    required this.trackColor,
    this.waveAmplitude,
    this.wavePeriod = 40,
    this.inset = 0,
    this.trailingMargin = 10,
    this.phase = 0,
  });

  final double? value;
  final double trackThickness;
  final Color activeColor;
  final Color trackColor;
  final double? waveAmplitude;
  final double wavePeriod;
  final double inset;
  final double trailingMargin;
  final double phase;

  @override
  State<ConfigurableLinearProgressIndicatorM3E> createState() =>
      _ConfigurableLinearProgressIndicatorM3EState();
}

class _ConfigurableLinearProgressIndicatorM3EState
    extends State<ConfigurableLinearProgressIndicatorM3E>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  bool get _shouldAnimate {
    final value = widget.value;
    return (value == null || value >= 1) && widget.phase == 0;
  }

  @override
  void initState() {
    super.initState();
    _controller =
        AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 1200),
        )..addListener(() {
          if (mounted && _shouldAnimate) setState(() {});
        });
    if (_shouldAnimate) _controller.repeat();
  }

  @override
  void didUpdateWidget(
    covariant ConfigurableLinearProgressIndicatorM3E oldWidget,
  ) {
    super.didUpdateWidget(oldWidget);
    if (_shouldAnimate) {
      if (!_controller.isAnimating) _controller.repeat();
    } else if (_controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final amplitude = widget.waveAmplitude ?? widget.trackThickness * 0.5;
    final phase = widget.phase != 0
        ? widget.phase
        : (_shouldAnimate ? _controller.value * 2 * math.pi : 0.0);
    return RepaintBoundary(
      child: SizedBox(
        height: widget.trackThickness + amplitude * 2,
        width: double.infinity,
        child: CustomPaint(
          painter: _ConfigurableLinearM3EPainter(
            value: widget.value,
            activeColor: widget.activeColor,
            trackColor: widget.trackColor,
            phase: phase,
            trackThickness: widget.trackThickness,
            waveAmplitude: amplitude,
            wavePeriod: widget.wavePeriod,
            inset: widget.inset,
            trailingMargin: widget.trailingMargin,
          ),
        ),
      ),
    );
  }
}

class _ConfigurableLinearM3EPainter extends CustomPainter {
  const _ConfigurableLinearM3EPainter({
    required this.value,
    required this.activeColor,
    required this.trackColor,
    required this.phase,
    required this.trackThickness,
    required this.waveAmplitude,
    required this.wavePeriod,
    required this.inset,
    required this.trailingMargin,
  });

  final double? value;
  final Color activeColor;
  final Color trackColor;
  final double phase;
  final double trackThickness;
  final double waveAmplitude;
  final double wavePeriod;
  final double inset;
  final double trailingMargin;

  @override
  void paint(Canvas canvas, Size size) {
    final left = inset;
    final right = size.width - trailingMargin;
    final width = math.max(0.0, right - left);
    final centerY = size.height / 2;
    final progress = (value ?? 0).clamp(0.0, 1.0);
    final activeEnd = value == null ? right : left + width * progress;
    final waveOnly = value == null || progress >= 1;

    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = trackThickness
      ..strokeCap = StrokeCap.round
      ..isAntiAlias = true;

    if (!waveOnly) {
      final trackStart = math.min(right, activeEnd + trackThickness * 2);
      canvas.drawLine(
        Offset(trackStart, centerY),
        Offset(right, centerY),
        base..color = trackColor,
      );
      canvas.drawCircle(
        Offset(math.max(left, right - trackThickness), centerY),
        trackThickness / 2,
        Paint()..color = activeColor,
      );
    }

    final end = activeEnd.clamp(left, right);
    final path = Path();
    const step = 1.5;
    final k = 2 * math.pi / wavePeriod;
    var x = left;
    var y = centerY + waveAmplitude * math.sin(phase + (x - left) * k);
    path.moveTo(x, y);
    for (x = left + step; x <= end; x += step) {
      y = centerY + waveAmplitude * math.sin(phase + (x - left) * k);
      path.lineTo(x, y);
    }
    y = centerY + waveAmplitude * math.sin(phase + (end - left) * k);
    path.lineTo(end, y);

    canvas.drawPath(
      path,
      base
        ..color = activeColor
        ..strokeWidth = trackThickness,
    );
  }

  @override
  bool shouldRepaint(covariant _ConfigurableLinearM3EPainter oldDelegate) {
    return value != oldDelegate.value ||
        activeColor != oldDelegate.activeColor ||
        trackColor != oldDelegate.trackColor ||
        phase != oldDelegate.phase ||
        trackThickness != oldDelegate.trackThickness ||
        waveAmplitude != oldDelegate.waveAmplitude ||
        wavePeriod != oldDelegate.wavePeriod ||
        inset != oldDelegate.inset ||
        trailingMargin != oldDelegate.trailingMargin;
  }
}
