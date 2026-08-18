import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/download_capabilities.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/music_sources/music_source_controller.dart';
import 'package:twilight_echo/core/services/download_service.dart';
import 'package:twilight_echo/features/music_sources/music_source_action_guard.dart';
import 'package:twilight_echo/features/search/widgets/quality_picker_sheet.dart';

void main() {
  testWidgets('download picker uses immediate per-track quality sizes', (
    tester,
  ) async {
    late _RecordingDownloadService service;
    final music = _music();
    const capabilities = DownloadCapabilities(
      sources: {
        MusicSource.mg: [Quality.k128, Quality.flac, Quality.hires],
      },
      availableSources: [MusicSource.mg],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          downloadCapabilitiesProvider.overrideWithValue(
            const AsyncData(capabilities),
          ),
          downloadServiceProvider.overrideWith(
            (ref) => service = _RecordingDownloadService(ref),
          ),
        ],
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: FilledButton(
                onPressed: () => showQualityPickerSheet(context, music),
                child: const Text('下载'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('下载'));
    await tester.pumpAndSettle();

    expect(find.text('hires · 48 MB'), findsOneWidget);
    expect(find.text(Quality.flac24bit.code), findsNothing);
    expect(find.text('flac · 24 MB'), findsOneWidget);
    expect(find.text('128k · 3 MB'), findsOneWidget);
    expect(
      tester
          .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'hires · 48 MB'))
          .selected,
      isTrue,
    );

    await tester.tap(find.text('开始下载'));
    await tester.pump();
    expect(service.quality, Quality.hires);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets(
    'download picker falls back to source qualities when metadata is empty',
    (tester) async {
      const capabilities = DownloadCapabilities(
        sources: {
          MusicSource.mg: [Quality.k128, Quality.flac, Quality.hires],
        },
        availableSources: [MusicSource.mg],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            downloadCapabilitiesProvider.overrideWithValue(
              const AsyncData(capabilities),
            ),
          ],
          child: MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: FilledButton(
                  onPressed: () => showQualityPickerSheet(
                    context,
                    _music(withQualities: false),
                  ),
                  child: const Text('下载'),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('下载'));
      await tester.pumpAndSettle();

      expect(find.text(Quality.hires.code), findsOneWidget);
      expect(
        tester
            .widget<ChoiceChip>(
              find.widgetWithText(ChoiceChip, Quality.hires.code),
            )
            .selected,
        isTrue,
      );
    },
  );

  testWidgets('download picker is blocked before opening without a source', (
    tester,
  ) async {
    Future<void>? action;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          downloadCapabilitiesProvider.overrideWithValue(
            const AsyncData(DownloadCapabilities.empty),
          ),
        ],
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: FilledButton(
                onPressed: () {
                  action = showQualityPickerSheet(context, _music());
                },
                child: const Text('下载'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('下载'));
    await action;
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('选择下载音质'), findsNothing);
    expect(
      onlineMusicSourceUnavailableMessage(DownloadCapabilities.empty, [
        MusicSource.mg,
      ]),
      '请先在设置中导入并启用音源',
    );
    await tester.pump(const Duration(seconds: 4));
  });
}

class _RecordingDownloadService extends DownloadService {
  _RecordingDownloadService(super.ref);

  Quality? quality;

  @override
  Future<DownloadResult> downloadOne({
    required MusicInfo music,
    Quality? quality,
    required EmbedRequest embed,
  }) async {
    this.quality = quality;
    return const DownloadResult(path: 'D:/Music/song.flac');
  }
}

MusicInfo _music({bool withQualities = true}) => MusicInfo.fromJson({
  'id': 'mg-song',
  'name': '测试歌曲',
  'singer': '测试歌手',
  'source': MusicSource.mg.code,
  'meta': {
    'songId': 'mg-song',
    'albumName': '测试专辑',
    'qualitys': withQualities
        ? [
            {'type': Quality.k128.code, 'size': '3 MB'},
            {'type': Quality.flac.code, 'size': '24 MB'},
            {'type': Quality.flac24bit.code, 'size': '48 MB'},
          ]
        : <Map<String, String>>[],
  },
});
