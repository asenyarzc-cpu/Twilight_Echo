import 'package:html_unescape/html_unescape_small.dart';

final _unescape = HtmlUnescape();

String decodeName(Object? value) {
  if (value == null) return '';
  return _unescape.convert(value.toString());
}

String formatPlayTime(num seconds) {
  if (!seconds.isFinite) return '';
  final s = seconds.truncate();
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final sec = s % 60;
  final mm = m.toString().padLeft(2, '0');
  final ss = sec.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
}

String? sizeFormat(Object? size) {
  final value = num.tryParse(size?.toString() ?? '');
  if (value == null || !value.isFinite || value <= 0) return null;
  if (value > 1024 * 1024 * 1024) {
    return '${(value / (1024 * 1024 * 1024)).toStringAsFixed(2)}G';
  }
  if (value > 1024 * 1024) {
    return '${(value / (1024 * 1024)).toStringAsFixed(2)}M';
  }
  if (value > 1024) return '${(value / 1024).toStringAsFixed(2)}K';
  return '${value.toInt()}B';
}

String formatSingerName(
  Object? singers, {
  String nameKey = 'name',
  String join = '、',
}) {
  if (singers is List) {
    final parts = singers
        .map((item) {
          if (item is Map) return item[nameKey];
          return null;
        })
        .where((v) => v != null && v.toString().isNotEmpty)
        .map((v) => v.toString())
        .toList();
    return decodeName(parts.join(join));
  }
  return decodeName(singers);
}

double similar(String a, String b) {
  final aClean = a.toLowerCase().replaceAll(RegExp(r'\s+'), '');
  final bClean = b.toLowerCase().replaceAll(RegExp(r'\s+'), '');
  if (aClean.isEmpty || bClean.isEmpty) return 0;
  if (aClean == bClean) return 1;
  final aSet = aClean.split('').toSet();
  final bSet = bClean.split('').toSet();
  var hit = 0;
  for (final ch in aSet) {
    if (bSet.contains(ch)) hit++;
  }
  return hit / [aSet.length, bSet.length].reduce((a, b) => a > b ? a : b);
}
