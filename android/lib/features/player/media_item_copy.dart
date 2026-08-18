import 'package:audio_service/audio_service.dart' show MediaItem;

/// `audio_service` 0.18.19 does not retain `artHeaders` in `MediaItem.copyWith`.
MediaItem preserveMediaItemArtHeaders(MediaItem original, MediaItem updated) {
  final artHeaders = updated.artHeaders ?? original.artHeaders;
  if (artHeaders == null) return updated;
  return MediaItem(
    id: updated.id,
    title: updated.title,
    album: updated.album,
    artist: updated.artist,
    genre: updated.genre,
    duration: updated.duration,
    artUri: updated.artUri,
    artHeaders: artHeaders,
    playable: updated.playable,
    displayTitle: updated.displayTitle,
    displaySubtitle: updated.displaySubtitle,
    displayDescription: updated.displayDescription,
    rating: updated.rating,
    isLive: updated.isLive,
    extras: updated.extras,
  );
}
