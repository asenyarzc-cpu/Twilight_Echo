import 'dart:convert' show LineSplitter;

/// Converts NetEase `yrc` word-timed lyrics into the lx `lxlyric` format
/// (`[mm:ss.xxx]<relMs,durMs>word`) that `KaraokeLyricsParser` consumes.
///
/// yrc lines look like:
///   {"t":0,"c":[{"tx":"作词: xxx"}]}            — JSON credit lines, dropped
///   [1300,2850](1300,240,0)真(1540,240,0)的…    — absolute-ms word stamps
///
/// Kept free of Flutter imports so `dart test` can exercise it directly.
String? wyYrcToLxLyric(String yrc) {
  final lineExp = RegExp(r'^\[(\d+),(\d+)\]');
  final wordExp = RegExp(r'\((\d+),(\d+),\d+\)');
  final out = <String>[];
  for (final raw in const LineSplitter().convert(yrc.replaceAll('\r', ''))) {
    final line = raw.trim();
    if (line.isEmpty) continue;
    final head = lineExp.firstMatch(line);
    if (head == null) continue; // JSON metadata / credit line
    final lineStart = int.parse(head.group(1)!);
    final body = line.substring(head.end);
    final matches = wordExp.allMatches(body).toList(growable: false);
    if (matches.isEmpty) continue;
    final buf = StringBuffer(_lxTime(lineStart));
    var wrote = false;
    for (var i = 0; i < matches.length; i++) {
      final match = matches[i];
      final textEnd = i + 1 < matches.length
          ? matches[i + 1].start
          : body.length;
      final text = body.substring(match.end, textEnd);
      if (text.isEmpty) continue;
      // yrc word stamps are absolute ms; lxlyric wants line-relative offsets.
      final rel = int.parse(match.group(1)!) - lineStart;
      final dur = int.parse(match.group(2)!);
      buf.write('<${rel < 0 ? 0 : rel},$dur>$text');
      wrote = true;
    }
    if (wrote) out.add(buf.toString());
  }
  if (out.isEmpty) return null;
  return out.join('\n');
}

String _lxTime(int ms) {
  final minutes = (ms ~/ 60000).toString().padLeft(2, '0');
  final seconds = ((ms % 60000) ~/ 1000).toString().padLeft(2, '0');
  final millis = (ms % 1000).toString().padLeft(3, '0');
  return '[$minutes:$seconds.$millis]';
}
