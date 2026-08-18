import 'package:flutter/material.dart';

class CoverLoadingSkeleton extends StatefulWidget {
  const CoverLoadingSkeleton({super.key});

  @override
  State<CoverLoadingSkeleton> createState() => _CoverLoadingSkeletonState();
}

class _CoverLoadingSkeletonState extends State<CoverLoadingSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );

  bool _animationsDisabled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final disabled = MediaQuery.disableAnimationsOf(context);
    if (disabled == _animationsDisabled &&
        (_controller.isAnimating || disabled)) {
      return;
    }
    _animationsDisabled = disabled;
    if (disabled) {
      _controller.stop();
      _controller.value = 0.38;
    } else {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: '正在加载封面',
      child: RepaintBoundary(
        key: const ValueKey('cover-loading-skeleton'),
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) => CustomPaint(
            painter: _CoverSkeletonPainter(
              progress: _controller.value,
              baseColor: scheme.surfaceContainerLow,
              highlightColor: scheme.surfaceContainerHighest.withValues(
                alpha: 0.72,
              ),
            ),
            child: const SizedBox.expand(),
          ),
        ),
      ),
    );
  }
}

class _CoverSkeletonPainter extends CustomPainter {
  const _CoverSkeletonPainter({
    required this.progress,
    required this.baseColor,
    required this.highlightColor,
  });

  final double progress;
  final Color baseColor;
  final Color highlightColor;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final bandWidth = size.width * 0.72;
    final travel = size.width + bandWidth * 2;
    final left = -bandWidth + travel * progress;
    final bandRect = Rect.fromLTWH(left, 0, bandWidth, size.height);
    final highlight = Paint()
      ..shader = LinearGradient(
        begin: Alignment.centerLeft,
        end: Alignment.centerRight,
        colors: [
          highlightColor.withValues(alpha: 0),
          highlightColor,
          highlightColor.withValues(alpha: 0),
        ],
        stops: const [0, 0.5, 1],
      ).createShader(bandRect);
    canvas.drawRect(bandRect, highlight);
  }

  @override
  bool shouldRepaint(covariant _CoverSkeletonPainter oldDelegate) {
    return progress != oldDelegate.progress ||
        baseColor != oldDelegate.baseColor ||
        highlightColor != oldDelegate.highlightColor;
  }
}

class CoverUnavailablePlaceholder extends StatelessWidget {
  const CoverUnavailablePlaceholder({super.key, this.iconSize = 34});

  final double iconSize;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: '暂无封面',
      child: ColoredBox(
        color: scheme.surfaceContainerLow,
        child: Center(
          child: Icon(
            Icons.album_rounded,
            size: iconSize,
            color: scheme.onSurfaceVariant.withValues(alpha: 0.58),
          ),
        ),
      ),
    );
  }
}
