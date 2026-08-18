import 'package:flutter/material.dart';

import '../../../theme/app_motion.dart';

/// 被动监听（不进手势竞技场）的横向滑动识别器：内部的横向滚动/
/// PageView 照常工作，本组件只在指针序列结束时判定一次。
///
/// [trackDrag] 打开时，横向主导的拖动会带着 child 做一段带阻尼的跟手
/// 位移（并轻微降透明度），松手未达阈值则弹回原位——给"整页切换"类
/// 滑动一个即时反馈。发现页由自己的 PageView 跟手，应传 false。
class HorizontalPageSwipe extends StatefulWidget {
  const HorizontalPageSwipe({
    super.key,
    required this.child,
    this.onSwipeLeft,
    this.onSwipeRight,
    this.onDragStart,
    this.trackDrag = true,
  });

  final Widget child;
  final VoidCallback? onSwipeLeft;
  final VoidCallback? onSwipeRight;

  /// 指针落下时回调一次，供调用方快照手势开始时的状态。
  final VoidCallback? onDragStart;
  final bool trackDrag;

  @override
  State<HorizontalPageSwipe> createState() => _HorizontalPageSwipeState();
}

/// Excludes a descendant interaction from the nearest [HorizontalPageSwipe].
///
/// Use this around horizontal controls such as carousels or swatch lists. The
/// control keeps its own gesture while the shell ignores that pointer sequence.
class HorizontalPageSwipeExclusion extends StatelessWidget {
  const HorizontalPageSwipeExclusion({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scope = context
        .dependOnInheritedWidgetOfExactType<_HorizontalPageSwipeScope>();
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (event) => scope?.exclude(event.pointer),
      child: child,
    );
  }
}

class _HorizontalPageSwipeState extends State<HorizontalPageSwipe>
    with SingleTickerProviderStateMixin {
  static const _minimumDistance = 72.0;
  static const _horizontalDominance = 1.3;
  static const _trackStartDistance = 14.0;
  static const _trackDamping = 0.35;
  static const _trackMaxOffset = 64.0;

  int? _pointer;
  Offset? _start;
  Offset? _latest;
  final Set<int> _excludedPointers = <int>{};

  /// 当前跟手位移（像素）。用 ValueNotifier + builder，child 子树不重建。
  final ValueNotifier<double> _offset = ValueNotifier<double>(0);
  late final AnimationController _settle;

  @override
  void initState() {
    super.initState();
    _settle = AnimationController(vsync: this, duration: AppMotion.short)
      ..addListener(() {
        _offset.value = _settleTween.evaluate(_settle);
      });
  }

  Tween<double> _settleTween = Tween<double>(begin: 0, end: 0);

  @override
  void dispose() {
    _settle.dispose();
    _offset.dispose();
    super.dispose();
  }

  void _handlePointerDown(PointerDownEvent event) {
    if (_excludedPointers.contains(event.pointer)) return;
    if (_pointer != null) return;
    _pointer = event.pointer;
    _start = event.position;
    _latest = event.position;
    _settle.stop(canceled: false);
    widget.onDragStart?.call();
  }

  bool get _tracks =>
      widget.trackDrag && !MediaQuery.disableAnimationsOf(context);

  void _handlePointerMove(PointerMoveEvent event) {
    if (_excludedPointers.contains(event.pointer)) return;
    if (_pointer != event.pointer) return;
    _latest = event.position;
    final start = _start;
    if (start == null || !_tracks) return;
    final delta = event.position - start;
    final horizontal =
        delta.dx.abs() > _trackStartDistance &&
        delta.dx.abs() > delta.dy.abs() * _horizontalDominance;
    final hasHandler = delta.dx < 0
        ? widget.onSwipeLeft != null
        : widget.onSwipeRight != null;
    if (!horizontal || !hasHandler) {
      if (_offset.value != 0) _springBack();
      return;
    }
    final magnitude = ((delta.dx.abs() - _trackStartDistance) * _trackDamping)
        .clamp(0.0, _trackMaxOffset);
    _offset.value = delta.dx.sign * magnitude;
  }

  void _handlePointerUp(PointerUpEvent event) {
    if (_excludedPointers.remove(event.pointer)) return;
    if (_pointer != event.pointer) return;
    final start = _start;
    final end = _latest ?? event.position;
    _reset();
    if (start == null) return;

    final delta = end - start;
    if (delta.dx.abs() < _minimumDistance ||
        delta.dx.abs() < delta.dy.abs() * _horizontalDominance) {
      _springBack();
      return;
    }
    // 提交：位移立刻归零，由外层路由过渡接力完成动画。
    _offset.value = 0;
    if (delta.dx < 0) {
      widget.onSwipeLeft?.call();
    } else {
      widget.onSwipeRight?.call();
    }
  }

  void _handlePointerCancel(PointerCancelEvent event) {
    if (_excludedPointers.remove(event.pointer)) return;
    if (_pointer != event.pointer) return;
    _reset();
    _springBack();
  }

  void _springBack() {
    if (_offset.value == 0) return;
    _settleTween = Tween<double>(begin: _offset.value, end: 0);
    _settle
      ..value = 0
      ..animateTo(1, curve: AppMotion.emphasized);
  }

  void _reset() {
    _pointer = null;
    _start = null;
    _latest = null;
  }

  void _excludePointer(int pointer) {
    _excludedPointers.add(pointer);
    if (_pointer != pointer) return;
    _reset();
    _springBack();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.onSwipeLeft == null && widget.onSwipeRight == null) {
      return widget.child;
    }
    return _HorizontalPageSwipeScope(
      exclude: _excludePointer,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: _handlePointerDown,
        onPointerMove: _handlePointerMove,
        onPointerUp: _handlePointerUp,
        onPointerCancel: _handlePointerCancel,
        child: ValueListenableBuilder<double>(
          valueListenable: _offset,
          child: widget.child,
          builder: (context, offset, child) {
            return Transform.translate(
              offset: Offset(offset, 0),
              child: Opacity(
                opacity: 1 - (offset.abs() / _trackMaxOffset) * 0.18,
                child: child,
              ),
            );
          },
        ),
      ),
    );
  }
}

class _HorizontalPageSwipeScope extends InheritedWidget {
  const _HorizontalPageSwipeScope({
    required this.exclude,
    required super.child,
  });

  final ValueChanged<int> exclude;

  @override
  bool updateShouldNotify(_HorizontalPageSwipeScope oldWidget) =>
      exclude != oldWidget.exclude;
}
