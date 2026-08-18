class LyricInfo {
  const LyricInfo({
    required this.lyric,
    this.tlyric,
    this.rlyric,
    this.lxlyric,
  });

  final String lyric;
  final String? tlyric;
  final String? rlyric;
  final String? lxlyric;

  factory LyricInfo.fromJson(Map<String, dynamic> json) => LyricInfo(
    lyric: (json['lyric'] as String?) ?? '',
    tlyric: _emptyToNull(json['tlyric'] as String?),
    rlyric: _emptyToNull(json['rlyric'] as String?),
    lxlyric: _emptyToNull(json['lxlyric'] as String?),
  );

  bool get isEmpty => lyric.isEmpty;
}

String? _emptyToNull(String? value) {
  if (value == null) return null;
  if (value.isEmpty) return null;
  return value;
}
