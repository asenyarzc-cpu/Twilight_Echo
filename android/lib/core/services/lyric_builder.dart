import 'dart:convert' show LineSplitter;

import '../models/enums.dart';
import '../models/lyric_format.dart';
import '../models/lyric_info.dart';

class LyricEmbedOptions {
  const LyricEmbedOptions({
    this.embedLyric = true,
    this.embedTranslatedLyric = true,
    this.embedRomanLyric = true,
    this.format = EmbeddedLyricFormat.automatic,
    this.source,
  });

  final bool embedLyric;
  final bool embedTranslatedLyric;
  final bool embedRomanLyric;
  final EmbeddedLyricFormat format;
  final MusicSource? source;

  bool get anyLyricBlock =>
      embedLyric || embedTranslatedLyric || embedRomanLyric;
}

class LyricBuilder {
  const LyricBuilder._();

  static const richestOptions = LyricEmbedOptions(
    embedLyric: true,
    embedTranslatedLyric: true,
    embedRomanLyric: true,
  );

  // One-or-more leading `[time]` segments — e.g. `[00:01.00]` or
  // `[00:01.00][00:30.50]`.
  static final _timeFieldExp = RegExp(r'^(?:\[[\d:.]+\])+');
  // A single time token inside a bracket: `mm:ss.xx`, `h:mm:ss.xx`.
  static final _timeExp = RegExp(r'\d{1,3}(?::\d{1,3}){0,2}(?:\.\d{1,3})');

  // Mirrors renderer/worker/download/lrcTool.ts in the desktop source format.
  static String build(LyricInfo info, LyricEmbedOptions options) {
    if (info.lyric.isEmpty || !options.anyLyricBlock) return '';

    final plainLyric = _fixKgLyric(info.lyric);
    final wordLyric = _fixKgLyric(info.lxlyric ?? '');
    final mainLyric = _buildMainLyric(
      plainLyric: plainLyric,
      wordLyric: wordLyric,
      format: options.format,
      source: options.source,
    );
    final alignmentLyric = plainLyric.isNotEmpty ? plainLyric : mainLyric;

    final hasT =
        options.embedTranslatedLyric && (info.tlyric?.isNotEmpty ?? false);
    final hasR = options.embedRomanLyric && (info.rlyric?.isNotEmpty ?? false);

    if (!hasT && !hasR) {
      return options.embedLyric ? mainLyric : '';
    }

    final labels = _parseLrcTimeLabels(alignmentLyric);
    var out = mainLyric.trimRight();

    if (hasT) {
      final filtered = _filterExtended(info.tlyric!, labels);
      if (filtered.isNotEmpty) out = '${out.trimRight()}\n\n$filtered';
    }
    if (hasR) {
      final filtered = _filterExtended(info.rlyric!, labels);
      if (filtered.isNotEmpty) out = '${out.trimRight()}\n\n$filtered';
    }
    return out;
  }

  static String _buildMainLyric({
    required String plainLyric,
    required String wordLyric,
    required EmbeddedLyricFormat format,
    required MusicSource? source,
  }) {
    switch (format) {
      case EmbeddedLyricFormat.automatic:
        if (!_sourcePrefersWordLyric(source) || wordLyric.isEmpty) {
          return plainLyric;
        }
        final enhanced = _toWordTimedLyric(wordLyric);
        return enhanced.isNotEmpty ? enhanced : plainLyric;
      case EmbeddedLyricFormat.lrc:
        return plainLyric;
      case EmbeddedLyricFormat.wordTimed:
        if (wordLyric.isEmpty) return plainLyric;
        final enhanced = _toWordTimedLyric(wordLyric);
        return enhanced.isNotEmpty ? enhanced : plainLyric;
    }
  }

  static bool _sourcePrefersWordLyric(MusicSource? source) {
    switch (source) {
      case MusicSource.tx:
      case MusicSource.kg:
      case MusicSource.kw:
        return true;
      case MusicSource.all:
      case MusicSource.wy:
      case MusicSource.mg:
      case null:
        return false;
    }
  }

  // Strip leading zeros in each numeric component so `[00:01.000]` and
  // `[0:1.00]` normalize to the same key. Without this, ms-precision drift
  // between sources made every translation line miss the lookup and get
  // dropped.
  static String _formatTimeLabel(String label) {
    var s = label.replaceFirstMapped(RegExp(r'^0+(\d+)'), (m) => m.group(1)!);
    s = s.replaceAllMapped(RegExp(r':0+(\d+)'), (m) => ':${m.group(1)!}');
    s = s.replaceFirstMapped(RegExp(r'\.0+(\d+)'), (m) => '.${m.group(1)!}');
    return s;
  }

  static Set<String> _parseLrcTimeLabels(String lrc) {
    final labels = <String>{};
    for (final raw in const LineSplitter().convert(lrc)) {
      final line = raw.trim();
      final field = _timeFieldExp.firstMatch(line);
      if (field == null) continue;
      final timeField = field.group(0)!;
      final text = line.substring(timeField.length).trim();
      if (text.isEmpty) continue;
      for (final t in _timeExp.allMatches(timeField)) {
        labels.add(_formatTimeLabel(t.group(0)!));
      }
    }
    return labels;
  }

  static String _filterExtended(String extended, Set<String> labels) {
    if (labels.isEmpty) return extended.trim();
    final lines = <String>[];
    for (final raw in const LineSplitter().convert(extended)) {
      var line = raw.trim();
      final field = _timeFieldExp.firstMatch(line);
      if (field == null) continue;
      final timeField = field.group(0)!;
      final text = line.substring(timeField.length).trim();
      if (text.isEmpty) continue;
      final times = _timeExp
          .allMatches(timeField)
          .map((m) => m.group(0)!)
          .toList(growable: false);
      if (times.isEmpty) continue;
      final kept = times
          .where((t) => labels.contains(_formatTimeLabel(t)))
          .toList(growable: false);
      if (kept.isEmpty) continue;
      if (kept.length != times.length) {
        line = '[${kept.join('][')}]$text';
      }
      lines.add(line);
    }
    return lines.join('\n');
  }

  // Some kg lyrics arrive as `[00:01:02.345]` (4-component) where the leading
  // `00:` is a spurious hour field that breaks timestamp alignment with the
  // translation/roma tracks.
  static String _fixKgLyric(String lrc) {
    final probe = RegExp(r'\[00:\d\d:\d\d\.\d+\]');
    if (!probe.hasMatch(lrc)) return lrc;
    return lrc.replaceAllMapped(
      RegExp(r'\[00:(\d\d:\d\d\.\d+\])', multiLine: true),
      (m) => '[${m.group(1)!}',
    );
  }

  static final _singleLineTimeExp = RegExp(r'^\[([\d:.]+)\]');
  static final _wordTimingExp = RegExp(r'<(\d+),(\d+)>');

  static String _toWordTimedLyric(String lrc) {
    final lines = <String>[];
    for (final raw in const LineSplitter().convert(lrc)) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      final match = _singleLineTimeExp.firstMatch(line);
      if (match == null) {
        lines.add(line);
        continue;
      }

      final lineStart = _parseTimeMs(match.group(1)!);
      if (lineStart == null) {
        lines.add(line);
        continue;
      }

      final body = line.substring(match.end);
      final words = _wordTimingExp.allMatches(body).toList(growable: false);
      if (words.isEmpty) {
        lines.add(line);
        continue;
      }

      final buffer = StringBuffer()..write('[${_formatTimeMs(lineStart)}]');
      int? lastEnd;
      for (var i = 0; i < words.length; i++) {
        final word = words[i];
        final relStart = int.tryParse(word.group(1)!);
        final duration = int.tryParse(word.group(2)!);
        if (relStart == null || duration == null) continue;
        final textStart = word.end;
        final textEnd = i + 1 < words.length ? words[i + 1].start : body.length;
        final text = body.substring(textStart, textEnd);
        final absoluteStart = lineStart + relStart;
        final absoluteEnd = absoluteStart + duration;
        if (lastEnd == null || absoluteStart != lastEnd) {
          buffer.write('<${_formatTimeMs(absoluteStart)}>');
        }
        buffer.write(text);
        buffer.write('<${_formatTimeMs(absoluteEnd)}>');
        lastEnd = absoluteEnd;
      }
      lines.add(buffer.toString());
    }
    return lines.join('\n');
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

  static String _formatTimeMs(int timeMs) {
    final safe = timeMs < 0 ? 0 : timeMs;
    final ms = (safe % 1000).toString().padLeft(3, '0');
    final totalSeconds = safe ~/ 1000;
    final minutes = (totalSeconds ~/ 60).toString().padLeft(2, '0');
    final seconds = (totalSeconds % 60).toString().padLeft(2, '0');
    return '$minutes:$seconds.$ms';
  }

  static const _pow60 = [1, 60, 3600];
}
