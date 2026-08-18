import 'enums.dart';

/// Source-level capabilities declared by the active on-device JS music source.
/// This is independent of whether a platform can be searched locally.
class DownloadCapabilities {
  const DownloadCapabilities({
    required this.sources,
    required this.availableSources,
  });

  /// Supported download qualities per source. A source only appears here when
  /// it reports at least one usable quality.
  final Map<MusicSource, List<Quality>> sources;

  /// Sources that can download right now (same keys as [sources]).
  final List<MusicSource> availableSources;

  /// `all` is the aggregate search filter, not a real download source, so it is
  /// always treated as available.
  bool isAvailable(MusicSource source) =>
      source == MusicSource.all || availableSources.contains(source);

  /// Qualities a source supports, or null when the source has no reported
  /// capability (caller should fall back to per-track qualities).
  List<Quality>? qualitiesFor(MusicSource source) => sources[source];

  factory DownloadCapabilities.fromJson(Map<String, dynamic> json) {
    final sources = <MusicSource, List<Quality>>{};
    final sourcesRaw = json['sources'];
    if (sourcesRaw is Map) {
      sourcesRaw.forEach((key, value) {
        // fromCode maps unknown keys to `all`; skip those so a stray key can't
        // masquerade as the aggregate source.
        final source = MusicSource.fromCode(key.toString());
        if (source == MusicSource.all || value is! List) return;
        final qualities = <Quality>[];
        for (final item in value) {
          final quality = Quality.tryFromCode(item.toString());
          if (quality != null && !qualities.contains(quality)) {
            qualities.add(quality);
          }
        }
        if (qualities.isNotEmpty) sources[source] = qualities;
      });
    }

    final available = <MusicSource>[];
    final availableRaw = json['availableSources'];
    if (availableRaw is List) {
      for (final item in availableRaw) {
        final source = MusicSource.fromCode(item.toString());
        if (source != MusicSource.all && !available.contains(source)) {
          available.add(source);
        }
      }
    }

    return DownloadCapabilities(sources: sources, availableSources: available);
  }

  static const DownloadCapabilities empty = DownloadCapabilities(
    sources: {},
    availableSources: [],
  );
}
