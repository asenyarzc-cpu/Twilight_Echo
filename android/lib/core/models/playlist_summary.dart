import 'enums.dart';

class PlaylistSummary {
  const PlaylistSummary({
    required this.id,
    required this.name,
    required this.source,
    this.coverUrl,
    this.creator,
    this.description,
    this.trackCount,
    this.playCount,
  });

  final String id;
  final String name;
  final MusicSource source;
  final String? coverUrl;
  final String? creator;
  final String? description;
  final int? trackCount;
  final int? playCount;

  String get key => '${source.code}:$id';
}
