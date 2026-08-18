import 'enums.dart';
import 'music_info.dart';

class PlaylistInfo {
  const PlaylistInfo({
    required this.id,
    required this.name,
    required this.source,
    required this.tracks,
    this.coverUrl,
    this.creator,
    this.description,
    this.playCount,
    this.trackCount,
  });

  final String id;
  final String name;
  final MusicSource source;
  final List<MusicInfo> tracks;
  final String? coverUrl;
  final String? creator;
  final String? description;
  final int? playCount;
  final int? trackCount;

  int get totalTracks => trackCount ?? tracks.length;
}

class ParsedPlaylistTarget {
  const ParsedPlaylistTarget({required this.id, required this.source});

  final String id;
  final MusicSource source;
}
