import 'dart:async';

import 'package:audio_service/audio_service.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/features/player/player_audio_handler.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'track transition keeps the media session alive with new metadata',
    (tester) async {
      expect(playerAudioServiceConfig.androidStopForegroundOnPause, isFalse);

      final handler = PlayerAudioHandler();
      final states = <PlaybackState>[];
      final subscription = handler.playbackState.listen(states.add);
      addTearDown(() async {
        await subscription.cancel();
        unawaited(handler.disposeHandler());
      });

      handler.updateMediaMetadata(
        MediaItem(
          id: 'old',
          title: '上一首',
          artist: '旧歌手',
          duration: const Duration(minutes: 3),
          artUri: Uri.parse('https://p1.music.126.net/old.jpg'),
          artHeaders: const {'Referer': 'https://music.163.com/'},
        ),
      );
      await tester.pump();
      expect(handler.mediaItem.value?.artHeaders, {
        'Referer': 'https://music.163.com/',
      });
      final stateCountBeforeTransition = states.length;

      await handler.beginTrackTransition(
        item: const MediaItem(id: 'next', title: '下一首', artist: '新歌手'),
        queueIndex: 1,
      );
      await tester.pump();

      expect(handler.mediaItem.value?.id, 'next');
      expect(handler.mediaItem.value?.title, '下一首');
      expect(
        handler.playbackState.value.processingState,
        AudioProcessingState.loading,
      );
      expect(handler.playbackState.value.playing, isFalse);
      expect(handler.playbackState.value.updatePosition, Duration.zero);
      expect(handler.playbackState.value.queueIndex, 1);
      expect(
        states
            .skip(stateCountBeforeTransition)
            .every(
              (state) => state.processingState != AudioProcessingState.idle,
            ),
        isTrue,
      );

      await handler.play();
      await handler.seek(const Duration(seconds: 30));
      expect(
        handler.playbackState.value.processingState,
        AudioProcessingState.loading,
      );

      handler.failTrackTransition('加载失败');
      expect(handler.mediaItem.value?.title, '上一首');
      expect(
        handler.playbackState.value.processingState,
        AudioProcessingState.error,
      );
      expect(handler.playbackState.value.errorMessage, contains('加载失败'));
      expect(tester.takeException(), isNull);
    },
  );
}
