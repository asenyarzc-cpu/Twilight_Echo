import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/app_motion.dart';

class RadioMenuOption {
  const RadioMenuOption({
    required this.id,
    required this.label,
    required this.selected,
    required this.onSelected,
    this.enabled = true,
  });

  final String id;
  final String label;
  final bool selected;
  final bool enabled;
  final VoidCallback onSelected;
}

typedef RadioMenuOptionsBuilder = List<RadioMenuOption> Function();

typedef RadioMenuAnchorBuilder =
    Widget Function(
      BuildContext context,
      bool expanded,
      GestureTapDownCallback onTapDown,
      VoidCallback onTap,
    );

class RadioMenuAnchor extends StatefulWidget {
  const RadioMenuAnchor({
    super.key,
    required this.menuId,
    required this.optionsBuilder,
    required this.anchorBuilder,
    this.multiSelect = false,
    this.minimumWidth = 136,
    this.maximumWidth = 184,
    this.maximumHeight,
  }) : assert(minimumWidth >= 0),
       assert(maximumWidth >= minimumWidth),
       assert(maximumHeight == null || maximumHeight > 0);

  final String menuId;
  final RadioMenuOptionsBuilder optionsBuilder;
  final RadioMenuAnchorBuilder anchorBuilder;
  final bool multiSelect;
  final double minimumWidth;
  final double maximumWidth;
  final double? maximumHeight;

  @override
  State<RadioMenuAnchor> createState() => _RadioMenuAnchorState();
}

class _RadioMenuAnchorState extends State<RadioMenuAnchor>
    with SingleTickerProviderStateMixin {
  static const _openDuration = Duration(milliseconds: 500);
  static const _closeDuration = Duration(milliseconds: 150);

  late final AnimationController _controller;
  OverlayEntry? _overlayEntry;
  LocalHistoryEntry? _historyEntry;
  Offset? _tapPosition;
  List<RadioMenuOption> _options = const [];
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: _openDuration,
      reverseDuration: _closeDuration,
    );
  }

  @override
  void didUpdateWidget(covariant RadioMenuAnchor oldWidget) {
    super.didUpdateWidget(oldWidget);
    final overlayEntry = _overlayEntry;
    if (overlayEntry == null) return;
    _options = widget.optionsBuilder();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(_overlayEntry, overlayEntry)) {
        overlayEntry.markNeedsBuild();
      }
    });
  }

  void _rememberTapPosition(TapDownDetails details) {
    _tapPosition = details.globalPosition;
  }

  void _toggleMenu() {
    if (_overlayEntry != null) {
      unawaited(_closeMenu());
      return;
    }
    _openMenu();
  }

  void _openMenu() {
    _options = widget.optionsBuilder();
    final overlay = Overlay.of(context, rootOverlay: true);
    final overlayBox = overlay.context.findRenderObject() as RenderBox?;
    final anchorBox = context.findRenderObject() as RenderBox?;
    final fallbackGlobalPosition = anchorBox == null
        ? Offset.zero
        : anchorBox.localToGlobal(
            Offset(anchorBox.size.width - 24, anchorBox.size.height / 2),
          );
    final globalPosition = _tapPosition ?? fallbackGlobalPosition;
    final localPosition =
        overlayBox?.globalToLocal(globalPosition) ?? globalPosition;
    final disableAnimations = MediaQuery.disableAnimationsOf(context);
    _controller.duration = disableAnimations ? Duration.zero : _openDuration;
    _controller.reverseDuration = disableAnimations
        ? Duration.zero
        : _closeDuration;

    _overlayEntry = OverlayEntry(
      builder: (context) => _RadioMenuOverlay(
        menuId: widget.menuId,
        tapPosition: localPosition,
        options: _options,
        multiSelect: widget.multiSelect,
        minimumWidth: widget.minimumWidth,
        maximumWidth: widget.maximumWidth,
        maximumHeight: widget.maximumHeight,
        animation: _controller,
        onDismiss: _closeMenu,
        onOptionSelected: _selectOption,
      ),
    );
    overlay.insert(_overlayEntry!);

    final route = ModalRoute.of(context);
    if (route != null) {
      late final LocalHistoryEntry historyEntry;
      historyEntry = LocalHistoryEntry(
        onRemove: () {
          if (identical(_historyEntry, historyEntry)) {
            _historyEntry = null;
          }
          unawaited(_closeMenu(removeHistoryEntry: false));
        },
      );
      _historyEntry = historyEntry;
      route.addLocalHistoryEntry(historyEntry);
    }

    if (mounted) setState(() {});
    unawaited(_controller.forward(from: 0));
  }

  void _selectOption(RadioMenuOption option) {
    if (!option.enabled || _closing) return;
    if (widget.multiSelect) {
      option.onSelected();
      _options = widget.optionsBuilder();
      _overlayEntry?.markNeedsBuild();
      return;
    }
    unawaited(_closeAndSelect(option));
  }

  Future<void> _closeAndSelect(RadioMenuOption option) async {
    await _closeMenu();
    if (mounted) option.onSelected();
  }

  Future<void> _closeMenu({bool removeHistoryEntry = true}) async {
    if (_overlayEntry == null || _closing) return;
    _closing = true;

    if (removeHistoryEntry) {
      final historyEntry = _historyEntry;
      _historyEntry = null;
      historyEntry?.remove();
    }

    await _controller.reverse();
    if (!mounted) return;

    _removeOverlayEntry();
    _closing = false;
    setState(() {});
  }

  void _removeOverlayEntry() {
    final overlayEntry = _overlayEntry;
    if (overlayEntry == null) return;
    _overlayEntry = null;
    overlayEntry.remove();
    overlayEntry.dispose();
  }

  @override
  void dispose() {
    _closing = true;
    final historyEntry = _historyEntry;
    _historyEntry = null;
    historyEntry?.remove();
    _removeOverlayEntry();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.anchorBuilder(
      context,
      _overlayEntry != null,
      _rememberTapPosition,
      _toggleMenu,
    );
  }
}

class _RadioMenuOverlay extends StatelessWidget {
  const _RadioMenuOverlay({
    required this.menuId,
    required this.tapPosition,
    required this.options,
    required this.multiSelect,
    required this.minimumWidth,
    required this.maximumWidth,
    required this.maximumHeight,
    required this.animation,
    required this.onDismiss,
    required this.onOptionSelected,
  });

  static const double _edgePadding = 12;
  static const double _menuGap = 8;
  static const Curve _heightForwardCurve = Cubic(0.3, 0, 0, 1);
  static const Curve _heightReverseCurve = _TweenCurve(
    0.35,
    1,
    curve: FlippedCurve(AppMotion.emphasizedAccelerate),
  );
  static const Curve _panelOpacityForwardCurve = Interval(0, 0.1);
  static const Curve _panelOpacityReverseCurve = FlippedCurve(
    Interval(2 / 3, 1),
  );
  static const double _itemFadeInDuration = 0.5;
  static const double _itemFadeOutDuration = 1 / 3;
  static const double _itemFadeOutDelay = 1 / 3;

  final String menuId;
  final Offset tapPosition;
  final List<RadioMenuOption> options;
  final bool multiSelect;
  final double minimumWidth;
  final double maximumWidth;
  final double? maximumHeight;
  final Animation<double> animation;
  final VoidCallback onDismiss;
  final ValueChanged<RadioMenuOption> onOptionSelected;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final viewPadding = MediaQuery.viewPaddingOf(context);
    final heightAnimation = _DirectionalCurveAnimation(
      parent: animation,
      forwardCurve: _heightForwardCurve,
      reverseCurve: _heightReverseCurve,
    );
    final panelOpacityAnimation = _DirectionalCurveAnimation(
      parent: animation,
      forwardCurve: _panelOpacityForwardCurve,
      reverseCurve: _panelOpacityReverseCurve,
    );
    final optionOpacityAnimations = _buildOptionOpacityAnimations();

    return Focus(
      autofocus: true,
      onKeyEvent: (node, event) {
        if (event is KeyDownEvent &&
            event.logicalKey == LogicalKeyboardKey.escape) {
          onDismiss();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: LayoutBuilder(
        builder: (context, constraints) {
          final safeLeft = viewPadding.left + _edgePadding;
          final safeRight =
              constraints.maxWidth - viewPadding.right - _edgePadding;
          final availableWidth = math.max(0.0, safeRight - safeLeft);
          final menuWidth = _measureMenuWidth(context, availableWidth);
          final rightSpace = safeRight - (tapPosition.dx + _menuGap);
          final leftSpace = (tapPosition.dx - _menuGap) - safeLeft;
          final opensRight =
              rightSpace >= menuWidth ||
              (leftSpace < menuWidth && rightSpace >= leftSpace);
          final opensDown = tapPosition.dy <= constraints.maxHeight / 2;

          return Stack(
            fit: StackFit.expand,
            children: [
              ModalBarrier(
                key: ValueKey('$menuId-barrier'),
                color: Colors.transparent,
                dismissible: true,
                semanticsLabel: '关闭菜单',
                onDismiss: onDismiss,
              ),
              CustomSingleChildLayout(
                delegate: _RadioMenuPositionDelegate(
                  tapPosition: tapPosition,
                  menuWidth: menuWidth,
                  maximumHeight: maximumHeight,
                  opensRight: opensRight,
                  opensDown: opensDown,
                  viewPadding: viewPadding,
                  edgePadding: _edgePadding,
                  menuGap: _menuGap,
                ),
                child: FadeTransition(
                  key: ValueKey('$menuId-fade'),
                  opacity: panelOpacityAnimation,
                  alwaysIncludeSemantics: true,
                  child: _RadioMenuPanel(
                    key: ValueKey('$menuId-panel'),
                    menuId: menuId,
                    options: options,
                    multiSelect: multiSelect,
                    scheme: scheme,
                    heightAnimation: heightAnimation,
                    optionOpacityAnimations: optionOpacityAnimations,
                    onOptionSelected: onOptionSelected,
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  List<Animation<double>> _buildOptionOpacityAnimations() {
    if (options.isEmpty) return const [];

    final fadeInGap = options.length == 1
        ? 0.0
        : (1 - _itemFadeInDuration) / (options.length - 1);
    final finalFadeOutStart = 1 - _itemFadeOutDuration - _itemFadeOutDelay;
    final fadeOutGap = options.length == 1
        ? 0.0
        : finalFadeOutStart / (options.length - 1);

    return [
      for (var index = 0; index < options.length; index++)
        _DirectionalCurveAnimation(
          parent: animation,
          forwardCurve: Interval(
            index * fadeInGap,
            index * fadeInGap + _itemFadeInDuration,
          ),
          reverseCurve: Interval(
            index * fadeOutGap,
            index * fadeOutGap + _itemFadeOutDuration,
          ),
        ),
    ];
  }

  double _measureMenuWidth(BuildContext context, double availableWidth) {
    final textScaler = MediaQuery.textScalerOf(context);
    final textDirection = Directionality.of(context);
    var longestLabel = 0.0;
    for (final option in options) {
      final painter = TextPainter(
        text: TextSpan(
          text: option.label,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
        ),
        maxLines: 1,
        textDirection: textDirection,
        textScaler: textScaler,
      )..layout();
      longestLabel = math.max(longestLabel, painter.width);
      painter.dispose();
    }

    final constrainedMaximumWidth = math.min(maximumWidth, availableWidth);
    final constrainedMinimumWidth = math.min(
      minimumWidth,
      constrainedMaximumWidth,
    );
    return (longestLabel + 54)
        .clamp(constrainedMinimumWidth, constrainedMaximumWidth)
        .toDouble();
  }
}

class _RadioMenuPositionDelegate extends SingleChildLayoutDelegate {
  const _RadioMenuPositionDelegate({
    required this.tapPosition,
    required this.menuWidth,
    required this.maximumHeight,
    required this.opensRight,
    required this.opensDown,
    required this.viewPadding,
    required this.edgePadding,
    required this.menuGap,
  });

  final Offset tapPosition;
  final double menuWidth;
  final double? maximumHeight;
  final bool opensRight;
  final bool opensDown;
  final EdgeInsets viewPadding;
  final double edgePadding;
  final double menuGap;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) {
    final availableHeight = math.max(
      0.0,
      constraints.maxHeight - viewPadding.vertical - edgePadding * 2,
    );
    final menuHeight = math.min(
      availableHeight,
      maximumHeight ?? availableHeight,
    );
    return BoxConstraints(
      minWidth: menuWidth,
      maxWidth: menuWidth,
      maxHeight: menuHeight,
    );
  }

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final safeLeft = viewPadding.left + edgePadding;
    final safeRight = size.width - viewPadding.right - edgePadding;
    final safeTop = viewPadding.top + edgePadding;
    final safeBottom = size.height - viewPadding.bottom - edgePadding;
    final preferredLeft = opensRight
        ? tapPosition.dx + menuGap
        : tapPosition.dx - menuGap - childSize.width;
    final maxLeft = math.max(safeLeft, safeRight - childSize.width);
    final left = preferredLeft.clamp(safeLeft, maxLeft).toDouble();
    final preferredTop = opensDown
        ? tapPosition.dy - 12
        : tapPosition.dy + 12 - childSize.height;
    final maxTop = math.max(safeTop, safeBottom - childSize.height);
    final top = preferredTop.clamp(safeTop, maxTop).toDouble();
    return Offset(left, top);
  }

  @override
  bool shouldRelayout(covariant _RadioMenuPositionDelegate oldDelegate) {
    return tapPosition != oldDelegate.tapPosition ||
        menuWidth != oldDelegate.menuWidth ||
        maximumHeight != oldDelegate.maximumHeight ||
        opensRight != oldDelegate.opensRight ||
        opensDown != oldDelegate.opensDown ||
        viewPadding != oldDelegate.viewPadding ||
        edgePadding != oldDelegate.edgePadding ||
        menuGap != oldDelegate.menuGap;
  }
}

class _RadioMenuPanel extends StatelessWidget {
  const _RadioMenuPanel({
    super.key,
    required this.menuId,
    required this.options,
    required this.multiSelect,
    required this.scheme,
    required this.heightAnimation,
    required this.optionOpacityAnimations,
    required this.onOptionSelected,
  });

  final String menuId;
  final List<RadioMenuOption> options;
  final bool multiSelect;
  final ColorScheme scheme;
  final Animation<double> heightAnimation;
  final List<Animation<double>> optionOpacityAnimations;
  final ValueChanged<RadioMenuOption> onOptionSelected;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: scheme.surfaceContainerHigh,
      surfaceTintColor: Colors.transparent,
      shadowColor: scheme.shadow.withValues(alpha: 0.18),
      elevation: 3,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.55)),
      ),
      clipBehavior: Clip.antiAlias,
      child: AnimatedBuilder(
        animation: heightAnimation,
        builder: (context, child) => Align(
          key: ValueKey('$menuId-reveal'),
          alignment: Alignment.topCenter,
          widthFactor: 1,
          heightFactor: heightAnimation.value,
          child: child,
        ),
        child: SingleChildScrollView(
          key: ValueKey('$menuId-scroll'),
          primary: false,
          physics: const ClampingScrollPhysics(),
          padding: const EdgeInsets.all(6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var index = 0; index < options.length; index++)
                FadeTransition(
                  key: ValueKey('$menuId-option-${options[index].id}-fade'),
                  opacity: optionOpacityAnimations[index],
                  alwaysIncludeSemantics: true,
                  child: _RadioMenuOptionTile(
                    key: ValueKey('$menuId-option-${options[index].id}'),
                    option: options[index],
                    multiSelect: multiSelect,
                    scheme: scheme,
                    onTap: () => onOptionSelected(options[index]),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DirectionalCurveAnimation extends Animation<double> {
  const _DirectionalCurveAnimation({
    required this.parent,
    required this.forwardCurve,
    required this.reverseCurve,
  });

  final Animation<double> parent;
  final Curve forwardCurve;
  final Curve reverseCurve;

  @override
  void addListener(VoidCallback listener) => parent.addListener(listener);

  @override
  void removeListener(VoidCallback listener) => parent.removeListener(listener);

  @override
  void addStatusListener(AnimationStatusListener listener) =>
      parent.addStatusListener(listener);

  @override
  void removeStatusListener(AnimationStatusListener listener) =>
      parent.removeStatusListener(listener);

  @override
  AnimationStatus get status => parent.status;

  @override
  double get value {
    final value = parent.value;
    if (value == 0 || value == 1) return value;
    final curve = status == AnimationStatus.reverse
        ? reverseCurve
        : forwardCurve;
    return curve.transform(value);
  }
}

class _TweenCurve extends Curve {
  const _TweenCurve(this.begin, this.end, {required this.curve});

  final double begin;
  final double end;
  final Curve curve;

  @override
  double transformInternal(double t) {
    return begin + (end - begin) * curve.transform(t);
  }
}

class _RadioMenuOptionTile extends StatelessWidget {
  const _RadioMenuOptionTile({
    super.key,
    required this.option,
    required this.multiSelect,
    required this.scheme,
    required this.onTap,
  });

  final RadioMenuOption option;
  final bool multiSelect;
  final ColorScheme scheme;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final enabledColor = option.selected ? scheme.primary : scheme.onSurface;
    final color = option.enabled
        ? enabledColor
        : scheme.onSurface.withValues(alpha: 0.38);
    final icon = multiSelect
        ? option.selected
              ? Icons.check_box_rounded
              : Icons.check_box_outline_blank_rounded
        : option.selected
        ? Icons.radio_button_checked_rounded
        : Icons.radio_button_unchecked_rounded;

    return Semantics(
      selected: option.selected,
      enabled: option.enabled,
      button: true,
      child: SizedBox(
        height: 48,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: option.enabled ? onTap : null,
            borderRadius: BorderRadius.circular(8),
            overlayColor: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.pressed)) {
                return scheme.onSurface.withValues(alpha: 0.10);
              }
              if (states.contains(WidgetState.hovered) ||
                  states.contains(WidgetState.focused)) {
                return scheme.onSurface.withValues(alpha: 0.06);
              }
              return null;
            }),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  Icon(icon, size: 20, color: color),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      option.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: color,
                        fontSize: 14,
                        fontWeight: option.selected
                            ? FontWeight.w600
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
