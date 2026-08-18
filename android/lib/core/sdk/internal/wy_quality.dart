import 'dart:convert';

import '../../models/enums.dart';
import '../../models/music_info.dart';
import 'format.dart';

const String wyMusicDetailPath = '/api/song/music/detail/get';

const Map<String, Quality> _wyDetailQualityMap = {
  'l': Quality.k128,
  'h': Quality.k320,
  'sq': Quality.flac,
  'hr': Quality.hires,
  'je': Quality.atmos,
  'sk': Quality.atmosPlus,
  'jm': Quality.master,
};

List<QualityOption> parseWySearchQualityOptions(Map song) {
  final result = <QualityOption>[];

  void add(Quality type, Object? size) {
    final formatted = sizeFormat(size);
    if (formatted != null) {
      result.add(QualityOption(type: type, size: formatted));
    }
  }

  final privilege = song['privilege'];
  if (privilege is Map && privilege['maxBrLevel'] == 'hires') {
    add(Quality.hires, (song['hr'] as Map?)?['size']);
  }
  final maxbr = privilege is Map ? privilege['maxbr'] : null;
  if (maxbr == 999000) add(Quality.flac, (song['sq'] as Map?)?['size']);
  if (maxbr == 999000 || maxbr == 320000) {
    add(Quality.k320, (song['h'] as Map?)?['size']);
  }
  if (maxbr == 999000 ||
      maxbr == 320000 ||
      maxbr == 192000 ||
      maxbr == 128000) {
    add(Quality.k128, (song['l'] as Map?)?['size']);
  }
  return _rankWyOptions(result);
}

List<QualityOption> parseWyQualityDetail(Object? raw) {
  if (raw is! Map) return const [];
  final code = int.tryParse(raw['code']?.toString() ?? '200');
  if (code != null && code != 200) return const [];
  final data = raw['data'] is Map ? raw['data'] as Map : raw;

  final result = <QualityOption>[];
  for (final entry in _wyDetailQualityMap.entries) {
    final quality = data[entry.key];
    if (quality is! Map) continue;
    final size = sizeFormat(quality['size']);
    if (size == null) continue;
    result.add(QualityOption(type: entry.value, size: size));
  }
  return _rankWyOptions(result);
}

Map<String, String> buildWyQualityBatchPayload(Iterable<Object?> songIds) {
  final result = <String, String>{};
  var index = 0;
  for (final rawId in songIds) {
    final songId = _numericSongId(rawId);
    if (songId == null) continue;
    final suffix = List.filled(index, '/').join();
    result['$wyMusicDetailPath$suffix'] = jsonEncode({'songId': songId});
    index++;
  }
  return result;
}

Map<String, List<QualityOption>> parseWyBatchQualityDetails(Object? raw) {
  if (raw is! Map) return const {};
  final code = int.tryParse(raw['code']?.toString() ?? '200');
  if (code != null && code != 200) return const {};

  final result = <String, List<QualityOption>>{};
  for (final value in raw.values) {
    if (value is! Map) continue;
    final data = value['data'];
    if (data is! Map) continue;
    final songId = data['songId']?.toString().trim() ?? '';
    if (songId.isEmpty) continue;
    final options = parseWyQualityDetail(value);
    if (options.isNotEmpty) result[songId] = options;
  }
  return result;
}

List<QualityOption> mergeWyQualityOptions(
  Iterable<QualityOption> fallback,
  Iterable<QualityOption> details,
) {
  final byType = <Quality, QualityOption>{
    for (final option in fallback) option.type: option,
  };
  for (final option in details) {
    byType[option.type] = option;
  }
  return _rankWyOptions(byType.values);
}

List<QualityOption> _rankWyOptions(Iterable<QualityOption> options) {
  final byType = <Quality, QualityOption>{
    for (final option in options) option.type: option,
  };
  return [for (final type in kQualityRank) ?byType[type]];
}

int? _numericSongId(Object? value) {
  final parsed = value is num
      ? value.toInt()
      : int.tryParse(value?.toString() ?? '');
  return parsed != null && parsed > 0 ? parsed : null;
}
