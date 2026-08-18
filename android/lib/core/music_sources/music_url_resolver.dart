import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/enums.dart';
import '../models/music_info.dart';
import '../models/music_url.dart';
import '../services/app_logger.dart';
import 'music_source_controller.dart';
import 'music_source_models.dart';
import 'music_source_runtime.dart';
import 'music_source_store.dart';

typedef MusicSourceUrlConsumer<T> =
    Future<T> Function(MusicSourceRecord source, MusicUrl url);

abstract interface class MusicUrlResolver {
  Future<MusicUrl> resolve({
    required MusicInfo music,
    required Quality quality,
  });

  Future<Quality> highestQualityFor(MusicInfo music);

  Future<MusicSourceFallbackResult<T>> useFirstAvailable<T>({
    required MusicInfo music,
    required Quality quality,
    required MusicSourceUrlConsumer<T> use,
    Set<String> excludedSourceIds = const <String>{},
    bool Function()? isCancelled,
    bool Function(Object error)? shouldFallbackOnConsumerError,
  });
}

class LocalMusicUrlResolver implements MusicUrlResolver {
  const LocalMusicUrlResolver(this._ref);

  final Ref _ref;

  @override
  Future<MusicUrl> resolve({
    required MusicInfo music,
    required Quality quality,
  }) async {
    final result = await useFirstAvailable<MusicUrl>(
      music: music,
      quality: quality,
      use: (_, url) async => url,
    );
    return result.value;
  }

  @override
  Future<Quality> highestQualityFor(MusicInfo music) async {
    final sourceState = await _ref.read(musicSourceControllerProvider.future);
    final enabled = sourceState.enabledRecords;
    if (enabled.isEmpty) {
      throw const MusicSourceRuntimeException('请先在设置中导入并启用音源');
    }
    final candidates = sourceState.enabledFor(music.source);
    if (candidates.isEmpty) {
      throw MusicSourceRuntimeException('已启用的音源均不支持${music.source.label}');
    }
    return highestMusicSourceQuality(
      sourceQualities: candidates.expand(
        (source) => source.qualitiesFor(music.source),
      ),
      trackQualities: music.sortedQualities.map((item) => item.type),
    );
  }

  @override
  Future<MusicSourceFallbackResult<T>> useFirstAvailable<T>({
    required MusicInfo music,
    required Quality quality,
    required MusicSourceUrlConsumer<T> use,
    Set<String> excludedSourceIds = const <String>{},
    bool Function()? isCancelled,
    bool Function(Object error)? shouldFallbackOnConsumerError,
  }) async {
    final sourceState = await _ref.read(musicSourceControllerProvider.future);
    if (sourceState.enabledRecords.isEmpty) {
      throw const MusicSourceRuntimeException('请先在设置中导入并启用音源');
    }
    final supported = sourceState.enabledFor(music.source);
    if (supported.isEmpty) {
      throw MusicSourceRuntimeException('已启用的音源均不支持${music.source.label}');
    }
    final sources = [
      for (final source in supported)
        if (!excludedSourceIds.contains(source.id)) source,
    ];
    if (sources.isEmpty) {
      throw const MusicSourceFallbackException([]);
    }

    final failures = <MusicSourceAttemptFailure>[];
    final attemptedSourceIds = <String>[];
    final qualityCandidates = musicSourceQualityFallbacks(
      requested: quality,
      sourceQualities: sources.expand(
        (source) => source.qualitiesFor(music.source),
      ),
    );
    final scripts = <String, String>{};
    for (final resolvedQuality in qualityCandidates) {
      for (final source in sources) {
        final sourceQualities = source.qualitiesFor(music.source);
        final supportsQuality = sourceQualities.isEmpty
            ? resolvedQuality == quality
            : sourceQualities.contains(resolvedQuality);
        if (!supportsQuality) continue;
        if (isCancelled?.call() ?? false) {
          throw const MusicSourceFallbackCancelledException();
        }
        attemptedSourceIds.add(source.id);
        var consumerStarted = false;
        try {
          var script = scripts[source.id];
          if (script == null) {
            script = await _ref
                .read(musicSourceStoreProvider)
                .readScript(source.id);
            scripts[source.id] = script;
          }
          final url = await _ref
              .read(musicSourceRuntimeProvider)
              .resolveWithSource(
                record: source,
                script: script,
                music: music,
                quality: resolvedQuality,
              );
          if (isCancelled?.call() ?? false) {
            throw const MusicSourceFallbackCancelledException();
          }
          consumerStarted = true;
          final value = await use(source, url);
          if (isCancelled?.call() ?? false) {
            throw const MusicSourceFallbackCancelledException();
          }
          return MusicSourceFallbackResult(
            source: source,
            value: value,
            attemptedSourceIds: List.unmodifiable(attemptedSourceIds),
          );
        } on MusicSourceFallbackCancelledException {
          rethrow;
        } catch (error, stackTrace) {
          if (consumerStarted &&
              shouldFallbackOnConsumerError != null &&
              !shouldFallbackOnConsumerError(error)) {
            rethrow;
          }
          failures.add(
            MusicSourceAttemptFailure(
              source: source,
              quality: resolvedQuality,
              error: error,
            ),
          );
          await AppLogger.write(
            'music-source',
            'fallback failed source=${source.name} '
                'quality=${resolvedQuality.code} song=${music.name}: $error\n'
                '$stackTrace',
          );
          if (isCancelled?.call() ?? false) {
            throw const MusicSourceFallbackCancelledException();
          }
        }
      }
    }
    throw MusicSourceFallbackException(failures);
  }
}

class MusicSourceFallbackResult<T> {
  const MusicSourceFallbackResult({
    required this.source,
    required this.value,
    this.attemptedSourceIds = const [],
  });

  final MusicSourceRecord source;
  final T value;
  final List<String> attemptedSourceIds;
}

class MusicSourceAttemptFailure {
  const MusicSourceAttemptFailure({
    required this.source,
    required this.error,
    this.quality,
  });

  final MusicSourceRecord source;
  final Object error;
  final Quality? quality;
}

class MusicSourceFallbackException implements Exception {
  const MusicSourceFallbackException(this.failures);

  final List<MusicSourceAttemptFailure> failures;

  @override
  String toString() {
    if (failures.isEmpty) return '所有已启用音源均无法播放这首歌';
    final last = failures.last;
    final quality = last.quality;
    final suffix = quality == null ? '' : ' ${quality.code}';
    return '所有已启用音源均无法播放这首歌（已尝试 ${failures.length} 次）：'
        '${last.source.name}$suffix：${last.error}';
  }
}

class MusicSourceFallbackCancelledException implements Exception {
  const MusicSourceFallbackCancelledException();
}

Quality chooseMusicSourceQuality({
  required Quality requested,
  required Iterable<Quality> sourceQualities,
  required Iterable<Quality> trackQualities,
}) {
  final rankedSupported = rankMusicSourceQualities(sourceQualities);
  if (rankedSupported.isEmpty) return requested;
  final supported = rankedSupported.toSet();

  // The active source is the authority for requests it explicitly supports.
  // Search metadata is often incomplete and must not silently downgrade one.
  if (supported.contains(requested)) return requested;

  final available = trackQualities.toSet();
  final candidates = [
    for (final quality in rankedSupported)
      if (available.isEmpty || available.contains(quality)) quality,
  ];
  if (candidates.isEmpty) {
    throw const MusicSourceRuntimeException('歌曲与音源没有可用的共同音质');
  }
  final requestedRank = kQualityRank.indexOf(requested);
  for (final quality in candidates) {
    if (kQualityRank.indexOf(quality) >= requestedRank) return quality;
  }
  return candidates.first;
}

List<Quality> musicSourceQualityFallbacks({
  required Quality requested,
  required Iterable<Quality> sourceQualities,
}) {
  final supported = sourceQualities.toSet();
  final requestedRank = kQualityRank.indexOf(requested);
  return List<Quality>.unmodifiable([
    requested,
    for (var index = requestedRank + 1; index < kQualityRank.length; index++)
      if (supported.contains(kQualityRank[index])) kQualityRank[index],
  ]);
}

Quality highestMusicSourceQuality({
  required Iterable<Quality> sourceQualities,
  required Iterable<Quality> trackQualities,
}) {
  final rankedSource = rankMusicSourceQualities(sourceQualities);
  if (rankedSource.isNotEmpty) return rankedSource.first;

  final rankedTrack = rankMusicSourceQualities(trackQualities);
  return rankedTrack.isEmpty ? Quality.k128 : rankedTrack.first;
}

List<Quality> rankMusicSourceQualities(Iterable<Quality> qualities) {
  final values = qualities.toSet();
  return [
    for (final quality in kQualityRank)
      if (values.contains(quality)) quality,
  ];
}

final musicUrlResolverProvider = Provider<MusicUrlResolver>(
  LocalMusicUrlResolver.new,
);
