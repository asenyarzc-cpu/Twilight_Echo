import 'dart:io';
import 'dart:typed_data';

import 'package:just_audio/just_audio.dart' show ProcessingState;

import '../../core/models/enums.dart';
import '../../core/models/lyric_info.dart';
import '../../core/models/music_info.dart';
import '../../core/services/tagger.dart';
import '../downloads/download_history_entry.dart';
import 'lyric_parser.dart';

const _unset = Object();

enum PlayerTrackKind { remote, localFile }

enum PlayerPlaybackMode {
  sequence('顺序播放'),
  shuffle('随机播放'),
  repeatOne('单曲循环');

  const PlayerPlaybackMode(this.label);

  final String label;
}

class PlayerTrack {
  const PlayerTrack({
    required this.id,
    required this.kind,
    required this.title,
    required this.artist,
    required this.album,
    required this.sourceLabel,
    required this.qualityLabel,
    this.availableQualityOptions = const [],
    this.coverUrl,
    this.coverBytes,
    this.remoteUrl,
    this.localPath,
  });

  final String id;
  final PlayerTrackKind kind;
  final String title;
  final String artist;
  final String album;
  final String sourceLabel;
  final String qualityLabel;
  final List<QualityOption> availableQualityOptions;
  final String? coverUrl;
  final Uint8List? coverBytes;
  final String? remoteUrl;
  final String? localPath;

  bool get isLocal => kind == PlayerTrackKind.localFile;

  List<Quality> get availableQualities => List<Quality>.unmodifiable(
    availableQualityOptions.map((option) => option.type),
  );

  factory PlayerTrack.fromMusic({
    required MusicInfo music,
    required Quality quality,
    required String url,
    required String? coverUrl,
    Iterable<Quality>? availableQualities,
  }) {
    final qualityOptions = _mergeQualityOptions(
      availableQualities ?? music.sortedQualities.map((item) => item.type),
      music.sortedQualities,
      selected: quality,
    );
    return PlayerTrack(
      id: '${music.source.code}:${music.id}:remote',
      kind: PlayerTrackKind.remote,
      title: music.name,
      artist: music.singer.trim().isEmpty ? '未知歌手' : music.singer.trim(),
      album: music.albumName,
      sourceLabel: music.source.label,
      qualityLabel: quality.code,
      availableQualityOptions: qualityOptions,
      coverUrl: coverUrl ?? music.meta.picUrl,
      remoteUrl: url,
    );
  }

  factory PlayerTrack.fromHistory(DownloadHistoryEntry entry) {
    return PlayerTrack(
      id: '${entry.id}:local',
      kind: PlayerTrackKind.localFile,
      title: entry.name,
      artist: entry.singer.trim().isEmpty ? '未知歌手' : entry.singer.trim(),
      album: entry.albumName,
      sourceLabel: entry.source.label,
      qualityLabel: entry.qualityCode,
      coverUrl: entry.picUrl,
      localPath: entry.savedPath,
    );
  }

  factory PlayerTrack.fromQueueEntry(
    DownloadHistoryEntry entry, {
    bool trustSavedPath = false,
  }) {
    final path = entry.savedPath?.trim();
    final music = entry.musicInfo;
    final hasLocalFile =
        path != null &&
        path.isNotEmpty &&
        (trustSavedPath || File(path).existsSync());
    if (!hasLocalFile && music != null) {
      return PlayerTrack(
        id: '${music.source.code}:${music.id}:remote',
        kind: PlayerTrackKind.remote,
        title: music.name,
        artist: music.singer.trim().isEmpty ? '未知歌手' : music.singer.trim(),
        album: music.albumName,
        sourceLabel: music.source.label,
        qualityLabel: entry.qualityCode,
        availableQualityOptions: _mergeQualityOptions(
          music.sortedQualities.map((item) => item.type),
          music.sortedQualities,
          selected: Quality.tryFromCode(entry.qualityCode),
        ),
        coverUrl: entry.picUrl ?? music.meta.picUrl,
      );
    }
    return PlayerTrack.fromHistory(entry);
  }

  /// A bare file from the download folder — no history entry to lean on, so
  /// title/artist come from the `artist - title.ext` naming convention and
  /// the quality label is just the extension.
  factory PlayerTrack.fromFile(String path) {
    final fileName = path.split(RegExp(r'[\\/]')).last;
    final dot = fileName.lastIndexOf('.');
    final base = dot > 0 ? fileName.substring(0, dot) : fileName;
    final ext = dot > 0 ? fileName.substring(dot + 1).toUpperCase() : '';
    final sep = base.indexOf(' - ');
    final artist = sep > 0 ? base.substring(0, sep).trim() : '';
    final title = sep > 0 ? base.substring(sep + 3).trim() : base.trim();
    return PlayerTrack(
      id: 'file:$path',
      kind: PlayerTrackKind.localFile,
      title: title.isEmpty ? fileName : title,
      artist: artist.isEmpty ? '未知歌手' : artist,
      album: '',
      sourceLabel: '本地',
      qualityLabel: ext,
      localPath: path,
    );
  }

  PlayerTrack withEmbeddedTags(EmbeddedAudioTags tags) {
    return PlayerTrack(
      id: id,
      kind: kind,
      title: _prefer(tags.title, title),
      artist: _prefer(tags.artist, artist),
      album: _prefer(tags.album, album),
      sourceLabel: sourceLabel,
      qualityLabel: qualityLabel,
      availableQualityOptions: availableQualityOptions,
      coverUrl: coverUrl,
      coverBytes: tags.artworkBytes ?? coverBytes,
      remoteUrl: remoteUrl,
      localPath: localPath,
    );
  }

  static String _prefer(String? value, String fallback) {
    final trimmed = value?.trim();
    return trimmed == null || trimmed.isEmpty ? fallback : trimmed;
  }

  static List<Quality> _rankQualities(
    Iterable<Quality> qualities, {
    Quality? selected,
  }) {
    final values = qualities.toSet();
    if (selected != null) values.add(selected);
    return List<Quality>.unmodifiable([
      for (final quality in kQualityRank)
        if (values.contains(quality)) quality,
    ]);
  }

  static List<QualityOption> _mergeQualityOptions(
    Iterable<Quality> qualities,
    Iterable<QualityOption> metadata, {
    Quality? selected,
  }) {
    final ranked = _rankQualities(qualities, selected: selected);
    final byCanonicalQuality = <Quality, Quality>{};
    for (final quality in ranked) {
      final canonicalQuality = _canonicalQuality(quality);
      if (!byCanonicalQuality.containsKey(canonicalQuality) ||
          quality == selected) {
        byCanonicalQuality[canonicalQuality] = quality;
      }
    }
    final visibleQualities = byCanonicalQuality.values.toList()
      ..sort(
        (a, b) => kQualityRank.indexOf(a).compareTo(kQualityRank.indexOf(b)),
      );
    final exact = <Quality, QualityOption>{};
    final canonical = <Quality, QualityOption>{};
    for (final option in metadata) {
      exact.putIfAbsent(option.type, () => option);
      canonical.putIfAbsent(_canonicalQuality(option.type), () => option);
    }

    return List<QualityOption>.unmodifiable([
      for (final quality in visibleQualities)
        _qualityOptionWithMetadata(
          quality,
          exact[quality] ?? canonical[_canonicalQuality(quality)],
        ),
    ]);
  }

  static QualityOption _qualityOptionWithMetadata(
    Quality quality,
    QualityOption? metadata,
  ) {
    return QualityOption(
      type: quality,
      size: metadata?.size,
      hash: metadata?.hash,
      mediaInfo: metadata?.mediaInfo,
    );
  }

  static Quality _canonicalQuality(Quality quality) =>
      quality == Quality.hires ? Quality.flac24bit : quality;
}

class PlayerState {
  const PlayerState({
    this.track,
    this.lyricInfo,
    this.lyrics = const KaraokeLyrics([]),
    this.loading = false,
    this.lyricLoading = false,
    this.playing = false,
    this.position = Duration.zero,
    this.duration = Duration.zero,
    this.processingState = ProcessingState.idle,
    this.canPlayPrevious = false,
    this.canPlayNext = false,
    this.queue = const [],
    this.queueIndex = -1,
    this.playbackMode = PlayerPlaybackMode.sequence,
    this.error,
  });

  final PlayerTrack? track;
  final LyricInfo? lyricInfo;
  final KaraokeLyrics lyrics;
  final bool loading;
  final bool lyricLoading;
  final bool playing;
  final Duration position;
  final Duration duration;
  final ProcessingState processingState;
  final bool canPlayPrevious;
  final bool canPlayNext;
  final List<DownloadHistoryEntry> queue;
  final int queueIndex;
  final PlayerPlaybackMode playbackMode;
  final String? error;

  bool get hasTrack => track != null;
  bool get buffering =>
      processingState == ProcessingState.loading ||
      processingState == ProcessingState.buffering;

  PlayerState copyWith({
    Object? track = _unset,
    Object? lyricInfo = _unset,
    KaraokeLyrics? lyrics,
    bool? loading,
    bool? lyricLoading,
    bool? playing,
    Duration? position,
    Duration? duration,
    ProcessingState? processingState,
    bool? canPlayPrevious,
    bool? canPlayNext,
    List<DownloadHistoryEntry>? queue,
    int? queueIndex,
    PlayerPlaybackMode? playbackMode,
    Object? error = _unset,
  }) {
    return PlayerState(
      track: identical(track, _unset) ? this.track : track as PlayerTrack?,
      lyricInfo: identical(lyricInfo, _unset)
          ? this.lyricInfo
          : lyricInfo as LyricInfo?,
      lyrics: lyrics ?? this.lyrics,
      loading: loading ?? this.loading,
      lyricLoading: lyricLoading ?? this.lyricLoading,
      playing: playing ?? this.playing,
      position: position ?? this.position,
      duration: duration ?? this.duration,
      processingState: processingState ?? this.processingState,
      canPlayPrevious: canPlayPrevious ?? this.canPlayPrevious,
      canPlayNext: canPlayNext ?? this.canPlayNext,
      queue: queue ?? this.queue,
      queueIndex: queueIndex ?? this.queueIndex,
      playbackMode: playbackMode ?? this.playbackMode,
      error: identical(error, _unset) ? this.error : error as String?,
    );
  }

  PlayerState beginTrackLoading({
    required PlayerTrack? nextTrack,
    required bool canPlayPrevious,
    required bool canPlayNext,
    List<DownloadHistoryEntry>? queue,
    int? queueIndex,
  }) {
    return copyWith(
      track: nextTrack,
      lyricInfo: null,
      lyrics: const KaraokeLyrics([]),
      loading: true,
      lyricLoading: true,
      playing: false,
      position: Duration.zero,
      duration: Duration.zero,
      processingState: ProcessingState.loading,
      canPlayPrevious: canPlayPrevious,
      canPlayNext: canPlayNext,
      queue: queue,
      queueIndex: queueIndex,
      error: null,
    );
  }

  PlayerState withLoadedLyrics({
    required LyricInfo info,
    required KaraokeLyrics parsed,
  }) {
    return copyWith(lyricInfo: info, lyrics: parsed, lyricLoading: false);
  }
}
