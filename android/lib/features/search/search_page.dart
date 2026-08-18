import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart' hide SearchController;
import 'package:flutter/material.dart' as material show SearchController;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/app_toast.dart';
import '../../core/ui/expressive_loading_status.dart';
import '../downloads/download_progress.dart';
import '../discovery/discovery_content.dart';
import '../discovery/discovery_controller.dart';
import '../music_sources/music_source_action_guard.dart';
import '../player/player_controller.dart';
import '../playlists/playlist_browser_sheet.dart';
import '../playlists/playlist_store.dart';
import 'search_controller.dart';
import 'search_toolbar_state.dart';
import 'widgets/quality_picker_sheet.dart';
import 'widgets/search_result_tile.dart';
import 'widgets/source_filter_chips.dart';

class SearchPage extends ConsumerStatefulWidget {
  const SearchPage({super.key});

  @override
  ConsumerState<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends ConsumerState<SearchPage> {
  late final material.SearchController _controller;
  late final ScrollController _resultsScrollController;
  Object? _tipRequest;
  Iterable<Widget> _lastSuggestionWidgets = const <Widget>[];
  AppToastHandle? _searchErrorToast;

  @override
  void initState() {
    super.initState();
    _controller = material.SearchController();
    _resultsScrollController = ScrollController();
    _controller.text = ref.read(searchControllerProvider).keyword;
  }

  @override
  void dispose() {
    _tipRequest = null;
    _dismissSearchErrorToast();
    _controller.dispose();
    _resultsScrollController.dispose();
    super.dispose();
  }

  Future<Iterable<Widget>> _buildSuggestionTiles(
    BuildContext context,
    material.SearchController controller,
  ) async {
    final query = controller.text.trim();
    if (query.isEmpty) {
      _tipRequest = null;
      _lastSuggestionWidgets = const <Widget>[];
      return _lastSuggestionWidgets;
    }

    // Identity-only marker — the SDK fan-out can't really cancel, so we just
    // ignore the result if a newer keystroke has started another tip lookup.
    final request = Object();
    _tipRequest = request;
    try {
      final api = ref.read(musicApiProvider);
      final tips = await api.searchTip(
        keyword: query,
        source: _sourceForSearchRequest(ref.read(searchControllerProvider)),
      );
      if (!identical(request, _tipRequest) || query != controller.text.trim()) {
        return _lastSuggestionWidgets;
      }
      final seen = <String>{};
      final items = tips
          .map((tip) => tip.trim())
          .where((tip) => tip.isNotEmpty && seen.add(tip))
          .take(8)
          .map(
            (tip) => _SuggestionTile(
              text: tip,
              onTap: () {
                controller.closeView(tip);
                _runSearch(keyword: tip);
              },
              onComplete: () {
                controller.text = tip;
                controller.selection = TextSelection.collapsed(
                  offset: controller.text.length,
                );
              },
            ),
          )
          .toList(growable: false);
      _lastSuggestionWidgets = items;
      return items;
    } on DioException {
      return _lastSuggestionWidgets;
    }
  }

  Future<void> _runSearch({
    String? keyword,
    int page = 1,
    bool scrollToTopOnSuccess = false,
  }) async {
    final query = (keyword ?? _controller.text).trim();
    if (query.isEmpty) {
      showAppToast(context, '请输入歌名、歌手或专辑', type: AppToastType.warning);
      return;
    }
    _controller.text = query;
    _controller.selection = TextSelection.collapsed(offset: query.length);
    if (_controller.isAttached && _controller.isOpen) {
      _controller.closeView(query);
    }
    _dismissTransientRoutes();
    _releaseSearchFocus();

    final requestedSource = _sourceForSearchRequest(
      ref.read(searchControllerProvider),
    );
    await ref
        .read(searchControllerProvider.notifier)
        .search(keyword: query, source: requestedSource, page: page);
    if (!scrollToTopOnSuccess || !mounted) return;

    final completedState = ref.read(searchControllerProvider);
    final response = completedState.response;
    final requestStillMatches =
        !completedState.loading &&
        completedState.error == null &&
        completedState.keyword == query &&
        completedState.source == requestedSource &&
        completedState.page == page &&
        response?.page == page;
    if (!requestStillMatches) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_resultsScrollController.hasClients) return;
      _resultsScrollController.jumpTo(
        _resultsScrollController.position.minScrollExtent,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(searchControllerProvider);

    ref.listen<Set<MusicSource>>(
      settingsProvider.select((settings) => settings.enabledSearchSources),
      (previous, next) {
        _tipRequest = null;
        _lastSuggestionWidgets = const <Widget>[];
      },
    );

    ref.listen<SearchState>(
      searchControllerProvider,
      _handleSearchStateChanged,
    );

    _syncToolbarState(state);

    return Scaffold(
      body: RepaintBoundary(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
              child: _NativeSearchField(
                controller: _controller,
                onSubmitted: (v) => _runSearch(keyword: v),
                loading: state.loading,
                suggestionsBuilder: _buildSuggestionTiles,
                onClear: _returnToDiscovery,
              ),
            ),
            if (state.isSearchActive) ...[
              const SourceFilterChips(),
              const SizedBox(height: 4),
              Expanded(
                child: _ResultsArea(
                  state: state,
                  scrollController: _resultsScrollController,
                  onTapItem: _openPicker,
                  onPlayItem: _play,
                  onAddToPlaylist: _selectPlaylistForMusic,
                ),
              ),
            ] else
              const Expanded(child: DiscoveryContent()),
          ],
        ),
      ),
    );
  }

  Future<void> _openPicker(MusicInfo music) async {
    await showQualityPickerSheet(context, music);
  }

  Future<void> _play(MusicInfo music) async {
    final available = await ensureOnlineMusicSourcesAvailable(context, [
      music.source,
    ]);
    if (!available || !mounted) return;
    context.go('/player', extra: '/');
    await ref.read(playerControllerProvider.notifier).playFromMusic(music);
  }

  Future<void> _selectPlaylistForMusic(MusicInfo music) async {
    final destination = await showPlaylistBrowserSheet(
      context,
      mode: PlaylistBrowserMode.addSongs,
    );
    if (!mounted || destination == null) return;

    const prefix = '/playlists/';
    if (!destination.startsWith(prefix)) return;
    final playlistId = destination.substring(prefix.length);
    final store = ref.read(localPlaylistsProvider.notifier);
    final playlist = store.byId(playlistId);
    if (playlist == null) {
      showAppToast(context, '歌单不存在或已被删除', type: AppToastType.warning);
      return;
    }

    try {
      final added = await store.addMusic(playlistId, music);
      if (!mounted) return;
      showAppToast(
        context,
        added == 0 ? '歌曲已在「${playlist.name}」中' : '已添加到「${playlist.name}」',
        type: added == 0 ? AppToastType.info : AppToastType.success,
      );
    } catch (error) {
      if (!mounted) return;
      showAppToast(context, '添加到歌单失败：$error', type: AppToastType.error);
    }
  }

  void _returnToDiscovery() {
    _controller.clear();
    if (_controller.isAttached && _controller.isOpen) {
      _controller.closeView('');
    }
    _tipRequest = null;
    _lastSuggestionWidgets = const <Widget>[];
    _dismissSearchErrorToast();
    ref.read(searchControllerProvider.notifier).resetToDiscovery();
    _releaseSearchFocus();
  }

  void _syncToolbarState(SearchState state) {
    final response = state.response;
    final hasResults = response != null && response.list.isNotEmpty;
    final allPage = response?.allPage ?? state.page;
    final canNext =
        hasResults && state.page < (allPage > 0 ? allPage : state.page + 1);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final next = SearchToolbarState(
        visible: hasResults,
        page: state.page,
        loading: state.loading,
        canPrev: hasResults && state.page > 1,
        canNext: canNext,
        onPrev: () =>
            _runSearch(page: state.page - 1, scrollToTopOnSuccess: true),
        onNext: () =>
            _runSearch(page: state.page + 1, scrollToTopOnSuccess: true),
      );
      // Always refresh the callbacks as well as the visible paging values.
      // They close over the current SearchState page; keeping an older state
      // object here makes the FAB look correct while invoking a stale page.
      ref.read(searchToolbarStateProvider.notifier).state = next;
    });
  }

  void _dismissTransientRoutes() {
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.of(
      context,
      rootNavigator: true,
    ).popUntil((route) => route.isFirst);
  }

  void _releaseSearchFocus() {
    FocusManager.instance.primaryFocus?.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      FocusManager.instance.primaryFocus?.unfocus();
    });
  }

  void _handleSearchStateChanged(SearchState? previous, SearchState next) {
    if (!mounted) return;
    if (next.error != null && next.error != previous?.error) {
      _dismissSearchErrorToast();
      _searchErrorToast = showAppToast(
        context,
        next.error!,
        type: AppToastType.error,
      );
    } else if (next.error == null && previous?.error != null) {
      _dismissSearchErrorToast();
    }
  }

  void _dismissSearchErrorToast() {
    final toast = _searchErrorToast;
    _searchErrorToast = null;
    dismissAppToast(toast, showRemoveAnimation: false);
  }

  MusicSource _sourceForSearchRequest(SearchState state) {
    if (state.isSearchActive) return state.source;
    final discoverySource = ref.read(selectedDiscoverySourceProvider);
    final enabled = ref.read(settingsProvider).enabledSearchSources;
    if (enabled.contains(discoverySource)) return discoverySource;
    return state.source == MusicSource.all || !enabled.contains(state.source)
        ? MusicSource.all
        : state.source;
  }
}

class _NativeSearchField extends StatelessWidget {
  const _NativeSearchField({
    required this.controller,
    required this.onSubmitted,
    required this.onClear,
    required this.loading,
    required this.suggestionsBuilder,
  });

  final material.SearchController controller;
  final ValueChanged<String> onSubmitted;
  final VoidCallback onClear;
  final bool loading;
  final Future<Iterable<Widget>> Function(
    BuildContext context,
    material.SearchController controller,
  )
  suggestionsBuilder;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textStyle = WidgetStatePropertyAll(
      TextStyle(
        color: scheme.onSurface,
        fontSize: 14,
        fontWeight: FontWeight.w500,
        height: 1.1,
        letterSpacing: 0,
      ),
    );
    final hintStyle = WidgetStatePropertyAll(
      TextStyle(
        color: scheme.onSurfaceVariant.withValues(alpha: 0.76),
        fontSize: 13,
        fontWeight: FontWeight.w500,
        height: 1.1,
      ),
    );
    final shape = WidgetStatePropertyAll(
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    );
    return SearchAnchor.bar(
      searchController: controller,
      isFullScreen: false,
      barHintText: '搜索歌曲、歌手、专辑',
      barLeading: Icon(
        Icons.search_rounded,
        color: scheme.onSurfaceVariant,
        size: 20,
      ),
      barTrailing: [
        _SearchTrailing(
          controller: controller,
          loading: loading,
          onClear: onClear,
        ),
      ],
      barElevation: const WidgetStatePropertyAll(0),
      barBackgroundColor: WidgetStatePropertyAll(scheme.surfaceContainerHigh),
      barOverlayColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.pressed)) {
          return scheme.primary.withValues(alpha: 0.08);
        }
        if (states.contains(WidgetState.hovered) ||
            states.contains(WidgetState.focused)) {
          return scheme.primary.withValues(alpha: 0.05);
        }
        return Colors.transparent;
      }),
      barSide: WidgetStatePropertyAll(
        BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.28)),
      ),
      barShape: shape,
      barPadding: const WidgetStatePropertyAll(
        EdgeInsetsDirectional.fromSTEB(12, 0, 6, 0),
      ),
      barTextStyle: textStyle,
      barHintStyle: hintStyle,
      constraints: const BoxConstraints(minHeight: 48, maxHeight: 48),
      viewConstraints: BoxConstraints(
        maxHeight: math.min(MediaQuery.sizeOf(context).height * 0.52, 520),
      ),
      viewShape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
      ),
      viewSide: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.8)),
      viewBackgroundColor: scheme.surfaceContainerHigh,
      viewElevation: 0,
      dividerColor: scheme.outlineVariant.withValues(alpha: 0.72),
      viewBarPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
      viewHeaderHeight: 48,
      viewHeaderTextStyle: textStyle.value,
      viewHeaderHintStyle: hintStyle.value,
      shrinkWrap: true,
      textCapitalization: TextCapitalization.none,
      textInputAction: TextInputAction.search,
      keyboardType: TextInputType.text,
      suggestionsBuilder: suggestionsBuilder,
      onSubmitted: onSubmitted,
    );
  }
}

class _SearchTrailing extends StatelessWidget {
  const _SearchTrailing({
    required this.controller,
    required this.loading,
    required this.onClear,
  });

  final material.SearchController controller;
  final bool loading;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 36,
      child: Center(
        child: ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            if (value.text.isEmpty) {
              return const SizedBox.shrink(key: ValueKey('empty'));
            }
            return IconButton(
              key: const ValueKey('clear'),
              tooltip: loading ? '取消搜索' : '清除',
              visualDensity: VisualDensity.compact,
              color: scheme.onSurfaceVariant,
              onPressed: onClear,
              icon: loading
                  ? SizedBox.square(
                      key: const ValueKey('loading-cancel'),
                      dimension: 22,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          CircularProgressIndicator(
                            strokeWidth: 2,
                            color: scheme.primary,
                          ),
                          Icon(
                            Icons.close_rounded,
                            size: 14,
                            color: scheme.onSurfaceVariant,
                          ),
                        ],
                      ),
                    )
                  : const Icon(Icons.close_rounded),
            );
          },
        ),
      ),
    );
  }
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({
    required this.text,
    required this.onTap,
    required this.onComplete,
  });

  final String text;
  final VoidCallback onTap;
  final VoidCallback onComplete;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListTile(
      minTileHeight: 54,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18),
      minLeadingWidth: 34,
      leading: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          shape: BoxShape.circle,
        ),
        child: Icon(
          Icons.history_rounded,
          color: scheme.onSurfaceVariant,
          size: 18,
        ),
      ),
      title: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: scheme.onSurface,
          fontSize: 14.5,
          fontWeight: FontWeight.w500,
          letterSpacing: -0.05,
        ),
      ),
      trailing: IconButton(
        tooltip: '补全',
        icon: const Icon(Icons.north_west_rounded),
        iconSize: 19,
        color: scheme.onSurfaceVariant,
        visualDensity: VisualDensity.compact,
        onPressed: onComplete,
      ),
      onTap: onTap,
    );
  }
}

class _SearchPreludeArt extends StatelessWidget {
  const _SearchPreludeArt();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 108,
      child: CustomPaint(painter: _SearchPreludePainter(scheme)),
    );
  }
}

class _SearchPreludePainter extends CustomPainter {
  const _SearchPreludePainter(this.scheme);

  final ColorScheme scheme;

  @override
  void paint(Canvas canvas, Size size) {
    final primary = scheme.primary;
    final tertiary = scheme.tertiary;
    final surface = scheme.surfaceContainerHighest;

    final prismRect = Rect.fromLTWH(
      size.width * 0.28,
      size.height * 0.3,
      size.width * 0.44,
      size.height * 0.42,
    );
    final prismPaint = Paint()
      ..style = PaintingStyle.fill
      ..color = surface.withValues(alpha: 0.64);
    final prismRadius = Radius.circular(size.width * 0.16);
    canvas.drawRRect(
      RRect.fromRectAndRadius(prismRect, prismRadius),
      prismPaint,
    );

    final lowerWavePath = Path()
      ..moveTo(size.width * 0.18, size.height * 0.58)
      ..cubicTo(
        size.width * 0.28,
        size.height * 0.38,
        size.width * 0.43,
        size.height * 0.8,
        size.width * 0.56,
        size.height * 0.52,
      )
      ..cubicTo(
        size.width * 0.68,
        size.height * 0.28,
        size.width * 0.78,
        size.height * 0.72,
        size.width * 0.86,
        size.height * 0.48,
      );
    final lowerWavePaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.058
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = primary.withValues(alpha: 0.86);
    canvas.drawPath(lowerWavePath, lowerWavePaint);

    final upperWavePaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.044
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = tertiary.withValues(alpha: 0.72);
    canvas.drawArc(
      Rect.fromLTWH(
        size.width * 0.16,
        size.height * 0.34,
        size.width * 0.68,
        size.height * 0.38,
      ),
      math.pi * 1.08,
      math.pi * 0.84,
      false,
      upperWavePaint,
    );

    final barPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.054
      ..strokeCap = StrokeCap.round
      ..color = tertiary.withValues(alpha: 0.82);
    final bars = <({double x, double top, double bottom})>[
      (x: 0.31, top: 0.51, bottom: 0.66),
      (x: 0.44, top: 0.41, bottom: 0.7),
      (x: 0.57, top: 0.37, bottom: 0.64),
      (x: 0.7, top: 0.47, bottom: 0.67),
    ];
    for (final bar in bars) {
      canvas.drawLine(
        Offset(size.width * bar.x, size.height * bar.top),
        Offset(size.width * bar.x, size.height * bar.bottom),
        barPaint,
      );
    }

    final glintPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.024
      ..strokeCap = StrokeCap.round
      ..color = primary.withValues(alpha: 0.36);
    canvas.drawLine(
      Offset(size.width * 0.28, size.height * 0.29),
      Offset(size.width * 0.34, size.height * 0.29),
      glintPaint,
    );
    canvas.drawLine(
      Offset(size.width * 0.31, size.height * 0.26),
      Offset(size.width * 0.31, size.height * 0.32),
      glintPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _SearchPreludePainter oldDelegate) {
    return oldDelegate.scheme != scheme;
  }
}

class _SearchLoadingStatus extends StatelessWidget {
  const _SearchLoadingStatus();

  @override
  Widget build(BuildContext context) {
    return const ExpressiveLoadingStatus(
      title: '正在搜索',
      subtitle: '正在聚合多个音乐平台的结果',
    );
  }
}

class _CenterStatus extends StatelessWidget {
  const _CenterStatus({
    required this.title,
    this.subtitle,
    this.art,
    this.icon,
    this.compact = false,
  });

  final String title;
  final String? subtitle;
  final Widget? art;
  final IconData? icon;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final visual =
        art ??
        Container(
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(24),
          ),
          alignment: Alignment.center,
          child: Icon(
            icon ?? Icons.search_rounded,
            size: 34,
            color: scheme.onSurfaceVariant,
          ),
        );

    return Align(
      alignment: Alignment(0, compact ? -0.34 : -0.24),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            visual,
            SizedBox(height: art != null ? 8 : 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: scheme.onSurface,
                fontWeight: FontWeight.w600,
                fontSize: 17.5,
                height: 1.16,
                letterSpacing: -0.12,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 7),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w500,
                  height: 1.42,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ResultsArea extends StatelessWidget {
  const _ResultsArea({
    required this.state,
    required this.scrollController,
    required this.onTapItem,
    required this.onPlayItem,
    required this.onAddToPlaylist,
  });

  final SearchState state;
  final ScrollController scrollController;
  final ValueChanged<MusicInfo> onTapItem;
  final ValueChanged<MusicInfo> onPlayItem;
  final ValueChanged<MusicInfo> onAddToPlaylist;

  @override
  Widget build(BuildContext context) {
    if (state.loading && state.response == null) {
      return const _SearchLoadingStatus();
    }
    final response = state.response;
    if (response == null) {
      return const _CenterStatus(
        art: _SearchPreludeArt(),
        title: '即刻开始搜索',
        subtitle: '输入歌名、歌手或专辑，发现可播放与下载的版本',
      );
    }
    if (response.list.isEmpty) {
      return const _CenterStatus(
        icon: Icons.manage_search_rounded,
        title: '没有找到结果',
        subtitle: '试试更换关键词或音乐来源',
        compact: true,
      );
    }
    return ListView.separated(
      key: const PageStorageKey('search-results-scroll'),
      controller: scrollController,
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 156),
      itemCount: response.list.length + 1,
      separatorBuilder: (_, index) =>
          index == 0 ? const SizedBox(height: 2) : const _SearchResultDivider(),
      itemBuilder: (_, index) {
        if (index == 0) {
          return _ResultsSummary(
            visibleCount: response.list.length,
            reportedTotal: response.total,
            page: state.page,
            allPage: response.allPage,
            loading: state.loading,
          );
        }
        final music = response.list[index - 1];
        return _ResultTile(
          music: music,
          onTapItem: onTapItem,
          onPlayItem: onPlayItem,
          onAddToPlaylist: onAddToPlaylist,
        );
      },
    );
  }
}

class _SearchResultDivider extends StatelessWidget {
  const _SearchResultDivider();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Divider(
      height: 1,
      thickness: 0.7,
      indent: 56,
      endIndent: 4,
      color: scheme.outlineVariant.withValues(alpha: 0.3),
    );
  }
}

class _ResultsSummary extends StatelessWidget {
  const _ResultsSummary({
    required this.visibleCount,
    required this.reportedTotal,
    required this.page,
    required this.allPage,
    required this.loading,
  });

  final int visibleCount;
  final int reportedTotal;
  final int page;
  final int allPage;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final countLabel = reportedTotal > 0
        ? '$reportedTotal 首'
        : '本页 $visibleCount 首';
    final normalizedAllPage = allPage < page ? page : allPage;
    final pageLabel = normalizedAllPage > 1
        ? '$page / $normalizedAllPage'
        : '$page';
    final pageSemantics = normalizedAllPage > 1
        ? '第 $page 页，共 $normalizedAllPage 页'
        : '第 $page 页';

    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 2, 2, 4),
      child: Row(
        children: [
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: '搜索结果',
                    style: TextStyle(
                      color: scheme.onSurface,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0,
                    ),
                  ),
                  TextSpan(
                    text: '  ·  $countLabel',
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 10.75,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 10),
          Semantics(
            label: pageSemantics,
            excludeSemantics: true,
            child: Container(
              height: 26,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (loading) ...[
                    SizedBox.square(
                      dimension: 11,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.7,
                        color: scheme.primary,
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  Text(
                    pageLabel,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultTile extends ConsumerWidget {
  const _ResultTile({
    required this.music,
    required this.onTapItem,
    required this.onPlayItem,
    required this.onAddToPlaylist,
  });

  final MusicInfo music;
  final ValueChanged<MusicInfo> onTapItem;
  final ValueChanged<MusicInfo> onPlayItem;
  final ValueChanged<MusicInfo> onAddToPlaylist;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Watching the per-music task (instances are reused for untouched tasks)
    // keeps progress updates from rebuilding every tile in the list.
    final task = ref.watch(
      downloadProgressProvider.select((p) => p.latestTaskForMusic(music.id)),
    );
    return SearchResultTile(
      music: music,
      onDownload: () => onTapItem(music),
      onPlay: () => onPlayItem(music),
      onAddToPlaylist: () => onAddToPlaylist(music),
      downloadTask: task,
    );
  }
}
