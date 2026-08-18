import 'package:flutter/material.dart';

import '../../../core/ui/expressive_loading_status.dart';
import '../songs_toolbar_state.dart';

class SongsListSummary extends StatelessWidget {
  const SongsListSummary({
    super.key,
    required this.count,
    required this.totalCount,
    required this.searching,
    required this.sortMode,
    required this.ascending,
    required this.batchMode,
    required this.onOpenSort,
    required this.onToggleBatch,
    this.showSort = true,
    this.collectionLabel = '本地歌曲',
  });

  final int count;
  final int totalCount;
  final bool searching;
  final SongSortMode sortMode;
  final bool ascending;
  final bool batchMode;
  final VoidCallback onOpenSort;
  final VoidCallback? onToggleBatch;
  final bool showSort;
  final String collectionLabel;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 52,
      child: Row(
        children: [
          Expanded(
            child: Text(
              searching ? '找到 $count 首歌曲' : '$totalCount 首$collectionLabel',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          if (showSort)
            _SummaryIconButton(
              key: const ValueKey('songs-sort-button'),
              tooltip: '排序：${sortMode.label}（${ascending ? '升序' : '降序'}）',
              onPressed: onOpenSort,
              icon: const Icon(Icons.sort_rounded, size: 21),
            ),
          _SummaryIconButton(
            key: const ValueKey('songs-batch-button'),
            tooltip: batchMode ? '退出批量操作' : '批量操作',
            onPressed: onToggleBatch,
            active: batchMode,
            icon: const Icon(Icons.checklist_rounded, size: 21),
          ),
        ],
      ),
    );
  }
}

class _SummaryIconButton extends StatelessWidget {
  const _SummaryIconButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.active = false,
  });

  final String tooltip;
  final Widget icon;
  final VoidCallback? onPressed;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 48,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          minimumSize: const Size.square(48),
          foregroundColor: active
              ? scheme.onSecondaryContainer
              : scheme.onSurfaceVariant,
          backgroundColor: active ? scheme.secondaryContainer : null,
          disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.34),
        ),
        icon: icon,
      ),
    );
  }
}

class SongsSearchBar extends StatelessWidget {
  const SongsSearchBar({
    super.key,
    required this.controller,
    this.focusNode,
    required this.query,
    this.autofocus = false,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final FocusNode? focusNode;
  final String query;
  final bool autofocus;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SearchBar(
      key: const ValueKey('songs-search-bar'),
      controller: controller,
      focusNode: focusNode,
      autoFocus: autofocus,
      hintText: '搜索歌曲、歌手或专辑',
      leading: Icon(
        Icons.search_rounded,
        size: 21,
        color: scheme.onSurfaceVariant,
      ),
      trailing: query.isEmpty
          ? null
          : [
              IconButton(
                tooltip: '清除搜索',
                onPressed: onClear,
                icon: const Icon(Icons.close_rounded, size: 20),
              ),
            ],
      onChanged: onChanged,
      onSubmitted: (_) => FocusManager.instance.primaryFocus?.unfocus(),
      elevation: const WidgetStatePropertyAll(0),
      backgroundColor: WidgetStatePropertyAll(scheme.surfaceContainerLow),
      side: WidgetStatePropertyAll(
        BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.56)),
      ),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      constraints: const BoxConstraints(minHeight: 50, maxHeight: 50),
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 14),
      ),
    );
  }
}

class SongListDivider extends StatelessWidget {
  const SongListDivider({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Divider(
      height: 1,
      thickness: 0.7,
      indent: 66,
      endIndent: 4,
      color: scheme.outlineVariant.withValues(alpha: 0.3),
    );
  }
}

class SongsLoading extends StatelessWidget {
  const SongsLoading({super.key});

  @override
  Widget build(BuildContext context) {
    return const ExpressiveLoadingStatus(
      title: '正在整理本地音乐',
      subtitle: '正在读取本地音乐文件夹与歌曲信息，请稍候',
      bottomPadding: 108,
    );
  }
}

class EmptySongs extends StatelessWidget {
  const EmptySongs({super.key, this.error, this.playlistMode = false});

  final String? error;
  final bool playlistMode;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final normalizedError = error?.trim();
    final hasError = normalizedError != null && normalizedError.isNotEmpty;
    final containerColor = hasError
        ? scheme.errorContainer
        : scheme.secondaryContainer;
    final contentColor = hasError
        ? scheme.onErrorContainer
        : scheme.onSecondaryContainer;

    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 24, 28, 108),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 330),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: containerColor,
                  borderRadius: BorderRadius.circular(30),
                ),
                child: Icon(
                  hasError
                      ? Icons.sync_problem_rounded
                      : playlistMode
                      ? Icons.queue_music_rounded
                      : Icons.library_music_outlined,
                  size: 40,
                  color: contentColor,
                ),
              ),
              const SizedBox(height: 18),
              Text(
                hasError
                    ? '暂时无法读取歌曲'
                    : playlistMode
                    ? '歌单还是空的'
                    : '还没有本地歌曲',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: scheme.onSurface,
                  fontWeight: FontWeight.w600,
                  fontSize: 18,
                  letterSpacing: -0.15,
                ),
              ),
              const SizedBox(height: 7),
              Text(
                hasError
                    ? normalizedError
                    : playlistMode
                    ? '添加歌曲后，会按歌单中的顺序显示在这里。'
                    : '本地音乐文件夹里的歌曲会自动出现在这里，也可以下拉重新扫描。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  height: 1.5,
                ),
              ),
              if (!playlistMode) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 13,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.swipe_down_alt_rounded,
                        size: 17,
                        color: scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 7),
                      Text(
                        hasError ? '下拉重试' : '下拉重新扫描',
                        style: TextStyle(
                          color: scheme.onSurfaceVariant,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class EmptySongSearch extends StatelessWidget {
  const EmptySongSearch({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 20, 28, 108),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.search_off_rounded,
              size: 46,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(height: 14),
            Text(
              '没有匹配的歌曲',
              style: TextStyle(
                color: scheme.onSurface,
                fontSize: 17,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '换一个歌曲名、歌手或专辑试试',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
