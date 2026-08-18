import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:html_unescape/html_unescape.dart';

import '../../models/lyric_info.dart';

// Decoder for Kugou's binary "KRC" lyric format. Unlike the plain "LRC"
// format, KRC carries word-level timings AND embeds translation/romaji as
// a base64-encoded JSON blob under a `[language:...]` tag.
//
// Pipeline (ported from the desktop source format's renderer/common/utils/lyricUtils/kg.js):
//   1. base64-decode the `content` field
//   2. strip the 4-byte magic header
//   3. XOR each byte with a cycling 16-byte key
//   4. zlib-inflate
//   5. parse the resulting text:
//        - [language:BASE64] → JSON with content[]: {type, lyricContent: [[word,...],...]}
//          type 0 = romaji, type 1 = translation
//        - body lines: [startMs,duration]<wordStart,wordDur,?>word<...>word...
//   6. Output `lyric` (plain LRC), `lxlyric` (with <rel,dur> word timings),
//      and `tlyric`/`rlyric` aligned per-line with the main lyric's timestamps.
class KgKrc {
  const KgKrc._();

  static final _key = Uint8List.fromList(const [
    0x40,
    0x47,
    0x61,
    0x77,
    0x5e,
    0x32,
    0x74,
    0x47,
    0x51,
    0x36,
    0x31,
    0x2d,
    0xce,
    0xd2,
    0x6e,
    0x69,
  ]);

  static final _headerExp = RegExp(r'^.*\[id:\$\w+\]\n', dotAll: true);
  static final _langExp = RegExp(r'\[language:([\w=\\/+]+)\]');
  static final _wordTime = RegExp(r'<(\d+),(\d+),\d+>');
  static final _htmlUnescape = HtmlUnescape();

  static LyricInfo decodeBase64Content(String base64Content) {
    final raw = base64.decode(base64Content);
    if (raw.length <= 4) {
      throw const FormatException('krc payload too short');
    }
    final body = Uint8List.fromList(raw.sublist(4));
    for (var i = 0; i < body.length; i++) {
      body[i] ^= _key[i % 16];
    }
    final inflated = ZLibDecoder().decodeBytes(body);
    final text = utf8.decode(inflated, allowMalformed: true);
    return _parse(text);
  }

  static LyricInfo _parse(String input) {
    var str = input.replaceAll('\r', '');
    if (_headerExp.hasMatch(str)) {
      str = str.replaceFirst(_headerExp, '');
    }

    // Extract translation / romaji block if present, then strip the tag so it
    // doesn't appear in the main body.
    List<List<String>>? trans;
    List<List<String>>? roma;
    final langMatch = _langExp.firstMatch(str);
    if (langMatch != null) {
      str = str.replaceFirst(RegExp(r'\[language:[\w=\\/+]+\]\n?'), '');
      try {
        final decoded = utf8.decode(base64.decode(langMatch.group(1)!));
        final json = jsonDecode(decoded);
        if (json is Map && json['content'] is List) {
          for (final item in json['content'] as List) {
            if (item is! Map) continue;
            final lyricContent = item['lyricContent'];
            if (lyricContent is! List) continue;
            final lines = <List<String>>[];
            for (final line in lyricContent) {
              if (line is List) {
                lines.add(line.map((e) => e.toString()).toList());
              } else {
                lines.add([line.toString()]);
              }
            }
            switch (item['type']) {
              case 0:
                roma = lines;
                break;
              case 1:
                trans = lines;
                break;
            }
          }
        }
      } catch (_) {
        // Malformed language block — fall through with no trans/roma.
      }
    }

    // Walk the body. For each `[startMs,duration]` header:
    //   - convert to `[mm:ss.xxx]`
    //   - prepend the same timestamp to the matching trans/roma line
    final lxBuffer = StringBuffer();
    final transOut = <String>[];
    final romaOut = <String>[];
    var idx = 0;
    var pos = 0;
    final lineHeader = RegExp(r'\[(\d+),(\d+)\]([^\n]*)');
    for (final m in lineHeader.allMatches(str)) {
      lxBuffer.write(str.substring(pos, m.start));
      final startMs = int.parse(m.group(1)!);
      final ts = _formatTimestamp(startMs);
      lxBuffer.write(ts);
      lxBuffer.write(m.group(3));
      if (trans != null && idx < trans.length) {
        transOut.add('$ts${trans[idx].join('')}');
      }
      if (roma != null && idx < roma.length) {
        romaOut.add('$ts${roma[idx].join('')}');
      }
      idx++;
      pos = m.end;
    }
    lxBuffer.write(str.substring(pos));

    // Strip per-character word duration sentinels:
    //   <wStart,wDur,?>  →  <wStart,wDur>
    var lxlyric = lxBuffer.toString().replaceAllMapped(
      _wordTime,
      (m) => '<${m.group(1)},${m.group(2)}>',
    );
    lxlyric = _htmlUnescape.convert(lxlyric);

    // Plain `lyric` = lxlyric with word timings stripped.
    final lyric = lxlyric.replaceAll(RegExp(r'<\d+,\d+>'), '');

    final transText = transOut.isEmpty
        ? null
        : _htmlUnescape.convert(transOut.join('\n'));
    final romaText = romaOut.isEmpty
        ? null
        : _htmlUnescape.convert(romaOut.join('\n'));

    return LyricInfo(
      lyric: lyric,
      tlyric: (transText != null && transText.isNotEmpty) ? transText : null,
      rlyric: (romaText != null && romaText.isNotEmpty) ? romaText : null,
      lxlyric: lxlyric.isEmpty ? null : lxlyric,
    );
  }

  static String _formatTimestamp(int ms) {
    final mils = (ms % 1000).toString();
    final totalSeconds = ms ~/ 1000;
    final m = (totalSeconds ~/ 60).toString().padLeft(2, '0');
    final s = (totalSeconds % 60).toString().padLeft(2, '0');
    return '[$m:$s.$mils]';
  }
}
