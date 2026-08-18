import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'music_source_models.dart';

const int kMaxMusicSourceScriptBytes = 2 * 1024 * 1024;
const int kMaxMusicSourceCount = 20;

MusicSourceMetadata parseMusicSourceMetadata(String script) {
  if (utf8.encode(script).length > kMaxMusicSourceScriptBytes) {
    throw const FormatException('音源脚本不能超过 2 MB');
  }
  final header = script.length > 16384 ? script.substring(0, 16384) : script;
  String valueFor(String key) {
    final match = RegExp(
      '^\\s*(?://+|/\\*+|\\*+|#)?\\s*@$key\\s+(.+?)\\s*(?:\\*/)?\\s*\$',
      multiLine: true,
      caseSensitive: false,
    ).firstMatch(header);
    return match?.group(1)?.trim() ?? '';
  }

  final name = valueFor('name');
  if (name.isEmpty) {
    throw const FormatException('脚本头部缺少 @name');
  }
  return MusicSourceMetadata(
    name: _limit(name, 80),
    description: _limit(valueFor('description'), 240),
    author: _limit(valueFor('author'), 80),
    homepage: _limit(valueFor('homepage'), 500),
    version: _limit(valueFor('version'), 40),
  );
}

String musicSourceId(MusicSourceMetadata metadata) {
  final identity = '${metadata.name}\u0000${metadata.author}'.toLowerCase();
  return sha256.convert(utf8.encode(identity)).toString().substring(0, 24);
}

String _limit(String value, int maxLength) =>
    value.length <= maxLength ? value : value.substring(0, maxLength);
