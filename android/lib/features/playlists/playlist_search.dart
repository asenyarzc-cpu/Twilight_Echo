import 'package:path/path.dart' as path;

import 'resolved_playlist_track.dart';

/// Filters resolved playlist tracks the same way [filterSongsByQuery] filters
/// local songs: whitespace-separated AND terms, case-insensitive, matched
/// against name / singer / album / local file name.
List<ResolvedPlaylistTrack> filterResolvedTracksByQuery(
  List<ResolvedPlaylistTrack> tracks,
  String query,
) {
  final terms = query
      .trim()
      .toLowerCase()
      .split(RegExp(r'\s+'))
      .where((term) => term.isNotEmpty)
      .toList(growable: false);
  if (terms.isEmpty) return tracks;

  return tracks
      .where((item) {
        final localPath =
            item.localEntry?.savedPath?.trim() ?? item.track.localPath?.trim();
        final fileName = localPath == null || localPath.isEmpty
            ? ''
            : path.basenameWithoutExtension(localPath);
        final searchable = [
          item.track.name,
          item.track.singer,
          item.track.albumName,
          fileName,
        ].join('\n').toLowerCase();
        return terms.every(searchable.contains);
      })
      .toList(growable: false);
}
