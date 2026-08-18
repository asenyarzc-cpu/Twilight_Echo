import 'package:flutter/material.dart';

import '../../../core/services/storage_browser_service.dart';
import '../../../theme/app_motion.dart';

Future<String?> showStorageFolderPickerSheet(
  BuildContext context, {
  String title = '选择文件夹',
  String? initialPath,
  StorageBrowserService service = const StorageBrowserService(),
}) {
  return showModalBottomSheet<String>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: false,
    backgroundColor: Colors.transparent,
    barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.42),
    builder: (context) => StorageFolderPickerSheet(
      title: title,
      initialPath: initialPath,
      service: service,
    ),
  );
}

class StorageFolderPickerSheet extends StatefulWidget {
  const StorageFolderPickerSheet({
    super.key,
    required this.title,
    required this.service,
    this.initialPath,
  });

  final String title;
  final String? initialPath;
  final StorageBrowserService service;

  @override
  State<StorageFolderPickerSheet> createState() =>
      _StorageFolderPickerSheetState();
}

class _StorageFolderPickerSheetState extends State<StorageFolderPickerSheet> {
  final List<String?> _history = [];
  String? _currentPath;
  List<StorageBrowserEntry> _entries = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _currentPath = widget.initialPath?.trim().isEmpty == true
        ? null
        : widget.initialPath;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final path = _currentPath;
      final entries = path == null
          ? await widget.service.listRoots()
          : await widget.service.listChildren(path);
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _entries = const [];
        _loading = false;
        _error = '$error';
      });
    }
  }

  void _open(StorageBrowserEntry entry) {
    if (!entry.isDirectory || !entry.canRead) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('该文件夹不可读取')));
      return;
    }
    _history.add(_currentPath);
    _currentPath = entry.path;
    _load();
  }

  void _back() {
    if (_history.isEmpty) {
      _currentPath = null;
    } else {
      _currentPath = _history.removeLast();
    }
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final currentPath = _currentPath;
    return Align(
      alignment: Alignment.bottomCenter,
      child: FractionallySizedBox(
        heightFactor: 0.88,
        child: Material(
          color: scheme.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
          clipBehavior: Clip.antiAlias,
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
                padding: const EdgeInsets.fromLTRB(18, 14, 12, 8),
                child: Row(
                  children: [
                    IconButton(
                      tooltip: currentPath == null ? '关闭' : '返回上一级',
                      onPressed: currentPath == null && _history.isEmpty
                          ? () => Navigator.of(context).pop()
                          : _back,
                      icon: Icon(
                        currentPath == null && _history.isEmpty
                            ? Icons.close_rounded
                            : Icons.arrow_back_rounded,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            currentPath ?? '存储位置',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: scheme.outline,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: '刷新',
                      onPressed: _loading ? null : _load,
                      icon: const Icon(Icons.refresh_rounded),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, color: scheme.outlineVariant),
              Expanded(child: _buildBody(context)),
              Divider(height: 1, color: scheme.outlineVariant),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 20, 16),
                  child: Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => Navigator.of(context).pop(),
                          child: const Text('取消'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: currentPath == null || _loading
                              ? null
                              : () => Navigator.of(context).pop(currentPath),
                          icon: const Icon(Icons.check_rounded),
                          label: const Text('选择此文件夹'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    final error = _error;
    if (error != null) {
      return _PickerMessage(
        icon: Icons.folder_off_outlined,
        title: '无法读取文件夹',
        subtitle: error,
        action: TextButton.icon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('重试'),
        ),
      );
    }
    if (_entries.isEmpty) {
      return _PickerMessage(
        icon: Icons.folder_open_outlined,
        title: _currentPath == null ? '没有可浏览的存储位置' : '没有子文件夹',
        subtitle: _currentPath == null ? '请确认已授予所有文件访问权限' : _currentPath!,
        action: TextButton.icon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('刷新'),
        ),
      );
    }
    return AnimatedSwitcher(
      duration: AppMotion.medium,
      child: ListView.builder(
        key: ValueKey(_currentPath ?? 'roots'),
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _entries.length,
        itemBuilder: (context, index) {
          final entry = _entries[index];
          return _StorageEntryTile(entry: entry, onTap: () => _open(entry));
        },
      ),
    );
  }
}

class _StorageEntryTile extends StatelessWidget {
  const _StorageEntryTile({required this.entry, required this.onTap});

  final StorageBrowserEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final subtitle = entry.isRoot ? _rootSubtitle(entry) : entry.path;
    return ListTile(
      enabled: entry.canRead,
      leading: Icon(
        entry.isRoot ? Icons.storage_rounded : Icons.folder_rounded,
        color: entry.canRead ? scheme.primary : scheme.outline,
      ),
      title: Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: onTap,
    );
  }

  String _rootSubtitle(StorageBrowserEntry entry) {
    final parts = <String>[entry.path];
    final capacity = _formatCapacity(entry);
    if (capacity != null) parts.add(capacity);
    if (entry.isReadOnly) parts.add('只读');
    return parts.join(' · ');
  }

  String? _formatCapacity(StorageBrowserEntry entry) {
    if (entry.totalBytes <= 0) return null;
    final used = entry.totalBytes - entry.freeBytes;
    return '${_formatBytes(used)} / ${_formatBytes(entry.totalBytes)}';
  }

  String _formatBytes(int bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = bytes.toDouble();
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    if (unit == 0) return '${value.toStringAsFixed(0)} ${units[unit]}';
    return '${value.toStringAsFixed(value >= 10 ? 1 : 2)} ${units[unit]}';
  }
}

class _PickerMessage extends StatelessWidget {
  const _PickerMessage({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.action,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 38, color: scheme.outline),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: scheme.outline),
            ),
            const SizedBox(height: 14),
            action,
          ],
        ),
      ),
    );
  }
}
