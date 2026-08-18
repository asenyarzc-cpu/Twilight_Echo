import 'enums.dart';

class MusicUrl {
  const MusicUrl({required this.url, this.type, this.fileName});

  final String url;
  final Quality? type;
  final String? fileName;

  factory MusicUrl.fromJson(Map<String, dynamic> json) => MusicUrl(
    url: (json['url'] as String?) ?? '',
    type: json['type'] is String
        ? Quality.fromCode(json['type'] as String)
        : null,
    fileName: normalizeResolvedFileName(json['fileName']),
  );
}

String? normalizeResolvedFileName(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  final lower = trimmed.toLowerCase();
  if (lower == 'null' || lower == 'undefined') return null;
  return trimmed;
}
