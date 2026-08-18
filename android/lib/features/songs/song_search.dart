import 'package:path/path.dart' as path;

import '../downloads/download_history_entry.dart';

List<DownloadHistoryEntry> filterSongsByQuery(
  List<DownloadHistoryEntry> songs,
  String query,
) {
  final terms = query
      .trim()
      .toLowerCase()
      .split(RegExp(r'\s+'))
      .where((term) => term.isNotEmpty)
      .toList(growable: false);
  if (terms.isEmpty) return songs;

  return songs
      .where((song) {
        final savedPath = song.savedPath;
        final fileName = savedPath == null || savedPath.isEmpty
            ? ''
            : path.basenameWithoutExtension(savedPath);
        final searchable = [
          song.name,
          song.singer,
          song.albumName,
          fileName,
        ].join('\n').toLowerCase();
        return terms.every(searchable.contains);
      })
      .toList(growable: false);
}
