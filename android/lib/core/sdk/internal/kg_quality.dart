import 'dart:convert';

import '../../models/enums.dart';
import '../../models/music_info.dart';
import 'crypto_util.dart';
import 'format.dart';

const int kgPrivilegeAppId = 1005;
const int kgPrivilegeClientVersion = 20489;
const int kgPrivilegeBatchLimit = 100;

const List<String> kgPrivilegeQualities = [
  '128',
  '320',
  'flac',
  'high',
  'viper_atmos',
  'viper_clear',
];

const Map<String, Quality> _kgDetailQualityMap = {
  '128': Quality.k128,
  '320': Quality.k320,
  'flac': Quality.flac,
  'high': Quality.hires,
  'viper_atmos': Quality.atmos,
  'viper_clear': Quality.master,
};

const String _kgAndroidSignatureSeed = 'OIlwieks28dk2k092lksi2UIkp';

class KgPrivilegeResource {
  const KgPrivilegeResource({required this.hash, this.albumId});

  final String hash;
  final Object? albumId;
}

List<QualityOption> parseKgSearchQualityOptions(Map raw) {
  final result = <QualityOption>[];

  void add(Quality type, Object? size, Object? hash) {
    final formatted = sizeFormat(size);
    if (formatted == null) return;
    result.add(
      QualityOption(type: type, size: formatted, hash: _nonEmptyString(hash)),
    );
  }

  add(Quality.k128, raw['FileSize'], raw['FileHash']);
  add(Quality.k320, raw['HQFileSize'], raw['HQFileHash']);
  add(Quality.flac, raw['SQFileSize'], raw['SQFileHash']);
  add(Quality.hires, raw['ResFileSize'], raw['ResFileHash']);
  return _rankKgOptions(result);
}

Map<String, dynamic> buildKgPrivilegeRequestBody(
  Iterable<KgPrivilegeResource> resources,
) {
  return <String, dynamic>{
    'appid': kgPrivilegeAppId,
    'area_code': 1,
    'behavior': 'play',
    'clientver': kgPrivilegeClientVersion,
    'need_hash_offset': 1,
    'relate': 1,
    'support_verify': 1,
    'resource': [
      for (final resource in resources)
        <String, dynamic>{
          'type': 'audio',
          'page_id': 0,
          'hash': resource.hash,
          'album_id': _numericAlbumId(resource.albumId),
        },
    ],
    'qualities': kgPrivilegeQualities,
  };
}

String encodeKgPrivilegeRequestBody(Iterable<KgPrivilegeResource> resources) =>
    jsonEncode(buildKgPrivilegeRequestBody(resources));

String buildKgPrivilegeSignature(
  Map<String, String> queryParameters,
  String exactJsonBody,
) {
  final keys = queryParameters.keys.toList()..sort();
  final queryText = keys
      .map((key) => '$key=${queryParameters[key] ?? ''}')
      .join();
  return CryptoUtil.md5Hex(
    '$_kgAndroidSignatureSeed$queryText$exactJsonBody'
    '$_kgAndroidSignatureSeed',
  );
}

/// Returns quality options keyed by the original search hash.
Map<String, List<QualityOption>> parseKgPrivilegeQualityDetails(Object? raw) {
  final decoded = _decodeKgResponse(raw);
  if (decoded is! Map) return const {};
  final errorCode = int.tryParse(decoded['error_code']?.toString() ?? '0');
  if (errorCode != null && errorCode != 0) return const {};
  final data = decoded['data'];
  if (data is! List) return const {};

  final result = <String, List<QualityOption>>{};
  for (final item in data) {
    if (item is! Map) continue;
    final baseHash = kgHashKey(item['hash']);
    final goods = item['relate_goods'];
    if (baseHash.isEmpty || goods is! List) continue;

    final byType = <Quality, QualityOption>{};
    for (final good in goods) {
      if (good is! Map) continue;
      final qualityCode = good['quality']?.toString().toLowerCase();
      final type = _kgDetailQualityMap[qualityCode];
      final info = good['info'];
      final size = info is Map ? sizeFormat(info['filesize']) : null;
      if (type == null || size == null) continue;
      byType[type] = QualityOption(
        type: type,
        size: size,
        hash: _nonEmptyString(good['hash']),
      );
    }

    if (byType.isNotEmpty) {
      result[baseHash] = _rankKgOptions(byType.values);
    }
  }
  return result;
}

String? parseKgPrivilegeCoverUrl(Object? raw, {int preferredSize = 480}) {
  final decoded = _decodeKgResponse(raw);
  if (decoded is! Map) return null;
  final data = decoded['data'];
  final item = data is List && data.isNotEmpty ? data.first : null;
  final info = item is Map ? item['info'] : null;
  if (info is! Map) return null;

  final template = _nonEmptyString(info['image']);
  if (template == null) return null;
  final rawSizes = info['imgsize'];
  final sizes = rawSizes is List
      ? rawSizes
            .map((value) => int.tryParse(value.toString()))
            .whereType<int>()
            .toList(growable: false)
      : const <int>[];
  final size = sizes.contains(preferredSize)
      ? preferredSize
      : sizes.firstOrNull ?? preferredSize;
  return template.replaceAll('{size}', '$size');
}

List<QualityOption> mergeKgQualityOptions(
  Iterable<QualityOption> fallback,
  Iterable<QualityOption> details,
) {
  final byType = <Quality, QualityOption>{
    for (final option in fallback) option.type: option,
  };
  for (final option in details) {
    byType[option.type] = option;
  }
  return _rankKgOptions(byType.values);
}

String kgHashKey(Object? value) =>
    (value?.toString().trim() ?? '').toUpperCase();

List<QualityOption> _rankKgOptions(Iterable<QualityOption> options) {
  final byType = <Quality, QualityOption>{
    for (final option in options) option.type: option,
  };
  return [for (final type in kQualityRank) ?byType[type]];
}

String? _nonEmptyString(Object? value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

Object _numericAlbumId(Object? value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

Object? _decodeKgResponse(Object? raw) {
  if (raw is! String) return raw;
  try {
    return jsonDecode(raw);
  } catch (_) {
    return null;
  }
}
