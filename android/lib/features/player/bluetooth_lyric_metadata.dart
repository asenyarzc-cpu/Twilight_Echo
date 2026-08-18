import 'package:audio_service/audio_service.dart' show MediaItem;

import 'media_item_copy.dart';
import 'player_models.dart';

const String androidBluetoothLyricsMetadataKey =
    'android.media.metadata.LYRICS';

typedef _BluetoothMetadataSignature = ({
  String trackId,
  int lineIndex,
  String? line,
  bool lineEnabled,
  bool fullEnabled,
  String? fullLyric,
});

class BluetoothLyricMetadataCoordinator {
  _BluetoothMetadataSignature? _lastSignature;

  void reset() => _lastSignature = null;

  MediaItem? next({
    required MediaItem current,
    required PlayerTrack track,
    required int lineIndex,
    required bool lineLyricEnabled,
    required bool fullLyricEnabled,
    String? activeLine,
    String? fullLyric,
    bool force = false,
  }) {
    final signature = (
      trackId: track.id,
      lineIndex: lineIndex,
      line: activeLine,
      lineEnabled: lineLyricEnabled,
      fullEnabled: fullLyricEnabled,
      fullLyric: fullLyric,
    );
    if (!force && signature == _lastSignature) return null;
    _lastSignature = signature;
    return BluetoothLyricMetadata.build(
      current: current,
      track: track,
      lineLyricEnabled: lineLyricEnabled,
      fullLyricEnabled: fullLyricEnabled,
      activeLine: activeLine,
      fullLyric: fullLyric,
    );
  }
}

/// Builds the current Android media-session presentation without touching the
/// audio transport. Keeping this transformation pure makes line updates and
/// restoration behavior deterministic and independently testable.
class BluetoothLyricMetadata {
  const BluetoothLyricMetadata._();

  static MediaItem build({
    required MediaItem current,
    required PlayerTrack track,
    required bool lineLyricEnabled,
    required bool fullLyricEnabled,
    String? activeLine,
    String? fullLyric,
  }) {
    final baseTitle = track.title.trim().isEmpty ? '未知歌曲' : track.title.trim();
    final baseArtist = track.artist.trim().isEmpty
        ? '未知歌手'
        : track.artist.trim();
    final line = activeLine?.trim();
    final showLine = lineLyricEnabled && line != null && line.isNotEmpty;
    final title = showLine ? line : baseTitle;
    final artist = showLine ? '$baseTitle - $baseArtist' : baseArtist;
    final extras = <String, dynamic>{...?current.extras}
      ..remove(androidBluetoothLyricsMetadataKey);
    final rawLyric = fullLyric?.trim();
    if (fullLyricEnabled && rawLyric != null && rawLyric.isNotEmpty) {
      extras[androidBluetoothLyricsMetadataKey] = rawLyric;
    }

    return preserveMediaItemArtHeaders(
      current,
      current.copyWith(
        title: title,
        artist: artist,
        displayTitle: title,
        displaySubtitle: artist,
        extras: extras,
      ),
    );
  }
}
