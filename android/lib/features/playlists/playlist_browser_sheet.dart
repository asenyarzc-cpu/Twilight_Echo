import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/ui/app_scrollbar.dart';
import '../../theme/app_motion.dart';
import 'playlist_models.dart';
import 'playlist_store.dart';
import 'widgets/playlist_artwork.dart';

enum PlaylistBrowserMode { browse, addSongs }

Future<String?> showPlaylistBrowserSheet(
  BuildContext context, {
  PlaylistBrowserMode mode = PlaylistBrowserMode.browse,
}) {
  return showModalBottomSheet<String>(
    context: context,
    useRootNavigator: true,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: false,
    backgroundColor: Colors.transparent,
    barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.42),
    builder: (_) => _PlaylistBrowserSheet(mode: mode),
  );
}

class _PlaylistBrowserSheet extends ConsumerWidget {
  const _PlaylistBrowserSheet({required this.mode});

  final PlaylistBrowserMode mode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final playlists = ref.watch(localPlaylistsProvider);
    final selecting = mode == PlaylistBrowserMode.addSongs;
    final viewportHeight = MediaQuery.sizeOf(context).height;
    final minChildSize = (176 / viewportHeight).clamp(0.44, 0.68);
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      minChildSize: minChildSize,
      maxChildSize: 0.92,
      snap: true,
      snapSizes: [minChildSize, 0.72, 0.92],
      builder: (context, scrollController) {
        return Material(
          color: scheme.surfaceContainerHigh,
          clipBehavior: Clip.antiAlias,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(30)),
          ),
          child: Column(
            children: [
              const SizedBox(height: 10),
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: scheme.onSurfaceVariant.withValues(alpha: 0.34),
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 12, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            selecting ? '添加歌曲到' : '我的歌单',
                            style: TextStyle(
                              color: scheme.onSurface,
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                              height: 1.1,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${playlists.length} 个歌单',
                            style: TextStyle(
                              color: scheme.onSurfaceVariant,
                              fontSize: 12.5,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
              if (!selecting)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                  child: _FixedManagementTile(
                    onTap: () => Navigator.of(context).pop('/playlists'),
                  ),
                ),
              Divider(
                height: 1,
                color: scheme.outlineVariant.withValues(alpha: 0.56),
              ),
              Expanded(
                child: AppScrollbar(
                  controller: scrollController,
                  child: playlists.isEmpty
                      ? _EmptyPlaylists(
                          controller: scrollController,
                          selecting: selecting,
                        )
                      : ListView.separated(
                          controller: scrollController,
                          physics: const BouncingScrollPhysics(
                            parent: AlwaysScrollableScrollPhysics(),
                          ),
                          padding: const EdgeInsets.fromLTRB(12, 10, 12, 24),
                          itemCount: playlists.length,
                          separatorBuilder: (_, _) => const SizedBox(height: 6),
                          itemBuilder: (context, index) {
                            final playlist = playlists[index];
                            return _PlaylistSheetTile(
                              playlist: playlist,
                              selecting: selecting,
                              onTap: () => Navigator.of(
                                context,
                              ).pop('/playlists/${playlist.id}'),
                            );
                          },
                        ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _FixedManagementTile extends StatelessWidget {
  const _FixedManagementTile({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.primaryContainer,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 68),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: scheme.primary,
                    borderRadius: BorderRadius.circular(15),
                  ),
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.library_music_rounded,
                    color: scheme.onPrimary,
                    size: 23,
                  ),
                ),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '歌单管理',
                        style: TextStyle(
                          color: scheme.onPrimaryContainer,
                          fontSize: 15.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '新建、导入、重命名与整理歌单',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: scheme.onPrimaryContainer.withValues(
                            alpha: 0.72,
                          ),
                          fontSize: 11.5,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  Icons.chevron_right_rounded,
                  color: scheme.onPrimaryContainer,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PlaylistSheetTile extends StatelessWidget {
  const _PlaylistSheetTile({
    required this.playlist,
    required this.selecting,
    required this.onTap,
  });

  final LocalPlaylist playlist;
  final bool selecting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AnimatedContainer(
      duration: AppMotion.short,
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: scheme.outlineVariant.withValues(alpha: 0.22),
        ),
      ),
      child: Material(
        color: Colors.transparent,
        clipBehavior: Clip.antiAlias,
        borderRadius: BorderRadius.circular(18),
        child: ListTile(
          onTap: onTap,
          minTileHeight: 64,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12),
          leading: PlaylistCover(
            playlist: playlist,
            size: 44,
            radius: 14,
            placeholder: Container(
              width: 44,
              height: 44,
              color: scheme.secondaryContainer,
              alignment: Alignment.center,
              child: Icon(
                Icons.queue_music_rounded,
                color: scheme.onSecondaryContainer,
                size: 23,
              ),
            ),
          ),
          title: Text(
            playlist.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: Text('${playlist.tracks.length} 首歌曲'),
          trailing: Icon(
            selecting ? Icons.add_rounded : Icons.chevron_right_rounded,
          ),
        ),
      ),
    );
  }
}

class _EmptyPlaylists extends StatelessWidget {
  const _EmptyPlaylists({required this.controller, required this.selecting});

  final ScrollController controller;
  final bool selecting;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListView(
      controller: controller,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 36, 24, 24),
      children: [
        Icon(
          Icons.playlist_add_rounded,
          color: scheme.onSurfaceVariant,
          size: 38,
        ),
        const SizedBox(height: 12),
        Text(
          selecting ? '没有可添加的歌单' : '还没有歌单',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: scheme.onSurface,
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          selecting ? '请先在歌单管理中创建或导入歌单' : '进入歌单管理即可新建或导入在线歌单',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: scheme.onSurfaceVariant,
            fontSize: 12.5,
            height: 1.4,
          ),
        ),
      ],
    );
  }
}
