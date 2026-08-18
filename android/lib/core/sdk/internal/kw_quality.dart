import '../../models/enums.dart';
import '../../models/music_info.dart';

const Map<String, Quality> _kwQualityByBitrate = {
  '20900': Quality.master,
  '20501': Quality.atmosPlus,
  '20201': Quality.atmos,
  '4000': Quality.hires,
  '2000': Quality.flac,
  '320': Quality.k320,
  '128': Quality.k128,
};

/// Parses Kuwo's `N_MINFO` field. Every segment already contains the file
/// size, so no media URL request is needed to populate the quality picker.
List<QualityOption> parseKwQualityOptions(Object? raw) {
  final text = raw?.toString().trim() ?? '';
  if (text.isEmpty) return const [];

  final byType = <Quality, QualityOption>{};
  for (final segment in text.split(';')) {
    final fields = <String, String>{};
    for (final part in segment.split(',')) {
      final separator = part.indexOf(':');
      if (separator <= 0 || separator == part.length - 1) continue;
      fields[part.substring(0, separator).trim().toLowerCase()] = part
          .substring(separator + 1)
          .trim();
    }

    final type = _kwQualityByBitrate[fields['bitrate']];
    final size = _normalizeKwSize(fields['size']);
    if (type == null || size == null) continue;
    byType.putIfAbsent(type, () => QualityOption(type: type, size: size));
  }

  return [for (final type in kQualityRank) ?byType[type]];
}

String? _normalizeKwSize(String? raw) {
  final value = raw?.trim() ?? '';
  if (value.isEmpty ||
      RegExp(
        r'^0+(?:\.0+)?(?:[kmgt]?b?)?$',
        caseSensitive: false,
      ).hasMatch(value)) {
    return null;
  }
  return value.toUpperCase();
}
