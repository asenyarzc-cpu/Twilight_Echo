import 'dart:math' as math;

import 'package:flutter/material.dart';

class AnimatedPlaybackGlyph extends StatefulWidget {
  const AnimatedPlaybackGlyph({super.key, required this.color});

  final Color color;

  @override
  State<AnimatedPlaybackGlyph> createState() => _AnimatedPlaybackGlyphState();
}

class _AnimatedPlaybackGlyphState extends State<AnimatedPlaybackGlyph>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 920),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Repaints every frame while playing; the boundary confines that to this
    // 24x24 glyph instead of the whole toolbar layer.
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return CustomPaint(
            size: const Size(24, 24),
            painter: _PlaybackGlyphPainter(
              progress: _controller.value,
              color: widget.color,
            ),
          );
        },
      ),
    );
  }
}

class _PlaybackGlyphPainter extends CustomPainter {
  const _PlaybackGlyphPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 3.2
      ..strokeCap = StrokeCap.round;
    final centers = [4.5, 9.5, 14.5, 19.5];
    for (var i = 0; i < centers.length; i++) {
      final phase = (progress + i * 0.19) * math.pi * 2;
      final height = 7.5 + (math.sin(phase) + 1) * 5.2;
      final centerY = size.height / 2;
      canvas.drawLine(
        Offset(centers[i], centerY - height / 2),
        Offset(centers[i], centerY + height / 2),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _PlaybackGlyphPainter oldDelegate) {
    return progress != oldDelegate.progress || color != oldDelegate.color;
  }
}
