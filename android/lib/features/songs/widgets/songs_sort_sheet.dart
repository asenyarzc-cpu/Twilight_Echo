import 'package:flutter/material.dart';

import '../songs_toolbar_state.dart';

Future<void> showSongsSortSheet({
  required BuildContext context,
  required SongSortMode initialMode,
  required bool initialAscending,
  required void Function(SongSortMode mode, bool ascending) onChanged,
}) {
  final scheme = Theme.of(context).colorScheme;
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    useSafeArea: true,
    showDragHandle: true,
    isScrollControlled: true,
    barrierColor: scheme.scrim.withValues(alpha: 0.36),
    builder: (_) => _SongsSortSheet(
      initialMode: initialMode,
      initialAscending: initialAscending,
      onChanged: onChanged,
    ),
  );
}

class _SongsSortSheet extends StatefulWidget {
  const _SongsSortSheet({
    required this.initialMode,
    required this.initialAscending,
    required this.onChanged,
  });

  final SongSortMode initialMode;
  final bool initialAscending;
  final void Function(SongSortMode mode, bool ascending) onChanged;

  @override
  State<_SongsSortSheet> createState() => _SongsSortSheetState();
}

class _SongsSortSheetState extends State<_SongsSortSheet> {
  late SongSortMode _mode;
  late bool _ascending;

  @override
  void initState() {
    super.initState();
    _mode = widget.initialMode;
    _ascending = widget.initialAscending;
  }

  void _selectMode(SongSortMode mode) {
    if (_mode == mode) return;
    setState(() {
      _mode = mode;
      _ascending = mode != SongSortMode.added;
    });
    widget.onChanged(_mode, _ascending);
  }

  void _selectDirection(Set<bool> selection) {
    if (selection.isEmpty) return;
    final ascending = selection.first;
    if (_ascending == ascending) return;
    setState(() => _ascending = ascending);
    widget.onChanged(_mode, _ascending);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return SafeArea(
      top: false,
      child: Center(
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 2, 8, 10),
                  child: Text(
                    '歌曲排序',
                    style: theme.textTheme.titleLarge?.copyWith(
                      color: scheme.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                for (final mode in SongSortMode.values)
                  ListTile(
                    minTileHeight: 52,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    selected: mode == _mode,
                    selectedTileColor: scheme.secondaryContainer.withValues(
                      alpha: 0.72,
                    ),
                    leading: Icon(mode.icon, size: 21),
                    title: Text(mode.label),
                    trailing: mode == _mode
                        ? Icon(
                            Icons.check_rounded,
                            color: scheme.onSecondaryContainer,
                          )
                        : null,
                    onTap: () => _selectMode(mode),
                  ),
                const SizedBox(height: 16),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    '排列顺序',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                SegmentedButton<bool>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment<bool>(
                      value: true,
                      icon: Icon(Icons.arrow_upward_rounded),
                      label: Text('升序'),
                    ),
                    ButtonSegment<bool>(
                      value: false,
                      icon: Icon(Icons.arrow_downward_rounded),
                      label: Text('降序'),
                    ),
                  ],
                  selected: {_ascending},
                  onSelectionChanged: _selectDirection,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
