import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import 'package:go_router/go_router.dart';

import '../../core/ui/app_toast.dart';
import '../../core/ui/configurable_m3e_progress.dart';
import '../../core/ui/cover_image_source.dart';
import '../../theme/app_motion.dart';
import '../player/player_controller.dart';
import '../playlists/playlist_store.dart';
import 'download_history_store.dart';
import 'download_progress.dart';

class DownloadHistoryPage extends ConsumerStatefulWidget {
  const DownloadHistoryPage({super.key});

  @override
  ConsumerState<DownloadHistoryPage> createState() =>
      _DownloadHistoryPageState();
}

class _DownloadHistoryPageState extends ConsumerState<DownloadHistoryPage> {
  @override
  Widget build(BuildContext context) {
    final progress = ref.watch(downloadProgressProvider);
    final history = ref.watch(downloadHistoryProvider);
    final busyTasks = progress.tasks
        .where((task) => task.isBusy)
        .toList(growable: false)
        .reversed
        .toList(growable: false);
    final finishedTasks = progress.tasks
        .where((task) => !task.isBusy)
        .toList(growable: false)
        .reversed
        .toList(growable: false);

    return Scaffold(
      body: CustomScrollView(
        key: const PageStorageKey('downloads-scroll'),
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            sliver: SliverToBoxAdapter(
              child: _SectionHeader(
                title: '进行中',
                count: busyTasks.length,
                actionLabel: finishedTasks.isEmpty ? null : '清理队列',
                onAction: finishedTasks.isEmpty
                    ? null
                    : () => ref
                          .read(downloadProgressProvider.notifier)
                          .clearFinished(),
              ),
            ),
          ),
          if (busyTasks.isEmpty)
            const SliverPadding(
              padding: EdgeInsets.fromLTRB(16, 10, 16, 0),
              sliver: SliverToBoxAdapter(child: _EmptyDownloads()),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              sliver: SliverList.separated(
                itemCount: busyTasks.length,
                separatorBuilder: (_, _) => const SizedBox(height: 10),
                itemBuilder: (context, index) {
                  return _AnimatedListItem(
                    index: index,
                    child: _TaskCard(task: busyTasks[index]),
                  );
                },
              ),
            ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 22, 16, 0),
            sliver: SliverToBoxAdapter(
              child: _SectionHeader(
                title: '歌曲列表',
                count: history.length,
                actionLabel: history.isEmpty ? null : '清空',
                onAction: history.isEmpty ? null : _confirmClear,
              ),
            ),
          ),
          if (history.isEmpty)
            const SliverPadding(
              padding: EdgeInsets.fromLTRB(16, 10, 16, 24),
              sliver: SliverToBoxAdapter(child: _EmptyHistory()),
            )
          else
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
              sliver: SlidableAutoCloseBehavior(
                child: SliverList.separated(
                  itemCount: history.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 6),
                  itemBuilder: (context, index) {
                    final entry = history[index];
                    return _AnimatedListItem(
                      index: index,
                      child: _HistoryTile(
                        key: ValueKey(entry.id),
                        entry: entry,
                        onPlay: entry.savedPath == null
                            ? null
                            : () => _play(entry),
                        onRemove: () => _confirmRemove(entry),
                      ),
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _play(DownloadHistoryEntry entry) async {
    final path = entry.savedPath;
    if (path == null || path.isEmpty || !File(path).existsSync()) {
      showAppToast(context, '文件不存在', type: AppToastType.warning);
      return;
    }
    context.go('/player', extra: '/downloads');
    await ref.read(playerControllerProvider.notifier).playFromHistory(entry);
  }

  Future<void> _confirmClear() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.cleaning_services_outlined),
        title: const Text('清空下载记录？'),
        content: const Text('会清理已结束的队列项和应用内历史，不会删除已经保存的音乐文件。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('清空'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    ref.read(downloadProgressProvider.notifier).clearFinished();
    await ref.read(downloadHistoryProvider.notifier).clear();
    if (!mounted) return;
    showAppToast(context, '下载记录已清空', type: AppToastType.success);
  }

  Future<void> _confirmRemove(DownloadHistoryEntry entry) async {
    final path = entry.savedPath;
    final canDeleteFile =
        entry.isCompleted &&
        path != null &&
        path.isNotEmpty &&
        File(path).existsSync();
    final choice = await showDialog<_RemoveChoice>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.delete_outline_rounded),
        title: const Text('删除下载记录？'),
        content: Text(
          canDeleteFile ? '可以只删除应用内记录，也可以同时删除已保存的音乐文件。' : '只会删除应用内记录，不会影响本地文件。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          if (canDeleteFile)
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(_RemoveChoice.recordOnly),
              child: const Text('只删记录'),
            ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(
              canDeleteFile
                  ? _RemoveChoice.recordAndFile
                  : _RemoveChoice.recordOnly,
            ),
            child: Text(canDeleteFile ? '记录和文件都删' : '删除记录'),
          ),
        ],
      ),
    );
    if (choice == null) return;

    var fileDeleted = false;
    if (choice == _RemoveChoice.recordAndFile &&
        path != null &&
        path.isNotEmpty) {
      try {
        final file = File(path);
        if (await file.exists()) {
          await file.delete();
          fileDeleted = true;
          await ref
              .read(localPlaylistsProvider.notifier)
              .removeLocalPathFromAll(path);
        }
      } catch (e) {
        if (!mounted) return;
        showAppToast(context, '文件删除失败：$e', type: AppToastType.error);
        return;
      }
    }

    await ref.read(downloadHistoryProvider.notifier).remove(entry.id);
    if (!mounted) return;
    showAppToast(
      context,
      fileDeleted ? '记录和文件已删除' : '下载记录已删除',
      type: AppToastType.success,
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.title,
    required this.count,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final int count;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Text(
          title,
          style: TextStyle(
            color: scheme.primary,
            fontSize: 18,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(width: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            '$count',
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const Spacer(),
        if (actionLabel != null)
          TextButton(onPressed: onAction, child: Text(actionLabel!)),
      ],
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.task});

  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = _toneFor(task.stage, scheme);
    final fraction = task.fraction;

    return AnimatedContainer(
      duration: AppMotion.medium,
      curve: AppMotion.emphasized,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(26),
        border: Border.all(
          color: scheme.outlineVariant.withValues(alpha: 0.62),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              _TaskStatusIcon(stage: task.stage, color: tone),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      task.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: scheme.onSurface,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      task.singer.isEmpty
                          ? describeStage(task.stage)
                          : task.singer,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: scheme.onSurfaceVariant,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              _PercentPill(task: task, color: tone),
            ],
          ),
          const SizedBox(height: 14),
          TweenAnimationBuilder<double>(
            tween: Tween<double>(end: fraction?.clamp(0.0, 1.0) ?? 0),
            duration: AppMotion.short,
            curve: AppMotion.emphasized,
            builder: (context, animatedValue, _) {
              return ConfigurableLinearProgressIndicatorM3E(
                value: fraction == null ? null : animatedValue,
                trackThickness: 2.6,
                activeColor: tone,
                trackColor: scheme.surfaceContainerHighest,
                waveAmplitude: 1.3,
                trailingMargin: 8,
              );
            },
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Text(
                  task.message ?? describeStage(task.stage),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ),
              if (task.total != null)
                Text(
                  '${_formatBytes(task.received)} / ${_formatBytes(task.total!)}',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Color _toneFor(DownloadStage stage, ColorScheme scheme) {
    return switch (stage) {
      DownloadStage.failed => scheme.error,
      DownloadStage.done => scheme.primary,
      DownloadStage.downloading => scheme.primary,
      _ => scheme.tertiary,
    };
  }
}

class _TaskStatusIcon extends StatelessWidget {
  const _TaskStatusIcon({required this.stage, required this.color});

  final DownloadStage stage;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final icon = switch (stage) {
      DownloadStage.downloading => Icons.arrow_downward_rounded,
      DownloadStage.done => Icons.check_rounded,
      DownloadStage.failed => Icons.error_outline_rounded,
      _ => Icons.music_note_rounded,
    };
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        shape: BoxShape.circle,
      ),
      child: Icon(icon, color: color, size: 24),
    );
  }
}

class _PercentPill extends StatelessWidget {
  const _PercentPill({required this.task, required this.color});

  final DownloadTask task;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fraction = task.fraction;
    final label = fraction == null
        ? describeStage(task.stage)
        : '${(fraction * 100).clamp(0, 100).round()}%';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: task.stage == DownloadStage.failed ? scheme.error : color,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _HistoryTile extends StatelessWidget {
  const _HistoryTile({
    super.key,
    required this.entry,
    required this.onPlay,
    required this.onRemove,
  });

  final DownloadHistoryEntry entry;
  final VoidCallback? onPlay;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Slidable(
        key: ValueKey('history-${entry.id}'),
        groupTag: 'download-history',
        endActionPane: ActionPane(
          motion: const BehindMotion(),
          extentRatio: 0.28,
          children: [
            SlidableAction(
              onPressed: (_) => onRemove(),
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
              icon: Icons.delete_outline_rounded,
              label: '删除',
            ),
          ],
        ),
        child: _HistoryTileContent(entry: entry, onPlay: onPlay),
      ),
    );
  }
}

class _HistoryTileContent extends StatelessWidget {
  const _HistoryTileContent({required this.entry, required this.onPlay});

  final DownloadHistoryEntry entry;
  final VoidCallback? onPlay;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final singer = entry.singer.trim().isNotEmpty
        ? entry.singer.trim()
        : '未知歌手';
    final album = entry.albumName.trim();
    final subtitle = album.isEmpty ? singer : '$singer · $album';

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: entry.isCompleted ? onPlay : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _HistoryCover(entry: entry),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: scheme.onSurface,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.15,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: entry.isCompleted
                            ? scheme.onSurfaceVariant
                            : scheme.error,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        height: 1.15,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              FilledButton(
                onPressed: entry.isCompleted ? onPlay : null,
                style: FilledButton.styleFrom(
                  fixedSize: const Size(44, 44),
                  shape: const CircleBorder(),
                  padding: EdgeInsets.zero,
                ),
                child: Icon(
                  entry.isCompleted
                      ? Icons.play_arrow_rounded
                      : Icons.error_outline_rounded,
                  size: 24,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HistoryCover extends StatelessWidget {
  const _HistoryCover({required this.entry});

  final DownloadHistoryEntry entry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final placeholder = Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: entry.isCompleted
            ? scheme.surfaceContainerHighest
            : scheme.errorContainer,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Icon(
        entry.isCompleted
            ? Icons.library_music_rounded
            : Icons.error_outline_rounded,
        color: entry.isCompleted ? scheme.onSurfaceVariant : scheme.error,
      ),
    );
    final url = CoverImageSource.normalizeUrl(entry.picUrl, size: 300);
    if (url == null || url.isEmpty) return placeholder;
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: CachedNetworkImage(
        imageUrl: url,
        httpHeaders: CoverImageSource.headersFor(url),
        width: 48,
        height: 48,
        fit: BoxFit.cover,
        memCacheWidth: 144,
        memCacheHeight: 144,
        placeholder: (_, _) => placeholder,
        errorWidget: (_, _, _) => placeholder,
      ),
    );
  }
}

class _EmptyDownloads extends StatelessWidget {
  const _EmptyDownloads();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.6)),
      ),
      child: Row(
        children: [
          Icon(Icons.download_done_rounded, color: scheme.onSurfaceVariant),
          const SizedBox(width: 10),
          Text(
            '暂无进行中的下载',
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyHistory extends StatelessWidget {
  const _EmptyHistory();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    const label = '暂无下载历史';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 28),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.6)),
      ),
      child: Column(
        children: [
          Icon(
            Icons.history_toggle_off_rounded,
            size: 42,
            color: scheme.onSurfaceVariant,
          ),
          const SizedBox(height: 10),
          Text(
            label,
            style: TextStyle(
              color: scheme.onSurface,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '下载完成后会自动出现在这里',
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
          ),
        ],
      ),
    );
  }
}

class _AnimatedListItem extends StatefulWidget {
  const _AnimatedListItem({required this.index, required this.child});

  final int index;
  final Widget child;

  @override
  State<_AnimatedListItem> createState() => _AnimatedListItemState();
}

class _AnimatedListItemState extends State<_AnimatedListItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _opacity;
  late final Animation<Offset> _offset;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: 220 + (widget.index % 5) * 22),
    );
    final curve = CurvedAnimation(
      parent: _controller,
      curve: AppMotion.emphasizedDecelerate,
    );
    _opacity = Tween<double>(begin: 0, end: 1).animate(curve);
    _offset = Tween<Offset>(
      begin: const Offset(0, 0.04),
      end: Offset.zero,
    ).animate(curve);
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: SlideTransition(position: _offset, child: widget.child),
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '${bytes}B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(2)}MB';
}

enum _RemoveChoice { recordOnly, recordAndFile }
