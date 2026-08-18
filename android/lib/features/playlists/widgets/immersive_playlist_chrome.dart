import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/ui/cover_image_source.dart';
import '../../../core/ui/cover_placeholder.dart';
import '../../../theme/app_motion.dart';
import '../../../theme/app_theme.dart';

ImageProvider<Object>? networkPlaylistArtworkProvider(
  String? rawUrl, {
  int size = 1200,
}) {
  final url = CoverImageSource.normalizeUrl(rawUrl, size: size);
  if (url == null || url.isEmpty) return null;
  return CachedNetworkImageProvider(
    url,
    headers: CoverImageSource.headersFor(url),
  );
}

class PlaylistArtworkTheme extends StatefulWidget {
  const PlaylistArtworkTheme({
    super.key,
    required this.artworkProvider,
    required this.cacheKey,
    required this.child,
    this.immersiveStatusBar = true,
  });

  final ImageProvider<Object>? artworkProvider;
  final String cacheKey;
  final Widget child;

  /// true = 状态栏图标恒用浅色（压在头图暗色 scrim 上）；
  /// false = 跟随主题亮度（宽屏分栏没有头图垫底）。
  final bool immersiveStatusBar;

  @override
  State<PlaylistArtworkTheme> createState() => _PlaylistArtworkThemeState();
}

typedef _ArtworkSchemeCacheKey = ({
  String cacheKey,
  ImageProvider<Object> provider,
  Brightness brightness,
});

class _PlaylistArtworkThemeState extends State<PlaylistArtworkTheme> {
  static const _schemeCacheLimit = 48;
  static final Map<_ArtworkSchemeCacheKey, ColorScheme> _resolvedSchemes = {};
  static final Map<_ArtworkSchemeCacheKey, Future<ColorScheme>>
  _pendingSchemes = {};

  ColorScheme? _scheme;
  _ArtworkSchemeCacheKey? _activeRequestKey;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resolveScheme();
  }

  @override
  void didUpdateWidget(covariant PlaylistArtworkTheme oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cacheKey != widget.cacheKey ||
        oldWidget.artworkProvider != widget.artworkProvider) {
      _activeRequestKey = null;
      _resolveScheme();
    }
  }

  void _resolveScheme() {
    final base = Theme.of(context).colorScheme;
    final provider = widget.artworkProvider;
    if (provider == null) {
      _activeRequestKey = null;
      _scheme = null;
      return;
    }
    final requestKey = (
      cacheKey: widget.cacheKey,
      provider: provider,
      brightness: base.brightness,
    );
    if (_activeRequestKey == requestKey) return;
    _activeRequestKey = requestKey;

    final resolved = _resolvedSchemes[requestKey];
    if (resolved != null) {
      _scheme = resolved;
      return;
    }
    if (_scheme?.brightness != base.brightness) {
      _scheme = null;
    }

    _makeSchemeCacheRoom(requestKey);
    final future = _pendingSchemes.putIfAbsent(
      requestKey,
      () => ColorScheme.fromImageProvider(
        provider: provider,
        brightness: base.brightness,
        dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
        contrastLevel: 0.1,
      ),
    );
    future.then(
      (scheme) {
        if (identical(_pendingSchemes[requestKey], future)) {
          _pendingSchemes.remove(requestKey);
          _resolvedSchemes[requestKey] = scheme;
        }
        if (!mounted || _activeRequestKey != requestKey) return;
        setState(() => _scheme = scheme);
      },
      onError: (_) {
        if (identical(_pendingSchemes[requestKey], future)) {
          _pendingSchemes.remove(requestKey);
        }
      },
    );
  }

  static void _makeSchemeCacheRoom(_ArtworkSchemeCacheKey requestKey) {
    if (_resolvedSchemes.containsKey(requestKey) ||
        _pendingSchemes.containsKey(requestKey)) {
      return;
    }
    while (_resolvedSchemes.length + _pendingSchemes.length >=
        _schemeCacheLimit) {
      if (_resolvedSchemes.isNotEmpty) {
        _resolvedSchemes.remove(_resolvedSchemes.keys.first);
      } else {
        _pendingSchemes.remove(_pendingSchemes.keys.first);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = _scheme ?? Theme.of(context).colorScheme;
    final onDarkSurface =
        widget.immersiveStatusBar || scheme.brightness == Brightness.dark;
    return AnimatedTheme(
      data: AppTheme.fromScheme(scheme),
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : AppMotion.long,
      curve: AppMotion.emphasized,
      child: AnnotatedRegion<SystemUiOverlayStyle>(
        value: SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: onDarkSurface
              ? Brightness.light
              : Brightness.dark,
          statusBarBrightness: onDarkSurface
              ? Brightness.dark
              : Brightness.light,
          systemNavigationBarColor: Colors.transparent,
          systemNavigationBarDividerColor: Colors.transparent,
          systemNavigationBarIconBrightness:
              scheme.brightness == Brightness.dark
              ? Brightness.light
              : Brightness.dark,
        ),
        child: widget.child,
      ),
    );
  }
}

class ImmersivePlaylistHeader extends StatelessWidget {
  const ImmersivePlaylistHeader({
    super.key,
    required this.artworkProvider,
    required this.topBar,
    this.artworkLoading = false,
    this.artworkHeroTag,
  });

  final ImageProvider<Object>? artworkProvider;
  final Widget topBar;
  final bool artworkLoading;
  final Object? artworkHeroTag;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final screen = MediaQuery.sizeOf(context);
    final height = (screen.height * 0.4).clamp(320.0, 460.0);

    return SizedBox(
      key: const ValueKey('immersive-playlist-header'),
      height: height,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (artworkHeroTag case final tag?)
            Hero(
              tag: tag,
              transitionOnUserGestures: true,
              createRectTween: (begin, end) =>
                  RectTween(begin: begin, end: end),
              child: PlaylistArtworkImage(
                provider: artworkProvider,
                loading: artworkLoading,
              ),
            )
          else
            PlaylistArtworkImage(
              provider: artworkProvider,
              loading: artworkLoading,
            ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.center,
                colors: [Color(0x8A000000), Color(0x00000000)],
              ),
            ),
          ),
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                stops: const [0.68, 1],
                colors: [
                  Colors.transparent,
                  scheme.surface.withValues(alpha: 0.18),
                ],
              ),
            ),
          ),
          Positioned(left: 0, right: 0, top: 0, child: topBar),
        ],
      ),
    );
  }
}

class PlaylistDetailInfo extends StatelessWidget {
  const PlaylistDetailInfo({
    super.key,
    required this.title,
    required this.metadata,
    this.description,
    this.descriptionLoading = false,
    this.padding = const EdgeInsets.fromLTRB(20, 20, 20, 8),
  });

  final String title;
  final String metadata;
  final String? description;
  final bool descriptionLoading;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final descriptionText = description?.trim() ?? '';
    return ColoredBox(
      key: const ValueKey('playlist-detail-info'),
      color: scheme.surface,
      child: Padding(
        padding: padding,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  key: const ValueKey('playlist-detail-title'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurface,
                    fontSize: 27,
                    height: 1.12,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  metadata,
                  key: const ValueKey('playlist-detail-metadata'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 12.5,
                    height: 1.35,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 10),
                SizedBox(
                  key: const ValueKey('playlist-description-slot'),
                  height: 40,
                  child: descriptionLoading && descriptionText.isEmpty
                      ? const _DescriptionSkeleton()
                      : descriptionText.isEmpty
                      ? null
                      : _DescriptionLongPressTooltip(text: descriptionText),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DescriptionLongPressTooltip extends StatefulWidget {
  const _DescriptionLongPressTooltip({required this.text});

  final String text;

  @override
  State<_DescriptionLongPressTooltip> createState() =>
      _DescriptionLongPressTooltipState();
}

class _DescriptionLongPressTooltipState
    extends State<_DescriptionLongPressTooltip> {
  final GlobalKey<TooltipState> _tooltipKey = GlobalKey<TooltipState>();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.topLeft,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPress: () => _tooltipKey.currentState?.ensureTooltipVisible(),
        child: Tooltip(
          key: _tooltipKey,
          message: widget.text,
          triggerMode: TooltipTriggerMode.manual,
          showDuration: const Duration(seconds: 6),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Text(
              widget.text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: scheme.onSurfaceVariant.withValues(alpha: 0.9),
                fontSize: 12.5,
                height: 1.42,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DescriptionSkeleton extends StatelessWidget {
  const _DescriptionSkeleton();

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;
    return Align(
      alignment: Alignment.topLeft,
      child: FractionallySizedBox(
        widthFactor: 0.72,
        child: Container(
          key: const ValueKey('playlist-description-skeleton'),
          height: 32,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.72),
            borderRadius: BorderRadius.circular(6),
          ),
        ),
      ),
    );
  }
}

class ImmersivePlaylistTopBar extends StatelessWidget {
  const ImmersivePlaylistTopBar({
    super.key,
    required this.title,
    this.leading,
    this.actions = const [],
    this.onImage = true,
  });

  final String title;
  final Widget? leading;
  final List<Widget> actions;

  /// true = 压在头图上（白字 + 阴影）；false = 直接放在 surface 上，
  /// 前景跟随主题（宽屏分栏没有头图，白字在浅色主题下不可见）。
  final bool onImage;

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.viewPaddingOf(context).top;
    final scheme = Theme.of(context).colorScheme;
    final foreground = onImage ? Colors.white : scheme.onSurface;
    return IconTheme(
      data: IconThemeData(color: foreground),
      child: DefaultTextStyle(
        style: TextStyle(
          color: foreground,
          fontSize: 17,
          fontWeight: FontWeight.w600,
          shadows: onImage
              ? const [Shadow(color: Color(0x85000000), blurRadius: 8)]
              : null,
        ),
        child: Padding(
          padding: EdgeInsets.fromLTRB(16, top, 12, 8),
          child: SizedBox(
            height: 48,
            child: Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: 4)],
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                ...actions,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ImmersiveTopIconButton extends StatelessWidget {
  const ImmersiveTopIconButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.onImage = true,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;

  /// 与 [ImmersivePlaylistTopBar.onImage] 同义。
  final bool onImage;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 44,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          foregroundColor: onImage ? Colors.white : scheme.onSurfaceVariant,
          disabledForegroundColor: onImage
              ? Colors.white.withValues(alpha: 0.38)
              : scheme.onSurface.withValues(alpha: 0.34),
          backgroundColor: onImage ? const Color(0x30000000) : null,
        ),
        icon: Icon(icon, size: 20),
      ),
    );
  }
}

/// 头图/封面卡片共用的封面渲染：null → 占位，loading → 骨架，
/// 加载中淡入、失败回落占位。
class PlaylistArtworkImage extends StatelessWidget {
  const PlaylistArtworkImage({
    super.key,
    required this.provider,
    required this.loading,
  });

  final ImageProvider<Object>? provider;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final provider = this.provider;
    if (provider == null) {
      return loading
          ? const CoverLoadingSkeleton()
          : const CoverUnavailablePlaceholder(iconSize: 56);
    }
    return Image(
      image: provider,
      fit: BoxFit.cover,
      alignment: Alignment.center,
      filterQuality: FilterQuality.medium,
      frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
        if (wasSynchronouslyLoaded) return child;
        return Stack(
          fit: StackFit.expand,
          children: [
            const CoverLoadingSkeleton(),
            AnimatedOpacity(
              opacity: frame == null ? 0 : 1,
              duration: AppMotion.medium,
              curve: AppMotion.emphasizedDecelerate,
              child: child,
            ),
          ],
        );
      },
      errorBuilder: (_, _, _) =>
          const CoverUnavailablePlaceholder(iconSize: 56),
    );
  }
}
