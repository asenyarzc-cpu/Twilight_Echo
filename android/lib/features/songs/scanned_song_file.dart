import '../../core/services/tagger.dart';
import 'local_song_scan_cache.dart';

/// Process-wide snapshot of embedded-tag reads keyed by normalized path.
/// Intentionally top-level (library-scoped singletons): the songs page copies
/// them into its per-instance caches on rebuild so tags read in a previous
/// visit render instantly. Exactly one copy of each map must exist in the
/// app — moved here verbatim from songs_page.dart.
final Map<String, EmbeddedAudioTags?> songTagCacheSnapshot = {};
final Map<String, DateTime> songTagModifiedAtSnapshot = {};

String _baseNameOf(String fileName) {
  final dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.substring(0, dot) : fileName;
}

class ScannedSongFile {
  const ScannedSongFile({
    required this.path,
    required this.fileName,
    required this.extension,
    required this.createdAt,
    required this.modifiedAt,
    required this.sizeBytes,
  });

  factory ScannedSongFile.fromSnapshot(LocalSongFileSnapshot snapshot) {
    return ScannedSongFile(
      path: snapshot.path,
      fileName: snapshot.fileName,
      extension: snapshot.extension,
      createdAt: snapshot.createdAt,
      modifiedAt: snapshot.modifiedAt,
      sizeBytes: snapshot.sizeBytes,
    );
  }

  final String path;
  final String fileName;
  final String extension;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final int sizeBytes;

  LocalSongFileSnapshot toSnapshot() => LocalSongFileSnapshot(
    path: path,
    fileName: fileName,
    extension: extension,
    createdAt: createdAt,
    modifiedAt: modifiedAt,
    sizeBytes: sizeBytes,
  );

  String get baseName => _baseNameOf(fileName);

  String get title {
    final sep = baseName.indexOf(' - ');
    final value = sep > 0
        ? baseName.substring(sep + 3).trim()
        : baseName.trim();
    return value.isEmpty ? fileName : value;
  }

  String get artist {
    final sep = baseName.indexOf(' - ');
    if (sep <= 0) return '未知歌手';
    final value = baseName.substring(0, sep).trim();
    return value.isEmpty ? '未知歌手' : value;
  }
}
