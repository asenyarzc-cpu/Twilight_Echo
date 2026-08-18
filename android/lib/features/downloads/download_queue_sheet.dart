import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../../core/ui/configurable_m3e_progress.dart';
import '../../theme/app_motion.dart';
import '../../theme/app_theme.dart';
import 'download_progress.dart';

Future<void> showDownloadQueueSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => const _DownloadQueueSheet(),
  );
}

class _DownloadQueueSheet extends ConsumerWidget {
  const _DownloadQueueSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final progress = ref.watch(downloadProgressProvider);
    final tasks = progress.tasks.reversed.toList();
    final canClear = progress.tasks.any((task) => !task.isBusy);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  '下载队列',
                  style: TextStyle(
                    color: scheme.onSurface,
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (canClear)
                  TextButton.icon(
                    onPressed: () => ref
                        .read(downloadProgressProvider.notifier)
                        .clearFinished(),
                    icon: const Icon(Icons.cleaning_services_outlined),
                    label: const Text('清理'),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (tasks.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 34, 12, 42),
                child: Column(
                  children: [
                    Icon(
                      Icons.download_done_rounded,
                      size: 42,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      '暂无下载任务',
                      style: TextStyle(
                        color: scheme.onSurfaceVariant,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              )
            else
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.58,
                ),
                child: SlidableAutoCloseBehavior(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: tasks.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (context, index) {
                      final task = tasks[index];
                      final tile = _DownloadTaskTile(task: task);
                      final child = task.isBusy
                          ? tile
                          : ClipRRect(
                              borderRadius: BorderRadius.circular(22),
                              child: Slidable(
                                key: ValueKey(task.id),
                                groupTag: 'download-queue',
                                endActionPane: ActionPane(
                                  motion: const BehindMotion(),
                                  extentRatio: 0.28,
                                  children: [
                                    SlidableAction(
                                      onPressed: (_) => ref
                                          .read(
                                            downloadProgressProvider.notifier,
                                          )
                                          .remove(task.id),
                                      backgroundColor: scheme.error,
                                      foregroundColor: scheme.onError,
                                      icon: Icons.delete_outline_rounded,
                                      label: '删除',
                                    ),
                                  ],
                                ),
                                child: tile,
                              ),
                            );
                      return _AnimatedQueueItem(index: index, child: child);
                    },
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _DownloadTaskTile extends StatelessWidget {
  const _DownloadTaskTile({required this.task});

  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = task.stage == DownloadStage.failed
        ? scheme.error
        : task.stage == DownloadStage.done
        ? scheme.primary
        : scheme.tertiary;
    return AnimatedContainer(
      duration: AppMotion.medium,
      curve: AppMotion.emphasized,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.appContainerHigh,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: tone.withValues(alpha: 0.14),
                  shape: BoxShape.circle,
                ),
                child: Icon(_iconFor(task.stage), color: tone, size: 21),
              ),
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
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      task.singer.isEmpty
                          ? describeStage(task.stage)
                          : task.singer,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: scheme.onSurfaceVariant,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _statusText(task),
                style: TextStyle(
                  color: tone,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TweenAnimationBuilder<double>(
            tween: Tween<double>(
              end:
                  (task.stage == DownloadStage.done ? 1.0 : task.fraction)
                      ?.clamp(0.0, 1.0) ??
                  0,
            ),
            duration: AppMotion.short,
            curve: AppMotion.emphasized,
            builder: (context, animatedValue, _) {
              return ConfigurableLinearProgressIndicatorM3E(
                value: task.fraction == null && task.stage != DownloadStage.done
                    ? null
                    : animatedValue,
                trackThickness: 2.6,
                activeColor: tone,
                trackColor: scheme.appContainerHighest,
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
                  '${_fmt(task.received)} / ${_fmt(task.total!)}',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  IconData _iconFor(DownloadStage stage) {
    switch (stage) {
      case DownloadStage.done:
        return Icons.check_rounded;
      case DownloadStage.failed:
        return Icons.error_outline_rounded;
      case DownloadStage.downloading:
        return Icons.downloading_rounded;
      default:
        return Icons.music_note_rounded;
    }
  }

  String _statusText(DownloadTask task) {
    if (task.stage == DownloadStage.done) return '完成';
    if (task.stage == DownloadStage.failed) return '失败';
    final fraction = task.fraction;
    if (fraction == null) return describeStage(task.stage);
    return '${(fraction * 100).clamp(0, 100).round()}%';
  }

  String _fmt(int bytes) {
    if (bytes < 1024) return '${bytes}B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(2)}MB';
  }
}

class _AnimatedQueueItem extends StatefulWidget {
  const _AnimatedQueueItem({required this.index, required this.child});

  final int index;
  final Widget child;

  @override
  State<_AnimatedQueueItem> createState() => _AnimatedQueueItemState();
}

class _AnimatedQueueItemState extends State<_AnimatedQueueItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _opacity;
  late final Animation<Offset> _offset;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: 220 + (widget.index % 6) * 24),
    );
    final curve = CurvedAnimation(
      parent: _controller,
      curve: AppMotion.emphasizedDecelerate,
    );
    _opacity = Tween<double>(begin: 0, end: 1).animate(curve);
    _offset = Tween<Offset>(
      begin: const Offset(0, 0.08),
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
