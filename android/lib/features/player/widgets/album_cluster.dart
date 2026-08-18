import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/settings_store.dart';
import '../../shell/player_pull_scope.dart';
import '../player_controller.dart';
import 'mini_lyrics_panel.dart';
import 'player_palette.dart';
import 'player_cover_actions_sheet.dart';
import 'spinning_cover_art.dart';
import 'track_change_switcher.dart';

const double _compactAlbumContentLift = 36;
const double _miniLyricsBottomInset = 20;

class AlbumPage extends ConsumerWidget {
  const AlbumPage({super.key, this.wide = false, this.onOpenLyrics});

  final bool wide;
  final VoidCallback? onOpenLyrics;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final player = ref.watch(
      playerControllerProvider.select(
        (state) => (
          track: state.track,
          miniLyricsReady: !state.lyricLoading && !state.lyrics.isEmpty,
        ),
      ),
    );
    final miniLyricsEnabled = ref.watch(
      settingsProvider.select((settings) => settings.showMiniLyrics),
    );
    final track = player.track;
    final showMiniLyrics =
        !wide &&
        onOpenLyrics != null &&
        miniLyricsEnabled &&
        player.miniLyricsReady;

    return LayoutBuilder(
      builder: (context, constraints) {
        final coverSize = math.min(
          wide ? 400.0 : 360.0,
          math.min(
            constraints.maxWidth * (wide ? 0.88 : 0.86),
            constraints.maxHeight * (wide ? 0.68 : 0.62),
          ),
        );
        final resolvedCoverSize = coverSize
            .clamp(160.0, wide ? 400.0 : 360.0)
            .toDouble();
        final artworkKey = track == null
            ? 'album-artwork:loading'
            : 'album-artwork:${track.id}:${track.coverUrl ?? ''}:'
                  '${identityHashCode(track.coverBytes)}';
        final metadataKey = track == null
            ? 'album-metadata:loading'
            : 'album-metadata:${track.id}:${track.album}';
        return Stack(
          fit: StackFit.expand,
          children: [
            Center(
              child: Transform.translate(
                offset: Offset(
                  0,
                  showMiniLyrics ? -_compactAlbumContentLift : 0,
                ),
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  padding: EdgeInsets.symmetric(vertical: wide ? 8 : 12),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox.square(
                        dimension: resolvedCoverSize,
                        // The tap recognizer coexists with the parent's vertical
                        // pull recognizer, so dragging still dismisses the page.
                        child: PlayerPullHandle(
                          child: Semantics(
                            button: track != null,
                            label: '打开当前歌曲菜单',
                            child: GestureDetector(
                              key: const ValueKey('player-cover-menu-button'),
                              behavior: HitTestBehavior.opaque,
                              onTap: track == null
                                  ? null
                                  : () => unawaited(
                                      showPlayerCoverActionsSheet(
                                        context,
                                        ref,
                                        track: track,
                                        wide: wide,
                                      ),
                                    ),
                              child: TrackChangeSwitcher(
                                transitionKey: artworkKey,
                                incomingOffset: Offset.zero,
                                scaleBegin: 0.88,
                                expand: true,
                                child: track == null
                                    ? _LoadingAlbumArtwork(
                                        size: resolvedCoverSize,
                                      )
                                    : SpinningCoverArt(
                                        track: track,
                                        size: resolvedCoverSize,
                                        placeholder: ColoredBox(
                                          color: Colors.white.withValues(
                                            alpha: 0.34,
                                          ),
                                          child: Center(
                                            child: Icon(
                                              Icons.album_rounded,
                                              size: 56,
                                              color: playerMuted(context),
                                            ),
                                          ),
                                        ),
                                        boxShadow: [
                                          BoxShadow(
                                            color: Colors.black.withValues(
                                              alpha: 0.16,
                                            ),
                                            blurRadius: 28,
                                            offset: const Offset(0, 18),
                                          ),
                                        ],
                                      ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      SizedBox(height: wide ? 18 : 22),
                      TrackChangeSwitcher(
                        transitionKey: metadataKey,
                        incomingOffset: const Offset(0.12, 0),
                        child: track == null
                            ? const SizedBox(height: 24)
                            : _AlbumMetadata(track: track),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (showMiniLyrics)
              Positioned(
                left: 0,
                bottom: _miniLyricsBottomInset,
                width: math.min(320, constraints.maxWidth * 0.78),
                child: MiniLyricsPanel(onOpenLyrics: onOpenLyrics!),
              ),
          ],
        );
      },
    );
  }
}

class _LoadingAlbumArtwork extends StatelessWidget {
  const _LoadingAlbumArtwork({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.22),
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: CircularProgressIndicator(
        color: playerInk(context),
        strokeWidth: 3,
      ),
    );
  }
}

class _AlbumMetadata extends StatelessWidget {
  const _AlbumMetadata({required this.track});

  final PlayerTrack track;

  @override
  Widget build(BuildContext context) {
    final album = track.album.trim().isEmpty ? '未知专辑' : track.album.trim();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          album,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: playerMuted(context).withValues(alpha: 0.78),
            fontSize: 15,
            fontWeight: FontWeight.w500,
            height: 1.15,
          ),
        ),
      ],
    );
  }
}
