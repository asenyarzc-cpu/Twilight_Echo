import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import '../services/app_logger.dart';
import 'internal/builders.dart';
import 'kg_sdk.dart';
import 'kw_sdk.dart';
import 'mg_sdk.dart';
import 'tx_sdk.dart';
import 'wy_sdk.dart';

class MusicSdkAggregator {
  const MusicSdkAggregator._();

  static Future<List<MusicInfo>> _searchSingle(
    MusicSource source,
    String keyword,
    int page,
    int limit,
  ) {
    switch (source) {
      case MusicSource.kw:
        return KwSdk.search(keyword, page: page, limit: limit);
      case MusicSource.kg:
        return KgSdk.search(keyword, page: page, limit: limit);
      case MusicSource.mg:
        return MgSdk.search(keyword, page: page, limit: limit);
      case MusicSource.tx:
        return TxSdk.search(keyword, page: page, limit: limit);
      case MusicSource.wy:
        return WySdk.search(keyword, page: page, limit: limit);
      case MusicSource.all:
        throw ArgumentError('use search() for source=all');
    }
  }

  static Future<List<String>> _tipSingle(MusicSource source, String keyword) {
    switch (source) {
      case MusicSource.kw:
        return KwSdk.tip(keyword);
      case MusicSource.kg:
        return KgSdk.tip(keyword);
      case MusicSource.mg:
        return MgSdk.tip(keyword);
      case MusicSource.tx:
        return TxSdk.tip(keyword);
      case MusicSource.wy:
        return WySdk.tip(keyword);
      case MusicSource.all:
        throw ArgumentError('use tip() for source=all');
    }
  }

  // Mirrors musicSdk/index.ts:searchMusic. For "all" sources, every platform is
  // queried in parallel and per-source failures are swallowed (so one dead
  // platform doesn't blank the whole result list).
  static Future<SearchResult> search({
    required String keyword,
    required MusicSource source,
    Iterable<MusicSource>? enabledSources,
    int page = 1,
    int limit = 30,
  }) async {
    final trimmed = keyword.trim();
    if (trimmed.isEmpty) {
      return SearchResult(list: const [], page: page, source: source);
    }

    final targets = _enabledSources(enabledSources);
    if (source != MusicSource.all) {
      if (!targets.contains(source)) {
        return SearchResult(
          list: const [],
          page: page,
          source: MusicSource.all,
          allPage: page,
        );
      }
      final list = await _searchSingle(source, trimmed, page, limit);
      return SearchResult(
        list: sortByKeyword(dedupeMusic(list), trimmed),
        page: page,
        source: source,
        allPage: list.isNotEmpty ? page + 1 : page,
        total: list.length,
      );
    }

    final results = await Future.wait(
      targets.map((s) async {
        try {
          return await _searchSingle(s, trimmed, page, limit);
        } catch (e) {
          await AppLogger.write('search', '${s.name} failed: $e');
          return <MusicInfo>[];
        }
      }),
      eagerError: false,
    );
    final merged = dedupeMusic(results.expand((e) => e).toList());
    return SearchResult(
      list: sortByKeyword(merged, trimmed),
      page: page,
      source: MusicSource.all,
      allPage: page + 1,
      total: merged.length,
    );
  }

  // Mirrors musicSdk/index.ts:tipSearch — round-robins suggestions from each
  // source, deduplicates case-insensitively, and stops at `limit`.
  static Future<List<String>> tip({
    required String keyword,
    required MusicSource source,
    Iterable<MusicSource>? enabledSources,
    int limit = 10,
  }) async {
    final trimmed = keyword.trim();
    if (trimmed.isEmpty) return const [];

    final enabled = _enabledSources(enabledSources);
    final targets = source == MusicSource.all
        ? enabled
        : (enabled.contains(source) ? [source] : const <MusicSource>[]);
    final results = await Future.wait(
      targets.map((s) async {
        try {
          return await _tipSingle(s, trimmed);
        } catch (_) {
          return <String>[];
        }
      }),
    );

    final seen = <String>{};
    final merged = <String>[];
    final indexes = List<int>.filled(results.length, 0);
    var exhausted = false;
    while (merged.length < limit && !exhausted) {
      exhausted = true;
      for (var i = 0; i < results.length && merged.length < limit; i++) {
        final list = results[i];
        if (indexes[i] >= list.length) continue;
        exhausted = false;
        final value = list[indexes[i]];
        indexes[i] = indexes[i] + 1;
        final normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
        if (normalized.isEmpty) continue;
        final key = normalized.toLowerCase();
        if (seen.contains(key)) continue;
        seen.add(key);
        merged.add(normalized);
      }
    }
    return merged;
  }

  static List<MusicSource> _enabledSources(Iterable<MusicSource>? sources) {
    final requested = sources ?? kDefaultEnabledSearchSources;
    return [
      for (final source in kManageableSearchSources)
        if (requested.contains(source)) source,
    ];
  }

  static Future<LyricInfo> getLyric(MusicInfo info) {
    switch (info.source) {
      case MusicSource.kw:
        return KwSdk.getLyric(info);
      case MusicSource.kg:
        return KgSdk.getLyric(info);
      case MusicSource.mg:
        return MgSdk.getLyric(info);
      case MusicSource.tx:
        return TxSdk.getLyric(info);
      case MusicSource.wy:
        return WySdk.getLyric(info);
      case MusicSource.all:
        throw ArgumentError('lyric requires a concrete source');
    }
  }

  // Mirrors musicResource.service.ts:getPicUrl: prefer the picUrl already
  // baked into meta (with wy's 500y500 hint), else fall through to a
  // source-specific lookup.
  static Future<String?> getPicUrl(
    MusicInfo info, {
    bool preferCached = true,
  }) async {
    final cached = info.meta.picUrl;
    if (preferCached && cached != null && cached.isNotEmpty) {
      if (info.source == MusicSource.wy && cached.contains('music.126.net')) {
        final normalized = cached.replaceFirst('http://', 'https://');
        final sep = cached.contains('?') ? '&' : '?';
        return '$normalized${sep}param=500y500';
      }
      return cached;
    }
    try {
      switch (info.source) {
        case MusicSource.kw:
          return await KwSdk.getPicUrl(info);
        case MusicSource.kg:
          return await KgSdk.getPicUrl(info);
        case MusicSource.mg:
          return await MgSdk.getPicUrl(info);
        case MusicSource.tx:
          return await TxSdk.getPicUrl(info);
        case MusicSource.wy:
          return await WySdk.getPicUrl(info);
        case MusicSource.all:
          return null;
      }
    } catch (_) {
      return null;
    }
  }
}

class SearchResult {
  const SearchResult({
    required this.list,
    required this.page,
    required this.source,
    this.allPage = 1,
    this.total = 0,
    this.limit = 30,
  });

  final List<MusicInfo> list;
  final int page;
  final int limit;
  final int allPage;
  final int total;
  final MusicSource source;
}
