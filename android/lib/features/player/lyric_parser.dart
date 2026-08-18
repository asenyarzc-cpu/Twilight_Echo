import 'dart:convert' show LineSplitter;
import 'dart:math' as math;

import '../../core/models/lyric_info.dart';

class KaraokeLyrics {
  const KaraokeLyrics(this.lines);

  final List<KaraokeLyricLine> lines;

  bool get isEmpty => lines.isEmpty;

  int activeIndex(Duration position) {
    if (lines.isEmpty) return -1;
    final ms = position.inMilliseconds;
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      if (ms >= line.startMs && ms < line.endMs) return i;
      if (ms < line.startMs) return math.max(0, i - 1);
    }
    return lines.length - 1;
  }
}

class KaraokeLyricLine {
  const KaraokeLyricLine({
    required this.startMs,
    required this.endMs,
    required this.text,
    this.translation,
    this.roman,
    this.words = const [],
  });

  final int startMs;
  final int endMs;
  final String text;
  final String? translation;
  final String? roman;
  final List<KaraokeWordTiming> words;

  bool get hasWordTiming => words.isNotEmpty;
}

class KaraokeWordTiming {
  const KaraokeWordTiming({
    required this.text,
    required this.startMs,
    required this.endMs,
  });

  final String text;
  final int startMs;
  final int endMs;

  double progressAt(int positionMs) {
    if (positionMs <= startMs) return 0;
    if (positionMs >= endMs) return 1;
    final duration = math.max(1, endMs - startMs);
    return ((positionMs - startMs) / duration).clamp(0, 1).toDouble();
  }
}

class KaraokeLyricsParser {
  const KaraokeLyricsParser._();

  static final _lineTimeExp = RegExp(
    r'\[(\d{1,3}(?::\d{1,3}){0,2}(?:\.\d{1,3})?)\]',
  );
  static final _leadingTimeFieldExp = RegExp(r'^(?:\[[\d:.]+\])+');
  static final _wordTimingExp = RegExp(r'<(\d+),(\d+)>');
  static final _absWordTagExp = RegExp(
    r'<(\d{1,3}(?::\d{1,3}){0,2}(?:\.\d{1,3})?)>',
  );

  /// Parses a single combined lyric string read back from a local file's
  /// embedded tag (written by `LyricBuilder.build`). That text may carry
  /// absolute-timestamp word tags (`<mm:ss.xxx>`, distinct
  /// from the API's `<offsetMs,durationMs>` word format) and, when
  /// translation/roman tracks were embedded too, reuses the main lyric's
  /// timestamps for those extra blocks. Lines are grouped by timestamp: the
  /// first occurrence is the main lyric (with its word tags converted into
  /// karaoke word timings), the second/third become translation/roman.
  static KaraokeLyrics parseEmbedded(String raw) {
    final bodiesByMs = <int, List<String>>{};
    for (final line in const LineSplitter().convert(raw.replaceAll('\r', ''))) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      final field = _leadingTimeFieldExp.firstMatch(trimmed);
      if (field == null) continue;
      final body = trimmed.substring(field.end);
      if (body.replaceAll(_absWordTagExp, '').trim().isEmpty) continue;
      for (final time in _lineTimeExp.allMatches(field.group(0)!)) {
        final ms = _parseTimeMs(time.group(1)!);
        if (ms == null) continue;
        bodiesByMs.putIfAbsent(ms, () => []).add(body);
      }
    }
    final lines = <KaraokeLyricLine>[];
    final sortedMs = bodiesByMs.keys.toList()..sort();
    for (final ms in sortedMs) {
      final bodies = bodiesByMs[ms]!;
      final words = _parseAbsoluteWords(bodies.first);
      final text = bodies.first.replaceAll(_absWordTagExp, '').trim();
      if (text.isEmpty) continue;
      String? extraAt(int index) {
        if (index >= bodies.length) return null;
        final value = bodies[index].replaceAll(_absWordTagExp, '').trim();
        return value.isEmpty ? null : value;
      }

      lines.add(
        KaraokeLyricLine(
          startMs: ms,
          endMs: words.isEmpty
              ? ms + 4000
              : math.max(ms + 1, words.map((w) => w.endMs).reduce(math.max)),
          text: text,
          translation: extraAt(1),
          roman: extraAt(2),
          words: words,
        ),
      );
    }
    return KaraokeLyrics(_finalizeLineEnds(lines));
  }

  /// Absolute word tags carry absolute timestamps and bracket each word:
  /// `<start>word<end><start>word<end>…`, where a shared boundary collapses
  /// the `<end><start>` pair into one tag. Every text chunk between two
  /// adjacent tags is therefore one word.
  static List<KaraokeWordTiming> _parseAbsoluteWords(String body) {
    final tags = _absWordTagExp.allMatches(body).toList(growable: false);
    if (tags.length < 2) return const [];
    final words = <KaraokeWordTiming>[];
    for (var i = 0; i + 1 < tags.length; i++) {
      final text = body.substring(tags[i].end, tags[i + 1].start);
      if (text.isEmpty) continue;
      final start = _parseTimeMs(tags[i].group(1)!);
      final end = _parseTimeMs(tags[i + 1].group(1)!);
      if (start == null || end == null || end < start) continue;
      words.add(
        KaraokeWordTiming(
          text: text,
          startMs: start,
          endMs: math.max(start + 1, end),
        ),
      );
    }
    return words;
  }

  static KaraokeLyrics parse(LyricInfo info) {
    final translations = _parseTextByTime(info.tlyric);
    final romans = _parseTextByTime(info.rlyric);
    final wordLyric = info.lxlyric?.trim();
    var lines = wordLyric != null && wordLyric.isNotEmpty
        ? _parseWordLyric(wordLyric, translations, romans)
        : const <KaraokeLyricLine>[];
    if (lines.isEmpty) {
      // lxlyric present but unparseable (or absent) — the plain lyric is
      // still worth showing per-line rather than reporting "no lyrics".
      lines = _parsePlainLyric(info.lyric, translations, romans);
    }
    return KaraokeLyrics(_finalizeLineEnds(lines));
  }

  static List<KaraokeLyricLine> _parseWordLyric(
    String lrc,
    Map<int, String> translations,
    Map<int, String> romans,
  ) {
    final lines = <KaraokeLyricLine>[];
    for (final raw in const LineSplitter().convert(lrc.replaceAll('\r', ''))) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      final field = _leadingTimeFieldExp.firstMatch(line);
      if (field == null) continue;
      final time = _lineTimeExp.firstMatch(field.group(0)!);
      if (time == null) continue;
      final startMs = _parseTimeMs(time.group(1)!);
      if (startMs == null) continue;
      final body = line.substring(field.end).trim();
      if (body.isEmpty) continue;
      final words = _parseWords(body, startMs);
      final text = body.replaceAll(_wordTimingExp, '').trim();
      if (text.isEmpty) continue;
      final endMs = words.isEmpty
          ? startMs + 4000
          : math.max(startMs + 1, words.map((w) => w.endMs).reduce(math.max));
      lines.add(
        KaraokeLyricLine(
          startMs: startMs,
          endMs: endMs,
          text: text,
          translation: _nearestLine(translations, startMs),
          roman: _nearestLine(romans, startMs),
          words: words,
        ),
      );
    }
    lines.sort((a, b) => a.startMs.compareTo(b.startMs));
    return lines;
  }

  static List<KaraokeWordTiming> _parseWords(String body, int lineStartMs) {
    final matches = _wordTimingExp.allMatches(body).toList(growable: false);
    if (matches.isEmpty) return const [];
    final words = <KaraokeWordTiming>[];
    for (var i = 0; i < matches.length; i++) {
      final match = matches[i];
      final relStart = int.tryParse(match.group(1)!);
      final duration = int.tryParse(match.group(2)!);
      if (relStart == null || duration == null) continue;
      final textStart = match.end;
      final textEnd = i + 1 < matches.length
          ? matches[i + 1].start
          : body.length;
      final text = body.substring(textStart, textEnd);
      if (text.isEmpty) continue;
      final startMs = lineStartMs + relStart;
      words.add(
        KaraokeWordTiming(
          text: text,
          startMs: startMs,
          endMs: math.max(startMs + 1, startMs + duration),
        ),
      );
    }
    return words;
  }

  static List<KaraokeLyricLine> _parsePlainLyric(
    String lrc,
    Map<int, String> translations,
    Map<int, String> romans,
  ) {
    final lines = <KaraokeLyricLine>[];
    for (final raw in const LineSplitter().convert(lrc.replaceAll('\r', ''))) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      final field = _leadingTimeFieldExp.firstMatch(line);
      if (field == null) continue;
      final text = line.substring(field.end).trim();
      if (text.isEmpty) continue;
      for (final match in _lineTimeExp.allMatches(field.group(0)!)) {
        final startMs = _parseTimeMs(match.group(1)!);
        if (startMs == null) continue;
        lines.add(
          KaraokeLyricLine(
            startMs: startMs,
            endMs: startMs + 4000,
            text: text,
            translation: _nearestLine(translations, startMs),
            roman: _nearestLine(romans, startMs),
          ),
        );
      }
    }
    lines.sort((a, b) => a.startMs.compareTo(b.startMs));
    return lines;
  }

  static List<KaraokeLyricLine> _finalizeLineEnds(
    List<KaraokeLyricLine> lines,
  ) {
    if (lines.isEmpty) return const [];
    final out = <KaraokeLyricLine>[];
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final nextStart = i + 1 < lines.length ? lines[i + 1].startMs : null;
      final naturalEnd = nextStart == null
          ? math.max(line.endMs, line.startMs + 4000)
          : math.max(line.startMs + 1, nextStart);
      out.add(
        KaraokeLyricLine(
          startMs: line.startMs,
          endMs: naturalEnd,
          text: line.text,
          translation: line.translation,
          roman: line.roman,
          words: line.words,
        ),
      );
    }
    return out;
  }

  static Map<int, String> _parseTextByTime(String? lrc) {
    if (lrc == null || lrc.trim().isEmpty) return const {};
    final out = <int, String>{};
    for (final raw in const LineSplitter().convert(lrc.replaceAll('\r', ''))) {
      final line = raw.trim();
      final field = _leadingTimeFieldExp.firstMatch(line);
      if (field == null) continue;
      final text = line.substring(field.end).trim();
      if (text.isEmpty) continue;
      for (final match in _lineTimeExp.allMatches(field.group(0)!)) {
        final ms = _parseTimeMs(match.group(1)!);
        if (ms != null) out[ms] = text;
      }
    }
    return out;
  }

  static String? _nearestLine(Map<int, String> lines, int startMs) {
    if (lines.isEmpty) return null;
    final exact = lines[startMs];
    if (exact != null) return exact;
    int? bestKey;
    var bestDelta = 121;
    for (final key in lines.keys) {
      final delta = (key - startMs).abs();
      if (delta < bestDelta) {
        bestDelta = delta;
        bestKey = key;
      }
    }
    return bestKey == null ? null : lines[bestKey];
  }

  static int? _parseTimeMs(String label) {
    final parts = label.split(':');
    if (parts.isEmpty || parts.length > 3) return null;
    num seconds = 0;
    for (var i = 0; i < parts.length; i++) {
      final exp = parts.length - 1 - i;
      final value = double.tryParse(parts[i]);
      if (value == null) return null;
      seconds += value * _pow60[exp];
    }
    return (seconds * 1000).round();
  }

  static const _pow60 = [1, 60, 3600];
}
