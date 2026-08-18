import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audio_service/audio_service.dart';
import 'package:audio_session/audio_session.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';

import 'media_item_copy.dart';

typedef PlayerTransportCallback = Future<void> Function();
typedef PlayerQueueItemCallback = Future<void> Function(int index);
typedef PlayerRepeatModeCallback =
    Future<void> Function(AudioServiceRepeatMode mode);
typedef PlayerShuffleModeCallback =
    Future<void> Function(AudioServiceShuffleMode mode);

const playerAudioServiceConfig = AudioServiceConfig(
  androidNotificationChannelId: 'com.twilight.echo.channel.audio_playback',
  androidNotificationChannelName: '音乐播放',
  androidNotificationChannelDescription: '显示正在播放的歌曲和媒体控制',
  androidNotificationIcon: 'drawable/ic_stat_music_note',
  androidShowNotificationBadge: false,
  androidNotificationOngoing: false,
  // Keep the MediaSession and notification alive while a track is paused or
  // replaced. Restarting a foreground service from the lock screen is not
  // reliable across Android vendors and can leave stale system metadata.
  androidStopForegroundOnPause: false,
  notificationColor: Color(0xFF006A60),
  artDownscaleWidth: 512,
  artDownscaleHeight: 512,
);

Future<PlayerAudioHandler> initializePlayerAudioHandler() async {
  final handler = await AudioService.init<PlayerAudioHandler>(
    builder: PlayerAudioHandler.new,
    config: playerAudioServiceConfig,
  );

  final session = await AudioSession.instance;
  await session.configure(const AudioSessionConfiguration.music());
  return handler;
}

class PlayerAudioHandler extends BaseAudioHandler with SeekHandler {
  PlayerAudioHandler() {
    _playbackSubscription = _player.playbackEventStream.listen(_broadcastState);
    _durationSubscription = _player.durationStream.listen(_updateDuration);
    _errorSubscription = _player.errorStream.listen((error) {
      _broadcastError(error, StackTrace.current);
    });
    _broadcastState(_player.playbackEvent);
  }

  final AudioPlayer _player = AudioPlayer();
  StreamSubscription<PlaybackEvent>? _playbackSubscription;
  StreamSubscription<Duration?>? _durationSubscription;
  StreamSubscription<PlayerException>? _errorSubscription;

  Object? _callbackOwner;
  PlayerTransportCallback? _onPrevious;
  PlayerTransportCallback? _onNext;
  PlayerQueueItemCallback? _onQueueItem;
  PlayerRepeatModeCallback? _onRepeatMode;
  PlayerShuffleModeCallback? _onShuffleMode;
  int? _queueIndex;
  AudioServiceRepeatMode _repeatMode = AudioServiceRepeatMode.all;
  AudioServiceShuffleMode _shuffleMode = AudioServiceShuffleMode.none;
  MediaItem? _currentMediaItem;
  MediaItem? _mediaItemBeforeTransition;
  int? _queueIndexBeforeTransition;
  bool _trackTransitionActive = false;

  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;
  Stream<PlayerException> get errorStream => _player.errorStream;
  MediaItem? get currentMediaItem => _currentMediaItem;

  Duration get position => _player.position;
  Duration? get duration => _player.duration;
  bool get playing => _player.playing;
  ProcessingState get processingState => _player.processingState;

  void bindTransportCallbacks({
    required Object owner,
    required PlayerTransportCallback onPrevious,
    required PlayerTransportCallback onNext,
    required PlayerQueueItemCallback onQueueItem,
    required PlayerRepeatModeCallback onRepeatMode,
    required PlayerShuffleModeCallback onShuffleMode,
  }) {
    _callbackOwner = owner;
    _onPrevious = onPrevious;
    _onNext = onNext;
    _onQueueItem = onQueueItem;
    _onRepeatMode = onRepeatMode;
    _onShuffleMode = onShuffleMode;
    _broadcastState(_player.playbackEvent);
  }

  void unbindTransportCallbacks(Object owner) {
    if (!identical(_callbackOwner, owner)) return;
    _callbackOwner = null;
    _onPrevious = null;
    _onNext = null;
    _onQueueItem = null;
    _onRepeatMode = null;
    _onShuffleMode = null;
  }

  Future<void> beginTrackTransition({
    required MediaItem item,
    int? queueIndex,
  }) async {
    if (!_trackTransitionActive) {
      _mediaItemBeforeTransition = _currentMediaItem;
      _queueIndexBeforeTransition = _queueIndex;
    }
    _trackTransitionActive = true;
    _queueIndex = queueIndex;
    _currentMediaItem = item;
    mediaItem.add(item);
    _broadcastState(_player.playbackEvent);
    if (_player.playing) await _player.pause();
  }

  void failTrackTransition(Object error) {
    if (!_trackTransitionActive) return;
    final previousItem = _mediaItemBeforeTransition;
    _queueIndex = _queueIndexBeforeTransition;
    if (previousItem != null) {
      _currentMediaItem = previousItem;
      mediaItem.add(previousItem);
    }
    _trackTransitionActive = false;
    _clearTransitionSnapshot();
    final restoredState = _transformEvent(_player.playbackEvent);
    playbackState.add(
      restoredState.copyWith(
        processingState:
            restoredState.processingState == AudioProcessingState.idle
            ? AudioProcessingState.error
            : restoredState.processingState,
        playing: false,
        errorCode: 1,
        errorMessage: error.toString(),
      ),
    );
  }

  Future<Duration?> load({
    required MediaItem item,
    required Uri sourceUri,
    int? queueIndex,
  }) async {
    _queueIndex = queueIndex;
    _currentMediaItem = item;
    mediaItem.add(item);
    final resolvedDuration = await _player.setAudioSource(
      AudioSource.uri(sourceUri),
    );
    _trackTransitionActive = false;
    _clearTransitionSnapshot();
    _updateDuration(resolvedDuration);
    _broadcastState(_player.playbackEvent);
    return resolvedDuration;
  }

  void updateMediaMetadata(MediaItem item) {
    final resolvedDuration = item.duration ?? _player.duration;
    _currentMediaItem = resolvedDuration == null
        ? item
        : preserveMediaItemArtHeaders(
            item,
            item.copyWith(duration: resolvedDuration),
          );
    mediaItem.add(_currentMediaItem);
  }

  void publishQueue(List<MediaItem> items, {int? currentIndex}) {
    _queueIndex = currentIndex;
    queue.add(List<MediaItem>.unmodifiable(items));
    _broadcastState(_player.playbackEvent);
  }

  void updatePlaybackModes({
    required AudioServiceRepeatMode repeatMode,
    required AudioServiceShuffleMode shuffleMode,
  }) {
    _repeatMode = repeatMode;
    _shuffleMode = shuffleMode;
    _broadcastState(_player.playbackEvent);
  }

  Future<Uri?> cacheArtwork(Uint8List? bytes) async {
    if (bytes == null || bytes.isEmpty) return null;
    final cacheRoot = await getTemporaryDirectory();
    final artDirectory = Directory(
      '${cacheRoot.path}${Platform.pathSeparator}media_art',
    );
    if (!artDirectory.existsSync()) {
      await artDirectory.create(recursive: true);
    }
    final extension = _artworkExtension(bytes);
    final file = File(
      '${artDirectory.path}${Platform.pathSeparator}'
      '${sha256.convert(bytes)}.$extension',
    );
    if (!file.existsSync()) {
      await file.writeAsBytes(bytes, flush: true);
    }
    return file.uri;
  }

  @override
  Future<void> play() async {
    if (_trackTransitionActive) return;
    if (_player.processingState == ProcessingState.completed) {
      await _player.seek(Duration.zero);
    }
    await _player.play();
  }

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) {
    if (_trackTransitionActive) return Future<void>.value();
    return _player.seek(position);
  }

  @override
  Future<void> skipToPrevious() async {
    await _onPrevious?.call();
  }

  @override
  Future<void> skipToNext() async {
    await _onNext?.call();
  }

  @override
  Future<void> skipToQueueItem(int index) async {
    await _onQueueItem?.call(index);
  }

  @override
  Future<void> setRepeatMode(AudioServiceRepeatMode repeatMode) async {
    _repeatMode = repeatMode;
    _broadcastState(_player.playbackEvent);
    await _onRepeatMode?.call(repeatMode);
  }

  @override
  Future<void> setShuffleMode(AudioServiceShuffleMode shuffleMode) async {
    _shuffleMode = shuffleMode;
    _broadcastState(_player.playbackEvent);
    await _onShuffleMode?.call(shuffleMode);
  }

  @override
  Future<void> stop() async {
    await _player.stop();
    await super.stop();
  }

  Future<void> disposeHandler() async {
    await _playbackSubscription?.cancel();
    await _durationSubscription?.cancel();
    await _errorSubscription?.cancel();
    await _player.dispose();
  }

  void _clearTransitionSnapshot() {
    _mediaItemBeforeTransition = null;
    _queueIndexBeforeTransition = null;
  }

  void _updateDuration(Duration? duration) {
    if (duration == null) return;
    final item = _currentMediaItem;
    if (item == null || item.duration == duration) return;
    _currentMediaItem = preserveMediaItemArtHeaders(
      item,
      item.copyWith(duration: duration),
    );
    mediaItem.add(_currentMediaItem);
  }

  void _broadcastError(Object error, StackTrace stackTrace) {
    if (_trackTransitionActive) {
      playbackState.add(_transitionState(_player.playbackEvent));
      return;
    }
    playbackState.add(
      _transformEvent(_player.playbackEvent).copyWith(
        processingState: AudioProcessingState.error,
        errorCode: 1,
        errorMessage: error.toString(),
      ),
    );
  }

  void _broadcastState(PlaybackEvent event) {
    playbackState.add(
      _trackTransitionActive ? _transitionState(event) : _transformEvent(event),
    );
  }

  PlaybackState _transitionState(PlaybackEvent event) {
    return _transformEvent(event).copyWith(
      processingState: AudioProcessingState.loading,
      playing: false,
      updatePosition: Duration.zero,
      bufferedPosition: Duration.zero,
      queueIndex: _queueIndex,
    );
  }

  PlaybackState _transformEvent(PlaybackEvent event) {
    final hasItem = _currentMediaItem != null;
    final controls = hasItem
        ? <MediaControl>[
            MediaControl.skipToPrevious,
            if (_player.playing) MediaControl.pause else MediaControl.play,
            MediaControl.skipToNext,
          ]
        : const <MediaControl>[];
    return PlaybackState(
      controls: controls,
      androidCompactActionIndices: hasItem ? const [0, 1, 2] : null,
      systemActions: hasItem
          ? const {
              MediaAction.seek,
              MediaAction.seekForward,
              MediaAction.seekBackward,
              MediaAction.setRepeatMode,
              MediaAction.setShuffleMode,
            }
          : const {},
      processingState: switch (_player.processingState) {
        ProcessingState.idle => AudioProcessingState.idle,
        ProcessingState.loading => AudioProcessingState.loading,
        ProcessingState.buffering => AudioProcessingState.buffering,
        ProcessingState.ready => AudioProcessingState.ready,
        ProcessingState.completed => AudioProcessingState.completed,
      },
      playing: _player.playing,
      updatePosition: _player.position,
      bufferedPosition: _player.bufferedPosition,
      speed: _player.speed,
      queueIndex: _queueIndex,
      repeatMode: _repeatMode,
      shuffleMode: _shuffleMode,
    );
  }

  String _artworkExtension(Uint8List bytes) {
    if (bytes.length >= 8 &&
        bytes[0] == 0x89 &&
        bytes[1] == 0x50 &&
        bytes[2] == 0x4E &&
        bytes[3] == 0x47) {
      return 'png';
    }
    if (bytes.length >= 12 &&
        bytes[0] == 0x52 &&
        bytes[1] == 0x49 &&
        bytes[2] == 0x46 &&
        bytes[3] == 0x46 &&
        bytes[8] == 0x57 &&
        bytes[9] == 0x45 &&
        bytes[10] == 0x42 &&
        bytes[11] == 0x50) {
      return 'webp';
    }
    return 'jpg';
  }
}

final playerAudioHandlerProvider = Provider<PlayerAudioHandler>((ref) {
  throw StateError('playerAudioHandlerProvider must be overridden at startup');
});
