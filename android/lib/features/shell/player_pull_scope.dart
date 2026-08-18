import 'package:flutter/widgets.dart';

/// Callbacks that drive the shell-level player pull progress.
///
/// The gesture sources live far apart — the bottom toolbar capsule (pull up to
/// open) and the player page's own top chrome / album cluster (pull down to
/// dismiss) — so the handlers travel through an [InheritedWidget] instead of
/// being threaded as constructor parameters through every layer in between.
///
/// [AppShell] builds one instance in `initState` and keeps it in a field: the
/// handlers are method tear-offs of a single state object, so the instance is
/// identical on every build and never triggers a dependent rebuild.
@immutable
class PlayerPullGestures {
  const PlayerPullGestures({
    required this.onWarm,
    required this.onStart,
    required this.onUpdate,
    required this.onEnd,
    required this.onCancel,
  });

  /// Called on pointer-down, before the drag clears the touch slop, so the
  /// player layer can mount and render its backdrop while still off screen.
  final VoidCallback onWarm;

  final VoidCallback onStart;

  /// Vertical finger delta in logical pixels, positive downwards.
  final ValueChanged<double> onUpdate;

  /// Release velocity in logical pixels per second, positive downwards.
  final ValueChanged<double> onEnd;

  final VoidCallback onCancel;
}

class PlayerPullScope extends InheritedWidget {
  const PlayerPullScope({
    super.key,
    required this.gestures,
    required super.child,
  });

  final PlayerPullGestures gestures;

  static PlayerPullGestures? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<PlayerPullScope>()
        ?.gestures;
  }

  @override
  bool updateShouldNotify(PlayerPullScope oldWidget) {
    return gestures != oldWidget.gestures;
  }
}

/// Makes a vertical drag on [child] scrub the shell's player pull progress.
///
/// Used inside the player page to drag it back down. It must sit *below* any
/// enclosing scrollable in the tree: the innermost vertical recognizer resolves
/// the gesture arena first, so a descendant wins over the scroll view while an
/// ancestor would lose to it.
class PlayerPullHandle extends StatelessWidget {
  const PlayerPullHandle({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final pull = PlayerPullScope.maybeOf(context);
    if (pull == null) return child;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragStart: (_) => pull.onStart(),
      onVerticalDragUpdate: (details) => pull.onUpdate(details.delta.dy),
      onVerticalDragEnd: (details) =>
          pull.onEnd(details.velocity.pixelsPerSecond.dy),
      onVerticalDragCancel: pull.onCancel,
      child: child,
    );
  }
}
