import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../theme/app_motion.dart';
import '../player_controller.dart';
import 'karaoke_lyrics_view.dart';
import 'player_palette.dart';
import 'track_change_switcher.dart';

class LyricsPanel extends ConsumerStatefulWidget {
  const LyricsPanel({super.key, this.edgeFadeEnabled = true});

  final bool edgeFadeEnabled;

  @override
  ConsumerState<LyricsPanel> createState() => _LyricsPanelState();
}

class _LyricsPanelState extends ConsumerState<LyricsPanel> {
  bool _showTranslation = true;

  @override
  Widget build(BuildContext context) {
    // Everything here changes only on track switch / lyric load; the
    // per-tick `position` is consumed inside KaraokeLyricsView.
    final vm = ref.watch(
      playerControllerProvider.select(
        (s) => (
          lyricLoading: s.lyricLoading,
          lyrics: s.lyrics,
          localWithoutLyrics: s.track?.isLocal ?? false,
        ),
      ),
    );
    final localWithoutLyrics = vm.localWithoutLyrics;
    final hasTranslation = vm.lyrics.lines.any((line) {
      final translation = line.translation?.trim();
      return translation != null && translation.isNotEmpty;
    });
    final Widget child;
    final String transitionKey;
    if (vm.lyricLoading) {
      transitionKey = 'lyric-loading';
      child = const _LyricStatus(
        icon: Icons.graphic_eq_rounded,
        title: '歌词加载中',
      );
    } else if (vm.lyrics.isEmpty) {
      transitionKey = 'lyric-empty';
      child = _LyricStatus(
        icon: localWithoutLyrics
            ? Icons.library_music_rounded
            : Icons.lyrics_outlined,
        title: localWithoutLyrics ? '本地播放' : '暂无歌词',
        subtitle: localWithoutLyrics ? '未找到歌词' : null,
      );
    } else {
      final lyricsKey = identityHashCode(vm.lyrics).toString();
      transitionKey = lyricsKey;
      child = Column(
        children: [
          Expanded(
            child: KaraokeLyricsView(
              key: ValueKey('lyrics-view-$lyricsKey'),
              lyrics: vm.lyrics,
              showTranslation: hasTranslation && _showTranslation,
              edgeFadeEnabled: widget.edgeFadeEnabled,
            ),
          ),
          if (hasTranslation)
            _LyricsTranslationToggle(
              showTranslation: _showTranslation,
              onTap: () {
                setState(() => _showTranslation = !_showTranslation);
              },
            ),
        ],
      );
    }
    return TrackChangeSwitcher(
      transitionKey: transitionKey,
      incomingOffset: const Offset(0.10, 0.018),
      scaleBegin: 0.985,
      expand: true,
      child: child,
    );
  }
}

class _LyricsTranslationToggle extends StatelessWidget {
  const _LyricsTranslationToggle({
    required this.showTranslation,
    required this.onTap,
  });

  final bool showTranslation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : AppMotion.medium;
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 10),
      child: Align(
        alignment: Alignment.centerRight,
        child: Tooltip(
          message: showTranslation ? '隐藏歌词翻译' : '显示歌词翻译',
          child: AnimatedContainer(
            duration: duration,
            curve: AppMotion.emphasized,
            decoration: BoxDecoration(
              color: playerInk(
                context,
              ).withValues(alpha: showTranslation ? 0.11 : 0.06),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Material(
              color: Colors.transparent,
              borderRadius: BorderRadius.circular(999),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 7,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      AnimatedRotation(
                        turns: showTranslation ? 0 : -0.08,
                        duration: duration,
                        curve: AppMotion.emphasized,
                        child: Icon(
                          Icons.translate_rounded,
                          color: playerInk(context).withValues(alpha: 0.76),
                          size: 16,
                        ),
                      ),
                      const SizedBox(width: 6),
                      AnimatedSize(
                        duration: duration,
                        curve: AppMotion.emphasized,
                        child: AnimatedSwitcher(
                          duration: duration,
                          switchInCurve: AppMotion.emphasizedDecelerate,
                          switchOutCurve: AppMotion.emphasizedAccelerate,
                          transitionBuilder: (child, animation) {
                            return FadeTransition(
                              opacity: animation,
                              child: SlideTransition(
                                position: Tween<Offset>(
                                  begin: const Offset(0, 0.18),
                                  end: Offset.zero,
                                ).animate(animation),
                                child: child,
                              ),
                            );
                          },
                          child: Text(
                            showTranslation ? '隐藏翻译' : '显示翻译',
                            key: ValueKey(showTranslation),
                            style: TextStyle(
                              color: playerInk(context).withValues(alpha: 0.78),
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              height: 1,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LyricStatus extends StatelessWidget {
  const _LyricStatus({required this.icon, required this.title, this.subtitle});

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 42, color: playerMuted(context)),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: playerInk(context),
                fontSize: 16,
                fontWeight: FontWeight.w500,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: playerMuted(context),
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
