import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/dio_factory.dart';
import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/search_response.dart';
import '../../core/services/app_logger.dart';
import '../../core/storage/settings_store.dart';
import '../discovery/discovery_controller.dart';

class SearchQuery {
  const SearchQuery({
    required this.keyword,
    required this.source,
    required this.page,
  });

  final String keyword;
  final MusicSource source;
  final int page;

  SearchQuery copyWith({String? keyword, MusicSource? source, int? page}) =>
      SearchQuery(
        keyword: keyword ?? this.keyword,
        source: source ?? this.source,
        page: page ?? this.page,
      );

  @override
  bool operator ==(Object other) =>
      other is SearchQuery &&
      other.keyword == keyword &&
      other.source == source &&
      other.page == page;

  @override
  int get hashCode => Object.hash(keyword, source, page);
}

class SearchState {
  const SearchState({
    this.keyword = '',
    this.source = MusicSource.all,
    this.page = 1,
    this.loading = false,
    this.error,
    this.response,
    this.searchActive = false,
  });

  final String keyword;
  final MusicSource source;
  final int page;
  final bool loading;
  final String? error;
  final SearchResponse? response;
  final bool searchActive;

  bool get isSearchActive =>
      searchActive || loading || response != null || keyword.trim().isNotEmpty;

  SearchState copyWith({
    String? keyword,
    MusicSource? source,
    int? page,
    bool? loading,
    Object? error = _sentinel,
    Object? response = _sentinel,
    bool? searchActive,
  }) => SearchState(
    keyword: keyword ?? this.keyword,
    source: source ?? this.source,
    page: page ?? this.page,
    loading: loading ?? this.loading,
    error: identical(error, _sentinel) ? this.error : error as String?,
    response: identical(response, _sentinel)
        ? this.response
        : response as SearchResponse?,
    searchActive: searchActive ?? this.searchActive,
  );

  static const _sentinel = Object();
}

class SearchController extends Notifier<SearchState> {
  Object? _activeRequest;
  final Map<SearchQuery, SearchResponse> _responseCache =
      <SearchQuery, SearchResponse>{};
  final Map<SearchQuery, Future<SearchResponse>> _inFlight =
      <SearchQuery, Future<SearchResponse>>{};

  @override
  SearchState build() {
    ref.onDispose(() {
      _activeRequest = null;
      _responseCache.clear();
      _inFlight.clear();
    });
    ref.listen<Set<MusicSource>>(
      settingsProvider.select((settings) => settings.enabledSearchSources),
      (previous, next) {
        _activeRequest = Object();
        _responseCache.removeWhere(
          (query, _) =>
              query.source == MusicSource.all ||
              (query.source != MusicSource.all && !next.contains(query.source)),
        );
        final activeSource = state.isSearchActive
            ? _sourceEnabled(state.source, next)
                  ? state.source
                  : _defaultSearchSource(next)
            : _defaultSearchSource(next);
        final keyword = state.keyword;
        state = state.copyWith(
          source: activeSource,
          page: 1,
          loading: false,
          error: null,
          response: null,
        );
        if (keyword.trim().isNotEmpty) {
          unawaited(search(keyword: keyword, source: activeSource));
        }
      },
    );
    ref.listen<MusicSource>(selectedDiscoverySourceProvider, (previous, next) {
      if (state.isSearchActive) return;
      final source = _defaultSearchSource();
      if (state.source == source) return;
      state = state.copyWith(source: source);
    });
    return SearchState(source: _defaultSearchSource());
  }

  void setSource(MusicSource source) {
    final enabled = ref.read(settingsProvider).enabledSearchSources;
    if (source != MusicSource.all && !enabled.contains(source)) return;
    if (source == state.source) return;
    state = state.copyWith(source: source);
    if (state.keyword.trim().isNotEmpty) {
      search(keyword: state.keyword, source: source, page: 1);
    }
  }

  Future<void> search({
    required String keyword,
    MusicSource? source,
    int page = 1,
  }) async {
    final cleaned = keyword.trim();
    if (cleaned.isEmpty) {
      state = state.copyWith(error: '请输入歌名、歌手或专辑');
      return;
    }

    final activeSource = source ?? state.source;
    final query = SearchQuery(
      keyword: cleaned,
      source: activeSource,
      page: page,
    );

    // Identity-only marker: the underlying SDK fan-out doesn't accept a
    // CancelToken, so we just stamp each call with a fresh Object() and
    // discard the result if a newer call has started since.
    final request = Object();
    _activeRequest = request;

    state = state.copyWith(
      keyword: cleaned,
      source: activeSource,
      page: page,
      loading: false,
      error: null,
      searchActive: true,
    );

    final cached = _responseCache[query];
    if (cached != null) {
      state = state.copyWith(response: cached);
      return;
    }

    state = state.copyWith(loading: true);
    final existing = _inFlight[query];
    final future =
        existing ??
        Future<SearchResponse>.sync(
          () => ref
              .read(musicApiProvider)
              .searchMusic(keyword: cleaned, source: activeSource, page: page),
        );
    if (existing == null) {
      _inFlight[query] = future;
    }
    unawaited(
      AppLogger.write(
        'search',
        '${existing == null ? 'START' : 'JOIN'} keyword="$cleaned" '
            'source=${activeSource.code} page=$page '
            'adapter=${currentNetworkAdapterLabel()}',
      ),
    );
    try {
      final result = await future;
      _responseCache[query] = result;
      if (!identical(request, _activeRequest)) return;
      unawaited(
        AppLogger.write(
          'search',
          'OK keyword="$cleaned" source=${activeSource.code} '
              'page=$page count=${result.list.length}',
        ),
      );
      state = state.copyWith(loading: false, response: result, error: null);
    } on DioException catch (e) {
      if (!identical(request, _activeRequest)) return;
      unawaited(
        AppLogger.write(
          'search',
          'FAIL keyword="$cleaned" source=${activeSource.code} '
              'page=$page error=$e',
        ),
      );
      state = state.copyWith(loading: false, error: describeDioError(e));
    } catch (e) {
      if (!identical(request, _activeRequest)) return;
      unawaited(
        AppLogger.write(
          'search',
          'FAIL keyword="$cleaned" source=${activeSource.code} '
              'page=$page error=$e',
        ),
      );
      state = state.copyWith(loading: false, error: e.toString());
    } finally {
      if (existing == null && identical(_inFlight[query], future)) {
        _inFlight.remove(query);
      }
    }
  }

  void clearError() {
    if (state.error != null) state = state.copyWith(error: null);
  }

  void resetToDiscovery() {
    _activeRequest = Object();
    state = SearchState(source: _defaultSearchSource());
  }

  bool _sourceEnabled(MusicSource source, Set<MusicSource> enabled) =>
      source == MusicSource.all || enabled.contains(source);

  MusicSource _defaultSearchSource([Set<MusicSource>? enabledSources]) {
    final enabled =
        enabledSources ?? ref.read(settingsProvider).enabledSearchSources;
    final discoverySource = ref.read(selectedDiscoverySourceProvider);
    return enabled.contains(discoverySource)
        ? discoverySource
        : MusicSource.all;
  }
}

final searchControllerProvider =
    NotifierProvider<SearchController, SearchState>(SearchController.new);
