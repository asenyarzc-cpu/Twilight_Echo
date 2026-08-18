import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/models/music_info.dart';
import '../player_controller.dart';

List<QualityOption> availablePlaybackQualityOptions(PlayerTrack track) {
  final parsedCurrent = Quality.tryFromCode(track.qualityLabel);
  final allOptions = track.availableQualityOptions.isEmpty
      ? [
          for (final quality
              in track.availableQualities.isEmpty
                  ? [?parsedCurrent]
                  : track.availableQualities)
            QualityOption(type: quality),
        ]
      : track.availableQualityOptions;
  return [
    for (final option in allOptions)
      if (_knownQualitySize(option) != null) option,
  ];
}

String playerQualityLabel(PlayerTrack track) {
  final quality = Quality.tryFromCode(track.qualityLabel);
  return switch (quality) {
    Quality.atmosPlus => 'Atmos+',
    Quality.flac24bit => '24-bit FLAC',
    null => track.qualityLabel,
    _ => _qualityName(quality),
  };
}

Future<void> showPlaybackQualitySheet(
  BuildContext context,
  WidgetRef ref, {
  required PlayerTrack track,
}) async {
  final options = availablePlaybackQualityOptions(track);
  final current = Quality.tryFromCode(track.qualityLabel);
  if (track.isLocal || options.length < 2) return;
  final controller = ref.read(playerControllerProvider.notifier);
  final scheme = Theme.of(context).colorScheme;
  final selected = await showModalBottomSheet<Quality>(
    context: context,
    useRootNavigator: true,
    useSafeArea: true,
    showDragHandle: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    barrierColor: scheme.scrim.withValues(alpha: 0.36),
    builder: (_) => _PlaybackQualitySheet(options: options, current: current),
  );
  if (selected == null || selected == current) return;
  await controller.switchQuality(selected);
}

class _PlaybackQualitySheet extends StatelessWidget {
  const _PlaybackQualitySheet({required this.options, required this.current});

  final List<QualityOption> options;
  final Quality? current;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final maxHeight = MediaQuery.sizeOf(context).height * 0.72;
    return SafeArea(
      key: const ValueKey('player-quality-sheet'),
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 2, 8, 10),
                child: Text(
                  '播放音质',
                  style: theme.textTheme.titleLarge?.copyWith(
                    color: scheme.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: options.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 4),
                  itemBuilder: (context, index) {
                    final option = options[index];
                    final selected = option.type == current;
                    return ListTile(
                      key: ValueKey(
                        'player-quality-option-${option.type.code}',
                      ),
                      minTileHeight: 62,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      selected: selected,
                      selectedTileColor: scheme.secondaryContainer.withValues(
                        alpha: 0.72,
                      ),
                      title: Text(
                        _qualityName(option.type),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      subtitle: Text('文件大小 ${_knownQualitySize(option)!}'),
                      trailing: selected
                          ? Icon(
                              Icons.check_circle_rounded,
                              color: scheme.onSecondaryContainer,
                            )
                          : null,
                      onTap: () => Navigator.of(context).pop(option.type),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _qualityName(Quality quality) {
  return switch (quality) {
    Quality.master => '母带音质',
    Quality.atmosPlus => 'Atmos Plus',
    Quality.atmos => '杜比全景声',
    Quality.hires => 'Hi-Res',
    Quality.flac24bit => '24-bit FLAC',
    Quality.flac => '无损 FLAC',
    Quality.wav => 'WAV',
    Quality.ape => 'APE',
    Quality.k320 => '高品质 320K',
    Quality.k192 => '较高品质 192K',
    Quality.k128 => '标准品质 128K',
  };
}

String? _knownQualitySize(QualityOption option) {
  final size = option.size?.trim();
  return size == null || size.isEmpty ? null : size;
}
