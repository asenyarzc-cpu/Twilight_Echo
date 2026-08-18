import 'package:flutter/material.dart';
import 'package:toastification/toastification.dart';

enum AppToastType { info, success, warning, error }

enum AppToastPosition {
  topLeft,
  topCenter,
  topRight,
  centerLeft,
  center,
  centerRight,
  bottomLeft,
  bottomCenter,
  bottomRight,
}

final GlobalKey<OverlayState> _appToastOverlayKey = GlobalKey<OverlayState>(
  debugLabel: 'app-toast-overlay',
);
ToastificationItem? _currentToast;

class AppToastHandle {
  AppToastHandle._(this._item);

  final ToastificationItem _item;
  bool _dismissed = false;
}

class AppToastOverlay extends StatelessWidget {
  const AppToastOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        child,
        Positioned.fill(
          child: IgnorePointer(
            child: KeyedSubtree(
              key: const ValueKey('app-toast-root-overlay'),
              child: Overlay(key: _appToastOverlayKey),
            ),
          ),
        ),
      ],
    );
  }
}

AppToastHandle showAppToast(
  BuildContext context,
  String message, {
  AppToastType type = AppToastType.info,
  AppToastPosition position = AppToastPosition.bottomCenter,
  Duration duration = const Duration(seconds: 3),
}) {
  return _showToast(
    context: context,
    message: message,
    type: type,
    position: position,
    duration: duration,
  );
}

AppToastHandle showAppToastOnOverlay(
  OverlayState overlay,
  String message, {
  AppToastType type = AppToastType.info,
  AppToastPosition position = AppToastPosition.bottomCenter,
  Duration duration = const Duration(seconds: 3),
}) {
  return _showToast(
    overlayState: overlay,
    message: message,
    type: type,
    position: position,
    duration: duration,
  );
}

void dismissAppToast(
  AppToastHandle? handle, {
  bool showRemoveAnimation = true,
}) {
  if (handle == null || handle._dismissed) return;
  handle._dismissed = true;
  toastification.dismiss(
    handle._item,
    showRemoveAnimation: showRemoveAnimation,
  );
  WidgetsBinding.instance.addPostFrameCallback((_) {
    toastification.dismiss(
      handle._item,
      showRemoveAnimation: showRemoveAnimation,
    );
  });
  if (identical(_currentToast, handle._item)) _currentToast = null;
}

AppToastHandle _showToast({
  BuildContext? context,
  OverlayState? overlayState,
  required String message,
  required AppToastType type,
  required AppToastPosition position,
  required Duration duration,
}) {
  final previous = _currentToast;
  if (previous != null) {
    toastification.dismiss(previous, showRemoveAnimation: false);
  }

  final stableOverlay = _appToastOverlayKey.currentState;
  final effectiveOverlay = stableOverlay ?? overlayState;

  late final ToastificationItem item;
  item = toastification.showCustom(
    context: effectiveOverlay == null ? context : null,
    overlayState: effectiveOverlay,
    alignment: position.alignment,
    animationDuration: const Duration(milliseconds: 220),
    autoCloseDuration: duration,
    animationBuilder: _toastAnimationBuilder,
    callbacks: ToastificationCallbacks(
      onAutoCompleteCompleted: (_) {
        if (identical(_currentToast, item)) _currentToast = null;
      },
    ),
    builder: (context, _) =>
        _ToastViewport(message: message, type: type, position: position),
  );
  _currentToast = item;
  return AppToastHandle._(item);
}

Widget _toastAnimationBuilder(
  BuildContext context,
  Animation<double> animation,
  Alignment alignment,
  Widget child,
) {
  final curved = CurvedAnimation(
    parent: animation,
    curve: Curves.easeOutCubic,
    reverseCurve: Curves.easeInCubic,
  );
  final offset = Offset(alignment.x * 0.12, alignment.y * 0.18);
  return FadeTransition(
    opacity: curved,
    child: SlideTransition(
      position: Tween<Offset>(begin: offset, end: Offset.zero).animate(curved),
      child: child,
    ),
  );
}

class _ToastViewport extends StatelessWidget {
  const _ToastViewport({
    required this.message,
    required this.type,
    required this.position,
  });

  final String message;
  final AppToastType type;
  final AppToastPosition position;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Padding(
        padding: position.viewportPadding,
        child: Align(
          alignment: position.contentAlignment,
          child: _ToastCapsule(message: message, type: type),
        ),
      ),
    );
  }
}

class _ToastCapsule extends StatelessWidget {
  const _ToastCapsule({required this.message, required this.type});

  final String message;
  final AppToastType type;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = _ToastTone.from(type, scheme.brightness);
    final background = Color.alphaBlend(
      tone.color.withValues(
        alpha: scheme.brightness == Brightness.dark ? 0.18 : 0.10,
      ),
      scheme.surfaceContainerHigh,
    );

    return Container(
      key: const ValueKey('app-toast-capsule'),
      constraints: const BoxConstraints(minHeight: 44, maxWidth: 360),
      padding: const EdgeInsets.fromLTRB(10, 8, 14, 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: tone.color.withValues(alpha: 0.34)),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(
              alpha: scheme.brightness == Brightness.dark ? 0.26 : 0.12,
            ),
            blurRadius: 18,
            offset: const Offset(0, 7),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: tone.color.withValues(alpha: 0.14),
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Icon(tone.icon, color: tone.color, size: 18),
          ),
          const SizedBox(width: 9),
          Flexible(
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: scheme.onSurface,
                fontSize: 14,
                fontWeight: FontWeight.w500,
                height: 1.25,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

extension on AppToastPosition {
  Alignment get alignment => switch (this) {
    AppToastPosition.topLeft => Alignment.topLeft,
    AppToastPosition.topCenter => Alignment.topCenter,
    AppToastPosition.topRight => Alignment.topRight,
    AppToastPosition.centerLeft => Alignment.centerLeft,
    AppToastPosition.center => Alignment.center,
    AppToastPosition.centerRight => Alignment.centerRight,
    AppToastPosition.bottomLeft => Alignment.bottomLeft,
    AppToastPosition.bottomCenter => Alignment.bottomCenter,
    AppToastPosition.bottomRight => Alignment.bottomRight,
  };

  Alignment get contentAlignment => switch (this) {
    AppToastPosition.topLeft ||
    AppToastPosition.centerLeft ||
    AppToastPosition.bottomLeft => Alignment.centerLeft,
    AppToastPosition.topRight ||
    AppToastPosition.centerRight ||
    AppToastPosition.bottomRight => Alignment.centerRight,
    _ => Alignment.center,
  };

  EdgeInsets get viewportPadding => switch (this) {
    AppToastPosition.bottomLeft ||
    AppToastPosition.bottomCenter ||
    AppToastPosition.bottomRight => const EdgeInsets.fromLTRB(16, 8, 16, 76),
    _ => const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
  };
}

class _ToastTone {
  const _ToastTone({required this.icon, required this.color});

  factory _ToastTone.from(AppToastType type, Brightness brightness) {
    final dark = brightness == Brightness.dark;
    return switch (type) {
      AppToastType.info => _ToastTone(
        icon: Icons.info_outline_rounded,
        color: dark ? const Color(0xFF8DB7FF) : const Color(0xFF2F6FED),
      ),
      AppToastType.success => _ToastTone(
        icon: Icons.check_rounded,
        color: dark ? const Color(0xFF66D3A5) : const Color(0xFF16865C),
      ),
      AppToastType.warning => _ToastTone(
        icon: Icons.warning_amber_rounded,
        color: dark ? const Color(0xFFFFBC65) : const Color(0xFFB76800),
      ),
      AppToastType.error => _ToastTone(
        icon: Icons.error_outline_rounded,
        color: dark ? const Color(0xFFFFB4AB) : const Color(0xFFBA1A1A),
      ),
    };
  }

  final IconData icon;
  final Color color;
}
