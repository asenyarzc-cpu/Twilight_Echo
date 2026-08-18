import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:material_symbols_icons/symbols.dart';

import '../../theme/app_motion.dart';
import 'configurable_m3e_progress.dart';

class ExpressiveDownloadButton extends StatefulWidget {
  const ExpressiveDownloadButton({
    super.key,
    required this.isLoading,
    required this.onPressed,
    this.isDone = false,
    this.progress,
    this.tooltip,
    this.size = 48,
    this.tapTargetSize,
    this.tonal = false,
    this.idleIcon = Symbols.download_rounded,
  }) : assert(size > 0),
       assert(tapTargetSize == null || tapTargetSize > 0);

  final bool isLoading;
  final bool isDone;
  final double? progress;
  final VoidCallback? onPressed;
  final String? tooltip;
  final double size;
  final double? tapTargetSize;
  final bool tonal;
  final IconData idleIcon;

  @override
  State<ExpressiveDownloadButton> createState() =>
      _ExpressiveDownloadButtonState();
}

class _ExpressiveDownloadButtonState extends State<ExpressiveDownloadButton>
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
    final enabled =
        widget.onPressed != null && !widget.isLoading && !widget.isDone;
    final idleContainer = widget.tonal
        ? scheme.secondaryContainer
        : scheme.primary;
    final idleForeground = widget.tonal
        ? scheme.onSecondaryContainer
        : scheme.onPrimary;
    final containerColor = widget.isLoading
        ? Colors.transparent
        : widget.isDone
        ? scheme.primaryContainer
        : idleContainer.withValues(alpha: enabled ? 1 : 0.48);
    final foregroundColor = widget.isDone
        ? scheme.onPrimaryContainer
        : idleForeground;
    final requestedTapTargetSize = widget.tapTargetSize ?? widget.size;
    final tapTargetSize = requestedTapTargetSize < widget.size
        ? widget.size
        : requestedTapTargetSize;
    final button = Semantics(
      button: true,
      enabled: enabled,
      label: widget.tooltip ?? '下载',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? widget.onPressed : null,
        onTapDown: enabled ? (_) => _springTo(0.9) : null,
        onTapCancel: enabled ? () => _springTo(1) : null,
        onTapUp: enabled ? (_) => _springTo(1) : null,
        child: SizedBox.square(
          dimension: tapTargetSize,
          child: Center(
            child: AnimatedBuilder(
              animation: _scale,
              builder: (context, child) =>
                  Transform.scale(scale: _scale.value, child: child),
              child: AnimatedContainer(
                duration: AppMotion.medium,
                curve: AppMotion.emphasized,
                width: widget.size,
                height: widget.size,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: containerColor,
                  shape: BoxShape.circle,
                ),
                child: ExpressiveDownloadGlyph(
                  isLoading: widget.isLoading,
                  isDone: widget.isDone,
                  progress: widget.progress,
                  size: widget.size,
                  circularButtonMode: true,
                  foregroundColor: foregroundColor,
                  secondaryColor: scheme.primary,
                  idleIcon: widget.idleIcon,
                ),
              ),
            ),
          ),
        ),
      ),
    );

    if (widget.tooltip == null) return button;
    return Tooltip(message: widget.tooltip!, child: button);
  }
}

class ExpressiveDownloadGlyph extends StatelessWidget {
  const ExpressiveDownloadGlyph({
    super.key,
    required this.isLoading,
    required this.size,
    required this.foregroundColor,
    required this.secondaryColor,
    this.isDone = false,
    this.progress,
    this.circularButtonMode = false,
    this.idleIcon = Symbols.download_rounded,
  });

  final bool isLoading;
  final bool isDone;
  final double size;
  final Color foregroundColor;
  final Color secondaryColor;
  final double? progress;
  final bool circularButtonMode;
  final IconData idleIcon;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: size,
      child: AnimatedSwitcher(
        duration: AppMotion.medium,
        switchInCurve: AppMotion.emphasizedDecelerate,
        switchOutCurve: AppMotion.emphasizedAccelerate,
        child: isLoading
            ? Stack(
                key: const ValueKey('loading'),
                alignment: Alignment.center,
                children: [
                  SizedBox.square(
                    dimension: size,
                    child: _M3EWavyDownloadIndicator(
                      progress: progress,
                      color: secondaryColor,
                      trackColor: secondaryColor.withValues(alpha: 0.15),
                      availableSize: size,
                    ),
                  ),
                ],
              )
            : isDone
            ? Icon(
                Icons.check_rounded,
                key: const ValueKey('done'),
                color: foregroundColor,
                size: size * (circularButtonMode ? 0.5 : 0.9),
              )
            : Icon(
                idleIcon,
                key: const ValueKey('idle'),
                color: foregroundColor,
                size: size * (circularButtonMode ? 0.43 : 0.86),
              ),
      ),
    );
  }
}

class _M3EWavyDownloadIndicator extends StatelessWidget {
  const _M3EWavyDownloadIndicator({
    required this.progress,
    required this.color,
    required this.trackColor,
    required this.availableSize,
  });

  final double? progress;
  final Color color;
  final Color trackColor;
  final double availableSize;

  @override
  Widget build(BuildContext context) {
    final value = progress?.clamp(0.0, 1.0);
    final indicatorSize = (availableSize * 11 / 12).clamp(0.0, 44.0).toDouble();
    final indicatorScale = indicatorSize / 44;
    final trackThickness = 2.6 * indicatorScale;
    final waveAmplitude = 1.3 * indicatorScale;
    if (value == null) {
      return Center(
        child: ConfigurableCircularProgressIndicatorM3E(
          size: indicatorSize,
          trackThickness: trackThickness,
          activeColor: color,
          trackColor: trackColor,
          waveAmplitude: waveAmplitude,
        ),
      );
    }

    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: value.toDouble()),
      duration: AppMotion.short,
      curve: AppMotion.emphasized,
      builder: (context, animatedValue, _) {
        return Center(
          child: ConfigurableCircularProgressIndicatorM3E(
            value: animatedValue,
            size: indicatorSize,
            trackThickness: trackThickness,
            activeColor: color,
            trackColor: trackColor,
            waveAmplitude: waveAmplitude,
          ),
        );
      },
    );
  }
}
