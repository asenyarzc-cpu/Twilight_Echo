import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../theme/app_motion.dart';
import '../../songs/songs_toolbar_state.dart';
import '../shell_route_utils.dart';
import 'library_view_menu.dart';

class ShellHeader extends ConsumerWidget {
  const ShellHeader({
    super.key,
    required this.location,
    required this.playlistBackLocation,
  });

  final String location;
  final String playlistBackLocation;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = shellSchemeFor(location, Theme.of(context).colorScheme);
    final textTheme = Theme.of(context).textTheme;
    final top = MediaQuery.viewPaddingOf(context).top;
    final onlinePlaylistDetail = location.startsWith('/discover/playlists/');
    final compact =
        location == '/' ||
        isSongsLibraryLocation(location) ||
        onlinePlaylistDetail;
    final headerTitle =
        location == '/songs/search' &&
            ref.watch(songsLibraryPlaylistIdProvider) != null
        ? '搜索歌单歌曲'
        : _titleFor(location);

    if (location == '/songs') {
      final songsToolbar = ref.watch(songsToolbarStateProvider);
      return Padding(
        padding: EdgeInsets.fromLTRB(16, top + 10, 16, 8),
        child: SongsHeader(state: songsToolbar, scheme: scheme),
      );
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(
        18,
        top + (compact ? 10 : 16),
        18,
        compact ? 8 : 12,
      ),
      child: Row(
        children: [
          if (location == '/playlists/import') ...[
            IconButton(
              tooltip: '返回上一页',
              onPressed: () {
                if (context.canPop()) {
                  context.pop();
                } else {
                  context.go(playlistBackLocation);
                }
              },
              icon: Icon(
                Icons.arrow_back_ios_new_rounded,
                color: scheme.onSurface,
                size: 21,
              ),
            ),
            const SizedBox(width: 4),
          ],
          Expanded(
            child: Text(
              headerTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: textTheme.headlineSmall?.copyWith(
                color: scheme.onSurface,
                fontSize: onlinePlaylistDetail ? 18 : (compact ? 22 : null),
                fontWeight: FontWeight.w600,
                height: 1.05,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _titleFor(String location) {
    if (location == '/') return '发现';
    if (location.startsWith('/discover/playlists/')) return '歌单详情';
    if (location == '/playlists') return '歌单管理';
    if (location == '/playlists/import') return '导入歌单';
    if (location.startsWith('/playlists/')) return '歌单详情';
    if (location == '/songs/search') return '搜索本地歌曲';
    if (location == '/settings/sources') return '音源管理';
    switch (location) {
      case '/history':
      case '/downloads':
        return '下载';
      case '/songs':
        return '歌曲';
      case '/player':
        return '播放';
      case '/settings':
        return '设置';
      case '/debug':
        return '调试日志';
      default:
        return 'Twilight Echo';
    }
  }
}

class SongsHeader extends StatelessWidget {
  const SongsHeader({super.key, required this.state, required this.scheme});

  final SongsToolbarState state;
  final ColorScheme scheme;

  @override
  Widget build(BuildContext context) {
    final title = Text(
      state.libraryTitle,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.headlineSmall?.copyWith(
        color: scheme.onSurface,
        fontSize: 22,
        fontWeight: FontWeight.w600,
        height: 1.05,
      ),
    );

    if (state.batchMode) {
      return Column(
        key: const ValueKey('songs-header-batch'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 44,
            child: Align(alignment: Alignment.centerLeft, child: title),
          ),
          Container(
            key: const ValueKey('songs-batch-header'),
            height: 44,
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: scheme.outlineVariant.withValues(alpha: 0.34),
                ),
                bottom: BorderSide(
                  color: scheme.outlineVariant.withValues(alpha: 0.34),
                ),
              ),
            ),
            child: Row(
              children: [
                TextButton(
                  onPressed: state.hasSongs ? state.onToggleSelectAll : null,
                  style: TextButton.styleFrom(
                    minimumSize: const Size(72, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    alignment: Alignment.centerLeft,
                  ),
                  child: Text(state.allSelected ? '取消全选' : '全选'),
                ),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: AppMotion.short,
                    child: Text(
                      '已选中 ${state.selectedCount} 项',
                      key: ValueKey(state.selectedCount),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: scheme.onSurface,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
                SizedBox.square(
                  dimension: 44,
                  child: IconButton(
                    tooltip: '退出批量管理',
                    onPressed: state.onToggleBatch,
                    icon: const Icon(Icons.close_rounded, size: 20),
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    }

    return SizedBox(
      key: const ValueKey('songs-header-normal'),
      height: 44,
      child: Row(
        children: [
          Expanded(
            child: Row(
              children: [
                Flexible(
                  child: LibraryViewMenu(
                    title: state.libraryTitle,
                    activePlaylistId: state.activePlaylistId,
                    scheme: scheme,
                    onSelected: state.onSelectLibraryPlaylist ?? (_) {},
                  ),
                ),
                const SizedBox(width: 4),
                _SongsHeaderIconButton(
                  tooltip: '歌单',
                  icon: Icons.queue_music_rounded,
                  onPressed: state.onOpenPlaylists,
                ),
                _SongsHeaderIconButton(
                  tooltip: '随机播放',
                  icon: Icons.shuffle_rounded,
                  onPressed: state.hasSongs ? state.onShuffle : null,
                ),
              ],
            ),
          ),
          _LibraryOverflowMenu(
            onOpenHistory: state.onOpenHistory,
            searchLabel: state.searchLabel,
            onSearch: state.onSearch,
            onUpdatePlaylist: state.onUpdatePlaylist,
            updatingPlaylist: state.updatingPlaylist,
          ),
        ],
      ),
    );
  }
}

class _SongsHeaderIconButton extends StatelessWidget {
  const _SongsHeaderIconButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: 44,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: 20),
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

class _LibraryOverflowMenu extends StatelessWidget {
  const _LibraryOverflowMenu({
    this.onOpenHistory,
    this.searchLabel = '搜索本地歌曲',
    this.onSearch,
    this.onUpdatePlaylist,
    this.updatingPlaylist = false,
  });

  final VoidCallback? onOpenHistory;
  final String searchLabel;
  final VoidCallback? onSearch;
  final VoidCallback? onUpdatePlaylist;
  final bool updatingPlaylist;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return MenuAnchor(
      key: const ValueKey('songs-overflow-menu'),
      useRootOverlay: true,
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(scheme.surfaceContainerHigh),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(3),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(vertical: 6),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      menuChildren: [
        MenuItemButton(
          leadingIcon: const Icon(Icons.search_rounded, size: 20),
          onPressed: onSearch == null
              ? null
              : () {
                  FocusManager.instance.primaryFocus?.unfocus();
                  onSearch!();
                },
          child: Text(searchLabel),
        ),
        if (onUpdatePlaylist != null)
          MenuItemButton(
            leadingIcon: updatingPlaylist
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.2),
                  )
                : const Icon(Icons.refresh_rounded, size: 20),
            onPressed: updatingPlaylist ? null : onUpdatePlaylist,
            child: Text(updatingPlaylist ? '正在更新' : '更新歌单'),
          ),
        MenuItemButton(
          leadingIcon: const Icon(Icons.history_rounded, size: 20),
          onPressed: onOpenHistory ?? () => context.go('/downloads'),
          child: const Text('下载历史'),
        ),
      ],
      builder: (context, controller, child) => SizedBox.square(
        dimension: 44,
        child: IconButton(
          tooltip: '更多歌曲操作',
          onPressed: () {
            if (controller.isOpen) {
              controller.close();
            } else {
              controller.open();
            }
          },
          icon: const Icon(Icons.more_vert_rounded, size: 21),
          visualDensity: VisualDensity.compact,
        ),
      ),
    );
  }
}
