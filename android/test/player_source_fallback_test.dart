import 'dart:async';
import 'dart:io';

import 'package:audio_service/audio_service.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:just_audio/just_audio.dart' as audio;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/api/music_api.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/lyric_info.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/music_url.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_source_runtime.dart';
import 'package:twilight_echo/core/music_sources/music_url_resolver.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/player/player_audio_handler.dart';
import 'package:twilight_echo/features/player/player_controller.dart';
import 'package:twilight_echo/features/downloads/download_history_entry.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('player track keeps source quality sizes and canonical Hi-Res data', () {
    final music = MusicInfo(
      id: 'sized-song',
      name: 'Sized Song',
      singer: 'Singer',
      source: MusicSource.kw,
      interval: '03:00',
      meta: const MusicMeta(
        songId: 'sized-song',
        albumName: 'Album',
        qualitys: [
          QualityOption(type: Quality.flac24bit, size: '48.20 MB'),
          QualityOption(type: Quality.flac, size: '24.10 MB'),
        ],
        raw: {},
      ),
      raw: const {},
    );

    final track = PlayerTrack.fromMusic(
      music: music,
      quality: Quality.hires,
      url: 'https://audio.test/sized-song.flac',
      coverUrl: null,
      availableQualities: const [
        Quality.hires,
        Quality.flac24bit,
        Quality.flac,
        Quality.k320,
      ],
    );

    expect(track.availableQualities, [
      Quality.hires,
      Quality.flac,
      Quality.k320,
    ]);
    expect(track.availableQualityOptions[0].type, Quality.hires);
    expect(track.availableQualityOptions[0].size, '48.20 MB');
    expect(track.availableQualityOptions[1].size, '24.10 MB');
    expect(track.availableQualityOptions[2].size, isNull);
  });

  test(
    'audio load failure falls back without publishing an error state',
    () async {
      final harness = await _Harness.create(loadFailures: 1);
      addTearDown(harness.dispose);
      final errors = <String>[];
      final subscription = harness.container.listen<PlayerState>(
        playerControllerProvider,
        (_, next) {
          if (next.error != null) errors.add(next.error!);
        },
      );
      addTearDown(subscription.close);

      await harness.controller.playFromMusic(_music());
      final state = harness.container.read(playerControllerProvider);

      expect(harness.audio.loadedUris, [
        Uri.parse('https://audio.test/first.mp3'),
        Uri.parse('https://audio.test/second.mp3'),
      ]);
      expect(harness.resolver.attemptedIds, ['first', 'second']);
      expect(state.loading, isFalse);
      expect(state.error, isNull);
      expect(state.track?.remoteUrl, 'https://audio.test/second.mp3');
      expect(harness.audio.failTransitionCount, 0);
      expect(errors, isEmpty);
    },
  );

  test('NetEase system media artwork carries the required headers', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);

    await harness.controller.playFromMusic(_neteaseMusic());

    final item = harness.audio.currentMediaItem;
    expect(
      item?.artUri.toString(),
      'https://p1.music.126.net/test/cover.jpg?param=500y500',
    );
    expect(item?.artHeaders, containsPair('Referer', 'https://music.163.com/'));
    expect(item?.artHeaders, contains('User-Agent'));
  });

  test('all source load failures publish only the final error state', () async {
    final harness = await _Harness.create(loadFailures: 2);
    addTearDown(harness.dispose);
    final errors = <String>[];
    final subscription = harness.container.listen<PlayerState>(
      playerControllerProvider,
      (_, next) {
        if (next.error != null) errors.add(next.error!);
      },
    );
    addTearDown(subscription.close);

    await harness.controller.playFromMusic(_music());
    final state = harness.container.read(playerControllerProvider);

    expect(harness.audio.loadedUris, hasLength(2));
    expect(state.loading, isFalse);
    expect(state.track, isNull);
    expect(state.error, contains('所有已启用音源均无法播放'));
    expect(harness.audio.failTransitionCount, 1);
    expect(errors, hasLength(1));
  });

  test('a playback error retries only sources not already attempted', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);

    await harness.controller.playFromMusic(_music());
    expect(
      harness.container.read(playerControllerProvider).track?.remoteUrl,
      'https://audio.test/first.mp3',
    );

    harness.audio.emitError(audio.PlayerException(1, 'stream failed', 0));
    await _waitUntil(() => harness.audio.loadedUris.length == 2);
    final state = harness.container.read(playerControllerProvider);

    expect(harness.audio.loadedUris, [
      Uri.parse('https://audio.test/first.mp3'),
      Uri.parse('https://audio.test/second.mp3'),
    ]);
    expect(state.error, isNull);
    expect(state.track?.remoteUrl, 'https://audio.test/second.mp3');
  });

  test('quality switch keeps position, lyrics, and paused state', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);

    await harness.controller.playFromMusic(_music());
    await _waitUntil(
      () => harness.container.read(playerControllerProvider).lyricInfo != null,
    );
    await harness.controller.seek(const Duration(seconds: 42));
    final before = harness.container.read(playerControllerProvider);
    final lyricsBefore = before.lyrics;
    final lyricLoadsBefore = harness.api.lyricLoadCount;

    expect(before.playing, isFalse);
    expect(before.track?.availableQualities, contains(Quality.k320));
    expect(await harness.controller.switchQuality(Quality.k320), isTrue);

    final after = harness.container.read(playerControllerProvider);
    expect(after.track?.qualityLabel, Quality.k320.code);
    expect(after.position, const Duration(seconds: 42));
    expect(identical(after.lyrics, lyricsBefore), isTrue);
    expect(after.playing, isFalse);
    expect(harness.api.lyricLoadCount, lyricLoadsBefore);
    expect(harness.resolver.requestedQualities, [Quality.k128, Quality.k320]);
  });

  test('failed quality switch keeps the previous quality retryable', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);

    await harness.controller.playFromMusic(_music());
    harness.resolver.failingQualities.add(Quality.k320);

    expect(await harness.controller.switchQuality(Quality.k320), isFalse);
    expect(
      harness.container.read(playerControllerProvider).track?.qualityLabel,
      Quality.k128.code,
    );

    expect(await harness.controller.switchQuality(Quality.k320), isFalse);
    expect(harness.resolver.requestedQualities, [
      Quality.k128,
      Quality.k320,
      Quality.k320,
    ]);
  });

  test('enqueue next stays next when shuffle mode is active', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);
    final directory = await Directory.systemTemp.createTemp(
      'twilight_echo-player-shuffle-next-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final entries = <DownloadHistoryEntry>[];
    for (final id in ['current', 'other-a', 'other-b', 'forced-next']) {
      final file = File('${directory.path}${Platform.pathSeparator}$id.mp3');
      await file.writeAsBytes(const [0]);
      entries.add(_localEntry(id, file.path));
    }

    await harness.controller.playFromHistoryQueue(entries.first, entries);
    harness.controller.setPlaybackMode(PlayerPlaybackMode.shuffle);
    await harness.controller.enqueueNext(entries.last);
    await harness.controller.playNext();

    final state = harness.container.read(playerControllerProvider);
    expect(state.track?.localPath, entries.last.savedPath);
    expect(state.queue[state.queueIndex].id, 'forced-next');
  });

  test(
    'shuffle next enters an enqueued queue after standalone playback',
    () async {
      final harness = await _Harness.create(loadFailures: 0);
      addTearDown(harness.dispose);
      final directory = await Directory.systemTemp.createTemp(
        'twilight_echo-player-standalone-next-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File(
        '${directory.path}${Platform.pathSeparator}forced-next.mp3',
      );
      await file.writeAsBytes(const [0]);
      final next = _localEntry('forced-next', file.path);

      await harness.controller.playFromMusic(_music());
      harness.controller.setPlaybackMode(PlayerPlaybackMode.shuffle);
      await harness.controller.enqueueNext(next);
      await harness.controller.playNext();

      final state = harness.container.read(playerControllerProvider);
      expect(state.track?.localPath, next.savedPath);
      expect(state.queueIndex, 0);
    },
  );

  test('playlist queue expands without restarting the active track', () async {
    final harness = await _Harness.create(loadFailures: 0);
    addTearDown(harness.dispose);
    final directory = await Directory.systemTemp.createTemp(
      'twilight_echo-player-expand-queue-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final expanded = <DownloadHistoryEntry>[];
    for (var index = 1; index <= 5; index++) {
      final file = File(
        '${directory.path}${Platform.pathSeparator}track-$index.mp3',
      );
      await file.writeAsBytes(const [0]);
      expanded.add(_localEntry('track-$index', file.path));
    }
    final initial = expanded.take(3).toList(growable: false);

    await harness.controller.playFromPlaylistQueue(initial[1], initial);
    final before = harness.container.read(playerControllerProvider);
    final loadedBefore = harness.audio.loadedUris.length;

    expect(
      harness.controller.expandPlaylistQueue(
        expectedQueue: initial,
        expandedQueue: expanded,
      ),
      isTrue,
    );

    final after = harness.container.read(playerControllerProvider);
    expect(after.queue, hasLength(5));
    expect(after.queueIndex, 1);
    expect(after.queue[after.queueIndex].id, 'track-2');
    expect(after.track?.id, before.track?.id);
    expect(harness.audio.loadedUris, hasLength(loadedBefore));
  });
}

class _Harness {
  _Harness({
    required this.container,
    required this.audio,
    required this.resolver,
    required this.api,
  });

  final ProviderContainer container;
  final _FakeAudioHandler audio;
  final _ScriptedResolver resolver;
  final _FakeMusicApi api;

  PlayerController get controller =>
      container.read(playerControllerProvider.notifier);

  static Future<_Harness> create({required int loadFailures}) async {
    final preferences = await SharedPreferences.getInstance();
    final audio = _FakeAudioHandler(loadFailures: loadFailures);
    final resolver = _ScriptedResolver([_record('first'), _record('second')]);
    final api = _FakeMusicApi();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        playerAudioHandlerProvider.overrideWithValue(audio),
        musicUrlResolverProvider.overrideWithValue(resolver),
        musicApiProvider.overrideWithValue(api),
      ],
    );
    container.read(playerControllerProvider);
    return _Harness(
      container: container,
      audio: audio,
      resolver: resolver,
      api: api,
    );
  }

  Future<void> dispose() async {
    container.dispose();
    await audio.disposeHandler();
  }
}

class _ScriptedResolver implements MusicUrlResolver {
  _ScriptedResolver(this.sources);

  final List<MusicSourceRecord> sources;
  final List<String> attemptedIds = [];
  final List<Quality> requestedQualities = [];
  final Set<Quality> failingQualities = {};

  @override
  Future<Quality> highestQualityFor(MusicInfo music) async => Quality.k128;

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
  Future<MusicSourceFallbackResult<T>> useFirstAvailable<T>({
    required MusicInfo music,
    required Quality quality,
    required MusicSourceUrlConsumer<T> use,
    Set<String> excludedSourceIds = const <String>{},
    bool Function()? isCancelled,
    bool Function(Object error)? shouldFallbackOnConsumerError,
  }) async {
    requestedQualities.add(quality);
    final failures = <MusicSourceAttemptFailure>[];
    final attempted = <String>[];
    for (final source in sources) {
      if (excludedSourceIds.contains(source.id)) continue;
      if (isCancelled?.call() ?? false) {
        throw const MusicSourceFallbackCancelledException();
      }
      attempted.add(source.id);
      attemptedIds.add(source.id);
      try {
        if (failingQualities.contains(quality)) {
          throw const MusicSourceRuntimeException('quality unavailable');
        }
        final url = MusicUrl(
          url: 'https://audio.test/${source.id}.mp3',
          type: quality,
        );
        final value = await use(source, url);
        return MusicSourceFallbackResult(
          source: source,
          value: value,
          attemptedSourceIds: List.unmodifiable(attempted),
        );
      } on MusicSourceFallbackCancelledException {
        rethrow;
      } catch (error) {
        failures.add(MusicSourceAttemptFailure(source: source, error: error));
      }
    }
    if (failures.isEmpty) {
      throw const MusicSourceRuntimeException('没有更多可用的备用音源');
    }
    throw MusicSourceFallbackException(failures);
  }
}

class _FakeAudioHandler extends PlayerAudioHandler {
  _FakeAudioHandler({required this.loadFailures});

  final int loadFailures;
  final List<Uri> loadedUris = [];
  final StreamController<audio.PlayerException> _errors =
      StreamController<audio.PlayerException>.broadcast(sync: true);
  int failTransitionCount = 0;
  Duration? _duration;
  Duration _position = Duration.zero;
  bool _playing = false;
  audio.ProcessingState _processingState = audio.ProcessingState.idle;

  @override
  Stream<Duration> get positionStream => const Stream<Duration>.empty();

  @override
  Stream<Duration?> get durationStream => const Stream<Duration?>.empty();

  @override
  Stream<audio.PlayerState> get playerStateStream =>
      const Stream<audio.PlayerState>.empty();

  @override
  Stream<audio.PlayerException> get errorStream => _errors.stream;

  @override
  Duration get position => _position;

  @override
  Duration? get duration => _duration;

  @override
  bool get playing => _playing;

  @override
  audio.ProcessingState get processingState => _processingState;

  @override
  Future<void> beginTrackTransition({
    required MediaItem item,
    int? queueIndex,
  }) async {
    _playing = false;
    _processingState = audio.ProcessingState.loading;
  }

  @override
  Future<Duration?> load({
    required MediaItem item,
    required Uri sourceUri,
    int? queueIndex,
  }) async {
    loadedUris.add(sourceUri);
    if (loadedUris.length <= loadFailures) {
      throw audio.PlayerException(1, 'load failed', 0);
    }
    _duration = const Duration(minutes: 3);
    _processingState = audio.ProcessingState.ready;
    return _duration;
  }

  @override
  Future<void> play() async {
    _playing = true;
  }

  @override
  Future<void> seek(Duration position) async {
    _position = position;
  }

  @override
  void failTrackTransition(Object error) {
    failTransitionCount++;
  }

  void emitError(audio.PlayerException error) => _errors.add(error);

  @override
  Future<void> disposeHandler() async {
    await _errors.close();
    await super.disposeHandler();
  }
}

class _FakeMusicApi extends MusicApi {
  int lyricLoadCount = 0;

  @override
  Future<LyricInfo> getLyric({required MusicInfo musicInfo}) async {
    lyricLoadCount++;
    return const LyricInfo(lyric: '[00:01.000]Test lyric');
  }

  @override
  Future<String?> getPicUrl({
    required MusicInfo musicInfo,
    bool preferCached = true,
  }) async => null;
}

Future<void> _waitUntil(bool Function() predicate) async {
  for (var attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('condition was not reached');
}

MusicSourceRecord _record(String id) {
  return MusicSourceRecord(
    id: id,
    name: id,
    description: '',
    author: 'test',
    homepage: '',
    version: '1',
    origin: 'test',
    importedAt: DateTime.utc(2026, 7, 31),
    updatedAt: DateTime.utc(2026, 7, 31),
    capabilities: const {
      MusicSource.kw: [Quality.k320, Quality.k128],
    },
  );
}

MusicInfo _music() {
  return MusicInfo(
    id: 'song-1',
    name: 'Test Song',
    singer: 'Test Singer',
    source: MusicSource.kw,
    interval: '03:00',
    meta: const MusicMeta(
      songId: 'song-1',
      albumName: 'Test Album',
      qualitys: [QualityOption(type: Quality.k128)],
      raw: {},
    ),
    raw: const {},
  );
}

MusicInfo _neteaseMusic() {
  return MusicInfo(
    id: 'netease-song',
    name: 'NetEase Song',
    singer: 'Test Singer',
    source: MusicSource.wy,
    interval: '03:00',
    meta: const MusicMeta(
      songId: 'netease-song',
      albumName: 'Test Album',
      picUrl: 'http://p1.music.126.net/test/cover.jpg',
      qualitys: [QualityOption(type: Quality.k128)],
      raw: {},
    ),
    raw: const {},
  );
}

DownloadHistoryEntry _localEntry(String id, String path) {
  return DownloadHistoryEntry(
    id: id,
    musicId: id,
    name: id,
    singer: 'Test Singer',
    albumName: 'Test Album',
    sourceCode: MusicSource.kw.code,
    qualityCode: Quality.k128.code,
    status: DownloadHistoryStatus.completed,
    createdAt: DateTime.utc(2026, 8, 4),
    savedPath: path,
  );
}
