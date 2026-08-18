import 'dart:math' as math;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/playlist_summary.dart';
import '../../core/ui/cover_image_source.dart';
import '../../core/ui/cover_placeholder.dart';
import '../../core/ui/app_refresh_indicator.dart';
import '../../theme/app_motion.dart';
import 'discovery_controller.dart';

class DiscoveryContent extends ConsumerStatefulWidget {
  const DiscoveryContent({super.key});

  @override
  ConsumerState<DiscoveryContent> createState() => _DiscoveryContentState();
}

class _DiscoveryContentState extends ConsumerState<DiscoveryContent> {
  late final PageController _pageController;

  /// 抑制 onPageChanged → provider → animateToPage 的回环。
  bool _syncingFromPager = false;

  @override
  void initState() {
    super.initState();
    final source = ref.read(selectedDiscoverySourceProvider);
    _pageController = PageController(
      initialPage: math.max(0, kDiscoverySources.indexOf(source)),
    );
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _handlePageChanged(int index) {
    _syncingFromPager = true;
    ref.read(selectedDiscoverySourceProvider.notifier).state =
        kDiscoverySources[index];
    _syncingFromPager = false;
  }

  void _animateToSource(MusicSource source) {
    final index = kDiscoverySources.indexOf(source);
    if (index < 0 || !_pageController.hasClients) return;
    final current =
        _pageController.page?.round() ?? _pageController.initialPage;
    if (current == index) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      _pageController.jumpToPage(index);
    } else {
      _pageController.animateToPage(
        index,
        duration: AppMotion.medium,
        curve: AppMotion.emphasized,
      );
    }
  }

  Widget _buildSourcePage(BuildContext context, int index) {
    final source = kDiscoverySources[index];
    return Consumer(
      builder: (context, ref, _) {
        final categoryId = ref.watch(selectedDiscoveryCategoryProvider(source));
        final result = ref.watch(featuredPlaylistsProvider(source));
        return result.when(
          loading: () => const _DiscoveryLoading(),
          error: (error, _) => _DiscoveryError(
            message: _friendlyError(error),
            onRetry: () => ref.invalidate(featuredPlaylistsProvider(source)),
          ),
          data: (items) => _DiscoveryList(
            source: source,
            initialItems: items,
            onRefresh: () async {
              ref.invalidate(featuredPlaylistsProvider(source));
              await ref.read(featuredPlaylistsProvider(source).future);
            },
            onLoadMore: (page) => ref
                .read(musicApiProvider)
                .featuredPlaylists(
                  source: source,
                  page: page,
                  limit: discoveryPlaylistPageSize,
                  categoryId: categoryId,
                ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    // tab 点击 / shell 手势等外部写入 provider 时，让 pager 跟着动画过去。
    ref.listen<MusicSource>(selectedDiscoverySourceProvider, (previous, next) {
      if (_syncingFromPager || previous == next) return;
      _animateToSource(next);
    });
    return Column(
      children: [
        DiscoverySourceSelector(pageController: _pageController),
        const SizedBox(height: 6),
        Expanded(
          child: PageView.builder(
            key: const PageStorageKey('discovery-source-pager'),
            controller: _pageController,
            physics: const BouncingScrollPhysics(),
            onPageChanged: _handlePageChanged,
            itemCount: kDiscoverySources.length,
            itemBuilder: _buildSourcePage,
          ),
        ),
      ],
    );
  }
}

class DiscoverySourceSelector extends ConsumerWidget {
  const DiscoverySourceSelector({super.key, this.pageController});

  /// 传入发现页的 pager 后，胶囊指示条连续跟随页面滑动进度；
  /// 不传（或 controller 还没挂载）时退化为按选中项动画。
  final PageController? pageController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(selectedDiscoverySourceProvider);
    final selectedIndex = math.max(0, kDiscoverySources.indexOf(selected));
    final scheme = Theme.of(context).colorScheme;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Container(
        key: const ValueKey('discovery-source-filter'),
        height: 38,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: scheme.surfaceContainer,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: scheme.outlineVariant.withValues(alpha: 0.22),
          ),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth / kDiscoverySources.length;
            final indicator = DecoratedBox(
              decoration: BoxDecoration(
                color: scheme.secondaryContainer,
                borderRadius: BorderRadius.circular(9),
              ),
            );
            final controller = pageController;
            return Stack(
              children: [
                if (controller != null)
                  AnimatedBuilder(
                    animation: controller,
                    builder: (context, child) {
                      final page = controller.hasClients
                          ? (controller.page ??
                                controller.initialPage.toDouble())
                          : selectedIndex.toDouble();
                      return Positioned(
                        left:
                            page.clamp(
                              0.0,
                              (kDiscoverySources.length - 1).toDouble(),
                            ) *
                            width,
                        top: 0,
                        bottom: 0,
                        width: width,
                        child: child!,
                      );
                    },
                    child: indicator,
                  )
                else
                  AnimatedPositioned(
                    left: selectedIndex * width,
                    top: 0,
                    bottom: 0,
                    width: width,
                    duration: reduceMotion ? Duration.zero : AppMotion.medium,
                    curve: AppMotion.emphasized,
                    child: indicator,
                  ),
                Row(
                  children: [
                    for (final source in kDiscoverySources)
                      Expanded(
                        child: Semantics(
                          button: true,
                          selected: selected == source,
                          child: InkWell(
                            key: ValueKey('discovery-source-${source.code}'),
                            borderRadius: BorderRadius.circular(9),
                            onTap: () =>
                                ref
                                        .read(
                                          selectedDiscoverySourceProvider
                                              .notifier,
                                        )
                                        .state =
                                    source,
                            child: Center(
                              child: Text(
                                source.label,
                                maxLines: 1,
                                overflow: TextOverflow.fade,
                                softWrap: false,
                                style: TextStyle(
                                  color: selected == source
                                      ? scheme.onSecondaryContainer
                                      : scheme.onSurfaceVariant,
                                  fontSize: 11.5,
                                  fontWeight: selected == source
                                      ? FontWeight.w600
                                      : FontWeight.w500,
                                  height: 1,
                                  letterSpacing: 0,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _DiscoveryList extends StatefulWidget {
  const _DiscoveryList({
    required this.source,
    required this.initialItems,
    required this.onRefresh,
    required this.onLoadMore,
  });

  final MusicSource source;
  final List<PlaylistSummary> initialItems;
  final Future<void> Function() onRefresh;
  final Future<List<PlaylistSummary>> Function(int page) onLoadMore;

  @override
  State<_DiscoveryList> createState() => _DiscoveryListState();
}

class _DiscoveryListState extends State<_DiscoveryList> {
  final ScrollController _scrollController = ScrollController();
  late List<PlaylistSummary> _items;
  var _nextPage = 2;
  var _loadingMore = false;
  var _hasMore = true;
  Object? _loadMoreError;

  @override
  void initState() {
    super.initState();
    _reset(widget.initialItems);
    _scrollController.addListener(_maybeLoadMore);
    _scheduleFillViewport();
  }

  @override
  void didUpdateWidget(covariant _DiscoveryList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.source != widget.source ||
        !identical(oldWidget.initialItems, widget.initialItems)) {
      _reset(widget.initialItems);
      _scheduleFillViewport();
    }
  }

  @override
  void dispose() {
    _scrollController
      ..removeListener(_maybeLoadMore)
      ..dispose();
    super.dispose();
  }

  void _reset(List<PlaylistSummary> items) {
    _items = List<PlaylistSummary>.from(items);
    _nextPage = 2;
    _loadingMore = false;
    _hasMore = items.isNotEmpty;
    _loadMoreError = null;
  }

  void _scheduleFillViewport() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadMore());
  }

  void _maybeLoadMore() {
    if (!mounted ||
        !_scrollController.hasClients ||
        _scrollController.position.extentAfter > 600) {
      return;
    }
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() {
      _loadingMore = true;
      _loadMoreError = null;
    });
    try {
      final page = await widget.onLoadMore(_nextPage);
      if (!mounted) return;
      final seen = _items.map((item) => item.key).toSet();
      final additions = [
        for (final item in page)
          if (seen.add(item.key)) item,
      ];
      setState(() {
        _items.addAll(additions);
        _nextPage++;
        _hasMore = page.isNotEmpty && additions.isNotEmpty;
      });
      if (_hasMore) _scheduleFillViewport();
    } catch (error) {
      if (!mounted) return;
      setState(() => _loadMoreError = error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      return _DiscoveryEmpty(onRefresh: widget.onRefresh);
    }
    return AppRefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView(
        key: PageStorageKey('discovery-${widget.source.code}-scroll'),
        controller: _scrollController,
        physics: const AlwaysScrollableScrollPhysics(
          parent: BouncingScrollPhysics(),
        ),
        padding: const EdgeInsets.fromLTRB(12, 2, 12, 156),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 960),
              child: _MasonryPlaylistGrid(items: _items),
            ),
          ),
          if (_loadingMore)
            const Padding(
              padding: EdgeInsets.only(top: 18),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_loadMoreError != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Center(
                child: IconButton.filledTonal(
                  tooltip: '重新加载',
                  onPressed: _loadMore,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _MasonryPlaylistGrid extends StatelessWidget {
  const _MasonryPlaylistGrid({required this.items});

  final List<PlaylistSummary> items;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columnCount = constraints.maxWidth >= 700 ? 3 : 2;
        const gap = 10.0;
        final width =
            (constraints.maxWidth - gap * (columnCount - 1)) / columnCount;
        final columns = List.generate(columnCount, (_) => <_MasonryEntry>[]);
        final heights = List<double>.filled(columnCount, 0);
        for (final item in items) {
          final ratio = _coverRatio(item);
          var target = 0;
          for (var index = 1; index < heights.length; index++) {
            if (heights[index] < heights[target]) target = index;
          }
          columns[target].add(_MasonryEntry(item, ratio));
          heights[target] += width / ratio + 82 + gap;
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var index = 0; index < columns.length; index++) ...[
              if (index > 0) const SizedBox(width: gap),
              Expanded(
                child: Column(
                  children: [
                    for (final entry in columns[index]) ...[
                      _PlaylistDiscoveryCard(
                        summary: entry.summary,
                        coverRatio: entry.coverRatio,
                      ),
                      const SizedBox(height: gap),
                    ],
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  double _coverRatio(PlaylistSummary item) {
    const ratios = <double>[0.76, 0.88, 1, 1.12, 1.24];
    var hash = 17;
    for (final codeUnit in item.key.codeUnits) {
      hash = 37 * hash + codeUnit;
    }
    return ratios[hash.abs() % ratios.length];
  }
}

class _MasonryEntry {
  const _MasonryEntry(this.summary, this.coverRatio);

  final PlaylistSummary summary;
  final double coverRatio;
}

class _PlaylistDiscoveryCard extends StatelessWidget {
  const _PlaylistDiscoveryCard({
    required this.summary,
    required this.coverRatio,
  });

  final PlaylistSummary summary;
  final double coverRatio;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final path = _detailPath(summary);
    return Card(
      key: ValueKey('discovery-card-${summary.key}'),
      margin: EdgeInsets.zero,
      elevation: 0,
      color: scheme.surfaceContainer,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.24)),
      ),
      child: InkWell(
        onTap: () => context.push(path, extra: summary),
        onLongPress: () => showDialog<void>(
          context: context,
          builder: (_) => PlaylistPreviewDialog(summary: summary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AspectRatio(
              aspectRatio: coverRatio,
              child: Hero(
                tag: onlinePlaylistArtworkHeroTag(summary.source, summary.id),
                transitionOnUserGestures: true,
                createRectTween: (begin, end) =>
                    RectTween(begin: begin, end: end),
                child: _PlaylistCover(url: summary.coverUrl, size: 36),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    height: 38,
                    child: Text(
                      summary.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: scheme.onSurface,
                        fontSize: 13.5,
                        height: 1.28,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0,
                      ),
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    _summaryMeta(summary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 11,
                      height: 1.1,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class PlaylistPreviewDialog extends ConsumerWidget {
  const PlaylistPreviewDialog({super.key, required this.summary});

  final PlaylistSummary summary;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = OnlinePlaylistKey(source: summary.source, id: summary.id);
    final detail = ref.watch(onlinePlaylistDetailProvider(key));
    final loaded = detail.asData?.value;
    final coverUrl = _firstNonEmpty(summary.coverUrl, loaded?.coverUrl);
    final creator = _firstNonEmpty(summary.creator, loaded?.creator);
    final description = _firstNonEmpty(
      summary.description,
      loaded?.description,
    );
    final trackCount = summary.trackCount ?? loaded?.totalTracks;
    final metadata = <String>[summary.source.label];
    if (creator != null) metadata.add(creator);
    if (trackCount != null) metadata.add('$trackCount 首');
    final scheme = Theme.of(context).colorScheme;
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460, maxHeight: 650),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 8, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: SizedBox.square(
                      dimension: 92,
                      child: _PlaylistCover(url: coverUrl, size: 30),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          summary.name,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: scheme.onSurface,
                            fontSize: 17,
                            height: 1.2,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0,
                          ),
                        ),
                        const SizedBox(height: 7),
                        Text(
                          metadata.join(' · '),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: scheme.onSurfaceVariant,
                            fontSize: 12,
                            height: 1.25,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            if (description != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    description,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 12.5,
                      height: 1.45,
                    ),
                  ),
                ),
              ),
            Divider(height: 1, color: scheme.outlineVariant),
            Flexible(
              child: detail.when(
                loading: () => const Center(
                  child: Padding(
                    padding: EdgeInsets.all(28),
                    child: CircularProgressIndicator(),
                  ),
                ),
                error: (error, _) => Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _friendlyError(error),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        IconButton.filledTonal(
                          tooltip: '重试',
                          onPressed: () =>
                              ref.invalidate(onlinePlaylistDetailProvider(key)),
                          icon: const Icon(Icons.refresh_rounded),
                        ),
                      ],
                    ),
                  ),
                ),
                data: (playlist) => ListView.separated(
                  shrinkWrap: true,
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  itemCount: math.min(8, playlist.tracks.length),
                  separatorBuilder: (_, _) => Divider(
                    height: 1,
                    indent: 54,
                    color: scheme.outlineVariant.withValues(alpha: 0.42),
                  ),
                  itemBuilder: (context, index) {
                    final music = playlist.tracks[index];
                    return ListTile(
                      dense: true,
                      minTileHeight: 48,
                      leading: SizedBox(
                        width: 28,
                        child: Center(
                          child: Text(
                            '${index + 1}',
                            style: TextStyle(
                              color: scheme.onSurfaceVariant,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ),
                      title: Text(
                        music.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        music.singer,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    );
                  },
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    context.push(_detailPath(summary), extra: summary);
                  },
                  icon: const Icon(Icons.open_in_new_rounded),
                  label: const Text('查看完整歌单'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlaylistCover extends StatelessWidget {
  const _PlaylistCover({required this.url, required this.size});

  final String? url;
  final double size;

  @override
  Widget build(BuildContext context) {
    final unavailable = CoverUnavailablePlaceholder(
      iconSize: (size * 0.9).clamp(28.0, 42.0),
    );
    final value = CoverImageSource.normalizeUrl(
      url,
      size: discoveryPlaylistArtworkSize,
    );
    if (value == null || value.isEmpty) return unavailable;
    return CachedNetworkImage(
      imageUrl: value,
      httpHeaders: CoverImageSource.headersFor(value),
      fit: BoxFit.cover,
      fadeInDuration: AppMotion.medium,
      fadeOutDuration: AppMotion.short,
      placeholder: (_, _) => const CoverLoadingSkeleton(),
      errorWidget: (_, _, _) => unavailable,
    );
  }
}

class _DiscoveryLoading extends StatelessWidget {
  const _DiscoveryLoading();

  @override
  Widget build(BuildContext context) {
    return const Center(child: CircularProgressIndicator());
  }
}

class _DiscoveryError extends StatelessWidget {
  const _DiscoveryError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
        Icon(
          Icons.cloud_off_rounded,
          size: 38,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 30),
          child: Text(message, textAlign: TextAlign.center),
        ),
        const SizedBox(height: 14),
        Center(
          child: IconButton.filledTonal(
            tooltip: '重试',
            onPressed: onRetry,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ),
      ],
    );
  }
}

class _DiscoveryEmpty extends StatelessWidget {
  const _DiscoveryEmpty({required this.onRefresh});

  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return AppRefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 150),
          Icon(Icons.library_music_outlined, size: 40),
          SizedBox(height: 12),
          Text('暂时没有精选歌单', textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

String _detailPath(PlaylistSummary summary) =>
    '/discover/playlists/${summary.source.code}/${summary.id}';

String _summaryMeta(PlaylistSummary summary) {
  if (summary.creator?.trim().isNotEmpty == true) {
    return summary.creator!.trim();
  }
  if (summary.trackCount != null) return '${summary.trackCount} 首';
  if (summary.playCount != null) {
    return '${_compactCount(summary.playCount!)} 次播放';
  }
  return '${summary.source.label}精选';
}

String _compactCount(int count) {
  if (count >= 100000000) {
    return '${(count / 100000000).toStringAsFixed(count >= 1000000000 ? 0 : 1)}亿';
  }
  if (count >= 10000) {
    return '${(count / 10000).toStringAsFixed(count >= 100000 ? 0 : 1)}万';
  }
  return '$count';
}

String _friendlyError(Object error) {
  final text = error.toString().replaceFirst('Exception: ', '').trim();
  return text.isEmpty ? '加载失败，请稍后重试' : text;
}

String? _firstNonEmpty(String? primary, String? fallback) {
  final first = primary?.trim();
  if (first != null && first.isNotEmpty) return first;
  final second = fallback?.trim();
  return second == null || second.isEmpty ? null : second;
}
