import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/models/music_info.dart';
import '../../../core/music_sources/music_source_controller.dart';
import '../../../core/music_sources/music_url_resolver.dart';
import '../../../core/services/download_service.dart';
import '../../../core/ui/app_toast.dart';
import '../../../core/ui/expressive_download_button.dart';
import '../../music_sources/music_source_action_guard.dart';

Future<void> showQualityPickerSheet(
  BuildContext context,
  MusicInfo music,
) async {
  final available = await ensureOnlineMusicSourcesAvailable(context, [
    music.source,
  ]);
  if (!available || !context.mounted) return;
  await showDialog<void>(
    context: context,
    useRootNavigator: true,
    barrierColor: Colors.black.withValues(alpha: 0.46),
    builder: (_) => QualityPickerSheet(music: music, toastContext: context),
  );
}

class QualityPickerSheet extends ConsumerStatefulWidget {
  const QualityPickerSheet({
    super.key,
    required this.music,
    required this.toastContext,
  });

  final MusicInfo music;
  final BuildContext toastContext;

  @override
  ConsumerState<QualityPickerSheet> createState() => _QualityPickerSheetState();
}

class _QualityPickerSheetState extends ConsumerState<QualityPickerSheet> {
  late Quality _selected;
  bool _submitting = false;
  bool _selectionWasUserChosen = false;

  @override
  void initState() {
    super.initState();
    final list = widget.music.sortedQualities;
    _selected = list.isEmpty ? widget.music.bestQuality : list.first.type;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final qualities = _availableQualities();
    final fallback = qualities.isEmpty
        ? [QualityOption(type: widget.music.bestQuality)]
        : qualities;
    if (!_selectionWasUserChosen || !fallback.any((q) => q.type == _selected)) {
      _selected = fallback.first.type;
    }

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 22, vertical: 24),
      backgroundColor: scheme.surfaceContainerHigh,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            18,
            20,
            18 + MediaQuery.of(context).viewInsets.bottom,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        color: scheme.secondaryContainer,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.download_rounded,
                        color: scheme.onSecondaryContainer,
                        size: 24,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '选择下载音质',
                            style: TextStyle(
                              color: scheme.onSurface,
                              fontSize: 18,
                              fontWeight: FontWeight.w600,
                              height: 1.1,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            widget.music.name,
                            style: TextStyle(
                              color: scheme.onSurfaceVariant,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  [
                    widget.music.singer.isEmpty ? '未知歌手' : widget.music.singer,
                    if (widget.music.albumName.isNotEmpty)
                      widget.music.albumName,
                  ].join(' · '),
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 13,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 18),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final q in fallback)
                      ChoiceChip(
                        label: Text(_qualityLabel(q)),
                        selected: _selected == q.type,
                        selectedColor: scheme.secondaryContainer,
                        checkmarkColor: scheme.onSecondaryContainer,
                        labelStyle: TextStyle(
                          color: _selected == q.type
                              ? scheme.onSecondaryContainer
                              : scheme.onSurfaceVariant,
                          fontWeight: _selected == q.type
                              ? FontWeight.w600
                              : FontWeight.w500,
                        ),
                        onSelected: _submitting
                            ? null
                            : (_) => setState(() {
                                _selected = q.type;
                                _selectionWasUserChosen = true;
                              }),
                      ),
                  ],
                ),
                const SizedBox(height: 22),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _submitting
                            ? null
                            : () => Navigator.of(context).maybePop(),
                        child: const Text('取消'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        onPressed: _submitting ? null : _onConfirm,
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ExpressiveDownloadGlyph(
                              isLoading: _submitting,
                              size: 24,
                              foregroundColor: _submitting
                                  ? scheme.primary
                                  : scheme.onPrimary,
                              secondaryColor: _submitting
                                  ? scheme.tertiary
                                  : scheme.onPrimary,
                            ),
                            const SizedBox(width: 8),
                            Text(_submitting ? '准备中...' : '开始下载'),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<QualityOption> _availableQualities() {
    final trackQualities = widget.music.sortedQualities;
    final sourceQualities = ref
        .watch(downloadCapabilitiesProvider)
        .valueOrNull
        ?.qualitiesFor(widget.music.source);
    if (trackQualities.isNotEmpty) {
      if (sourceQualities == null || sourceQualities.isEmpty) {
        return trackQualities;
      }
      final usedCanonicalQualities = <Quality>{};
      final available = <QualityOption>[];
      for (final sourceQuality in rankMusicSourceQualities(sourceQualities)) {
        final canonical = _canonicalQuality(sourceQuality);
        if (!usedCanonicalQualities.add(canonical)) continue;
        final trackOption = trackQualities
            .where((option) => _canonicalQuality(option.type) == canonical)
            .firstOrNull;
        if (trackOption == null) continue;
        available.add(
          QualityOption(
            type: sourceQuality,
            size: trackOption.size,
            hash: trackOption.hash,
            mediaInfo: trackOption.mediaInfo,
          ),
        );
      }
      // Capability declarations can be incomplete in older source scripts.
      return available.isEmpty ? trackQualities : available;
    }

    if (sourceQualities == null || sourceQualities.isEmpty) {
      return trackQualities;
    }

    return [
      for (final quality in rankMusicSourceQualities(sourceQualities))
        QualityOption(type: quality),
    ];
  }

  Quality _canonicalQuality(Quality quality) =>
      quality == Quality.hires ? Quality.flac24bit : quality;

  String _qualityLabel(QualityOption option) {
    final size = option.size?.trim();
    return size == null || size.isEmpty
        ? option.type.code
        : '${option.type.code} · $size';
  }

  Future<void> _onConfirm() async {
    setState(() => _submitting = true);
    final navigator = Navigator.of(context);
    final toastOverlay = Overlay.of(widget.toastContext);
    const embed = EmbedRequest();

    final capabilities = ref.read(downloadCapabilitiesProvider).valueOrNull;
    if (capabilities != null &&
        !capabilities.isAvailable(widget.music.source)) {
      navigator.pop();
      showAppToastOnOverlay(
        toastOverlay,
        '${widget.music.source.label}当前不支持下载',
        type: AppToastType.warning,
      );
      return;
    }

    final service = ref.read(downloadServiceProvider);
    navigator.pop();
    showAppToastOnOverlay(
      toastOverlay,
      '已加入下载队列：${widget.music.name}',
      type: AppToastType.info,
      duration: const Duration(seconds: 2),
    );
    try {
      final result = await service.downloadOne(
        music: widget.music,
        quality: _selected,
        embed: embed,
      );
      showAppToastOnOverlay(
        toastOverlay,
        '下载完成：${result.path}',
        type: AppToastType.success,
        duration: const Duration(seconds: 4),
      );
    } catch (e) {
      showAppToastOnOverlay(toastOverlay, '下载失败：$e', type: AppToastType.error);
    }
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
