import 'package:flutter/material.dart';

import 'immersive_playlist_chrome.dart';

/// 歌单详情页切换到左右分栏的最小宽度。与播放页的宽屏断点（720）取值
/// 一致；不设高度门槛——分栏左列自身可滚动，横屏手机上分栏也严格优于
/// 现状里被 clamp 到 320 高、几乎占满屏的横幅头图。
const double kPlaylistWideLayoutBreakpoint = 720.0;

bool playlistDetailUsesWideLayout(BuildContext context) {
  return MediaQuery.sizeOf(context).width >= kPlaylistWideLayoutBreakpoint;
}

/// 宽屏分栏骨架：顶栏横跨顶部，下方 340dp 左列（歌单信息）+ 右列
/// （歌曲列表）。本地/在线详情页的数据、加载、错误态共用。
class PlaylistWideBody extends StatelessWidget {
  const PlaylistWideBody({
    super.key,
    required this.topBar,
    required this.infoPane,
    required this.right,
  });

  final Widget topBar;
  final Widget infoPane;
  final Widget right;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('playlist-wide-layout'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        topBar,
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(width: 340, child: infoPane),
              Expanded(child: right),
            ],
          ),
        ),
      ],
    );
  }
}

/// 分栏左列：方形封面卡片 + 标题/元信息/简介 + 操作按钮，整列可滚动。
class PlaylistWideInfoPane extends StatelessWidget {
  const PlaylistWideInfoPane({
    super.key,
    required this.artworkProvider,
    required this.title,
    required this.metadata,
    this.artworkLoading = false,
    this.artworkHeroTag,
    this.description,
    this.descriptionLoading = false,
    this.actions,
    this.bottomPadding = 156,
  });

  final ImageProvider<Object>? artworkProvider;
  final bool artworkLoading;
  final Object? artworkHeroTag;
  final String title;
  final String metadata;
  final String? description;
  final bool descriptionLoading;
  final Widget? actions;

  /// 底部留白，默认避开浮动工具栏；批量态底栏接管时传小值。
  final double bottomPadding;

  @override
  Widget build(BuildContext context) {
    final artwork = ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: AspectRatio(
        aspectRatio: 1,
        child: PlaylistArtworkImage(
          provider: artworkProvider,
          loading: artworkLoading,
        ),
      ),
    );
    return SingleChildScrollView(
      key: const ValueKey('playlist-wide-info-pane'),
      physics: const BouncingScrollPhysics(
        parent: AlwaysScrollableScrollPhysics(),
      ),
      padding: EdgeInsets.fromLTRB(20, 4, 12, bottomPadding),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (artworkHeroTag case final tag?)
            Hero(
              tag: tag,
              transitionOnUserGestures: true,
              createRectTween: (begin, end) =>
                  RectTween(begin: begin, end: end),
              child: artwork,
            )
          else
            artwork,
          PlaylistDetailInfo(
            title: title,
            metadata: metadata,
            description: description,
            descriptionLoading: descriptionLoading,
            padding: const EdgeInsets.fromLTRB(0, 16, 0, 0),
          ),
          ?actions,
        ],
      ),
    );
  }
}
