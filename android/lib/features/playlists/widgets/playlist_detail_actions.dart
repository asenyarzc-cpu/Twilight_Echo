import 'package:flutter/material.dart';

/// 歌单详情页的主操作区：播放全部 + 收藏/取消收藏。
///
/// 在线歌单详情、本地歌单详情以及宽屏分栏左列共用，保证两个页面的
/// 操作区视觉一致。[showFavorite] 为 false 时（本地非导入歌单）只保留
/// 播放全部一个按钮占满整行。
class PlaylistDetailActions extends StatelessWidget {
  const PlaylistDetailActions({
    super.key,
    this.onPlay,
    this.onFavorite,
    this.showFavorite = true,
    this.saving = false,
    this.removingFavorite = false,
    this.saved = false,
    this.loading = false,
    this.favoriteLabel,
    this.padding = const EdgeInsets.fromLTRB(16, 4, 16, 8),
  });

  final VoidCallback? onPlay;
  final VoidCallback? onFavorite;
  final bool showFavorite;
  final bool saving;
  final bool removingFavorite;
  final bool saved;
  final bool loading;

  /// 覆盖收藏按钮的静态文案（本地导入歌单传「取消收藏」）；
  /// saving 期间仍显示「收藏中/取消中」。
  final String? favoriteLabel;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final playButton = SizedBox(
      height: 48,
      child: FilledButton.icon(
        key: const ValueKey('playlist-play-all'),
        onPressed: loading ? null : onPlay,
        style: loading
            ? FilledButton.styleFrom(
                disabledBackgroundColor: scheme.primary,
                disabledForegroundColor: scheme.onPrimary,
              )
            : null,
        icon: const Icon(Icons.play_arrow_rounded),
        label: const Text('播放全部'),
      ),
    );
    final favoriteButton = SizedBox(
      height: 48,
      child: FilledButton.tonalIcon(
        key: const ValueKey('playlist-favorite'),
        onPressed: loading ? null : onFavorite,
        style: loading
            ? FilledButton.styleFrom(
                disabledBackgroundColor: scheme.secondaryContainer,
                disabledForegroundColor: scheme.onSecondaryContainer,
              )
            : null,
        icon: saving
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : Icon(
                saved ? Icons.favorite_rounded : Icons.favorite_border_rounded,
              ),
        label: Text(
          saving
              ? removingFavorite
                    ? '取消中'
                    : '收藏中'
              : favoriteLabel ?? (saved ? '已收藏' : '收藏歌单'),
        ),
      ),
    );
    return Padding(
      padding: padding,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 900),
          child: LayoutBuilder(
            builder: (context, constraints) {
              // 窄栏（如宽屏分栏 ~308px 的左列）里两个按钮并排放不下，
              // 收藏按钮换到下一行各占整行。
              final stacked =
                  showFavorite && constraints.maxWidth < _kStackedBreakpoint;
              if (stacked) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    playButton,
                    const SizedBox(height: 10),
                    favoriteButton,
                  ],
                );
              }
              return Row(
                children: [
                  Expanded(flex: 3, child: playButton),
                  if (showFavorite) ...[
                    const SizedBox(width: 10),
                    Expanded(flex: 2, child: favoriteButton),
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// 低于该可用宽度时操作按钮改为上下两行。
const double _kStackedBreakpoint = 340;
