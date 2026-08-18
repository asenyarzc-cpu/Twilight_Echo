import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';

/// Pure-Dart download-history model, split from download_history_store.dart
/// (which is re-exported there) so that test/unit_test.dart and
/// player_models.dart can import it without dragging the store's
/// settings_store / cover_image_source closure — and with it Flutter's
/// material layer — into `dart test`.
enum DownloadHistoryStatus { completed, failed }

class DownloadHistoryEntry {
  const DownloadHistoryEntry({
    required this.id,
    required this.musicId,
    required this.name,
    required this.singer,
    required this.albumName,
    required this.sourceCode,
    required this.qualityCode,
    required this.status,
    required this.createdAt,
    this.savedPath,
    this.message,
    this.picUrl,
    this.sizeBytes,
    this.musicJson,
  });

  final String id;
  final String musicId;
  final String name;
  final String singer;
  final String albumName;
  final String sourceCode;
  final String qualityCode;
  final DownloadHistoryStatus status;
  final DateTime createdAt;
  final String? savedPath;
  final String? message;
  final String? picUrl;
  final int? sizeBytes;
  final Map<String, dynamic>? musicJson;

  MusicSource get source => MusicSource.fromCode(sourceCode);
  bool get isCompleted => status == DownloadHistoryStatus.completed;

  MusicInfo? get musicInfo {
    final json = musicJson;
    if (json == null) return null;
    try {
      return MusicInfo.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  factory DownloadHistoryEntry.fromJson(Map<String, dynamic> json) {
    return DownloadHistoryEntry(
      id: json['id'] as String? ?? '',
      musicId: json['musicId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      singer: json['singer'] as String? ?? '',
      albumName: json['albumName'] as String? ?? '',
      sourceCode: json['source'] as String? ?? MusicSource.all.code,
      qualityCode: json['quality'] as String? ?? Quality.k128.code,
      status: (json['status'] as String?) == 'failed'
          ? DownloadHistoryStatus.failed
          : DownloadHistoryStatus.completed,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      savedPath: json['savedPath'] as String?,
      message: json['message'] as String?,
      picUrl: json['picUrl'] as String?,
      sizeBytes: json['sizeBytes'] as int?,
      musicJson: _mapOrNull(json['musicInfo']),
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'musicId': musicId,
    'name': name,
    'singer': singer,
    'albumName': albumName,
    'source': sourceCode,
    'quality': qualityCode,
    'status': status == DownloadHistoryStatus.failed ? 'failed' : 'completed',
    'createdAt': createdAt.toIso8601String(),
    if (savedPath != null) 'savedPath': savedPath,
    if (message != null) 'message': message,
    if (picUrl != null) 'picUrl': picUrl,
    if (sizeBytes != null) 'sizeBytes': sizeBytes,
    if (musicJson != null) 'musicInfo': musicJson,
  };
}

Map<String, dynamic>? _mapOrNull(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}
