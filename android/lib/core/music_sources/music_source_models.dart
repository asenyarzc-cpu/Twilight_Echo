import '../models/download_capabilities.dart';
import '../models/enums.dart';

class MusicSourceMetadata {
  const MusicSourceMetadata({
    required this.name,
    this.description = '',
    this.author = '',
    this.homepage = '',
    this.version = '',
  });

  final String name;
  final String description;
  final String author;
  final String homepage;
  final String version;
}

class MusicSourceRecord {
  const MusicSourceRecord({
    required this.id,
    required this.name,
    required this.description,
    required this.author,
    required this.homepage,
    required this.version,
    required this.origin,
    required this.importedAt,
    required this.updatedAt,
    required this.capabilities,
    this.lastError,
  });

  final String id;
  final String name;
  final String description;
  final String author;
  final String homepage;
  final String version;
  final String origin;
  final DateTime importedAt;
  final DateTime updatedAt;
  final Map<MusicSource, List<Quality>> capabilities;
  final String? lastError;

  bool supports(MusicSource source) => capabilities.containsKey(source);

  List<Quality> qualitiesFor(MusicSource source) =>
      capabilities[source] ?? const [];

  MusicSourceRecord copyWith({
    String? origin,
    DateTime? updatedAt,
    Map<MusicSource, List<Quality>>? capabilities,
    String? lastError,
    bool clearLastError = false,
  }) {
    return MusicSourceRecord(
      id: id,
      name: name,
      description: description,
      author: author,
      homepage: homepage,
      version: version,
      origin: origin ?? this.origin,
      importedAt: importedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      capabilities: capabilities ?? this.capabilities,
      lastError: clearLastError ? null : lastError ?? this.lastError,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'description': description,
    'author': author,
    'homepage': homepage,
    'version': version,
    'origin': origin,
    'importedAt': importedAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
    'capabilities': {
      for (final entry in capabilities.entries)
        entry.key.code: entry.value.map((quality) => quality.code).toList(),
    },
    if (lastError != null) 'lastError': lastError,
  };

  factory MusicSourceRecord.fromJson(Map<String, dynamic> json) {
    final capabilities = <MusicSource, List<Quality>>{};
    final rawCapabilities = json['capabilities'];
    if (rawCapabilities is Map) {
      rawCapabilities.forEach((key, value) {
        final source = MusicSource.tryFromCode(key.toString());
        if (source == null || source == MusicSource.all || value is! List) {
          return;
        }
        final qualities = <Quality>[];
        for (final raw in value) {
          final quality = Quality.tryFromCode(raw.toString());
          if (quality != null && !qualities.contains(quality)) {
            qualities.add(quality);
          }
        }
        capabilities[source] = List.unmodifiable(qualities);
      });
    }
    return MusicSourceRecord(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '未命名音源',
      description: json['description'] as String? ?? '',
      author: json['author'] as String? ?? '',
      homepage: json['homepage'] as String? ?? '',
      version: json['version'] as String? ?? '',
      origin: json['origin'] as String? ?? '',
      importedAt:
          DateTime.tryParse(json['importedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      updatedAt:
          DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      capabilities: Map.unmodifiable(capabilities),
      lastError: json['lastError'] as String?,
    );
  }

  static Map<MusicSource, List<Quality>> parseRuntimeCapabilities(Object? raw) {
    final result = <MusicSource, List<Quality>>{};
    if (raw is! Map) return result;
    final sources = raw['sources'];
    if (sources is! Map) return result;
    sources.forEach((key, value) {
      final source = MusicSource.tryFromCode(key.toString());
      if (source == null || source == MusicSource.all || value is! Map) return;
      final actions = value['actions'];
      if (actions is! List ||
          !actions.map((action) => action.toString()).contains('musicUrl')) {
        return;
      }
      final qualities = <Quality>[];
      final rawQualities = value['qualitys'];
      if (rawQualities is List) {
        for (final item in rawQualities) {
          final quality = Quality.tryFromCode(item.toString());
          if (quality != null && !qualities.contains(quality)) {
            qualities.add(quality);
          }
        }
      }
      result[source] = List.unmodifiable(qualities);
    });
    return Map.unmodifiable(result);
  }
}

class MusicSourceState {
  const MusicSourceState({
    required this.records,
    required this.enabledIds,
    this.activatingId,
  });

  final List<MusicSourceRecord> records;
  final List<String> enabledIds;
  final String? activatingId;

  List<MusicSourceRecord> get enabledRecords {
    final recordsById = {for (final record in records) record.id: record};
    final enabled = <MusicSourceRecord>[];
    for (final id in enabledIds) {
      final record = recordsById[id];
      if (record != null) enabled.add(record);
    }
    return List.unmodifiable(enabled);
  }

  MusicSourceRecord? get primary {
    final enabled = enabledRecords;
    return enabled.isEmpty ? null : enabled.first;
  }

  bool isEnabled(String id) => enabledIds.contains(id);

  int? priorityOf(String id) {
    final index = enabledIds.indexOf(id);
    return index < 0 ? null : index + 1;
  }

  List<MusicSourceRecord> enabledFor(MusicSource source) {
    return List.unmodifiable([
      for (final record in enabledRecords)
        if (record.supports(source)) record,
    ]);
  }

  DownloadCapabilities get downloadCapabilities {
    final sources = <MusicSource, List<Quality>>{};
    for (final record in enabledRecords) {
      for (final entry in record.capabilities.entries) {
        final qualities = sources.putIfAbsent(entry.key, () => <Quality>[]);
        for (final quality in entry.value) {
          if (!qualities.contains(quality)) qualities.add(quality);
        }
      }
    }
    return DownloadCapabilities(
      sources: Map<MusicSource, List<Quality>>.unmodifiable({
        for (final entry in sources.entries)
          entry.key: List<Quality>.unmodifiable(entry.value),
      }),
      availableSources: List.unmodifiable(sources.keys),
    );
  }

  MusicSourceState copyWith({
    List<MusicSourceRecord>? records,
    List<String>? enabledIds,
    String? activatingId,
    bool clearActivating = false,
  }) {
    return MusicSourceState(
      records: records ?? this.records,
      enabledIds: enabledIds ?? this.enabledIds,
      activatingId: clearActivating ? null : activatingId ?? this.activatingId,
    );
  }

  static const empty = MusicSourceState(records: [], enabledIds: []);
}

const int kMaxEnabledMusicSourceCount = 5;
