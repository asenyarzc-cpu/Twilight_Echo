import 'package:flutter/material.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../../../core/music_sources/music_source_models.dart';

class MusicSourceCard extends StatelessWidget {
  const MusicSourceCard({
    super.key,
    required this.record,
    required this.enabled,
    required this.priority,
    required this.busy,
    required this.activating,
    required this.onToggle,
    required this.onDelete,
  }) : assert(!enabled || priority != null);

  final MusicSourceRecord record;
  final bool enabled;
  final int? priority;
  final bool busy;
  final bool activating;
  final ValueChanged<bool> onToggle;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final platforms = record.capabilities.keys
        .map((source) => source.label)
        .join('、');
    final cardColor = Color.alphaBlend(
      enabled ? scheme.primary.withValues(alpha: 0.055) : Colors.transparent,
      scheme.surfaceContainerLow,
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: Slidable(
        key: ValueKey('music-source-${record.id}'),
        groupTag: 'music-sources',
        enabled: !busy,
        endActionPane: ActionPane(
          motion: const BehindMotion(),
          extentRatio: 0.28,
          children: [
            SlidableAction(
              key: const ValueKey('music-source-delete-action'),
              onPressed: (_) => onDelete(),
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
              icon: Icons.delete_outline_rounded,
              label: '删除',
            ),
          ],
        ),
        child: Semantics(
          selected: enabled,
          label: enabled
              ? '${record.name}，已启用，优先级 $priority'
              : '${record.name}，未启用',
          child: Material(
            color: Colors.transparent,
            child: ListTile(
              selected: enabled,
              tileColor: cardColor,
              selectedTileColor: cardColor,
              onTap: busy ? null : () => onToggle(!enabled),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 10,
              ),
              horizontalTitleGap: 12,
              minVerticalPadding: 12,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
                side: BorderSide(
                  color: enabled
                      ? scheme.primary.withValues(alpha: 0.62)
                      : scheme.outlineVariant.withValues(alpha: 0.34),
                ),
              ),
              leading: Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: enabled
                      ? scheme.primaryContainer
                      : scheme.surfaceContainerHighest,
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: activating
                      ? const SizedBox.square(
                          dimension: 20,
                          child: CircularProgressIndicator(strokeWidth: 2.3),
                        )
                      : Icon(
                          Icons.music_note_rounded,
                          color: enabled
                              ? scheme.onPrimaryContainer
                              : scheme.onSurfaceVariant,
                          size: 22,
                        ),
                ),
              ),
              title: Text(
                record.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: scheme.onSurface,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (enabled) ...[
                          Icon(
                            Icons.check_circle_rounded,
                            color: scheme.primary,
                            size: 15,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            priority == 1 ? '首选' : '备用 ${priority! - 1}',
                            style: TextStyle(
                              color: scheme.primary,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(width: 8),
                        ],
                        Expanded(
                          child: Text(
                            platforms.isEmpty ? '未通过校验' : platforms,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: scheme.onSurfaceVariant,
                              fontSize: 12,
                            ),
                          ),
                        ),
                        if (record.version.isNotEmpty) ...[
                          const SizedBox(width: 8),
                          Text(
                            record.version,
                            style: TextStyle(
                              color: scheme.outline,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (record.lastError != null) ...[
                      const SizedBox(height: 7),
                      Text(
                        record.lastError!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: scheme.error, fontSize: 11),
                      ),
                    ],
                  ],
                ),
              ),
              trailing: Switch.adaptive(
                key: ValueKey('music-source-enabled-${record.id}'),
                value: enabled,
                onChanged: busy ? null : onToggle,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
