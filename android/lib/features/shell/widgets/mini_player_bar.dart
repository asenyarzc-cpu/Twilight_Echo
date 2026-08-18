import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart' show ProcessingState;

import '../../../theme/app_motion.dart';
import '../../player/player_controller.dart';
import '../../player/widgets/spinning_cover_art.dart';

/// Mini "now playing" strip that shares the bottom toolbar capsule: spinning
/// cover art on the left, track title in the middle, transport controls on
/// the right. Swapped in and out of the capsule by the toolbar pager.
class MiniPlayerBar extends ConsumerWidget {
  const MiniPlayerBar({
    super.key,
    required this.width,
    required this.height,
    required this.onOpenPlayer,
  });

  final double width;
  final double height;
  final VoidCallback onOpenPlayer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final vm = ref.watch(
      playerControllerProvider.select(
        (s) => (
          track: s.track,
          playing: s.playing,
          loading: s.loading,
          buffering: s.buffering,
          ended: s.processingState == ProcessingState.completed,
          canPrev: s.canPlayPrevious,
          canNext: s.canPlayNext,
        ),
      ),
    );
    final controller = ref.read(playerControllerProvider.notifier);
    final track = vm.track;
    final canControl = track != null && !vm.loading;
    // Narrow capsules (small screens at min action width) drop the artist
    // line and shrink the artwork/buttons so everything still fits.
    final compact = width < 240;
    final coverSize = compact ? 36.0 : 44.0;
    final buttonSize = compact ? 36.0 : 40.0;

    return Row(
      children: [
        const SizedBox(width: 4),
        Expanded(
          child: Tooltip(
            message: '打开播放页',
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onOpenPlayer,
              child: Row(
                children: [
                  SizedBox.square(
                    dimension: coverSize,
                    child: track == null
                        ? _IdleCover(scheme: scheme)
                        : SpinningCoverArt(
                            track: track,
                            size: coverSize,
                            placeholder: ColoredBox(
                              color: scheme.surfaceContainerHighest,
                              child: Center(
                                child: Icon(
                                  Icons.album_rounded,
                                  size: 20,
                                  color: scheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _TrackLabels(
                      track: track,
                      compact: compact,
                      scheme: scheme,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        _MiniControlButton(
          tooltip: '上一首',
          icon: Icons.skip_previous_rounded,
          size: buttonSize,
          onPressed: canControl && vm.canPrev ? controller.playPrevious : null,
        ),
        _MiniPlayButton(
          playing: vm.playing,
          showSpinner: vm.loading || vm.buffering,
          ended: vm.ended,
          canControl: canControl,
          controller: controller,
          size: buttonSize,
        ),
        _MiniControlButton(
          tooltip: '下一首',
          icon: Icons.skip_next_rounded,
          size: buttonSize,
          onPressed: canControl && vm.canNext ? controller.playNext : null,
        ),
        const SizedBox(width: 4),
      ],
    );
  }
}

class _IdleCover extends StatelessWidget {
  const _IdleCover({required this.scheme});

  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: scheme.surfaceContainerHighest,
      ),
      child: Center(
        child: Icon(
          Icons.album_rounded,
          size: 20,
          color: scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _TrackLabels extends StatelessWidget {
  const _TrackLabels({
    required this.track,
    required this.compact,
    required this.scheme,
  });

  final PlayerTrack? track;
  final bool compact;
  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    final track = this.track;
    if (track == null) {
      return Text(
        '暂无播放',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: scheme.onSurfaceVariant.withValues(alpha: 0.72),
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      );
    }
    final artist = track.artist.trim();
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          track.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: scheme.onSurface,
            fontSize: 13,
            fontWeight: FontWeight.w600,
            height: 1.2,
          ),
        ),
        if (!compact && artist.isNotEmpty) ...[
          const SizedBox(height: 1),
          Text(
            artist,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontSize: 10.5,
              fontWeight: FontWeight.w500,
              height: 1.2,
            ),
          ),
        ],
      ],
    );
  }
}

class _MiniControlButton extends StatelessWidget {
  const _MiniControlButton({
    required this.tooltip,
    required this.icon,
    required this.size,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final double size;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = onPressed != null;
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      icon: Icon(
        icon,
        size: 24,
        color: scheme.onSurfaceVariant.withValues(alpha: enabled ? 1 : 0.35),
      ),
    );
  }
}

class _MiniPlayButton extends StatelessWidget {
  const _MiniPlayButton({
    required this.playing,
    required this.showSpinner,
    required this.ended,
    required this.canControl,
    required this.controller,
    required this.size,
  });

  final bool playing;
  final bool showSpinner;
  final bool ended;
  final bool canControl;
  final PlayerController controller;
  final double size;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = scheme.onSurfaceVariant.withValues(
      alpha: canControl ? 1 : 0.35,
    );
    final Widget glyph;
    if (showSpinner) {
      glyph = SizedBox.square(
        key: const ValueKey('mini-play:spinner'),
        dimension: 16,
        child: CircularProgressIndicator(
          strokeWidth: 2.4,
          color: scheme.onSurfaceVariant,
        ),
      );
    } else {
      final icon = ended
          ? Icons.replay_rounded
          : playing
          ? Icons.pause_rounded
          : Icons.play_arrow_rounded;
      glyph = Icon(
        icon,
        key: ValueKey('mini-play:${icon.codePoint}'),
        size: 26,
        color: color,
      );
    }
    return IconButton(
      tooltip: ended
          ? '重播'
          : playing
          ? '暂停'
          : '播放',
      onPressed: canControl
          ? (ended ? controller.replay : controller.toggle)
          : null,
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      icon: AnimatedSwitcher(
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : AppMotion.medium,
        switchInCurve: AppMotion.emphasizedDecelerate,
        switchOutCurve: AppMotion.emphasizedAccelerate,
        transitionBuilder: (child, animation) {
          return FadeTransition(
            opacity: animation,
            child: ScaleTransition(
              scale: Tween<double>(begin: 0.82, end: 1).animate(animation),
              child: child,
            ),
          );
        },
        child: glyph,
      ),
    );
  }
}
