import '../../models/music_info.dart';
import 'format.dart';

/// Pure lyric-routing helpers for the TX (QQ Music) SDK.
///
/// Kept free of Flutter/plugin imports so `test/unit_test.dart` can exercise
/// them under `dart test` without pulling in `tx_sdk.dart`'s http/logging
/// dependencies.

/// Resolve the integer QQ song ID used by the PlayLyricInfo endpoint.
///
/// `mid` (string, e.g. "002TOVre3tDgBD") is stored as songId; the numeric
/// ID lives on meta.metaId from search results.
int? txResolveIntegerSongId(MusicInfo info) {
  final metaId = info.meta.metaId;
  if (metaId != null && metaId.toString().isNotEmpty) {
    final n = int.tryParse(metaId.toString());
    if (n != null && n > 0) return n;
  }
  final raw = info.meta.songId;
  if (raw is int) return raw;
  if (raw is String) return int.tryParse(raw);
  return null;
}

// crypt:1 QRC payloads for lyric/roma can be wrapped in an XML envelope:
//   <?xml ...?><QrcInfos>...<Lyric_1 LyricType="1" LyricContent="...REAL..."/>
//   </LyricInfo></QrcInfos>
// Strip the wrapper to get just the QRC-format body. crypt:0 (and trans
// either way) ships plain content, so we pass it through.
final _lyricContentExp = RegExp(
  // QQ sometimes leaves literal quotes inside LyricContent unescaped, such
  // as Bradford "Brad" Delson. Only the quote closing the self-closing QRC
  // tag is an attribute boundary.
  r'''LyricContent=(["'])([\s\S]*?)\1\s*/>''',
  dotAll: true,
);

String txExtractLyricContent(String raw) {
  final m = _lyricContentExp.firstMatch(raw);
  if (m == null) return raw;
  return decodeName(m.group(2)!);
}
