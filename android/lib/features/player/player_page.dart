import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../theme/app_motion.dart';
import 'player_controller.dart';
import 'widgets/album_cluster.dart';
import 'widgets/immersive_background.dart';
import 'widgets/lyrics_panel.dart';
import 'widgets/top_chrome_row.dart';
import 'widgets/transport_bar.dart';

class PlayerPage extends ConsumerStatefulWidget {
  const PlayerPage({
    super.key,
    required this.returnLocation,
    required this.progress,
    required this.active,
    required this.onDismissRequested,
  });

  final String returnLocation;

  /// Shell-owned reveal progress: 0 parks the page just below the screen,
  /// 1 seats it fully. Driven either by a settle animation or directly by the
  /// pull gesture, which is why the page never animates itself.
  final Animation<double> progress;

  /// True only while `/player` is the active route. The page stays mounted
  /// below that (during a pull, or parked at progress 0), so anything with
  /// side effects outside the page — error toasts, hit testing — must be
  /// gated on this.
  final bool active;

  /// Asks the shell to slide the page away and navigate to [target], or to
  /// the remembered return location when omitted.
  final void Function([String? target]) onDismissRequested;

  @override
  ConsumerState<PlayerPage> createState() => _PlayerPageState();
}

class _PlayerPageState extends ConsumerState<PlayerPage> {
  late Animation<Offset> _slide;

  @override
  void initState() {
    super.initState();
    _slide = _slideFor(widget.progress);
  }

  @override
  void didUpdateWidget(covariant PlayerPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.progress != widget.progress) {
      _slide = _slideFor(widget.progress);
    }
  }

  Animation<Offset> _slideFor(Animation<double> progress) {
    return progress.drive(
      Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Watch only what decides the page skeleton. `position` ticks every few
    // frames while playing; keeping it out of this watch stops the cover,
    // title and background from rebuilding on every tick.
    final showEmpty = ref.watch(
      playerControllerProvider.select((s) => s.track == null && !s.loading),
    );

    ref.listen<PlayerState>(playerControllerProvider, (prev, next) {
      // The page outlives the route, so without this guard a playback error
      // would raise a snack bar over whatever page the user is actually on.
      if (!widget.active) return;
      final error = next.error;
      if (error != null && error != prev?.error) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error), duration: const Duration(seconds: 3)),
        );
      }
    });

    // Back handling and pop scoping live in AppShell: this subtree is a
    // sibling of the route content rather than the route itself, so a
    // PopScope here would register against the shell's own ModalRoute.
    return SlideTransition(
      key: const ValueKey('player-exit-slide'),
      position: _slide,
      child: IgnorePointer(
        ignoring: !widget.active,
        child: Scaffold(
          // The layer is pinned to the full screen height; letting the
          // keyboard resize it would re-run the backdrop's blur pipeline.
          resizeToAvoidBottomInset: false,
          body: Stack(
            fit: StackFit.expand,
            children: [
              const Positioned.fill(
                key: ValueKey('player-backdrop'),
                child: RepaintBoundary(child: ImmersiveBackground()),
              ),
              SafeArea(
                key: const ValueKey('player-chrome'),
                child: Column(
                  children: [
                    TopChromeRow(
                      onOpenSongs: () => widget.onDismissRequested('/songs'),
                    ),
                    Expanded(
                      child: showEmpty
                          ? const _EmptyPlayer()
                          : const _NowPlayingBody(),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NowPlayingBody extends ConsumerStatefulWidget {
  const _NowPlayingBody();

  @override
  ConsumerState<_NowPlayingBody> createState() => _NowPlayingBodyState();
}

class _NowPlayingBodyState extends ConsumerState<_NowPlayingBody> {
  late final PageController _pageController;
  int? _compactPagerPointer;
  Offset _compactPagerPointerDelta = Offset.zero;
  bool _compactPagerHorizontalDrag = false;
  bool _compactPagerScrolling = false;

  bool get _compactPagerMoving =>
      _compactPagerHorizontalDrag || _compactPagerScrolling;

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _openLyricsPage() {
    if (!_pageController.hasClients) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      _pageController.jumpToPage(1);
      return;
    }
    _pageController.animateToPage(
      1,
      duration: AppMotion.long,
      curve: AppMotion.emphasized,
    );
  }

  bool _handleCompactPagerScroll(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification is ScrollStartNotification &&
        notification.dragDetails == null) {
      _setCompactPagerScrolling(true);
    } else if (notification is ScrollEndNotification) {
      _setCompactPagerScrolling(false);
    }
    return false;
  }

  void _handleCompactPagerPointerDown(PointerDownEvent event) {
    if (_compactPagerPointer != null) return;
    _compactPagerPointer = event.pointer;
    _compactPagerPointerDelta = Offset.zero;
  }

  void _handleCompactPagerPointerMove(PointerMoveEvent event) {
    if (_compactPagerPointer != event.pointer || _compactPagerHorizontalDrag) {
      return;
    }
    _compactPagerPointerDelta += event.delta;
    if (_compactPagerPointerDelta.dx.abs() >= 4 &&
        _compactPagerPointerDelta.dx.abs() >
            _compactPagerPointerDelta.dy.abs()) {
      _setCompactPagerHorizontalDrag(true);
    }
  }

  void _handleCompactPagerPointerEnd(PointerEvent event) {
    if (_compactPagerPointer != event.pointer) return;
    _compactPagerPointer = null;
    _compactPagerPointerDelta = Offset.zero;
    if (_compactPagerHorizontalDrag && _pageController.hasClients) {
      final page = _pageController.page;
      _compactPagerScrolling =
          page != null && (page - page.roundToDouble()).abs() > 0.001;
    }
    _setCompactPagerHorizontalDrag(false);
  }

  void _setCompactPagerHorizontalDrag(bool value) {
    if (_compactPagerHorizontalDrag == value) return;
    final wasMoving = _compactPagerMoving;
    _compactPagerHorizontalDrag = value;
    if (wasMoving != _compactPagerMoving) setState(() {});
  }

  void _setCompactPagerScrolling(bool value) {
    if (_compactPagerScrolling == value) return;
    final wasMoving = _compactPagerMoving;
    _compactPagerScrolling = value;
    if (wasMoving != _compactPagerMoving) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide =
            constraints.maxWidth >= 720 && constraints.maxHeight >= 460;
        if (wide) {
          return Padding(
            key: const ValueKey('player-wide-layout'),
            padding: const EdgeInsets.fromLTRB(32, 8, 32, 18),
            child: Row(
              children: [
                Expanded(
                  flex: 10,
                  child: Column(
                    children: [
                      const Expanded(
                        child: KeyedSubtree(
                          key: ValueKey('player-wide-album'),
                          child: AlbumPage(wide: true),
                        ),
                      ),
                      const SizedBox(height: 4),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 560),
                        child: const TransportBar(),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 40),
                const Expanded(
                  flex: 11,
                  child: KeyedSubtree(
                    key: ValueKey('player-wide-lyrics'),
                    child: LyricsPanel(),
                  ),
                ),
              ],
            ),
          );
        }

        // Phone layouts keep the swipe gesture between album and lyrics.
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 14),
          child: Column(
            children: [
              Expanded(
                child: NotificationListener<OverscrollIndicatorNotification>(
                  key: const ValueKey('player-compact-pager-edge-guard'),
                  onNotification: (notification) {
                    if (notification.depth == 0) {
                      notification.disallowIndicator();
                    }
                    return false;
                  },
                  child: Listener(
                    key: const ValueKey('player-compact-pager-pointer-guard'),
                    behavior: HitTestBehavior.translucent,
                    onPointerDown: _handleCompactPagerPointerDown,
                    onPointerMove: _handleCompactPagerPointerMove,
                    onPointerUp: _handleCompactPagerPointerEnd,
                    onPointerCancel: _handleCompactPagerPointerEnd,
                    child: NotificationListener<ScrollNotification>(
                      onNotification: _handleCompactPagerScroll,
                      child: PageView(
                        key: const ValueKey('player-compact-pager'),
                        controller: _pageController,
                        clipBehavior: Clip.hardEdge,
                        children: [
                          ClipRect(
                            key: const ValueKey('player-compact-album-clip'),
                            clipBehavior: Clip.hardEdge,
                            child: AlbumPage(onOpenLyrics: _openLyricsPage),
                          ),
                          ClipRect(
                            key: const ValueKey('player-compact-lyrics-clip'),
                            clipBehavior: Clip.hardEdge,
                            child: LyricsPanel(
                              edgeFadeEnabled: !_compactPagerMoving,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const TransportBar(),
            ],
          ),
        );
      },
    );
  }
}

class _EmptyPlayer extends StatelessWidget {
  const _EmptyPlayer();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.music_note_rounded,
              size: 56,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(height: 14),
            Text(
              '没有正在播放的歌曲哦',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: scheme.onSurface,
                fontSize: 18,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
