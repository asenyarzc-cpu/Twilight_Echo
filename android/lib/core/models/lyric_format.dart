enum EmbeddedLyricFormat {
  automatic(code: 'auto', label: '自动', description: 'QQ/酷狗/酷我逐字'),
  lrc(code: 'lrc', label: '逐句 LRC', description: '全部音源逐句'),
  wordTimed(code: 'word_timed', label: '增强型 LRC', description: '逐字歌词');

  const EmbeddedLyricFormat({
    required this.code,
    required this.label,
    required this.description,
  });

  final String code;
  final String label;
  final String description;

  static EmbeddedLyricFormat fromCode(String? code) {
    if (code == 'qrc') return EmbeddedLyricFormat.automatic;
    for (final format in values) {
      if (format.code == code) return format;
    }
    return EmbeddedLyricFormat.automatic;
  }
}
