import 'dart:convert' show LineSplitter;
import 'dart:math' as math;

import '../../models/lyric_info.dart';

// Kuwo's lyricx format looks like LRC, but its per-word `<a,b>` pairs are not
// the relative start/duration pairs used by lxlyric. The `[kuwo:...]` tag
// carries the scale factors needed to decode those pairs.
class KwLyricx {
  const KwLyricx._();

  static final _timeLine = RegExp(r'^\[([\d:.]+)\]');
  static final _tagLine = RegExp(
    r'^\[(ver|ti|ar|al|offset|by|kuwo):\s*(.*?)\s*\]$',
    caseSensitive: false,
  );
  static final _rawWordTime = RegExp(r'<(-?\d+),(-?\d+)(?:,-?\d+)?>');
  static final _rawWordTimeAtStart = RegExp(r'^<-?\d+,-?\d+(?:,-?\d+)?>');

  static LyricInfo parse(String raw) {
    final clock = _KwWordClock();
    final entries = <_KwLine>[];
    final lines = const LineSplitter().convert(raw.replaceAll('\r', ''));

    for (final rawLine in lines) {
      final line = rawLine.trim();
      if (line.isEmpty) continue;

      final tag = _tagLine.firstMatch(line);
      if (tag != null) {
        if (tag.group(1)?.toLowerCase() == 'kuwo') {
          clock.applyTag(tag.group(2) ?? '');
        }
        continue;
      }

      final time = _timeLine.firstMatch(line);
      if (time == null) continue;
      final text = line.substring(time.end).trim();
      if (text.isEmpty) continue;
      entries.add(_KwLine(_normalizeTime(time.group(1)!), text));
    }

    final sorted = _sortLines(entries);
    final lyricLines = <String>[];
    final wordLines = <String>[];
    var hasWordTiming = false;

    for (final line in sorted.main) {
      final plain = _stripWordTimes(line.text);
      if (plain.trim().isEmpty) continue;
      lyricLines.add('[${line.time}]$plain');

      final normalized = _normalizeWordLine(line.text, clock);
      hasWordTiming = hasWordTiming || normalized.hasWordTiming;
      wordLines.add('[${line.time}]${normalized.text}');
    }

    final transLines = <String>[];
    for (final line in sorted.trans) {
      final plain = _stripWordTimes(line.text);
      if (plain.trim().isNotEmpty) {
        transLines.add('[${line.time}]$plain');
      }
    }

    return LyricInfo(
      lyric: lyricLines.join('\n'),
      tlyric: transLines.isEmpty ? null : transLines.join('\n'),
      lxlyric: hasWordTiming ? wordLines.join('\n') : null,
    );
  }

  static _SortedKwLines _sortLines(List<_KwLine> entries) {
    final seenTimes = <String>{};
    final main = <_KwLine>[];
    final trans = <_KwLine>[];

    for (final entry in entries) {
      if (seenTimes.contains(entry.time)) {
        if (main.length < 2) continue;
        final transLine = main.removeLast().copyWith(time: main.last.time);
        trans.add(transLine);
        main.add(entry);
      } else {
        main.add(entry);
        seenTimes.add(entry.time);
      }
    }

    final isLyricx = entries.any(
      (line) => _rawWordTimeAtStart.hasMatch(line.text),
    );
    if (!isLyricx &&
        trans.length > main.length * 0.3 &&
        main.length - trans.length > 6) {
      return _SortedKwLines(entries, const []);
    }
    return _SortedKwLines(main, trans);
  }

  static _NormalizedKwText _normalizeWordLine(String text, _KwWordClock clock) {
    final matches = _rawWordTime.allMatches(text).toList(growable: false);
    if (matches.isEmpty || !clock.isValid) {
      return _NormalizedKwText(_stripWordTimes(text), false);
    }

    final timings = <_KwWordTiming>[];
    _KwWordTiming? previous;
    for (final match in matches) {
      final rawStart = int.tryParse(match.group(1)!);
      final rawEnd = int.tryParse(match.group(2)!);
      if (rawStart == null || rawEnd == null) continue;

      final timing = clock.decode(rawStart, rawEnd);
      if (previous != null && timing.start < previous.end) {
        previous.end = timing.start;
        if (previous.start > previous.end) previous.start = previous.end;
      }
      timings.add(timing);
      previous = timing;
    }

    if (timings.length != matches.length) {
      return _NormalizedKwText(_stripWordTimes(text), false);
    }

    final buffer = StringBuffer();
    var cursor = 0;
    for (var i = 0; i < matches.length; i++) {
      final match = matches[i];
      final timing = timings[i];
      buffer.write(text.substring(cursor, match.start));
      buffer.write('<${_roundMs(timing.start)},${_roundDuration(timing)}>');
      cursor = match.end;
    }
    buffer.write(text.substring(cursor));

    return _NormalizedKwText(buffer.toString(), true);
  }

  static String _stripWordTimes(String text) =>
      text.replaceAll(_rawWordTime, '');

  static String _normalizeTime(String time) {
    if (RegExp(r'\.\d\d$').hasMatch(time)) return '${time}0';
    return time;
  }

  static int _roundMs(double value) => math.max(0, value.round());

  static int _roundDuration(_KwWordTiming timing) {
    return math.max(0, (timing.end - timing.start).round());
  }
}

class _KwWordClock {
  var offset = 1;
  var offset2 = 1;
  var isValid = true;

  void applyTag(String rawContent) {
    var content = rawContent.trim();
    final chained = content.indexOf('][');
    if (chained >= 0) content = content.substring(0, chained);

    final value = int.tryParse(content, radix: 8);
    if (value == null) {
      isValid = false;
      return;
    }

    offset = value ~/ 10;
    offset2 = value % 10;
    if (offset == 0 || offset2 == 0) isValid = false;
  }

  _KwWordTiming decode(int rawStart, int rawEnd) {
    final start = ((rawStart + rawEnd) / (offset * 2)).abs();
    final end = ((rawStart - rawEnd) / (offset2 * 2)).abs() + start;
    return _KwWordTiming(start, end);
  }
}

class _KwWordTiming {
  _KwWordTiming(this.start, this.end);

  double start;
  double end;
}

class _KwLine {
  const _KwLine(this.time, this.text);

  final String time;
  final String text;

  _KwLine copyWith({String? time, String? text}) {
    return _KwLine(time ?? this.time, text ?? this.text);
  }
}

class _SortedKwLines {
  const _SortedKwLines(this.main, this.trans);

  final List<_KwLine> main;
  final List<_KwLine> trans;
}

class _NormalizedKwText {
  const _NormalizedKwText(this.text, this.hasWordTiming);

  final String text;
  final bool hasWordTiming;
}
