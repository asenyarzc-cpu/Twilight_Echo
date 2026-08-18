import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_symbols_icons/symbols.dart';

import '../../downloads/download_progress.dart';
import '../../shell/player_pull_scope.dart';
import '../player_controller.dart';
import 'player_palette.dart';
import 'track_change_switcher.dart';

class TopChromeRow extends ConsumerWidget {
  const TopChromeRow({super.key, required this.onOpenSongs});

  final VoidCallback onOpenSongs;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(downloadProgressProvider.select((p) => p.isBusy));
    final trackMetadata = ref.watch(
      playerControllerProvider.select(
        (s) =>
            (id: s.track?.id, title: s.track?.title, artist: s.track?.artist),
      ),
    );
    return PlayerPullHandle(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 8, 12, 4),
        child: Row(
          children: [
            Expanded(
              child: TrackChangeSwitcher(
                transitionKey:
                    'top-title:${trackMetadata.id ?? 'loading'}:'
                    '${trackMetadata.title ?? ''}:'
                    '${trackMetadata.artist ?? ''}',
                alignment: Alignment.centerLeft,
                child:
                    trackMetadata.title != null &&
                        trackMetadata.title!.trim().isNotEmpty
                    ? Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            key: const ValueKey('player-header-title'),
                            trackMetadata.title!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: playerInk(context),
                              fontSize: 18,
                              fontWeight: FontWeight.w500,
                              height: 1.05,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            key: const ValueKey('player-header-artist'),
                            trackMetadata.artist?.trim().isNotEmpty == true
                                ? trackMetadata.artist!.trim()
                                : '未知歌手',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: playerMuted(
                                context,
                              ).withValues(alpha: 0.78),
                              fontSize: 13,
                              fontWeight: FontWeight.w400,
                              height: 1.05,
                            ),
                          ),
                        ],
                      )
                    : const SizedBox(height: 36),
              ),
            ),
            const SizedBox(width: 12),
            _ChromeIconButton(
              icon: Symbols.library_music_rounded,
              tooltip: '本地歌曲',
              onPressed: onOpenSongs,
              badge: busy,
            ),
          ],
        ),
      ),
    );
  }
}

class _ChromeIconButton extends StatelessWidget {
  const _ChromeIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.badge = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final bool badge;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.white.withValues(alpha: 0.28),
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: SizedBox(
            width: 36,
            height: 36,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Icon(icon, color: playerInk(context), size: 20),
                if (badge)
                  Positioned(
                    top: 6,
                    right: 6,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: const BoxDecoration(
                        color: Color(0xFFFF6B57),
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
