import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/enums.dart';
import '../models/lyric_info.dart';
import '../models/music_info.dart';
import '../models/playlist_info.dart';
import '../models/playlist_summary.dart';
import '../models/search_response.dart';
import '../sdk/music_sdk.dart' as sdk;
import '../sdk/playlist_catalog_sdk.dart';
import '../sdk/playlist_sdk.dart';
import '../storage/settings_store.dart';

class MusicApi {
  MusicApi({
    Iterable<MusicSource> enabledSearchSources = kDefaultEnabledSearchSources,
  }) : _enabledSearchSources = Set<MusicSource>.unmodifiable(
         enabledSearchSources,
       );

  final Set<MusicSource> _enabledSearchSources;

  // Local: hits each music platform directly. There is no CancelToken here —
  // the aggregator and 5 platform SDKs don't thread it through to SdkHttp, so
  // accepting one at this layer would be misleading. Callers that need
  // "discard stale response" semantics should track requests by identity.
  Future<SearchResponse> searchMusic({
    required String keyword,
    required MusicSource source,
    int page = 1,
    int limit = 30,
  }) async {
    final result = await sdk.MusicSdkAggregator.search(
      keyword: keyword,
      source: source,
      enabledSources: _enabledSearchSources,
      page: page,
      limit: limit,
    );
    return SearchResponse(
      list: result.list,
      page: result.page,
      limit: result.limit,
      allPage: result.allPage,
      total: result.total,
      source: result.source,
    );
  }

  // Local: parallel tip from each platform with round-robin merge.
  Future<List<String>> searchTip({
    required String keyword,
    required MusicSource source,
    int limit = 8,
  }) {
    return sdk.MusicSdkAggregator.tip(
      keyword: keyword,
      source: source,
      enabledSources: _enabledSearchSources,
      limit: limit,
    );
  }

  // Local: parses public playlists from all five platforms on-device.
  // Playback and download URL resolution are handled by MusicUrlResolver.
  Future<PlaylistInfo> parsePlaylist({
    required String input,
    MusicSource source = MusicSource.all,
    int? maxTracks,
  }) {
    return PlaylistSdk.parse(
      input: input,
      source: source,
      maxTracks: maxTracks,
    );
  }

  Future<List<PlaylistSummary>> featuredPlaylists({
    required MusicSource source,
    int page = 1,
    int limit = 20,
    String? categoryId,
  }) {
    return PlaylistCatalogSdk.featured(
      source,
      page: page,
      limit: limit,
      categoryId: categoryId,
    );
  }

  // Local: direct call to the platform lyric API for each source.
  Future<LyricInfo> getLyric({required MusicInfo musicInfo}) {
    return sdk.MusicSdkAggregator.getLyric(musicInfo);
  }

  // Local: returns the picUrl already on the MusicInfo (faster path), or
  // hits the source-specific cover endpoint.
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) {
    return sdk.MusicSdkAggregator.getPicUrl(
      musicInfo,
      preferCached: preferCached,
    );
  }
}

final musicApiProvider = Provider<MusicApi>((ref) {
  final enabledSearchSources = ref.watch(
    settingsProvider.select((settings) => settings.enabledSearchSources),
  );
  return MusicApi(enabledSearchSources: enabledSearchSources);
});

String describeDioError(Object error) {
  if (error is DioException) {
    final response = error.response?.data;
    if (response is Map && response['message'] is String) {
      return response['message'] as String;
    }
    if (error.type == DioExceptionType.connectionTimeout) return '连接超时';
    if (error.type == DioExceptionType.receiveTimeout) return '接收超时';
    if (error.type == DioExceptionType.sendTimeout) return '发送超时';
    if (error.type == DioExceptionType.connectionError) return '无法连接到服务器';
    if (error.type == DioExceptionType.cancel) return '请求已取消';
    if (error.message != null && error.message!.isNotEmpty) {
      return error.message!;
    }
    return '请求失败';
  }
  return error.toString();
}
