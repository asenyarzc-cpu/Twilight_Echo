import 'package:flutter/material.dart';

import '../../../theme/app_motion.dart';

class TrackChangeSwitcher extends StatelessWidget {
  const TrackChangeSwitcher({
    super.key,
    required this.transitionKey,
    required this.child,
    this.alignment = Alignment.center,
    this.incomingOffset = const Offset(0.16, 0),
    this.scaleBegin = 1,
    this.expand = false,
    this.duration,
  });

  final Object transitionKey;
  final Widget child;
  final AlignmentGeometry alignment;
  final Offset incomingOffset;
  final double scaleBegin;
  final bool expand;
  final Duration? duration;

  @override
  Widget build(BuildContext context) {
    final childKey = ValueKey<Object>(transitionKey);
    final resolvedDuration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : duration ?? AppMotion.long;
    return AnimatedSwitcher(
      duration: resolvedDuration,
      reverseDuration: resolvedDuration,
      switchInCurve: AppMotion.emphasizedDecelerate,
      switchOutCurve: AppMotion.emphasizedAccelerate,
      layoutBuilder: (currentChild, previousChildren) {
        return Stack(
          alignment: alignment,
          fit: expand ? StackFit.expand : StackFit.loose,
          clipBehavior: Clip.none,
          children: [...previousChildren, ?currentChild],
        );
      },
      transitionBuilder: (transitionChild, animation) {
        final incoming = transitionChild.key == childKey;
        final slideBegin = incoming
            ? incomingOffset
            : Offset(-incomingOffset.dx, -incomingOffset.dy);
        Widget animated = SlideTransition(
          position: Tween<Offset>(
            begin: slideBegin,
            end: Offset.zero,
          ).animate(animation),
          child: transitionChild,
        );
        if (scaleBegin != 1) {
          animated = ScaleTransition(
            scale: Tween<double>(begin: scaleBegin, end: 1).animate(animation),
            child: animated,
          );
        }
        return FadeTransition(opacity: animation, child: animated);
      },
      child: KeyedSubtree(key: childKey, child: child),
    );
  }
}
