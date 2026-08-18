import 'dart:convert';

// Ports the QRC-format lyric parser from the desktop source format's
// renderer/utils/musicSdk/tx/lyric.js.
//
// After QRC decryption, TX returns lyrics in two distinct shapes:
//   * `lyric` / `roma`: word-timed format like `[123,1500]<0,200>He<200,300>llo`
//   * `trans`:          plain LRC like `[00:01.50]翻译内容`
//
// `parseQrcLyric` converts the word-timed format into:
//   * a clean LRC track (`lyric`) with `[mm:ss.xxx]` headers and word timings stripped
//   * an lxlyric track preserving per-character relative offsets
//
// `parseQrcRoma` is the same shape but only returns the clean LRC (no lxlyric
// is exposed for roma in the desktop source format's flow).
class TxQrcLyric {
  const TxQrcLyric._();

  static final _lineTime = RegExp(r'^\[(\d+),\d+\]');
  static final _wordTime = RegExp(r'\(\d+,\d+\)');
  static final _wordTimeAll = RegExp(r'\(\d+,\d+\)');
  static final _wordTimeCapture = RegExp(r'\((\d+),(\d+)\)');
  static final _stdLine = RegExp(r'^\[([\d:.]+)\]');

  static String _msFormat(int timeMs) {
    if (timeMs < 0) return '';
    final ms = (timeMs % 1000).toString().padLeft(3, '0');
    final totalSeconds = timeMs ~/ 1000;
    final m = (totalSeconds ~/ 60).toString().padLeft(2, '0');
    final s = (totalSeconds % 60).toString().padLeft(2, '0');
    return '[$m:$s.$ms]';
  }

  /// Returns (`lyric`, `lxlyric`).
  static ({String lyric, String lxlyric}) parseQrcLyric(String raw) {
    final src = raw.replaceAll('\r', '').trim();
    if (src.isEmpty) return (lyric: '', lxlyric: '');
    final lrcLines = <String>[];
    final lxLines = <String>[];
    for (final rawLine in src.split('\n')) {
      final line = rawLine.trim();
      final m = _lineTime.firstMatch(line);
      if (m == null) {
        // Pass through `[offset]` and standard `[mm:ss.xx]` lines so we don't
        // drop ID3-style metadata that some QQ payloads include.
        if (line.startsWith('[offset')) {
          lrcLines.add(line);
          lxLines.add(line);
        } else if (_stdLine.hasMatch(line)) {
          lrcLines.add(line);
        }
        continue;
      }
      final startMs = int.tryParse(m.group(1)!) ?? -1;
      final header = _msFormat(startMs);
      if (header.isEmpty) continue;
      final words = line.substring(m.end);
      lrcLines.add('$header${words.replaceAll(_wordTimeAll, '')}');

      // Build lxlyric with relative-to-line word timings: <relMs,durMs>.
      // Source format puts time AFTER the word it covers:
      //   "He(t0)llo(t1)world(t2)" → split → ["He","llo","world",""].
      // Output flips time BEFORE the word, mirroring the desktop source format's
      // `times.map((t,i) => t + wordArr[i])`.
      final matches = _wordTimeAll.allMatches(words).toList();
      if (matches.isEmpty) {
        lxLines.add('$header${words.replaceAll(_wordTimeAll, '')}');
        continue;
      }
      final times = matches.map((mm) {
        final w = _wordTimeCapture.firstMatch(mm.group(0)!)!;
        final relStart = (int.parse(w.group(1)!) - startMs).clamp(0, 1 << 31);
        final dur = int.parse(w.group(2)!);
        return '<$relStart,$dur>';
      }).toList();
      final wordArr = words.split(_wordTime);
      final buffer = StringBuffer();
      for (var i = 0; i < times.length; i++) {
        buffer.write(times[i]);
        if (i < wordArr.length) buffer.write(wordArr[i]);
      }
      lxLines.add('$header$buffer');
    }
    return (lyric: lrcLines.join('\n'), lxlyric: lxLines.join('\n'));
  }

  /// Roma uses the QRC line-time format but the desktop source format only exports its
  /// LRC track, so we just reuse the lyric arm of parseQrcLyric.
  static String parseQrcRoma(String raw) {
    return parseQrcLyric(raw).lyric;
  }

  /// Re-aligns timestamps of `extended` (translation or roma) onto the exact
  /// timestamp strings used by `mainLyric`. Mirrors the desktop source format's
  /// `fixTlrcTimeTag`: for each line in `extended`, walk through the
  /// remaining `mainLyric` lines and pick the closest one within 100ms; the
  /// extended line's timestamp is rewritten to that main timestamp.
  ///
  /// Necessary because TX returns trans/roma at slightly different precision
  /// than the main track (e.g. trans uses centiseconds, main uses
  /// milliseconds). Without alignment, `LyricBuilder._filterExtended` drops
  /// every extended line since timestamps no longer match exactly.
  static String alignTimestamps(String extended, String mainLyric) {
    final mainEntries = _collectTimestampedLines(mainLyric);
    if (mainEntries.isEmpty) return extended;
    final extendedLines = const LineSplitter().convert(extended);
    final out = <String>[];
    var cursor = 0;
    for (final rawLine in extendedLines) {
      final line = rawLine.trim();
      if (line.isEmpty) continue;
      final match = _stdLineCapture.firstMatch(line);
      if (match == null) continue;
      final timeStr = match.group(1)!;
      final body = line.substring(match.end);
      if (body.trim().isEmpty) continue;
      final t1 = _parseLrcMs(timeStr);
      while (cursor < mainEntries.length) {
        final candidate = mainEntries[cursor];
        cursor++;
        if ((candidate.ms - t1).abs() < 100) {
          out.add('[${candidate.label}]$body');
          break;
        }
      }
    }
    return out.join('\n');
  }

  static final _stdLineCapture = RegExp(r'^\[([\d:.]+)\]');

  static List<_TimedLine> _collectTimestampedLines(String lrc) {
    final entries = <_TimedLine>[];
    for (final raw in const LineSplitter().convert(lrc)) {
      final line = raw.trim();
      final m = _stdLineCapture.firstMatch(line);
      if (m == null) continue;
      final label = m.group(1)!;
      final body = line.substring(m.end);
      if (body.trim().isEmpty) continue;
      entries.add(_TimedLine(label, _parseLrcMs(label)));
    }
    return entries;
  }

  static int _parseLrcMs(String label) {
    // Accepts `mm:ss.xx`, `mm:ss.xxx`, or `h:mm:ss.xxx`.
    final parts = label.split(':');
    num seconds = 0;
    for (var i = 0; i < parts.length; i++) {
      final exp = parts.length - 1 - i;
      final v = double.tryParse(parts[i]) ?? 0;
      seconds += v * _pow60[exp];
    }
    return (seconds * 1000).round();
  }

  static const _pow60 = [1, 60, 3600];
}

class _TimedLine {
  const _TimedLine(this.label, this.ms);
  final String label;
  final int ms;
}
