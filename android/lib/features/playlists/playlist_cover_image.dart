import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../core/ui/cover_image_source.dart';
import '../../core/ui/cover_placeholder.dart';
import '../../theme/app_motion.dart';

class PlaylistCoverImage extends StatelessWidget {
  const PlaylistCoverImage({
    super.key,
    required this.url,
    required this.size,
    required this.radius,
    required this.placeholder,
  });

  final String? url;
  final double size;
  final double radius;
  final Widget placeholder;

  @override
  Widget build(BuildContext context) {
    final normalized = CoverImageSource.normalizeUrl(
      url,
      size: (size * 3).round(),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: normalized == null || normalized.isEmpty
          ? placeholder
          : CachedNetworkImage(
              imageUrl: normalized,
              httpHeaders: CoverImageSource.headersFor(normalized),
              width: size,
              height: size,
              memCacheWidth: (size * 3).round(),
              memCacheHeight: (size * 3).round(),
              fit: BoxFit.cover,
              fadeInDuration: AppMotion.medium,
              fadeOutDuration: AppMotion.short,
              placeholder: (_, _) => const CoverLoadingSkeleton(),
              errorWidget: (_, _, _) => placeholder,
            ),
    );
  }
}
