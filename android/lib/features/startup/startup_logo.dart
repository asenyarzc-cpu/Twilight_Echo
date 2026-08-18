import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/app_motion.dart';

class StartupLogo extends StatefulWidget {
  const StartupLogo({super.key, this.size = 112});

  final double size;

  @override
  State<StartupLogo> createState() => _StartupLogoState();
}

class _StartupLogoState extends State<StartupLogo>
    with TickerProviderStateMixin {
  late final AnimationController _entry = AnimationController(
    duration: const Duration(milliseconds: 1200),
    vsync: this,
  );
  late final AnimationController _glow = AnimationController(
    duration: const Duration(milliseconds: 2400),
    vsync: this,
  );

  @override
  void initState() {
    super.initState();
    _entry
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed) {
          _glow.repeat(reverse: true);
        }
      })
      ..forward();
  }

  @override
  void dispose() {
    _entry.dispose();
    _glow.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return AnimatedBuilder(
      animation: Listenable.merge([_entry, _glow]),
      builder: (context, child) {
        final draw = _segment(_entry.value, 0.0, 0.58);
        final reveal = _segment(_entry.value, 0.58, 0.92, Curves.easeOutCubic);
        final strokeFade =
            1 - _segment(_entry.value, 0.64, 0.88, Curves.easeOutCubic);
        final breathe = Curves.easeInOutSine.transform(_glow.value);
        final glowAlpha = reveal * (0.08 + 0.05 * breathe);
        final glowBlur = 22.0 + 10.0 * breathe;

        return Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(widget.size * 0.24),
            boxShadow: [
              BoxShadow(
                color: scheme.shadow.withValues(
                  alpha: scheme.brightness == Brightness.light ? 0.16 : 0.34,
                ),
                blurRadius: 22,
                offset: const Offset(0, 12),
              ),
              BoxShadow(
                color: scheme.primary.withValues(alpha: glowAlpha),
                blurRadius: glowBlur,
                spreadRadius: 1,
              ),
              BoxShadow(
                color: scheme.tertiary.withValues(alpha: glowAlpha * 0.7),
                blurRadius: glowBlur * 0.8,
                offset: const Offset(0, 14),
              ),
            ],
          ),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (strokeFade > 0)
                CustomPaint(
                  painter: _LogoStrokePainter(
                    progress: draw,
                    fade: strokeFade,
                    color: scheme.primary,
                  ),
                ),
              Opacity(
                opacity: reveal,
                child: Padding(
                  padding: EdgeInsets.all(widget.size * 0.16),
                  child: child,
                ),
              ),
            ],
          ),
        );
      },
      child: ClipRRect(
        borderRadius: BorderRadius.circular(widget.size * 0.23),
        child: Image.asset('logo_fg.png', fit: BoxFit.contain),
      ),
    );
  }
}

class _LogoStrokePainter extends CustomPainter {
  const _LogoStrokePainter({
    required this.progress,
    required this.fade,
    required this.color,
  });

  final double progress;
  final double fade;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0 || fade <= 0) return;

    final frame = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          (Offset.zero & size).deflate(1.5),
          Radius.circular(size.shortestSide * 0.23),
        ),
      );
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..strokeWidth = math.max(1.5, size.shortestSide * 0.014)
      ..color = color.withValues(alpha: fade);

    _drawPath(
      canvas,
      frame,
      _segment(progress, 0.0, 0.72, AppMotion.emphasizedDecelerate),
      paint..strokeWidth = math.max(1.5, size.shortestSide * 0.018),
    );
    _drawPath(
      canvas,
      _ribbonPath(size),
      _segment(progress, 0.02, 0.70, AppMotion.emphasizedDecelerate),
      paint..strokeWidth = math.max(1.4, size.shortestSide * 0.014),
    );
    _drawPath(
      canvas,
      _noteHeadPath(size),
      _segment(progress, 0.14, 0.82, AppMotion.emphasizedDecelerate),
      paint,
    );
    _drawPath(
      canvas,
      _downloadCirclePath(size),
      _segment(progress, 0.24, 0.90, AppMotion.emphasizedDecelerate),
      paint,
    );
    _drawPath(
      canvas,
      _downloadArrowPath(size),
      _segment(progress, 0.42, 1.0, AppMotion.emphasizedDecelerate),
      paint,
    );
  }

  Path _ribbonPath(Size size) {
    final path = Path();

    path
      ..moveToPoint(_assetPoint(size, 329, 790))
      ..lineToPoint(_assetPoint(size, 329, 337));
    path
      ..moveToPoint(_assetPoint(size, 329, 337))
      ..cubicToPoints(
        _assetPoint(size, 329, 292),
        _assetPoint(size, 367, 270),
        _assetPoint(size, 420, 260),
      )
      ..cubicToPoints(
        _assetPoint(size, 530, 236),
        _assetPoint(size, 642, 206),
        _assetPoint(size, 665, 140),
      );
    path
      ..moveToPoint(_assetPoint(size, 329, 393))
      ..cubicToPoints(
        _assetPoint(size, 331, 346),
        _assetPoint(size, 368, 327),
        _assetPoint(size, 420, 317),
      )
      ..cubicToPoints(
        _assetPoint(size, 531, 296),
        _assetPoint(size, 642, 269),
        _assetPoint(size, 665, 205),
      );
    path
      ..moveToPoint(_assetPoint(size, 329, 421))
      ..cubicToPoints(
        _assetPoint(size, 334, 394),
        _assetPoint(size, 370, 382),
        _assetPoint(size, 420, 377),
      )
      ..cubicToPoints(
        _assetPoint(size, 532, 357),
        _assetPoint(size, 642, 331),
        _assetPoint(size, 665, 277),
      );
    path
      ..moveToPoint(_assetPoint(size, 665, 140))
      ..lineToPoint(_assetPoint(size, 665, 462));
    return path;
  }

  Path _noteHeadPath(Size size) {
    final center = _assetPoint(size, 244, 797);
    final width = _assetLength(size, 184);
    final height = _assetLength(size, 156);
    final oval = Rect.fromCenter(
      center: Offset.zero,
      width: width,
      height: height,
    );
    final transform = Matrix4.identity()
      ..translateByDouble(center.dx, center.dy, 0, 1)
      ..rotateZ(-0.20);
    return Path()
      ..addPath(Path()..addOval(oval), Offset.zero, matrix4: transform.storage);
  }

  Path _downloadCirclePath(Size size) {
    final center = _assetPoint(size, 665, 690);
    final radius = _assetLength(size, 199);
    final rect = Rect.fromCircle(center: center, radius: radius);
    return Path()
      ..moveTo(center.dx, center.dy - radius)
      ..arcTo(rect, -math.pi / 2, math.pi * 2, false);
  }

  Path _downloadArrowPath(Size size) {
    return Path()
      ..moveToPoint(_assetPoint(size, 665, 570))
      ..lineToPoint(_assetPoint(size, 665, 750))
      ..moveToPoint(_assetPoint(size, 590, 675))
      ..lineToPoint(_assetPoint(size, 665, 750))
      ..lineToPoint(_assetPoint(size, 740, 675))
      ..moveToPoint(_assetPoint(size, 570, 789))
      ..lineToPoint(_assetPoint(size, 760, 789));
  }

  Offset _assetPoint(Size size, double x, double y) {
    const inset = 0.16;
    const scale = 1 - inset * 2;
    return Offset(
      size.width * (inset + scale * x / 1024),
      size.height * (inset + scale * y / 1024),
    );
  }

  double _assetLength(Size size, double length) {
    const scale = 1 - 0.16 * 2;
    return size.shortestSide * scale * length / 1024;
  }

  void _drawPath(Canvas canvas, Path path, double progress, Paint paint) {
    if (progress <= 0) return;
    for (final metric in path.computeMetrics()) {
      canvas.drawPath(
        metric.extractPath(0, metric.length * progress.clamp(0.0, 1.0)),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _LogoStrokePainter oldDelegate) {
    return oldDelegate.progress != progress ||
        oldDelegate.fade != fade ||
        oldDelegate.color != color;
  }
}

extension on Path {
  void moveToPoint(Offset point) => moveTo(point.dx, point.dy);

  void lineToPoint(Offset point) => lineTo(point.dx, point.dy);

  void cubicToPoints(Offset control1, Offset control2, Offset end) {
    cubicTo(control1.dx, control1.dy, control2.dx, control2.dy, end.dx, end.dy);
  }
}

double _segment(
  double t,
  double start,
  double end, [
  Curve curve = Curves.easeInOutCubic,
]) {
  return curve.transform(((t - start) / (end - start)).clamp(0.0, 1.0));
}
