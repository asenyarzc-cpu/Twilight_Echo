import '../models/enums.dart';
import '../models/music_info.dart';

class FileNaming {
  const FileNaming._();

  // Mirrors filterFileName / buildFileName in lx-music-server.
  // Strips characters that would break common Android filesystems and joins
  // "{artist - title}.{ext}".
  static String build(MusicInfo info, String extension) {
    final base = info.singer.isEmpty
        ? info.name
        : '${info.singer} - ${info.name}';
    final safe = sanitize(base);
    final trimmed = safe.length > 200 ? safe.substring(0, 200) : safe;
    return '$trimmed.$extension';
  }

  static String resolvedOrBuild(
    MusicInfo info,
    String extension,
    String? resolvedName,
  ) {
    final normalized = resolvedName?.trim();
    if (normalized == null ||
        normalized.isEmpty ||
        normalized.toLowerCase() == 'null' ||
        normalized.toLowerCase() == 'undefined') {
      return build(info, extension);
    }

    // A user-imported source is allowed to suggest a name, not a path.
    final leaf = normalized.replaceAll('\\', '/').split('/').last;
    final safe = sanitize(leaf);
    if (safe == 'untitled' ||
        safe.toLowerCase() == 'null' ||
        safe.toLowerCase() == 'undefined') {
      return build(info, extension);
    }
    final dot = safe.lastIndexOf('.');
    return dot <= 0 || dot == safe.length - 1 ? '$safe.$extension' : safe;
  }

  // Lossy: replaces \ / : * ? " < > | (any of which would break SAF / FAT32)
  // and trims surrounding whitespace and trailing dots.
  static String sanitize(String value) {
    var result = value.replaceAll(RegExp(r'[\\/:*?"<>|\x00-\x1f]'), '_');
    result = result.replaceAll(RegExp(r'\s+'), ' ').trim();
    while (result.endsWith('.') || result.endsWith(' ')) {
      result = result.substring(0, result.length - 1);
    }
    if (result.isEmpty) return 'untitled';
    return result;
  }

  static String extensionFor(Quality requested, Quality? actual) {
    final q = actual ?? requested;
    return q.extension;
  }
}
