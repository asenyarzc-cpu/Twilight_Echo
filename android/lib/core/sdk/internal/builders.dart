import '../../models/enums.dart';
import '../../models/music_info.dart';
import 'format.dart';

// On-device MusicInfo builder. Mirrors lib/musicInfo.ts:toNewMusicInfo from the
// server, but constructs both the structured model AND its `raw` JSON so the
// downstream music source resolution receives the same original shape.
MusicInfo buildMusicInfo({
  required String name,
  required String singer,
  required MusicSource source,
  required Object songId,
  required List<QualityOption> qualitys,
  String? interval,
  String albumName = '',
  String? picUrl,
  Object? albumId,
  String? hash,
  String? strMediaMid,
  Object? metaId,
  String? albumMid,
  String? copyrightId,
  String? lrcUrl,
  String? mrcUrl,
  String? trcUrl,
}) {
  // Build the meta JSON the way toNewMusicInfo did: same key names, only set
  // source-specific extras when non-null so the server-side script gets exactly
  // what it expects.
  final metaJson = <String, dynamic>{
    'songId': songId,
    'albumName': albumName,
    'picUrl': picUrl ?? '',
    'qualitys': qualitys
        .map(
          (q) => <String, dynamic>{
            'type': q.type.code,
            'size': q.size,
            if (q.hash != null) 'hash': q.hash,
            if (q.mediaInfo != null) 'mediaInfo': q.mediaInfo,
          },
        )
        .toList(),
    '_qualitys': {
      for (final q in qualitys)
        q.type.code: {
          'size': q.size,
          if (q.hash != null) 'hash': q.hash,
          if (q.mediaInfo != null) 'mediaInfo': q.mediaInfo,
        },
    },
    'albumId': ?albumId,
  };

  String id;
  switch (source) {
    case MusicSource.kg:
      metaJson['hash'] = hash;
      id = '${songId}_${hash ?? ''}';
    case MusicSource.tx:
      if (strMediaMid != null) metaJson['strMediaMid'] = strMediaMid;
      if (metaId != null) metaJson['id'] = metaId;
      if (albumMid != null) metaJson['albumMid'] = albumMid;
      id = '${source.code}_$songId';
    case MusicSource.mg:
      if (copyrightId != null) metaJson['copyrightId'] = copyrightId;
      if (lrcUrl != null) metaJson['lrcUrl'] = lrcUrl;
      if (mrcUrl != null) metaJson['mrcUrl'] = mrcUrl;
      if (trcUrl != null) metaJson['trcUrl'] = trcUrl;
      id = '${source.code}_$songId';
    case MusicSource.kw:
    case MusicSource.wy:
    case MusicSource.all:
      id = '${source.code}_$songId';
  }

  final rawJson = <String, dynamic>{
    'id': id,
    'name': name,
    'singer': singer,
    'source': source.code,
    'interval': interval,
    'meta': metaJson,
  };

  return MusicInfo.fromJson(rawJson);
}

/// Converts the structured app model back to the flat legacy music-source shape.
/// This mirrors resolver service's `toOldMusicInfo` adapter.
Map<String, dynamic> toOldMusicInfoJson(MusicInfo music, {Quality? quality}) {
  final meta = music.meta;
  final rawQualities = meta.raw['qualitys'];
  final rawQualityMap = meta.raw['_qualitys'];
  final qualities = rawQualities is List
      ? List<dynamic>.from(rawQualities)
      : [
          for (final quality in meta.qualitys)
            <String, dynamic>{
              'type': quality.type.code,
              'size': quality.size,
              if (quality.hash != null) 'hash': quality.hash,
              if (quality.mediaInfo != null) 'mediaInfo': quality.mediaInfo,
            },
        ];
  final qualityMap = rawQualityMap is Map
      ? Map<String, dynamic>.from(rawQualityMap)
      : <String, dynamic>{
          for (final quality in meta.qualitys)
            quality.type.code: <String, dynamic>{
              'size': quality.size,
              if (quality.hash != null) 'hash': quality.hash,
              if (quality.mediaInfo != null) 'mediaInfo': quality.mediaInfo,
            },
        };
  final selectedMediaMid = quality == null
      ? null
      : meta.qualitys
            .where((option) => option.type == quality)
            .map((option) => option.mediaInfo)
            .whereType<String>()
            .map((value) => value.trim())
            .where((value) => value.isNotEmpty)
            .firstOrNull;

  return <String, dynamic>{
    'name': music.name,
    'singer': music.singer,
    'source': music.source.code,
    'songmid': meta.songId,
    'interval': music.interval,
    'albumName': meta.albumName,
    'albumId': meta.albumId,
    'img': meta.picUrl ?? '',
    'hash': meta.hash,
    'strMediaMid': selectedMediaMid ?? meta.strMediaMid,
    'songId': meta.metaId,
    'albumMid': meta.albumMid,
    'copyrightId': meta.copyrightId,
    'lrcUrl': meta.lrcUrl,
    'mrcUrl': meta.mrcUrl,
    'trcUrl': meta.trcUrl,
    'types': qualities,
    '_types': qualityMap,
    'typeUrl': <String, dynamic>{},
  };
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}

// Cross-source dedupe by id. Server uses lib/musicInfo.ts:dedupeMusic which
// drops items with empty id and keeps the first occurrence per id.
List<MusicInfo> dedupeMusic(List<MusicInfo> list) {
  final seen = <String>{};
  final out = <MusicInfo>[];
  for (final item in list) {
    if (item.id.isEmpty || seen.contains(item.id)) continue;
    seen.add(item.id);
    out.add(item);
  }
  return out;
}

// Exact title and title/artist matches must dominate fuzzy matches. Equal
// scores retain the platform's original rank.
List<MusicInfo> sortByKeyword(List<MusicInfo> list, String keyword) {
  final indexed = list.asMap().entries.toList(growable: false);
  indexed.sort((a, b) {
    final scoreA = _searchRelevance(keyword, a.value);
    final scoreB = _searchRelevance(keyword, b.value);
    final byScore = scoreB.compareTo(scoreA);
    return byScore != 0 ? byScore : a.key.compareTo(b.key);
  });
  return [for (final entry in indexed) entry.value];
}

int _searchRelevance(String keyword, MusicInfo music) {
  final query = _normalizeSearchText(keyword);
  final title = _normalizeSearchText(music.name);
  final artist = _normalizeSearchText(music.singer);
  if (query.isEmpty) return 0;

  final titleArtist = '$title$artist';
  final artistTitle = '$artist$title';
  if (query == titleArtist || query == artistTitle) return 120000;
  if (query == title) return 110000;
  if (query == artist) return 100000;

  var score = 0;
  if (title.startsWith(query)) {
    score = 90000;
  } else if (title.contains(query)) {
    score = 80000;
  } else if (query.length >= 2 && query.contains(title)) {
    score = 70000;
  } else if (titleArtist.contains(query) || artistTitle.contains(query)) {
    score = 65000;
  } else if (artist.startsWith(query)) {
    score = 60000;
  } else if (artist.contains(query)) {
    score = 50000;
  }

  final titleSimilarity = similar(query, title);
  final combinedSimilarity = similar(query, titleArtist) * 0.85;
  final fuzzy =
      (10000 *
              (titleSimilarity > combinedSimilarity
                  ? titleSimilarity
                  : combinedSimilarity))
          .round();
  return score + fuzzy;
}

String _normalizeSearchText(String value) {
  return value.toLowerCase().replaceAll(
    RegExp(r'''[\s\-_.,，。!！?？:：;；/\\|()（）\[\]【】{}《》<>·"“”'‘’]+'''),
    '',
  );
}
