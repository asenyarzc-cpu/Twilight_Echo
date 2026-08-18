enum MusicSource {
  all('all', '全部'),
  kw('kw', '酷我'),
  kg('kg', '酷狗'),
  tx('tx', 'QQ'),
  wy('wy', '网易云'),
  mg('mg', '咪咕');

  const MusicSource(this.code, this.label);
  final String code;
  final String label;

  static MusicSource fromCode(String code) =>
      MusicSource.values.firstWhere((s) => s.code == code, orElse: () => all);

  static MusicSource? tryFromCode(String code) {
    for (final source in MusicSource.values) {
      if (source.code == code) return source;
    }
    return null;
  }
}

const List<MusicSource> kSearchSources = MusicSource.values;
const List<MusicSource> kManageableSearchSources = [
  MusicSource.kw,
  MusicSource.kg,
  MusicSource.tx,
  MusicSource.wy,
  MusicSource.mg,
];
const Set<MusicSource> kDefaultEnabledSearchSources = {
  MusicSource.kw,
  MusicSource.kg,
  MusicSource.tx,
  MusicSource.wy,
};

enum Quality {
  master('master'),
  atmosPlus('atmos_plus'),
  atmos('atmos'),
  hires('hires'),
  flac24bit('flac24bit'),
  flac('flac'),
  wav('wav'),
  ape('ape'),
  k320('320k'),
  k192('192k'),
  k128('128k');

  const Quality(this.code);
  final String code;

  static Quality fromCode(String code) =>
      Quality.values.firstWhere((q) => q.code == code, orElse: () => k128);

  // Like fromCode but returns null for unrecognized codes instead of defaulting
  // to 128k. Used when parsing server-provided quality lists, where an unknown
  // code must be dropped rather than silently turned into 128k.
  static Quality? tryFromCode(String code) {
    for (final q in Quality.values) {
      if (q.code == code) return q;
    }
    return null;
  }

  String get extension {
    switch (this) {
      case flac:
      case flac24bit:
      case hires:
      case master:
      case atmos:
      case atmosPlus:
        return 'flac';
      case wav:
        return 'wav';
      case ape:
        return 'ape';
      case k320:
      case k192:
      case k128:
        return 'mp3';
    }
  }

  bool get isLossless {
    switch (this) {
      case flac:
      case flac24bit:
      case hires:
      case master:
      case atmos:
      case atmosPlus:
      case wav:
      case ape:
        return true;
      case k320:
      case k192:
      case k128:
        return false;
    }
  }
}

// Server sort order (best first): master > atmos_plus > atmos > hires
//   > flac24bit > flac > 320k > 192k > 128k.
const List<Quality> kQualityRank = [
  Quality.master,
  Quality.atmosPlus,
  Quality.atmos,
  Quality.hires,
  Quality.flac24bit,
  Quality.flac,
  Quality.wav,
  Quality.ape,
  Quality.k320,
  Quality.k192,
  Quality.k128,
];

enum OnlinePlaybackQuality {
  highest('highest', '最高可用', '自动选择歌曲提供的最高音质', null),
  hires('hires', 'Hi-Res', '优先 Hi-Res，不可用时向下兼容', Quality.hires),
  lossless('flac', '无损 FLAC', '优先无损，不可用时向下兼容', Quality.flac),
  high('320k', '高品质 320K', '优先 320K，不可用时向下兼容', Quality.k320),
  standard('128k', '标准 128K', '节省流量，优先使用 128K', Quality.k128);

  const OnlinePlaybackQuality(
    this.code,
    this.label,
    this.description,
    this.preferredQuality,
  );

  final String code;
  final String label;
  final String description;
  final Quality? preferredQuality;

  static OnlinePlaybackQuality fromCode(String? code) {
    for (final preference in values) {
      if (preference.code == code) return preference;
    }
    return highest;
  }
}
