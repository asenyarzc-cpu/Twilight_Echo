import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart' show Ticker;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../theme/app_motion.dart';
import '../lyric_parser.dart';
import '../player_controller.dart';
import 'lyric_line.dart';

const double _kLyricScrollAnchor = 0.42;
const double _kLyricScrollStiffness = 210;
const double _kLyricScrollDamping = 27;
const double _kLyricEdgeFadeExtent = 48;
const Duration _kLyricLineLayoutDuration = Duration(milliseconds: 380);
const Duration _kLyricBlurRestoreDelay = Duration(seconds: 3);

class KaraokeLyricsView extends ConsumerStatefulWidget {
  const KaraokeLyricsView({
    super.key,
    required this.lyrics,
    required this.showTranslation,
    this.edgeFadeEnabled = true,
  });

  final KaraokeLyrics lyrics;
  final bool showTranslation;
  final bool edgeFadeEnabled;

  @override
  ConsumerState<KaraokeLyricsView> createState() => _KaraokeLyricsViewState();
}

class _KaraokeLyricsViewState extends ConsumerState<KaraokeLyricsView>
    with TickerProviderStateMixin {
  final _controller = ScrollController();
  final _lineKeys = <int, GlobalKey>{};
  final _viewportKey = GlobalKey();
  // Per-tick playback values flow through these notifiers so the
  // ListView itself only rebuilds when the active line (or a tap selection)
  // changes — not on every position stream emission.
  final _anchorMs = ValueNotifier<int>(0);
  final _playing = ValueNotifier<bool>(false);
  final _buffering = ValueNotifier<bool>(false);
  final _blurSuppressed = ValueNotifier<bool>(false);
  int _activeIndex = -1;
  int? _selectedIndex;
  Timer? _selectedLineTimer;
  Timer? _autoScrollResumeTimer;
  Timer? _blurRestoreTimer;
  Timer? _manualBlurRestoreTimer;
  Timer? _translationAnchorTimer;
  late final Ticker _translationLayoutTicker;
  late final Ticker _lyricScrollTicker;
  final Stopwatch _lineLayoutStopwatch = Stopwatch();
  double? _translationAnchorY;
  double? _lyricScrollTarget;
  double _lyricScrollVelocity = 0;
  Duration? _lyricScrollLastElapsed;
  int _translationAnchorGeneration = 0;
  bool _translationCorrectionScheduled = false;
  bool _lyricScrollTargetIsRough = false;
  bool _userScrollLocked = false;
  bool _manualBlurSuppressed = false;
  bool _selectionBlurSuppressed = false;
  bool _skipNextLineStagger = false;
  int _lyricStaggerGeneration = 0;
  int _lyricStaggerVisibleStartIndex = 0;
  double _lyricStaggerShiftPx = 0;
  Timer? _lyricStaggerResetTimer;
  Timer? _lineAdvanceTimer;
  final Stopwatch _anchorAge = Stopwatch();

  @override
  void initState() {
    super.initState();
    _translationLayoutTicker = createTicker(_handleTranslationLayoutTick);
    _lyricScrollTicker = createTicker(_handleLyricScrollTick);
    final initial = ref.read(playerControllerProvider);
    _anchorMs.value = initial.position.inMilliseconds;
    _playing.value = initial.playing;
    _buffering.value = initial.buffering;
    if (initial.playing && !initial.buffering) _anchorAge.start();
    _activeIndex = widget.lyrics.activeIndex(initial.position);
    _scheduleScrollToActive(retriesLeft: 1);
    _scheduleLineAdvance();
    ref.listenManual(playerControllerProvider.select((s) => s.position), (
      previous,
      next,
    ) {
      _reanchorPlaybackClock(next);
      _syncActiveLine(next);
      _scheduleLineAdvance();
    });
    ref.listenManual(playerControllerProvider.select((s) => s.playing), (
      previous,
      next,
    ) {
      final current = ref.read(playerControllerProvider);
      _reanchorPlaybackClock(current.position, playing: next);
      _playing.value = next;
      _scheduleLineAdvance();
    });
    ref.listenManual(playerControllerProvider.select((s) => s.buffering), (
      previous,
      next,
    ) {
      _buffering.value = next;
      final current = ref.read(playerControllerProvider);
      _reanchorPlaybackClock(current.position, buffering: next);
      _scheduleLineAdvance();
    });
  }

  @override
  void didUpdateWidget(covariant KaraokeLyricsView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(widget.lyrics, oldWidget.lyrics)) {
      _stopTranslationLayoutAnchor();
      _stopLyricScroll(resetVelocity: true);
      _lineKeys.clear();
      _selectedIndex = null;
      _selectedLineTimer?.cancel();
      _blurRestoreTimer?.cancel();
      _manualBlurRestoreTimer?.cancel();
      _lyricStaggerResetTimer?.cancel();
      _manualBlurSuppressed = false;
      _selectionBlurSuppressed = false;
      _skipNextLineStagger = false;
      _lyricStaggerGeneration++;
      _lyricStaggerShiftPx = 0;
      _syncBlurSuppression();
      final current = ref.read(playerControllerProvider);
      final position = current.position;
      _reanchorPlaybackClock(position);
      _activeIndex = widget.lyrics.activeIndex(position);
      _scheduleScrollToActive(retriesLeft: 1);
      _scheduleLineAdvance();
      return;
    }
    if (widget.showTranslation != oldWidget.showTranslation) {
      _beginTranslationLayoutAnchor();
    }
  }

  @override
  void dispose() {
    _selectedLineTimer?.cancel();
    _autoScrollResumeTimer?.cancel();
    _blurRestoreTimer?.cancel();
    _manualBlurRestoreTimer?.cancel();
    _translationAnchorTimer?.cancel();
    _lyricStaggerResetTimer?.cancel();
    _lineAdvanceTimer?.cancel();
    _translationLayoutTicker.dispose();
    _lyricScrollTicker.dispose();
    _controller.dispose();
    _anchorMs.dispose();
    _playing.dispose();
    _buffering.dispose();
    _blurSuppressed.dispose();
    super.dispose();
  }

  void _selectLine(int index) {
    _cancelLyricStagger();
    _skipNextLineStagger = true;
    _suppressBlurForSelection();
    if (_selectedIndex != index) {
      setState(() => _selectedIndex = index);
    }
    _selectedLineTimer?.cancel();
    _selectedLineTimer = Timer(const Duration(milliseconds: 1200), () {
      if (!mounted || _selectedIndex != index) return;
      setState(() => _selectedIndex = null);
    });
  }

  void _syncActiveLine(Duration position) {
    final next = widget.lyrics.activeIndex(position);
    if (next == _activeIndex) return;
    final previous = _activeIndex;
    final skipLineStagger = _skipNextLineStagger;
    _skipNextLineStagger = false;
    final useLineStagger =
        previous >= 0 &&
        next >= 0 &&
        (next - previous).abs() <= 10 &&
        !_userScrollLocked &&
        !skipLineStagger &&
        !MediaQuery.disableAnimationsOf(context);
    setState(() => _activeIndex = next);
    _lineLayoutStopwatch
      ..reset()
      ..start();
    if (useLineStagger) {
      _scheduleLineStaggerToActive(retriesLeft: 1);
    } else {
      _cancelLyricStagger();
      _scheduleScrollToActive(retriesLeft: 1);
    }
  }

  /// The position stream only ticks every ~200 ms, so driving line advances
  /// from it alone lands them visibly late and unevenly. Extrapolate
  /// wall-clock time past the latest anchor (same idea as _KaraokeLineText)
  /// and fire a one-shot timer exactly at the next line boundary.
  void _scheduleLineAdvance() {
    _lineAdvanceTimer?.cancel();
    if (!_playing.value || _buffering.value) return;
    final lines = widget.lyrics.lines;
    final nextIndex = _activeIndex + 1;
    if (_activeIndex < 0 || nextIndex >= lines.length) return;
    final nowMs = _anchorMs.value + _anchorAge.elapsedMilliseconds;
    final waitMs = math.max(0, lines[nextIndex].startMs - nowMs);
    _lineAdvanceTimer = Timer(Duration(milliseconds: waitMs), () {
      if (!mounted) return;
      if (_buffering.value) {
        // Playback is stalled, so extrapolated time is running ahead of the
        // real position. Advancing now would flip the line early and snap
        // back on the next anchor; wait for a real anchor instead.
        return;
      }
      _syncActiveLine(
        Duration(
          milliseconds: _anchorMs.value + _anchorAge.elapsedMilliseconds,
        ),
      );
      _scheduleLineAdvance();
    });
  }

  void _reanchorPlaybackClock(
    Duration position, {
    bool? playing,
    bool? buffering,
  }) {
    _anchorAge
      ..stop()
      ..reset();
    _anchorMs.value = position.inMilliseconds;
    if ((playing ?? _playing.value) && !(buffering ?? _buffering.value)) {
      _anchorAge.start();
    }
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    final userDriven =
        (notification is ScrollStartNotification &&
            notification.dragDetails != null) ||
        (notification is ScrollUpdateNotification &&
            notification.dragDetails != null) ||
        (notification is OverscrollNotification &&
            notification.dragDetails != null);
    if (userDriven) {
      _holdAutoScrollForUser();
    } else if (notification is ScrollEndNotification) {
      _releaseAutoScrollAfterUserScroll();
    }
    return false;
  }

  void _holdAutoScrollForUser() {
    _autoScrollResumeTimer?.cancel();
    _manualBlurRestoreTimer?.cancel();
    _stopTranslationLayoutAnchor();
    _stopLyricScroll(resetVelocity: true);
    _cancelLyricStagger();
    _userScrollLocked = true;
    _manualBlurSuppressed = true;
    _syncBlurSuppression();
  }

  void _releaseAutoScrollAfterUserScroll() {
    if (!_userScrollLocked) return;
    _manualBlurRestoreTimer?.cancel();
    _manualBlurRestoreTimer = Timer(_kLyricBlurRestoreDelay, () {
      if (!mounted) return;
      _manualBlurSuppressed = false;
      _syncBlurSuppression();
    });
    _autoScrollResumeTimer?.cancel();
    _autoScrollResumeTimer = Timer(const Duration(milliseconds: 1800), () {
      if (!mounted) return;
      _userScrollLocked = false;
      _scheduleScrollToActive(retriesLeft: 1);
    });
  }

  void _scheduleScrollToActive({required int retriesLeft}) {
    if (_userScrollLocked || _translationLayoutTicker.isActive) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _activeIndex < 0 || _userScrollLocked) return;
      if (!_controller.hasClients) {
        if (retriesLeft > 0) {
          _scheduleScrollToActive(retriesLeft: retriesLeft - 1);
        }
        return;
      }

      _refreshLyricScrollTarget();
      final target = _lyricScrollTarget;
      if (target == null) return;

      if (MediaQuery.disableAnimationsOf(context)) {
        _controller.jumpTo(target);
        if (_lyricScrollTargetIsRough && retriesLeft > 0) {
          _scheduleScrollToActive(retriesLeft: retriesLeft - 1);
        }
        return;
      }

      _startLyricScroll();
    });
  }

  void _scheduleLineStaggerToActive({required int retriesLeft}) {
    _stopLyricScroll(resetVelocity: true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _activeIndex < 0 || _userScrollLocked) return;
      if (!_controller.hasClients) {
        if (retriesLeft > 0) {
          _scheduleLineStaggerToActive(retriesLeft: retriesLeft - 1);
        }
        return;
      }

      _refreshLyricScrollTarget();
      final target = _lyricScrollTarget;
      if (target == null) return;
      if (_lyricScrollTargetIsRough) {
        _startLyricScroll();
        return;
      }

      final shift = target - _controller.offset;
      if (shift.abs() >= 0.25) {
        final visibleStart = _firstVisibleLyricIndex();
        _controller.jumpTo(target);
        setState(() {
          _lyricStaggerGeneration++;
          _lyricStaggerVisibleStartIndex = visibleStart;
          _lyricStaggerShiftPx = shift;
        });
        _scheduleLyricStaggerReset();
      }
      // Exact stagger path ends here: the list has already been relocated and
      // each visible row owns the inverse shift animation. Running the normal
      // list-follow spring as well makes two independent Y motions compete.
    });
  }

  /// Zeroes [_lyricStaggerShiftPx] once the wave has surely finished (the
  /// accumulated per-line delays plus spring settling stay well under this
  /// bound). Field-only on purpose: rows already built keep their finished
  /// state, while rows materialized later by ordinary scrolling must not
  /// pick up a stale initial shift in initState.
  void _scheduleLyricStaggerReset() {
    _lyricStaggerResetTimer?.cancel();
    final generation = _lyricStaggerGeneration;
    _lyricStaggerResetTimer = Timer(const Duration(milliseconds: 1400), () {
      if (!mounted || _lyricStaggerGeneration != generation) return;
      _lyricStaggerShiftPx = 0;
    });
  }

  int _firstVisibleLyricIndex() {
    final viewportObject = _viewportKey.currentContext?.findRenderObject();
    if (viewportObject is! RenderBox || !viewportObject.hasSize) {
      return _activeIndex;
    }
    int? first;
    for (final entry in _lineKeys.entries) {
      final lineObject = entry.value.currentContext?.findRenderObject();
      if (lineObject is! RenderBox ||
          !lineObject.attached ||
          !lineObject.hasSize) {
        continue;
      }
      final top = lineObject
          .localToGlobal(Offset.zero, ancestor: viewportObject)
          .dy;
      final bottom = top + lineObject.size.height;
      if (bottom > 0 && top < viewportObject.size.height) {
        first = first == null ? entry.key : math.min(first, entry.key);
      }
    }
    return first ?? _activeIndex;
  }

  void _cancelLyricStagger() {
    _lyricStaggerResetTimer?.cancel();
    if (_lyricStaggerShiftPx == 0) return;
    setState(() {
      _lyricStaggerGeneration++;
      _lyricStaggerShiftPx = 0;
    });
  }

  void _refreshLyricScrollTarget() {
    if (!_controller.hasClients || _activeIndex < 0) return;

    final currentY = _activeLineCenterInViewport();
    final viewportObject = _viewportKey.currentContext?.findRenderObject();
    if (currentY != null &&
        viewportObject is RenderBox &&
        viewportObject.attached &&
        viewportObject.hasSize) {
      final position = _controller.position;
      _lyricScrollTarget =
          (_controller.offset +
                  currentY -
                  viewportObject.size.height * _kLyricScrollAnchor)
              .clamp(position.minScrollExtent, position.maxScrollExtent);
      _lyricScrollTargetIsRough = false;
      return;
    }

    // A large seek can target a line that ListView has not built yet. Move
    // toward an estimated offset without teleporting; as soon as the row is
    // materialized, the same spring retargets to its exact visual center.
    final lineCount = widget.lyrics.lines.length;
    if (lineCount <= 0) return;
    final position = _controller.position;
    final denominator = math.max(1, lineCount - 1);
    _lyricScrollTarget =
        (position.maxScrollExtent *
                (_activeIndex.clamp(0, lineCount - 1) / denominator))
            .clamp(position.minScrollExtent, position.maxScrollExtent);
    _lyricScrollTargetIsRough = true;
  }

  void _startLyricScroll() {
    if (_lyricScrollTarget == null || _userScrollLocked) return;
    _lyricScrollLastElapsed = null;
    if (!_lyricScrollTicker.isActive) {
      _lyricScrollTicker.start();
    }
  }

  void _handleLyricScrollTick(Duration elapsed) {
    if (!mounted || !_controller.hasClients || _userScrollLocked) {
      _stopLyricScroll(resetVelocity: true);
      return;
    }

    final trackingLineLayout =
        _lineLayoutStopwatch.isRunning &&
        _lineLayoutStopwatch.elapsed < _kLyricLineLayoutDuration;
    if (!trackingLineLayout && _lineLayoutStopwatch.isRunning) {
      _lineLayoutStopwatch.stop();
    }
    if (_lyricScrollTargetIsRough || trackingLineLayout) {
      _refreshLyricScrollTarget();
    }

    final target = _lyricScrollTarget;
    if (target == null) {
      _stopLyricScroll(resetVelocity: true);
      return;
    }

    final previousElapsed = _lyricScrollLastElapsed;
    _lyricScrollLastElapsed = elapsed;
    var deltaSeconds = previousElapsed == null
        ? 1 / 60
        : (elapsed - previousElapsed).inMicroseconds /
              Duration.microsecondsPerSecond;
    deltaSeconds = deltaSeconds.clamp(0.0, 0.05);

    var offset = _controller.offset;
    var remaining = deltaSeconds;
    // Small fixed substeps keep the spring stable on occasional long frames.
    while (remaining > 0) {
      final step = math.min(remaining, 1 / 120);
      final acceleration =
          _kLyricScrollStiffness * (target - offset) -
          _kLyricScrollDamping * _lyricScrollVelocity;
      _lyricScrollVelocity += acceleration * step;
      offset += _lyricScrollVelocity * step;
      remaining -= step;
    }

    final position = _controller.position;
    final clampedOffset = offset.clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (clampedOffset != offset) _lyricScrollVelocity = 0;
    if ((clampedOffset - _controller.offset).abs() > 0.01) {
      _controller.jumpTo(clampedOffset);
    }

    final settled =
        !_lyricScrollTargetIsRough &&
        !trackingLineLayout &&
        (target - clampedOffset).abs() < 0.25 &&
        _lyricScrollVelocity.abs() < 4;
    if (settled) {
      if ((target - _controller.offset).abs() > 0.01) {
        _controller.jumpTo(target);
      }
      _stopLyricScroll(resetVelocity: true);
      _scheduleSelectionBlurRestore();
    }
  }

  void _suppressBlurForSelection() {
    _blurRestoreTimer?.cancel();
    _selectionBlurSuppressed = true;
    _syncBlurSuppression();
    // A failed/no-op seek must not leave the focus effect disabled forever.
    _scheduleSelectionBlurRestore();
  }

  void _scheduleSelectionBlurRestore({
    Duration delay = _kLyricBlurRestoreDelay,
  }) {
    if (!_selectionBlurSuppressed) return;
    _blurRestoreTimer?.cancel();
    _blurRestoreTimer = Timer(delay, () {
      if (!mounted) return;
      _selectionBlurSuppressed = false;
      _syncBlurSuppression();
    });
  }

  void _syncBlurSuppression() {
    final suppressed = _manualBlurSuppressed || _selectionBlurSuppressed;
    if (_blurSuppressed.value != suppressed) {
      _blurSuppressed.value = suppressed;
    }
  }

  void _stopLyricScroll({required bool resetVelocity}) {
    if (_lyricScrollTicker.isActive) _lyricScrollTicker.stop();
    _lyricScrollLastElapsed = null;
    if (resetVelocity) _lyricScrollVelocity = 0;
  }

  void _beginTranslationLayoutAnchor() {
    _stopTranslationLayoutAnchor();
    _stopLyricScroll(resetVelocity: true);
    if (_userScrollLocked) return;

    final anchorY = _activeLineCenterInViewport();
    if (anchorY == null) {
      _scheduleScrollToActive(retriesLeft: 1);
      return;
    }

    final generation = ++_translationAnchorGeneration;
    _translationAnchorY = anchorY;
    if (MediaQuery.disableAnimationsOf(context)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || generation != _translationAnchorGeneration) return;
        _correctTranslationLayoutAnchor();
        _translationAnchorY = null;
      });
      return;
    }

    _translationLayoutTicker.start();
    _scheduleTranslationAnchorCorrection();
    _translationAnchorTimer = Timer(
      AppMotion.medium + const Duration(milliseconds: 80),
      () => _finishTranslationLayoutAnchor(generation),
    );
  }

  void _handleTranslationLayoutTick(Duration elapsed) {
    _scheduleTranslationAnchorCorrection();
  }

  void _scheduleTranslationAnchorCorrection() {
    if (_translationCorrectionScheduled) return;
    _translationCorrectionScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _translationCorrectionScheduled = false;
      if (!mounted || !_translationLayoutTicker.isActive || _userScrollLocked) {
        return;
      }
      _correctTranslationLayoutAnchor();
    });
  }

  void _finishTranslationLayoutAnchor(int generation) {
    if (!mounted || generation != _translationAnchorGeneration) return;
    _translationAnchorTimer?.cancel();
    _translationAnchorTimer = null;
    if (_translationLayoutTicker.isActive) {
      _translationLayoutTicker.stop();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          generation != _translationAnchorGeneration ||
          _userScrollLocked) {
        return;
      }
      _correctTranslationLayoutAnchor();
      _translationAnchorY = null;
    });
  }

  void _stopTranslationLayoutAnchor() {
    _translationAnchorGeneration++;
    _translationAnchorTimer?.cancel();
    _translationAnchorTimer = null;
    if (_translationLayoutTicker.isActive) {
      _translationLayoutTicker.stop();
    }
    _translationAnchorY = null;
  }

  double? _activeLineCenterInViewport() {
    if (_activeIndex < 0) return null;
    final viewportObject = _viewportKey.currentContext?.findRenderObject();
    final lineObject = _lineKeys[_activeIndex]?.currentContext
        ?.findRenderObject();
    if (viewportObject is! RenderBox ||
        lineObject is! RenderBox ||
        !viewportObject.attached ||
        !lineObject.attached ||
        !viewportObject.hasSize ||
        !lineObject.hasSize) {
      return null;
    }
    return lineObject
        .localToGlobal(
          Offset(lineObject.size.width / 2, lineObject.size.height / 2),
          ancestor: viewportObject,
        )
        .dy;
  }

  void _correctTranslationLayoutAnchor() {
    final anchorY = _translationAnchorY;
    final currentY = _activeLineCenterInViewport();
    if (anchorY == null || currentY == null || !_controller.hasClients) {
      return;
    }
    final delta = currentY - anchorY;
    if (delta.abs() < 0.25) return;
    final position = _controller.position;
    final target = (_controller.offset + delta).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if ((target - _controller.offset).abs() < 0.25) return;
    _controller.jumpTo(target);
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.read(playerControllerProvider.notifier);
    final lines = widget.lyrics.lines;
    final lyricsList = NotificationListener<ScrollNotification>(
      onNotification: _handleScrollNotification,
      child: ListView.builder(
        key: const ValueKey('karaoke-lyrics-list'),
        controller: _controller,
        physics: const BouncingScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(0, 104, 0, 94),
        itemCount: lines.length,
        itemBuilder: (context, index) {
          final line = lines[index];
          final active = index == _activeIndex;
          final distance = _activeIndex < 0
              ? index
              : (index - _activeIndex).abs();
          return StaggeredLyricLine(
            // The key sits OUTSIDE the stagger Transform on purpose: line
            // measurements (_activeLineCenterInViewport and friends) start
            // at this render object, and localToGlobal excludes the start
            // object's own paint transform. That keeps the spring tracker
            // reading pure *layout* positions — if it saw the stagger
            // offset too, it would fight the wave and yank the whole list
            // (large visible jitter on every line advance).
            key: _lineKeys.putIfAbsent(index, GlobalKey.new),
            lineStartMs: line.startMs,
            index: index,
            generation: _lyricStaggerGeneration,
            shiftPx: _lyricStaggerShiftPx,
            visibleStartIndex: _lyricStaggerVisibleStartIndex,
            child: LyricLineTile(
              line: line,
              active: active,
              selected: index == _selectedIndex,
              distance: distance,
              blurSuppressed: _blurSuppressed,
              showTranslation: widget.showTranslation,
              anchorMs: _anchorMs,
              playing: _playing,
              buffering: _buffering,
              onSelect: () => _selectLine(index),
              onSeek: () {
                _selectLine(index);
                controller.seek(Duration(milliseconds: line.startMs));
              },
            ),
          );
        },
      ),
    );
    return SizedBox.expand(
      key: _viewportKey,
      // Keep the original fade while the lyrics page is fully settled. The
      // compact pager disables it before moving the page, so Xiaomi GPUs never
      // have to transform this full-viewport shader surface. The render object
      // itself never changes type, so disabling the fade cannot detach the
      // ListView or reset its ScrollController position.
      child: _ToggleableLyricEdgeFade(
        key: const ValueKey('karaoke-lyrics-edge-fade'),
        enabled: widget.edgeFadeEnabled,
        fadeExtent: _kLyricEdgeFadeExtent,
        child: lyricsList,
      ),
    );
  }
}

class _ToggleableLyricEdgeFade extends SingleChildRenderObjectWidget {
  const _ToggleableLyricEdgeFade({
    super.key,
    required this.enabled,
    required this.fadeExtent,
    required super.child,
  });

  final bool enabled;
  final double fadeExtent;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return _RenderToggleableLyricEdgeFade(
      enabled: enabled,
      fadeExtent: fadeExtent,
    );
  }

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderToggleableLyricEdgeFade renderObject,
  ) {
    renderObject
      ..enabled = enabled
      ..fadeExtent = fadeExtent;
  }
}

class _RenderToggleableLyricEdgeFade extends RenderProxyBox {
  _RenderToggleableLyricEdgeFade({
    required bool enabled,
    required double fadeExtent,
  }) : _enabled = enabled,
       _fadeExtent = fadeExtent;

  bool _enabled;
  double _fadeExtent;

  bool get enabled => _enabled;

  set enabled(bool value) {
    if (_enabled == value) return;
    _enabled = value;
    markNeedsPaint();
  }

  set fadeExtent(double value) {
    if (_fadeExtent == value) return;
    _fadeExtent = value;
    markNeedsPaint();
  }

  @override
  ShaderMaskLayer? get layer => super.layer as ShaderMaskLayer?;

  @override
  // Keep the compositing requirement stable while toggling the mask. This
  // mirrors Flutter's built-in filter render objects and avoids changing the
  // ancestor layer structure in the middle of a horizontal pager gesture.
  bool get alwaysNeedsCompositing => child != null;

  @override
  void paint(PaintingContext context, Offset offset) {
    if (child == null) {
      layer = null;
      return;
    }
    if (!_enabled) {
      layer = null;
      super.paint(context, offset);
      return;
    }

    assert(needsCompositing);
    final edgeStop = size.height <= 0
        ? 0.0
        : math.min(_fadeExtent / size.height, 0.18);
    layer ??= ShaderMaskLayer();
    layer!
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: const [
          Colors.transparent,
          Colors.white,
          Colors.white,
          Colors.transparent,
        ],
        stops: [0, edgeStop, 1 - edgeStop, 1],
      ).createShader(Offset.zero & size)
      ..maskRect = offset & size
      ..blendMode = BlendMode.dstIn;
    context.pushLayer(layer!, super.paint, offset);
  }
}
