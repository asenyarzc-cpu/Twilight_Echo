import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/ui/cover_image_source.dart';
import '../../../theme/app_motion.dart';
import '../player_controller.dart';

/// Circular album artwork that spins while playback is active.
///
/// Extracted from the player's album page so the shell's mini player bar can
/// reuse the same rotation and image pipeline. [placeholder] is supplied by
/// the caller because the player page styles it with its immersive palette
/// while the toolbar uses the ambient color scheme.
class SpinningCoverArt extends ConsumerStatefulWidget {
  const SpinningCoverArt({
    super.key,
    required this.track,
    required this.size,
    required this.placeholder,
    this.boxShadow,
  });

  final PlayerTrack track;
  final double size;
  final Widget placeholder;
  final List<BoxShadow>? boxShadow;

  @override
  ConsumerState<SpinningCoverArt> createState() => _SpinningCoverArtState();
}

class _SpinningCoverArtState extends ConsumerState<SpinningCoverArt>
    with SingleTickerProviderStateMixin {
  late final AnimationController _rotationController;

  @override
  void initState() {
    super.initState();
    _rotationController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 24),
    );
    if (ref.read(playerControllerProvider).playing) {
      _rotationController.repeat();
    }
    ref.listenManual(playerControllerProvider.select((s) => s.playing), (
      previous,
      playing,
    ) {
      if (playing) {
        if (!_rotationController.isAnimating) {
          _rotationController.repeat();
        }
      } else {
        _rotationController.stop(canceled: false);
      }
    });
  }

  @override
  void dispose() {
    _rotationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final normalized = CoverImageSource.normalizeUrl(
      widget.track.coverUrl,
      size: 700,
    );
    return RepaintBoundary(
      child: RotationTransition(
        turns: _rotationController,
        child: Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            boxShadow: widget.boxShadow,
          ),
          clipBehavior: Clip.antiAlias,
          child: ClipOval(
            child: _ArtworkImage(
              url: normalized,
              bytes: widget.track.coverBytes,
              placeholder: widget.placeholder,
            ),
          ),
        ),
      ),
    );
  }
}

class _ArtworkImage extends StatelessWidget {
  const _ArtworkImage({
    required this.url,
    required this.bytes,
    required this.placeholder,
  });

  final String? url;
  final Uint8List? bytes;
  final Widget placeholder;

  @override
  Widget build(BuildContext context) {
    if (bytes != null && bytes!.isNotEmpty) {
      // Same decode target as the songs list covers so both share one
      // ResizeImage cache entry instead of decoding the artwork twice.
      return Image.memory(
        bytes!,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        cacheWidth: 480,
        cacheHeight: 480,
      );
    }
    if (url == null || url!.isEmpty) return placeholder;
    return CachedNetworkImage(
      imageUrl: url!,
      httpHeaders: CoverImageSource.headersFor(url),
      fit: BoxFit.cover,
      fadeInDuration: AppMotion.long,
      fadeOutDuration: AppMotion.medium,
      memCacheWidth: 480,
      memCacheHeight: 480,
      placeholder: (_, _) => placeholder,
      errorWidget: (_, _, _) => placeholder,
    );
  }
}
