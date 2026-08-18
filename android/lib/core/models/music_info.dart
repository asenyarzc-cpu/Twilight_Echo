import 'enums.dart';

class QualityOption {
  const QualityOption({
    required this.type,
    this.size,
    this.hash,
    this.mediaInfo,
  });

  final Quality type;
  final String? size;
  final String? hash;
  final String? mediaInfo;

  factory QualityOption.fromJson(Map<String, dynamic> json) => QualityOption(
    type: Quality.fromCode(json['type'] as String? ?? '128k'),
    size: json['size'] as String?,
    hash: json['hash'] as String?,
    mediaInfo: json['mediaInfo'] as String?,
  );
}

class MusicMeta {
  const MusicMeta({
    required this.songId,
    required this.albumName,
    this.picUrl,
    this.albumId,
    required this.qualitys,
    this.hash,
    this.strMediaMid,
    this.metaId,
    this.albumMid,
    this.copyrightId,
    this.lrcUrl,
    this.mrcUrl,
    this.trcUrl,
    required this.raw,
  });

  final Object songId;
  final String albumName;
  final String? picUrl;
  final Object? albumId;
  final List<QualityOption> qualitys;

  // Source-specific extras carried so they round-trip back to the server.
  final String? hash;
  final String? strMediaMid;
  final Object? metaId;
  final String? albumMid;
  final String? copyrightId;
  final String? lrcUrl;
  final String? mrcUrl;
  final String? trcUrl;

  // Original platform metadata preserved for the active music source script.
  final Map<String, dynamic> raw;

  factory MusicMeta.fromJson(Map<String, dynamic> json) {
    final qualitysRaw = json['qualitys'];
    final qualitys = <QualityOption>[];
    if (qualitysRaw is List) {
      for (final item in qualitysRaw) {
        if (item is Map<String, dynamic>) {
          qualitys.add(QualityOption.fromJson(item));
        } else if (item is Map) {
          qualitys.add(QualityOption.fromJson(Map<String, dynamic>.from(item)));
        }
      }
    }

    return MusicMeta(
      songId: (json['songId'] as Object?) ?? '',
      albumName: (json['albumName'] as String?) ?? '',
      picUrl: json['picUrl'] as String?,
      albumId: json['albumId'] as Object?,
      qualitys: qualitys,
      hash: json['hash'] as String?,
      strMediaMid: json['strMediaMid'] as String?,
      metaId: json['id'] as Object?,
      albumMid: json['albumMid'] as String?,
      copyrightId: json['copyrightId'] as String?,
      lrcUrl: json['lrcUrl'] as String?,
      mrcUrl: json['mrcUrl'] as String?,
      trcUrl: json['trcUrl'] as String?,
      raw: Map<String, dynamic>.from(json),
    );
  }

  Map<String, dynamic> toJson() => raw;
}

class MusicInfo {
  const MusicInfo({
    required this.id,
    required this.name,
    required this.singer,
    required this.source,
    required this.interval,
    required this.meta,
    required this.raw,
  });

  final String id;
  final String name;
  final String singer;
  final MusicSource source;
  final String? interval;
  final MusicMeta meta;
  final Map<String, dynamic> raw;

  factory MusicInfo.fromJson(Map<String, dynamic> json) {
    final metaRaw = json['meta'];
    final metaMap = metaRaw is Map<String, dynamic>
        ? metaRaw
        : (metaRaw is Map
              ? Map<String, dynamic>.from(metaRaw)
              : <String, dynamic>{});

    return MusicInfo(
      id: (json['id'] as String?) ?? '',
      name: (json['name'] as String?) ?? '',
      singer: (json['singer'] as String?) ?? '',
      source: MusicSource.fromCode((json['source'] as String?) ?? ''),
      interval: json['interval'] as String?,
      meta: MusicMeta.fromJson(metaMap),
      raw: Map<String, dynamic>.from(json),
    );
  }

  Map<String, dynamic> toJson() => raw;

  List<QualityOption> get sortedQualities {
    final list = [...meta.qualitys];
    list.sort(
      (a, b) => kQualityRank.indexOf(a.type) - kQualityRank.indexOf(b.type),
    );
    return list;
  }

  Quality get bestQuality =>
      sortedQualities.isEmpty ? Quality.k128 : sortedQualities.first.type;

  Quality playbackQualityFor(OnlinePlaybackQuality preference) {
    final seen = <Quality>{};
    final available = <Quality>[
      for (final option in sortedQualities)
        if (seen.add(option.type)) option.type,
    ];
    if (available.isEmpty) return Quality.k128;

    final preferred = preference.preferredQuality;
    if (preferred == null) return available.first;
    if (available.contains(preferred)) return preferred;

    final preferredRank = kQualityRank.indexOf(preferred);
    if (preferredRank < 0) return available.first;

    Quality? closestLower;
    var closestLowerRank = kQualityRank.length;
    Quality? closestHigher;
    var closestHigherRank = -1;
    for (final quality in available) {
      final rank = kQualityRank.indexOf(quality);
      if (rank < 0) continue;
      if (rank > preferredRank && rank < closestLowerRank) {
        closestLower = quality;
        closestLowerRank = rank;
      } else if (rank < preferredRank && rank > closestHigherRank) {
        closestHigher = quality;
        closestHigherRank = rank;
      }
    }
    return closestLower ?? closestHigher ?? available.first;
  }

  String get albumName => meta.albumName;
}
