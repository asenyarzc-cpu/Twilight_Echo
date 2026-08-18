import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/services/embedded_artwork_cache.dart';
import '../../../core/ui/cover_image_source.dart';
import '../playlist_cover_image.dart';
import '../playlist_cover_resolver.dart';
import '../playlist_models.dart';

/// 歌单封面回退来源：第一个带封面来源（网络图或本地文件）的曲目。
///
/// 只取第一个候选、不级联尝试后续曲目，避免歌单列表一次性
/// 触发大量内嵌封面读盘（[EmbeddedArtworkCache] 并发上限为 2）。
PlaylistTrack? playlistCoverFallbackTrack(LocalPlaylist playlist) {
  for (final track in playlist.tracks) {
    if (track.picUrl?.trim().isNotEmpty == true || track.isLocal) {
      return track;
    }
  }
  return null;
}

/// 歌单封面：`coverUrl` → 首个有封面来源的曲目 → 占位图。
class PlaylistCover extends StatelessWidget {
  const PlaylistCover({
    super.key,
    required this.playlist,
    required this.size,
    required this.radius,
    required this.placeholder,
  });

  final LocalPlaylist playlist;
  final double size;
  final double radius;
  final Widget placeholder;

  @override
  Widget build(BuildContext context) {
    final coverUrl = playlist.coverUrl?.trim();
    if (coverUrl != null && coverUrl.isNotEmpty) {
      return PlaylistCoverImage(
        url: coverUrl,
        size: size,
        radius: radius,
        placeholder: placeholder,
      );
    }
    final fallback = playlistCoverFallbackTrack(playlist);
    if (fallback == null) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: placeholder,
      );
    }
    return PlaylistTrackArtwork(
      localPath: fallback.localPath,
      picUrl: fallback.picUrl,
      size: size,
      radius: radius,
      placeholder: placeholder,
    );
  }
}

/// 单曲封面：本地文件内嵌封面 → 网络 `picUrl` → 占位图。
class PlaylistTrackArtwork extends StatefulWidget {
  const PlaylistTrackArtwork({
    super.key,
    required this.localPath,
    required this.picUrl,
    required this.size,
    required this.radius,
    required this.placeholder,
  });

  final String? localPath;
  final String? picUrl;
  final double size;
  final double radius;
  final Widget placeholder;

  @override
  State<PlaylistTrackArtwork> createState() => _PlaylistTrackArtworkState();
}

class ResolvingPlaylistTrackArtwork extends ConsumerWidget {
  const ResolvingPlaylistTrackArtwork({
    super.key,
    required this.playlistId,
    required this.track,
    required this.size,
    required this.radius,
    required this.placeholder,
  });

  final String playlistId;
  final PlaylistTrack track;
  final double size;
  final double radius;
  final Widget placeholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final normalized = CoverImageSource.normalizeUrl(
      track.picUrl,
      size: (size * 3).round(),
    );
    final storedUrl = CoverImageSource.isUsableUrl(normalized)
        ? normalized
        : null;
    AsyncValue<String?>? lookup;
    if (storedUrl == null && track.musicInfo != null) {
      lookup = ref.watch(
        playlistTrackCoverProvider(
          PlaylistTrackCoverKey(playlistId: playlistId, track: track),
        ),
      );
    }
    final resolved = lookup?.asData?.value?.trim();

    return PlaylistTrackArtwork(
      localPath: track.localPath,
      picUrl: resolved?.isNotEmpty == true ? resolved : storedUrl,
      size: size,
      radius: radius,
      placeholder: placeholder,
    );
  }
}

class _PlaylistTrackArtworkState extends State<PlaylistTrackArtwork> {
  Uint8List? _artworkBytes;
  EmbeddedArtworkRequest? _artworkRequest;
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    _loadEmbeddedArtwork();
  }

  @override
  void didUpdateWidget(covariant PlaylistTrackArtwork oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.localPath != oldWidget.localPath) {
      _loadEmbeddedArtwork();
    }
  }

  @override
  void dispose() {
    _loadGeneration++;
    _artworkRequest?.cancel();
    _artworkRequest = null;
    super.dispose();
  }

  void _loadEmbeddedArtwork() {
    final generation = ++_loadGeneration;
    _artworkRequest?.cancel();
    _artworkRequest = null;
    _artworkBytes = null;
    final path = widget.localPath?.trim();
    if (path == null || path.isEmpty) return;
    final request = EmbeddedArtworkCache.subscribe(path);
    _artworkRequest = request;
    unawaited(
      request.future.then((bytes) {
        if (identical(_artworkRequest, request)) _artworkRequest = null;
        request.cancel();
        if (!mounted ||
            generation != _loadGeneration ||
            path != widget.localPath?.trim() ||
            bytes == null ||
            bytes.isEmpty) {
          return;
        }
        setState(() => _artworkBytes = bytes);
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final artworkBytes = _artworkBytes;
    if (artworkBytes != null && artworkBytes.isNotEmpty) {
      final cacheSize = (widget.size * 3).round();
      return ClipRRect(
        borderRadius: BorderRadius.circular(widget.radius),
        child: Image.memory(
          artworkBytes,
          width: widget.size,
          height: widget.size,
          fit: BoxFit.cover,
          cacheWidth: cacheSize,
          cacheHeight: cacheSize,
          filterQuality: FilterQuality.medium,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => widget.placeholder,
        ),
      );
    }
    return PlaylistCoverImage(
      url: widget.picUrl,
      size: widget.size,
      radius: widget.radius,
      placeholder: widget.placeholder,
    );
  }
}
