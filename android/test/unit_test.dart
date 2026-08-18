import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:just_audio/just_audio.dart' show ProcessingState;
import 'package:test/test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/lyric_format.dart';
import 'package:twilight_echo/core/models/lyric_info.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/music_url.dart';
import 'package:twilight_echo/core/sdk/internal/builders.dart';
import 'package:twilight_echo/core/sdk/internal/crypto_util.dart';
import 'package:twilight_echo/core/sdk/internal/format.dart';
import 'package:twilight_echo/core/sdk/internal/kg_krc.dart';
import 'package:twilight_echo/core/sdk/internal/kw_lyricx.dart';
import 'package:twilight_echo/core/sdk/internal/qrc.dart';
import 'package:twilight_echo/core/sdk/internal/tx_qrc_lyric.dart';
import 'package:twilight_echo/core/sdk/internal/tx_lyric_routing.dart';
import 'package:twilight_echo/core/sdk/internal/wy_yrc.dart';
import 'package:twilight_echo/core/services/embedded_artwork_cache.dart';
import 'package:twilight_echo/core/services/file_naming.dart';
import 'package:twilight_echo/core/services/flac_metadata_writer.dart';
import 'package:twilight_echo/core/services/lyric_builder.dart';
import 'package:twilight_echo/core/services/tagger.dart';
import 'package:twilight_echo/core/storage/base_url.dart';
import 'package:twilight_echo/features/downloads/download_history_entry.dart';
import 'package:twilight_echo/features/player/lyric_parser.dart';
// player_models (not player_controller): the controller's closure pulls in
// audio_service / settings_store → Flutter, which breaks `dart test`.
import 'package:twilight_echo/features/player/player_models.dart';

void main() {
  group('PlayerTrack queue entries', () {
    final Map<String, dynamic> music = {
      'id': 'queue-song',
      'name': 'Queue song',
      'singer': 'Queue artist',
      'source': MusicSource.wy.code,
      'interval': '03:30',
      'meta': {
        'songId': 'queue-song',
        'albumName': 'Queue album',
        'qualitys': [
          {'type': Quality.k320.code, 'size': '1024'},
        ],
      },
    };

    DownloadHistoryEntry entry({String? savedPath}) => DownloadHistoryEntry(
      id: 'queue-entry',
      musicId: 'queue-song',
      name: 'Queue song',
      singer: 'Queue artist',
      albumName: 'Queue album',
      sourceCode: MusicSource.wy.code,
      qualityCode: Quality.k320.code,
      status: DownloadHistoryStatus.completed,
      createdAt: DateTime.utc(2026, 7, 20),
      savedPath: savedPath,
      musicJson: music,
    );

    test('uses the remote snapshot when a saved path is missing', () {
      final track = PlayerTrack.fromQueueEntry(
        entry(savedPath: r'Z:\missing\queue-song.flac'),
      );

      expect(track.kind, PlayerTrackKind.remote);
      expect(track.id, '${MusicSource.wy.code}:queue-song:remote');
      expect(track.localPath, isNull);
    });

    test(
      'can trust a persisted queue path without a synchronous file stat',
      () {
        final track = PlayerTrack.fromQueueEntry(
          entry(savedPath: r'Z:\missing\queue-song.flac'),
          trustSavedPath: true,
        );

        expect(track.kind, PlayerTrackKind.localFile);
        expect(track.localPath, r'Z:\missing\queue-song.flac');
      },
    );

    test('prefers an existing local file over the remote snapshot', () {
      final directory = Directory.systemTemp.createTempSync('player-queue-');
      addTearDown(() => directory.deleteSync(recursive: true));
      final file = File('${directory.path}${Platform.pathSeparator}song.flac')
        ..createSync();

      final track = PlayerTrack.fromQueueEntry(entry(savedPath: file.path));

      expect(track.kind, PlayerTrackKind.localFile);
      expect(track.localPath, file.path);
    });
  });

  group('PlayerState track transition', () {
    const oldTrack = PlayerTrack(
      id: 'old',
      kind: PlayerTrackKind.remote,
      title: 'Old song',
      artist: 'Artist',
      album: 'Album',
      sourceLabel: 'QQ',
      qualityLabel: '320k',
    );
    const oldLyrics = KaraokeLyrics([
      KaraokeLyricLine(startMs: 1000, endMs: 3000, text: 'Old lyric'),
    ]);

    test('clears every old transport value before a remote track loads', () {
      const playing = PlayerState(
        track: oldTrack,
        lyricInfo: LyricInfo(lyric: '[00:01.000]Old lyric'),
        lyrics: oldLyrics,
        playing: true,
        position: Duration(seconds: 2),
        duration: Duration(minutes: 3),
        processingState: ProcessingState.ready,
      );

      final loading = playing.beginTrackLoading(
        nextTrack: null,
        canPlayPrevious: false,
        canPlayNext: false,
        queue: const [],
        queueIndex: -1,
      );

      expect(loading.track, isNull);
      expect(loading.lyricInfo, isNull);
      expect(loading.lyrics.isEmpty, isTrue);
      expect(loading.loading, isTrue);
      expect(loading.lyricLoading, isTrue);
      expect(loading.playing, isFalse);
      expect(loading.position, Duration.zero);
      expect(loading.duration, Duration.zero);
      expect(loading.processingState, ProcessingState.loading);
    });

    test('a lyric response cannot revive transport state while loading', () {
      final loading =
          const PlayerState(
            loading: true,
            lyricLoading: true,
            playing: false,
            processingState: ProcessingState.loading,
          ).withLoadedLyrics(
            info: const LyricInfo(lyric: '[00:01.000]New lyric'),
            parsed: const KaraokeLyrics([
              KaraokeLyricLine(startMs: 1000, endMs: 3000, text: 'New lyric'),
            ]),
          );

      expect(loading.lyrics.isEmpty, isFalse);
      expect(loading.lyricLoading, isFalse);
      expect(loading.loading, isTrue);
      expect(loading.playing, isFalse);
      expect(loading.position, Duration.zero);
      expect(loading.duration, Duration.zero);
      expect(loading.processingState, ProcessingState.loading);
    });
  });

  group('SettingsStore', () {
    test('normalizeBaseUrl defaults to the MD production server', () {
      expect(normalizeBaseUrl(''), kDefaultBaseUrl);
      expect(normalizeBaseUrl('   '), kDefaultBaseUrl);
      expect(kDefaultBaseUrl, 'https://example.com');
    });

    test('normalizeBaseUrl accepts bare domains and strips trailing slash', () {
      expect(normalizeBaseUrl('example.com'), 'https://example.com');
      expect(normalizeBaseUrl('https://example.com/'), 'https://example.com');
    });

    test('normalizeBaseUrl migrates the retired primary server to MD', () {
      expect(normalizeBaseUrl('legacy.example.com'), kDefaultBaseUrl);
      expect(normalizeBaseUrl('https://legacy.example.com/'), kDefaultBaseUrl);
    });

    test('normalizeBaseUrl uses http for explicit custom ports', () {
      expect(normalizeBaseUrl('example.com:3100'), 'http://example.com:3100');
      expect(
        normalizeBaseUrl('http://example.com:3100/'),
        'http://example.com:3100',
      );
      expect(normalizeBaseUrl('8.138.235.61:3100'), 'http://8.138.235.61:3100');
    });
  });

  group('FileNaming', () {
    test('sanitize replaces forbidden filesystem characters', () {
      final clean = FileNaming.sanitize('a/b\\c:d*e?f"g<h>i|j');
      for (final ch in [r'/', r'\', ':', '*', '?', '"', '<', '>', '|']) {
        expect(clean, isNot(contains(ch)));
      }
    });

    test('sanitize trims trailing dots and spaces', () {
      expect(FileNaming.sanitize('   foo ... '), isNot(endsWith('.')));
      expect(FileNaming.sanitize('   foo ... '), isNot(endsWith(' ')));
    });

    test('sanitize falls back to "untitled" for empty input', () {
      expect(FileNaming.sanitize(''), 'untitled');
      expect(FileNaming.sanitize('   '), 'untitled');
    });

    test('nullish resolved names fall back to a typed generated name', () {
      final music = buildMusicInfo(
        name: '搁浅',
        singer: '周杰伦',
        source: MusicSource.kw,
        songId: 'jay-geqian',
        qualitys: const [],
      );

      expect(
        MusicUrl.fromJson(const {
          'url': 'https://example.test/song',
          'fileName': 'null',
        }).fileName,
        isNull,
      );
      expect(
        FileNaming.resolvedOrBuild(music, 'flac', 'null'),
        '周杰伦 - 搁浅.flac',
      );
    });

    test('resolved names are treated as safe leaf names, not paths', () {
      final music = buildMusicInfo(
        name: '搁浅',
        singer: '周杰伦',
        source: MusicSource.kw,
        songId: 'jay-geqian',
        qualitys: const [],
      );

      expect(
        FileNaming.resolvedOrBuild(
          music,
          'flac',
          r'C:\downloads\nested\unsafe:name',
        ),
        'unsafe_name.flac',
      );
    });
  });

  group('search relevance', () {
    MusicInfo song(String id, String name, String singer) => buildMusicInfo(
      name: name,
      singer: singer,
      source: MusicSource.kw,
      songId: id,
      qualitys: const [],
    );

    test('exact-title ties retain the platform result order', () {
      final sorted = sortByKeyword([
        song('jay', '搁浅', '周杰伦'),
        song('luoluo', '搁浅', '落落'),
        song('other', '搁浅', '未知歌手'),
      ], '搁浅');

      expect(sorted.map((item) => item.singer), ['周杰伦', '落落', '未知歌手']);
    });

    test('title and artist query promotes the exact combined match', () {
      final sorted = sortByKeyword([
        song('luoluo', '搁浅', '落落'),
        song('jay', '搁浅', '周杰伦'),
        song('cover', '周杰伦的歌', '搁浅乐队'),
      ], '搁浅 周杰伦');

      expect(sorted.first.singer, '周杰伦');
    });
  });

  group('artwork MIME detection', () {
    test('recognizes common cover image formats by bytes', () {
      expect(
        imageMimeTypeFromBytes(Uint8List.fromList([0xFF, 0xD8, 0xFF, 0x00])),
        'image/jpeg',
      );
      expect(
        imageMimeTypeFromBytes(
          Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        ),
        'image/png',
      );
      expect(
        imageMimeTypeFromBytes(
          Uint8List.fromList([
            0x52,
            0x49,
            0x46,
            0x46,
            0,
            0,
            0,
            0,
            0x57,
            0x45,
            0x42,
            0x50,
          ]),
        ),
        'image/webp',
      );
      expect(imageMimeTypeFromBytes(Uint8List.fromList([1, 2, 3])), isNull);
    });
  });

  group('FlacMetadataWriter', () {
    test(
      'rewrites comments and artwork while preserving audio frames',
      () async {
        final dir = await Directory.systemTemp.createTemp('flac_tags_test_');
        addTearDown(() => dir.delete(recursive: true));

        final audioFrames = Uint8List.fromList(
          List<int>.generate(8192, (i) => (i * 31) & 0xFF),
        );
        final file = File('${dir.path}/song.flac');
        await file.writeAsBytes(
          _buildFlacFile(
            comments: const [
              'TITLE=old title',
              'LYRICS=old lyric',
              'COMMENT=keep me',
            ],
            pictureBytes: Uint8List.fromList([1, 2, 3]),
            audioFrames: audioFrames,
          ),
        );

        final result = await FlacMetadataWriter.write(
          file.path,
          title: 'new title',
          artist: 'new artist',
          album: 'new album',
          lyrics: '[00:01.00]new lyric',
          pictureBytes: Uint8List.fromList([9, 8, 7, 6]),
        );

        expect(result, isNotNull);
        expect(result!.lyricsLength, '[00:01.00]new lyric'.length);
        expect(result.artworkLength, 4);

        final summary = await FlacMetadataWriter.readSummary(file.path);
        expect(summary, isNotNull);
        expect(summary!.firstComment('TITLE'), 'new title');
        expect(summary.firstComment('ARTIST'), 'new artist');
        expect(summary.firstComment('ALBUM'), 'new album');
        expect(summary.firstComment('LYRICS'), '[00:01.00]new lyric');
        expect(summary.firstComment('COMMENT'), 'keep me');
        expect(summary.artworkLength, 4);
        expect(summary.artworkBytes, [9, 8, 7, 6]);

        final librarySummary = await FlacMetadataWriter.readSummary(
          file.path,
          includeLyrics: false,
        );
        expect(librarySummary, isNotNull);
        expect(librarySummary!.firstComment('TITLE'), 'new title');
        expect(librarySummary.firstComment('LYRICS'), isNull);
        expect(librarySummary.artworkBytes, [9, 8, 7, 6]);

        final textOnlySummary = await FlacMetadataWriter.readSummary(
          file.path,
          includeLyrics: false,
          includeArtwork: false,
        );
        expect(textOnlySummary, isNotNull);
        expect(textOnlySummary!.firstComment('TITLE'), 'new title');
        expect(textOnlySummary.firstComment('LYRICS'), isNull);
        expect(textOnlySummary.artworkLength, 0);
        expect(textOnlySummary.artworkBytes, isNull);

        final projectedTags = await Tagger.readEmbeddedTags(
          file.path,
          includeLyrics: false,
          includeArtwork: false,
        );
        expect(projectedTags, isNotNull);
        expect(projectedTags!.title, 'new title');
        expect(projectedTags.lyrics, isNull);
        expect(projectedTags.artworkBytes, isNull);

        final lazyArtwork = await EmbeddedArtworkCache.load(
          file.path,
          version: 1,
        );
        expect(lazyArtwork, [9, 8, 7, 6]);
        expect(
          await EmbeddedArtworkCache.load(file.path, version: 1),
          same(lazyArtwork),
        );

        final queuedA = EmbeddedArtworkCache.subscribe(
          file.path,
          version: 'queue-a',
        );
        final queuedB = EmbeddedArtworkCache.subscribe(
          file.path,
          version: 'queue-b',
        );
        final cancelled = EmbeddedArtworkCache.subscribe(
          file.path,
          version: 'queue-c',
        );
        cancelled.cancel();
        expect(await cancelled.future, isNull);
        expect(await queuedA.future, [9, 8, 7, 6]);
        expect(await queuedB.future, [9, 8, 7, 6]);
        queuedA.cancel();
        queuedB.cancel();

        final invalidated = EmbeddedArtworkCache.subscribe(
          file.path,
          version: 'invalidate',
        );
        EmbeddedArtworkCache.evictPath(file.path);
        expect(await invalidated.future, isNull);
        invalidated.cancel();

        final rewritten = await file.readAsBytes();
        expect(
          rewritten.sublist(rewritten.length - audioFrames.length),
          audioFrames,
        );
      },
    );

    test('returns null for non-FLAC files', () async {
      final dir = await Directory.systemTemp.createTemp('flac_tags_test_');
      addTearDown(() => dir.delete(recursive: true));

      final file = File('${dir.path}/song.mp3');
      await file.writeAsBytes([1, 2, 3, 4]);

      final result = await FlacMetadataWriter.write(
        file.path,
        title: 'title',
        lyrics: 'lyrics',
      );

      expect(result, isNull);
      expect(await file.readAsBytes(), [1, 2, 3, 4]);
    });

    test(
      'Tagger detects FLAC by magic even without a flac extension',
      () async {
        final dir = await Directory.systemTemp.createTemp('flac_magic_test_');
        addTearDown(() => dir.delete(recursive: true));
        final file = File('${dir.path}/resolved-audio');
        await file.writeAsBytes(
          _buildFlacFile(
            comments: const [],
            pictureBytes: Uint8List(0),
            audioFrames: Uint8List.fromList([1, 2, 3, 4]),
          ),
        );

        await Tagger.write(
          file.path,
          const TaggingPayload(title: '搁浅', artist: '周杰伦', album: '十一月的萧邦'),
        );

        final summary = await FlacMetadataWriter.readSummary(file.path);
        expect(summary?.firstComment('TITLE'), '搁浅');
        expect(summary?.firstComment('ARTIST'), '周杰伦');
        expect(summary?.firstComment('ALBUM'), '十一月的萧邦');
      },
    );
  });

  group('LyricBuilder', () {
    test('returns empty when source lyric is empty', () {
      expect(
        LyricBuilder.build(
          const LyricInfo(lyric: ''),
          const LyricEmbedOptions(),
        ),
        isEmpty,
      );
    });

    test('auto embeds enhanced word lyrics for QQ/Kugou/Kuwo sources', () {
      const info = LyricInfo(
        lyric: '[00:01.00]Hello',
        tlyric: '[00:01.00]浣犲ソ',
        lxlyric: '[00:01.00]<0,500>Hello',
      );
      for (final source in [MusicSource.tx, MusicSource.kg, MusicSource.kw]) {
        final out = LyricBuilder.build(
          info,
          LyricEmbedOptions(embedTranslatedLyric: true, source: source),
        );
        expect(out, contains('[00:01.000]<00:01.000>Hello<00:01.500>'));
        expect(out, contains('[00:01.00]浣犲ソ'));
        expect(out, isNot(contains('[awlrc:')));
        expect(out, isNot(contains('<0,500>')));
      }
    });

    test('auto uses line-level lyric for NetEase and Migu sources', () {
      const info = LyricInfo(
        lyric: '[00:01.00]Hello',
        lxlyric: '[00:01.00]<0,500>Hello',
      );
      for (final source in [MusicSource.wy, MusicSource.mg, null]) {
        final out = LyricBuilder.build(info, LyricEmbedOptions(source: source));
        expect(out, '[00:01.00]Hello');
        expect(out, isNot(contains('<0,500>')));
      }
    });

    test('can force line-level LRC instead of word lyrics', () {
      const info = LyricInfo(
        lyric: '[00:01.00]Hello',
        lxlyric: '[00:01.00]<0,500>Hello',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(format: EmbeddedLyricFormat.lrc),
      );

      expect(out, '[00:01.00]Hello');
      expect(out, isNot(contains('<0,500>')));
    });

    test('converts word lyrics to enhanced LRC timestamps', () {
      const info = LyricInfo(
        lyric: '[00:05.890]词：方文山',
        lxlyric:
            '[00:05.890]<0,1180>词<1180,1180>：'
            '<2360,1180>方<3540,1180>文<4720,1180>山',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(format: EmbeddedLyricFormat.wordTimed),
      );

      expect(
        out,
        '[00:05.890]<00:05.890>词<00:07.070>：'
        '<00:08.250>方<00:09.430>文<00:10.610>山<00:11.790>',
      );
      expect(out, isNot(contains('<0,1180>')));
    });

    test('enhanced LRC preserves delayed first word marker', () {
      const info = LyricInfo(
        lyric: '[00:01.000]Hello',
        lxlyric: '[00:01.000]<500,250>He<750,250>llo',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(format: EmbeddedLyricFormat.wordTimed),
      );

      expect(out, '[00:01.000]<00:01.500>He<00:01.750>llo<00:02.000>');
    });

    test('falls back to plain lyric when lxlyric is unavailable', () {
      const info = LyricInfo(lyric: '[00:01.00]Hello');
      final out = LyricBuilder.build(info, const LyricEmbedOptions());

      expect(out, '[00:01.00]Hello');
    });

    test('filterExtended drops lines whose timestamp is not in original', () {
      const info = LyricInfo(
        lyric: '[00:01.00]A\n[00:05.00]B',
        tlyric: '[00:01.00]a\n[00:02.00]b-orphan\n[00:05.00]c',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(embedLyric: true, embedTranslatedLyric: true),
      );
      expect(out, contains('[00:01.00]a'));
      expect(out, contains('[00:05.00]c'));
      expect(out, isNot(contains('b-orphan')));
    });

    // Bug repro: wy returns main as `[00:01.000]` but tlyric/romalrc sometimes
    // come back with different ms precision. Old filter compared the raw
    // bracket string and dropped every line.
    test('filterExtended normalizes timestamps across ms-precision', () {
      const info = LyricInfo(
        lyric: '[00:01.000]A\n[00:05.000]B',
        tlyric: '[0:1.00]a\n[00:05.0]c',
        rlyric: '[00:01.00]ah\n[00:05.000]see',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(
          embedLyric: true,
          embedTranslatedLyric: true,
          embedRomanLyric: true,
        ),
      );
      expect(out, contains('[0:1.00]a'));
      expect(out, contains('[00:05.0]c'));
      expect(out, contains('[00:01.00]ah'));
      expect(out, contains('[00:05.000]see'));
    });

    test(
      'filterExtended keeps multi-timestamp lines when any token matches',
      () {
        const info = LyricInfo(
          lyric: '[00:01.00]A\n[00:05.00]B',
          tlyric: '[00:01.00][00:99.00]a-shared\n[00:99.00]orphan',
        );
        final out = LyricBuilder.build(
          info,
          const LyricEmbedOptions(embedLyric: true, embedTranslatedLyric: true),
        );
        // The shared line must survive with only the matching timestamp.
        expect(out, contains('[00:01.00]a-shared'));
        expect(out, isNot(contains('orphan')));
      },
    );

    test('filterExtended drops metadata and untimestamped lines', () {
      const info = LyricInfo(
        lyric: '[00:01.00]A',
        tlyric: '[ti:title]\n[ar:artist]\nplain text\n[00:01.00]a',
      );
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(embedLyric: true, embedTranslatedLyric: true),
      );
      expect(out, contains('[00:01.00]a'));
      expect(out, isNot(contains('[ti:title]')));
      expect(out, isNot(contains('[ar:artist]')));
      expect(out, isNot(contains('plain text')));
    });

    test(
      'build trims source so blocks are separated by exactly one blank line',
      () {
        const info = LyricInfo(
          lyric: '[00:01.00]A\n[00:05.00]B\n',
          tlyric: '[00:01.00]a\n[00:05.00]c\n',
        );
        final out = LyricBuilder.build(
          info,
          const LyricEmbedOptions(embedLyric: true, embedTranslatedLyric: true),
        );
        expect(out, isNot(contains('\n\n\n')));
        expect(out, contains('[00:05.00]B\n\n[00:01.00]a'));
      },
    );
  });

  group('KaraokeLyricsParser', () {
    test('parses word-level lxlyric into absolute karaoke timings', () {
      const info = LyricInfo(
        lyric: '[00:10.000]七里香',
        tlyric: '[00:10.04]Common jasmine orange',
        rlyric: '[00:10.000]qi li xiang',
        lxlyric: '[00:10.000]<0,300>七<300,400>里<700,500>香',
      );

      final lyrics = KaraokeLyricsParser.parse(info);

      expect(lyrics.lines, hasLength(1));
      final line = lyrics.lines.single;
      expect(line.text, '七里香');
      expect(line.translation, 'Common jasmine orange');
      expect(line.roman, 'qi li xiang');
      expect(line.startMs, 10000);
      expect(line.words.map((w) => w.text), ['七', '里', '香']);
      expect(line.words.map((w) => w.startMs), [10000, 10300, 10700]);
      expect(line.words.map((w) => w.endMs), [10300, 10700, 11200]);
      expect(line.words.first.progressAt(10150), closeTo(0.5, 0.001));
    });

    test('falls back to line-level LRC when word timing is unavailable', () {
      const info = LyricInfo(
        lyric: '[00:01.000][00:03.000]Hello',
        tlyric: '[00:03.00]你好',
      );

      final lyrics = KaraokeLyricsParser.parse(info);

      expect(lyrics.lines, hasLength(2));
      expect(lyrics.lines.first.text, 'Hello');
      expect(lyrics.lines.first.words, isEmpty);
      expect(lyrics.lines.last.translation, '你好');
      expect(lyrics.activeIndex(const Duration(milliseconds: 3200)), 1);
    });

    test('falls back to plain lyric when lxlyric parses to nothing', () {
      // Malformed word track (KRC-style comma line stamps that the lx format
      // does not use) must not blank the whole panel while the plain LRC is
      // perfectly usable.
      const info = LyricInfo(
        lyric: '[00:01.000]Hello\n[00:03.000]World',
        lxlyric: '[0,2000]<0,500>Hello',
      );

      final lyrics = KaraokeLyricsParser.parse(info);

      expect(lyrics.lines, hasLength(2));
      expect(lyrics.lines.first.text, 'Hello');
      expect(lyrics.lines.last.text, 'World');
    });

    test('parseEmbedded keeps Absolute word tags as karaoke timings', () {
      // Exactly what LyricBuilder embeds for a word-timed source with a
      // translation block appended (same timestamps as the main lyric).
      const embedded =
          '[00:10.000]<00:10.000>七<00:10.300>里<00:10.700>香<00:11.200>\n'
          '[00:12.000]<00:12.000>你<00:12.500>好<00:13.000>\n'
          '\n'
          '[00:10.000]Common jasmine orange\n'
          '[00:12.000]hello';

      final lyrics = KaraokeLyricsParser.parseEmbedded(embedded);

      expect(lyrics.lines, hasLength(2));
      final first = lyrics.lines.first;
      expect(first.text, '七里香');
      expect(first.translation, 'Common jasmine orange');
      expect(first.hasWordTiming, isTrue);
      expect(first.words.map((w) => w.text), ['七', '里', '香']);
      expect(first.words.map((w) => w.startMs), [10000, 10300, 10700]);
      expect(first.words.map((w) => w.endMs), [10300, 10700, 11200]);
      expect(lyrics.lines.last.translation, 'hello');
    });

    test('parseEmbedded handles non-contiguous word tags and roma block', () {
      const embedded =
          '[00:01.000]<00:01.000>Hi<00:01.400><00:02.000>ya<00:02.300>\n'
          '\n'
          '[00:01.000]嗨\n'
          '\n'
          '[00:01.000]hai';

      final lyrics = KaraokeLyricsParser.parseEmbedded(embedded);

      expect(lyrics.lines, hasLength(1));
      final line = lyrics.lines.single;
      expect(line.text, 'Hiya');
      expect(line.translation, '嗨');
      expect(line.roman, 'hai');
      expect(line.words.map((w) => w.text), ['Hi', 'ya']);
      expect(line.words.map((w) => w.startMs), [1000, 2000]);
      expect(line.words.map((w) => w.endMs), [1400, 2300]);
    });

    test('parseEmbedded still works for plain LRC without word tags', () {
      const embedded = '[00:01.000]Hello\n[00:03.000]World';

      final lyrics = KaraokeLyricsParser.parseEmbedded(embedded);

      expect(lyrics.lines, hasLength(2));
      expect(lyrics.lines.first.text, 'Hello');
      expect(lyrics.lines.first.words, isEmpty);
      expect(lyrics.lines.first.endMs, 3000);
    });
  });

  group('WY yrc', () {
    test('converts absolute word stamps into line-relative lxlyric', () {
      const yrc =
          '{"t":0,"c":[{"tx":"作词: 周杰伦"}]}\n'
          '[1300,990](1300,240,0)真(1540,240,0)的(1780,510,0)吗\n'
          '[62000,500](62000,500,0)Yeah';

      final out = wyYrcToLxLyric(yrc);

      expect(
        out,
        '[00:01.300]<0,240>真<240,240>的<480,510>吗\n'
        '[01:02.000]<0,500>Yeah',
      );
    });

    test('feeds KaraokeLyricsParser with word timings intact', () {
      final lx = wyYrcToLxLyric('[1300,990](1300,240,0)真(1540,240,0)的')!;
      final lyrics = KaraokeLyricsParser.parse(
        LyricInfo(lyric: '[00:01.30]真的', lxlyric: lx),
      );

      expect(lyrics.lines, hasLength(1));
      expect(lyrics.lines.single.words.map((w) => w.text), ['真', '的']);
      expect(lyrics.lines.single.words.map((w) => w.startMs), [1300, 1540]);
    });

    test('returns null when only credit lines exist', () {
      expect(wyYrcToLxLyric('{"t":0,"c":[{"tx":"作曲"}]}'), isNull);
    });
  });

  group('format helpers', () {
    test('formatPlayTime handles minutes, hours, and zero', () {
      expect(formatPlayTime(222), '03:42');
      expect(formatPlayTime(3725), '1:02:05');
      expect(formatPlayTime(0), '00:00');
    });

    test('sizeFormat formats per server thresholds', () {
      expect(sizeFormat(512), '512B');
      expect(sizeFormat(2048), '2.00K');
      expect(sizeFormat(2 * 1024 * 1024), '2.00M');
      expect(sizeFormat(0), isNull);
      expect(sizeFormat(null), isNull);
    });

    test('formatSingerName joins list with named key', () {
      expect(
        formatSingerName(const [
          {'name': 'A'},
          {'name': 'B'},
        ]),
        'A、B',
      );
    });

    test('similar collapses whitespace and case-folds', () {
      expect(similar('Hello World', 'hello world'), greaterThan(0.9));
      expect(similar('a', 'b'), 0);
    });
  });

  group('QRC', () {
    test('decrypts captured TX trans payload to expected Japanese text', () {
      // Real `crypt: 1` trans payload for songID=203014070 (TX song
      // "願い〜あの頃のキミへ〜"). Captured from a production response and
      // verified against the reverse-engineered Python oracle. This is the
      // golden test that protects the custom DES tables and hardcoded
      // subkeys from regressions.
      final decoded = QrcDecoder.decrypt(_kTxTransGoldenHex);
      expect(decoded, startsWith('[ti:願い'));
      expect(decoded, contains('[ar:當山みれい'));
      expect(decoded, contains('[al:願い'));
      expect(decoded, contains('[offset:0]'));
      expect(decoded, contains('[kana:'));
    });

    test('empty input returns empty string', () {
      expect(QrcDecoder.decrypt(''), '');
      expect(QrcDecoder.decrypt(null), '');
    });

    test('odd-length hex throws FormatException', () {
      expect(() => QrcDecoder.decrypt('abc'), throwsA(isA<FormatException>()));
    });

    test('non-multiple-of-8 cipher length throws', () {
      expect(
        () => QrcDecoder.decrypt('0123456789abcdef0123'),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('KgKrc', () {
    // Mirrors the the desktop source format encoder so we can roundtrip without a real
    // KG sample: deflate -> XOR(cycling 16-byte key) -> prepend 4-byte magic
    // -> base64. The 4-byte magic is whatever, the decoder strips it before
    // touching the body.
    final key = [
      0x40,
      0x47,
      0x61,
      0x77,
      0x5e,
      0x32,
      0x74,
      0x47,
      0x51,
      0x36,
      0x31,
      0x2d,
      0xce,
      0xd2,
      0x6e,
      0x69,
    ];

    String encryptKrc(String plainBody) {
      final deflated = ZLibEncoder().encode(utf8.encode(plainBody));
      final body = Uint8List.fromList(deflated);
      for (var i = 0; i < body.length; i++) {
        body[i] ^= key[i % 16];
      }
      final magic = Uint8List.fromList([0x6B, 0x72, 0x63, 0x31]); // "krc1"
      final full = Uint8List(4 + body.length)
        ..setRange(0, 4, magic)
        ..setRange(4, 4 + body.length, body);
      return base64.encode(full);
    }

    test('decodes line-timed body without language tag', () {
      const krcBody =
          '[id:\$00000000]\n'
          '[1500,2000]<0,500,0>Hello<500,500,0>world\n'
          '[5000,2000]<0,1000,0>foo<1000,500,0>bar';
      final out = KgKrc.decodeBase64Content(encryptKrc(krcBody));
      expect(out.lyric, '[00:01.500]Helloworld\n[00:05.0]foobar');
      expect(out.lxlyric, contains('[00:01.500]<0,500>Hello<500,500>world'));
      expect(out.tlyric, isNull);
      expect(out.rlyric, isNull);
    });

    test('extracts translation + roma from [language:...] block', () {
      // Two lines of main lyric. Translation has same number of lines.
      const langJson =
          '{"content":['
          '{"type":1,"lyricContent":[["你好"],["再见"]]},'
          '{"type":0,"lyricContent":[["ni","hao"],["zai","jian"]]}'
          ']}';
      final langB64 = base64.encode(utf8.encode(langJson));
      final krcBody =
          '[id:\$1234abcd]\n'
          '[language:$langB64]\n'
          '[0,2000]<0,500,0>hello\n'
          '[3000,1000]<0,1000,0>bye';
      final out = KgKrc.decodeBase64Content(encryptKrc(krcBody));
      expect(out.lyric, contains('[00:00.0]hello'));
      expect(out.lyric, contains('[00:03.0]bye'));
      expect(out.tlyric, '[00:00.0]你好\n[00:03.0]再见');
      expect(out.rlyric, '[00:00.0]nihao\n[00:03.0]zaijian');
    });

    test('html-unescapes content', () {
      // KG occasionally emits &apos; / &quot; etc.
      const krcBody = '[1500,500]<0,500,0>It&apos;s';
      final out = KgKrc.decodeBase64Content(encryptKrc(krcBody));
      expect(out.lyric, "[00:01.500]It's");
    });
  });

  group('KwLyricx', () {
    test('decodes Kuwo private word timing into lxlyric offsets', () {
      const raw =
          '[kuwo:051]\n'
          '[ver:v1.0]\n'
          '[ti:黄昏 ]\n'
          '[ar:周传雄]\n'
          '[offset:0]\n'
          '[00:00.000]<693,-693>黄<3465,2079>昏<6237,4851> '
          '<9009,7623>-<11781,10395> <14553,13167>周'
          '<17325,15939>传<20097,18711>雄\n'
          '[00:29.150]<330,-330>过<1680,960>完<3100,2420>整'
          '<4500,3740>个<6040,5240>夏<8140,6340>天';

      final out = KwLyricx.parse(raw);

      expect(out.lyric, contains('[00:00.000]黄昏 - 周传雄'));
      expect(out.lyric, contains('[00:29.150]过完整个夏天'));
      expect(out.lxlyric, contains('[00:00.000]<0,693>黄<693,693>昏<1386,693> '));
      expect(out.lxlyric, contains('[00:29.150]<0,330>过<330,360>完<690,340>整'));
      expect(out.lxlyric, isNot(contains('[kuwo:')));
      expect(out.lxlyric, isNot(contains('<693,-693>')));
    });

    test('builds sane word-timed lyric from Kuwo lyricx', () {
      const raw =
          '[kuwo:051]\n'
          '[00:00.000]<693,-693>黄<3465,2079>昏<6237,4851> '
          '<9009,7623>-<11781,10395> <14553,13167>周'
          '<17325,15939>传<20097,18711>雄';

      final info = KwLyricx.parse(raw);
      final out = LyricBuilder.build(
        info,
        const LyricEmbedOptions(format: EmbeddedLyricFormat.wordTimed),
      );

      expect(out, startsWith('[00:00.000]<00:00.000>黄<00:00.693>昏'));
      expect(out, contains('<00:02.079>-<00:02.772>'));
      expect(out, isNot(contains('[kuwo:')));
      expect(out, isNot(contains('693,-693')));
    });
  });

  group('TxQrcLyric', () {
    // QRC line format: `[lineStartMs,lineDurationMs]wordA(wordStartMsAbs,wordDurMs)wordB(...)...`.
    // The parser strips word timings for the clean lyric track and rebuilds
    // an lxlyric track with relative-to-line word offsets.
    test(
      'parseQrcLyric extracts clean LRC and lxlyric from word-timed form',
      () {
        const raw = '[1500,2000]He(1500,300)llo(1800,500)world(2300,1200)';
        final out = TxQrcLyric.parseQrcLyric(raw);
        expect(out.lyric, '[00:01.500]Helloworld');
        expect(out.lxlyric, '[00:01.500]<0,300>He<300,500>llo<800,1200>world');
      },
    );

    test('parseQrcLyric formats ms as 3-digit fractional seconds', () {
      const raw =
          '[5,100]X(5,100)\n[60000,100]Y(60000,100)\n[3661500,100]Z(3661500,100)';
      final out = TxQrcLyric.parseQrcLyric(raw);
      expect(out.lyric, contains('[00:00.005]X'));
      expect(out.lyric, contains('[01:00.000]Y'));
      expect(out.lyric, contains('[61:01.500]Z'));
    });

    test('parseQrcLyric drops lines without QRC header but keeps [offset]', () {
      const raw = '[ti:title]\n[offset:-100]\nbare\n[1500,500]Hi(1500,500)';
      final out = TxQrcLyric.parseQrcLyric(raw);
      expect(out.lyric, contains('[offset:-100]'));
      expect(out.lyric, contains('[00:01.500]Hi'));
      expect(out.lyric, isNot(contains('[ti:title]')));
      expect(out.lyric, isNot(contains('bare')));
    });

    test('parseQrcRoma reuses lyric arm and strips word timings', () {
      const raw = '[1500,500]kimi(1500,500)\n[2000,500]e(2000,500)';
      final out = TxQrcLyric.parseQrcRoma(raw);
      expect(out, '[00:01.500]kimi\n[00:02.000]e');
    });

    test(
      'alignTimestamps re-binds trans (centisecond) to main (millisecond)',
      () {
        // Main lyric is ms-precise; trans uses cs precision and is off by ~1ms.
        const mainLyric = '[00:14.939]fu ta ri\n[01:20.500]ka na shi';
        const trans = '[00:14.94]两个人\n[01:20.50]悲伤的';
        final aligned = TxQrcLyric.alignTimestamps(trans, mainLyric);
        expect(aligned, '[00:14.939]两个人\n[01:20.500]悲伤的');
      },
    );

    test('alignTimestamps drops extended lines with no near-by main match', () {
      // Trans line at 60s has no main line within 100ms ⇒ dropped.
      const mainLyric = '[00:14.939]a\n[00:30.000]b';
      const trans = '[00:14.94]matches\n[01:00.00]orphan';
      final aligned = TxQrcLyric.alignTimestamps(trans, mainLyric);
      expect(aligned, '[00:14.939]matches');
    });
  });

  group('TxSdk lyric routing', () {
    test('uses numeric QQ song ID from meta id before songmid', () {
      final info = buildMusicInfo(
        name: '七里香',
        singer: '周杰伦',
        source: MusicSource.tx,
        songId: '004Z8Ihr0JIu5s',
        qualitys: const [],
        metaId: '102065756',
      );
      expect(txResolveIntegerSongId(info), 102065756);
    });

    test('extracts and unescapes QRC XML LyricContent attribute', () {
      const raw =
          '<?xml version="1.0"?><QrcInfos><LyricInfo>'
          '<Lyric_1 LyricType="1" LyricContent="[0,1000]It&apos;s(0,1000)"/>'
          '</LyricInfo></QrcInfos>';
      expect(txExtractLyricContent(raw), "[0,1000]It's(0,1000)");
    });

    test('keeps literal quotes inside QRC LyricContent', () {
      const raw =
          '<?xml version="1.0"?><QrcInfos><LyricInfo>'
          '<Lyric_1 LyricType="1" LyricContent="'
          '[10035,11856]Produced (10035,456)by: (10491,456)Bradford '
          '(10947,456)"(11403,456)Brad(11859,456)" (12315,456)Delson\n'
          '[21892,1000]I&apos;m(21892,1000) tired'
          '"/>'
          '</LyricInfo></QrcInfos>';

      expect(
        txExtractLyricContent(raw),
        '[10035,11856]Produced (10035,456)by: (10491,456)Bradford '
        '(10947,456)"(11403,456)Brad(11859,456)" (12315,456)Delson\n'
        "[21892,1000]I'm(21892,1000) tired",
      );
    });
  });

  group('CryptoUtil', () {
    test('md5/sha1 match openssl', () {
      expect(CryptoUtil.md5Hex('hello'), '5d41402abc4b2a76b9719d911017c592');
      expect(
        CryptoUtil.sha1Hex('hello'),
        'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
      );
    });

    test('AES-128-ECB-PKCS7 EAPI golden value matches node output', () {
      const expected =
          '74A595527B7A1647174ADDB4F261E92F180F42F921F98E9D338C60DB20AF499CEA90E95FB2FDA117A0B5D8175C2F21E536AD23834570BF74BD436592CA16911BB0283B2F7FB458FDFF37CAB15CC9CD8BAC29F11ACC19AB5D13ABEADE2C21D57871E0F22F662AAAAF4989685DF8ADD5959786A4789F36C29BC6A9035A5E134FD9FE4694C0202277C7A9378D251C5CC070C4BDAA25091EDB9553239E517FDCF8A5FEC5B5CA98E2AD4F53750641BEA410F81669A2C0CC525911DA1B2D0749316B7D';

      const path = '/api/search/song/list/page';
      // Same payload as the Node fixture script
      final payload =
          '{"keyword":"test","needCorrect":"1","channel":"typing","offset":0,"scene":"normal","total":true,"limit":30}';
      final message = 'nobody${path}use${payload}md5forencrypt';
      final digest = CryptoUtil.md5Hex(message);
      final data = '$path-36cd479b6b5-$payload-36cd479b6b5-$digest';
      final encrypted = CryptoUtil.aesEncryptEcbPkcs7(
        Uint8List.fromList(utf8.encode(data)),
        Uint8List.fromList(utf8.encode('e82ckenh8dichen8')),
      );
      expect(CryptoUtil.bytesToHex(encrypted, upper: true), expected);
    });

    test('RSA-1024 no-padding matches node publicEncrypt', () {
      const expected =
          'd473b9eca232f1b4090dd606b0df86de318748dd2eec307e4ed4345030fc4ee30331e598f41d5a6f5befaab94630ea1a1eda7cfade84fbec1a907913d2e4d2c8744bc572b99a050075e075b4537f645ecfa994f95906c32818e076aeda6bdb906bfa0bb96c4cf4bc3ed6d9ab76cf08441153d9d85e1ea3d78fa8d9210d581cee';

      final modulus = BigInt.parse(
        'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
        radix: 16,
      );
      final exponent = BigInt.from(0x10001);
      final raw = Uint8List.fromList(List.filled(16, 'a'.codeUnitAt(0)));
      final padded = Uint8List(128);
      padded.setRange(112, 128, raw);
      final encrypted = CryptoUtil.rsaNoPadding(padded, modulus, exponent);
      expect(CryptoUtil.bytesToHex(encrypted), expected);
    });
  });
}

Uint8List _buildFlacFile({
  required List<String> comments,
  required Uint8List pictureBytes,
  required Uint8List audioFrames,
}) {
  final out = BytesBuilder(copy: false);
  out.add(const [0x66, 0x4C, 0x61, 0x43]); // fLaC
  out.add(_flacBlock(0, Uint8List(34)));
  out.add(_flacBlock(4, _vorbisComment(comments)));
  out.add(_flacBlock(6, _picturePayload(pictureBytes), isLast: true));
  out.add(audioFrames);
  return out.takeBytes();
}

Uint8List _flacBlock(int type, Uint8List payload, {bool isLast = false}) {
  final out = Uint8List(4 + payload.length);
  out[0] = (isLast ? 0x80 : 0x00) | type;
  out[1] = (payload.length >> 16) & 0xFF;
  out[2] = (payload.length >> 8) & 0xFF;
  out[3] = payload.length & 0xFF;
  out.setRange(4, out.length, payload);
  return out;
}

Uint8List _vorbisComment(List<String> comments) {
  final vendor = utf8.encode('test');
  final encodedComments = [
    for (final comment in comments) utf8.encode(comment),
  ];
  final length =
      4 +
      vendor.length +
      4 +
      encodedComments.fold<int>(0, (sum, bytes) => sum + 4 + bytes.length);
  final out = Uint8List(length);
  var offset = 0;

  void writeU32(int value) {
    out[offset++] = value & 0xFF;
    out[offset++] = (value >> 8) & 0xFF;
    out[offset++] = (value >> 16) & 0xFF;
    out[offset++] = (value >> 24) & 0xFF;
  }

  void writeBytes(List<int> bytes) {
    out.setRange(offset, offset + bytes.length, bytes);
    offset += bytes.length;
  }

  writeU32(vendor.length);
  writeBytes(vendor);
  writeU32(encodedComments.length);
  for (final comment in encodedComments) {
    writeU32(comment.length);
    writeBytes(comment);
  }
  return out;
}

Uint8List _picturePayload(Uint8List pictureBytes) {
  final mime = ascii.encode('image/jpeg');
  final length =
      4 + 4 + mime.length + 4 + 4 + 4 + 4 + 4 + 4 + pictureBytes.length;
  final out = Uint8List(length);
  var offset = 0;

  void writeU32(int value) {
    out[offset++] = (value >> 24) & 0xFF;
    out[offset++] = (value >> 16) & 0xFF;
    out[offset++] = (value >> 8) & 0xFF;
    out[offset++] = value & 0xFF;
  }

  writeU32(3);
  writeU32(mime.length);
  out.setRange(offset, offset + mime.length, mime);
  offset += mime.length;
  writeU32(0);
  writeU32(0);
  writeU32(0);
  writeU32(0);
  writeU32(0);
  writeU32(pictureBytes.length);
  out.setRange(offset, offset + pictureBytes.length, pictureBytes);
  return out;
}

// Captured production-side TX response: `trans` field for songID=203014070
// ("願い〜あの頃のキミへ〜 (祈愿~致那个时候的你～)" by 當山みれい), QRC-encrypted
// hex from a `crypt: 1` PlayLyricInfo call. Used as a golden sample to lock
// down the custom DES tables + hardcoded subkeys.
const String _kTxTransGoldenHex =
    'B0CC62EF7D37B07CFC8D3FD793DFF8373C0F55C090CB5B36F6E2090B769B9227'
    'DFB103B1873F33A25781172961B139CA3A26BB8E783BBDFA907F2D6D8DA5B071'
    '865AB0B9F1FE7FF98794D32466BAC57ADF38F7B6E3E56E3139D125A6219D2B3B'
    '949CF8E4809E2F69F8BF28CD041B8F0509C4095FE6485D1A4511998653CA1114'
    'C5B8260B6D25C59316E46EADFEC20A61CC608A05B9DE4F850A8963FB1BE4260C'
    'BF6EE2EFE632761FDF15F3858DDDC15AF9DAE3C177CE68CF19972EF15CBD8E3A'
    '52DB2C75D2DBC2B64CB16BDA4144834C1E91D37BB82C92A06926A45CFFD4CFAB'
    '0CC92C0C7831B4888F8B9F81AB125D0D18E4DFB6FC2ECB6DE9ACF8A28B3DE4B7'
    '13D7A7E5C44BECD65244A418ED36BD9409C141198CD05FFD2814E3A3D7403928'
    '6033029EEB2AFAD3DC79DA40B84992CF991F424E500DFD291D51788A5A0216BE'
    '749F30B51DE24C63DF1A459D5BA35695D6104A29B805689B775A848EC55D298C'
    'DC17A3D0587E81AD7100A1E3782AECB797E6F1974E9D6DECE75EE203CD72F55D'
    '1229DC723D562F4777EDEC3C725209C7C01B67931FE03506840F683B4C1DBB2A'
    '47E2352C72FD56DE0605A90C6DF4583DF8DC87C0DE0F60347DAB6FDA5B68C5C8'
    'DABD64E7D68176315FCB81CFBE5DFA0A744C892174CC08097B1C005E229BEB4F'
    '595440AE80AA8E3DDCCD87B943CF6CC114FBD1FD66932F716A6936D2FE6DA781'
    '41D225861FC4E8543666A44010616BE86E4E09A3114B5176D3B534C69C37F75C'
    '82C3518760123592F411EE923C3E5F7470E9B1F8BA4A70723C4A49B20CCA0613'
    '86517F8E4C7831C9EE3D546932DE41AB0AE0E8186CE650D1531857A895EBE9A2'
    '382131079691B77450B1FEB91B4343D0FC8637F97D6C6E97BE73C424C827E789'
    'B1584A070DBAB0FF1606E254778094FBCE4092400FC2E6B133444C1A38D68772'
    '4E2B80BEC92F9EB5D25488A32D358727A9E0EB68798E9B31760A99E96C2B4BC2'
    '52DF49B5A04D8C52825644BD64E1978C6950348BD10308CB5FD85FFFCFC2B5C4'
    '214FED43BC5012F20DB2D10503A4E916F1AFE52685A3E7E3AAB6BF88FB6D4D02'
    '89D11A3618B6C44A048321D5BA32D1238F8832616D1E44E2C7303D25624618D0'
    '3B45A200F4C7A4EE9B1747934A581BD4DA9F282ACFECD74CEAB722B66686C761'
    '54BF7A65BD3994CF996F9FE8BD61F6117724515AEA6157263CEC09863B3D4C4F'
    'DD3513A74CC504760D454F32F439805720BC9D605A6BFA3AC191C12DEE1E212A'
    '19F7BB9CFBE6BE21DF138A2175929043D5F5DC860939F43E131851600D0ACAF5'
    'F8A6FC72E4A7E4B2A2141C6B01C8D7F653FE1DBC2E94798CB41751C75F9BD59F'
    'A233BF7EA2A96E2FC1CFF0BEFFBC8C8159BA5078137619FDC4B2401A9C096794'
    '43DFE0A22F4EFFDC65674A182688CED035D39811856F7659F9BF89B222340BE0'
    '120A59A65F5B9FA0F5813E9EC2C28FAA2556071F6D7D91B0E6F93EAF4189E59F'
    'F83A3D4E9DBB2BEB0C79843DEA42ED9071D4A6A7778F5F37F7FE6DF5757FF270'
    '46A5F8A26A09660224387AABD212B552F79B99059F82BC9C9EB47160908C8BC7'
    '51D0D97339C70FF93704AFE4331C1D1CB5E5B5D45C011A7CD207CEC19DC964A9'
    '2DF6849CCDF92C251937918CA496897003449AC4D0D866C9D60337190D236EC3'
    '2EBFE68F2767213188701C8B71CF644CF61799C7122D0C0818FAC67502F7D3E8'
    '23071C3E425FA2EA8DD397935B1A3A8450346CEEB4ACBCC49D1A600380844993'
    'E290CE14F0AECB147A9B45A9B8B693B2FF42C56663E94ACED5ED6F8B5937E5F6'
    'FF2818BC7659261F6141CF691A1F310128C9DFA8DA2A3FC1DAF51C52AE813FDD'
    'BDA2798E438990E5CEFE29FDC9D73D3B5601608D3FD61D5469A4DBE20590AF09'
    '299393110EA497D4AAA42EB534D50E1C42DDC2A2CB8D393A9B44BA68FD4DB018'
    '4B58741AE3AA3176EA0A8AE453071C0BC371781C95DC3CA8C29662A6871B96F2'
    '18C7D820CFD454B145FA80A603865F5EF651C4448DDD4EA99C8413D681702FF4'
    '36DBACAAEB7ED672EA9B30A795CCAD9B173851BED6A596A4F7E6281F8FA38EA0'
    'EA28B7DBFFB9AE7CA2F921061E8C3A5A63056038EDE762494775580C5932F081'
    'FF01725F47D6635A245AE5C03B6DE8C84F5ED3B217644FF0856710BBB7D356BE'
    '538AE5A36A17A5CD92E55596C28B2D0F72E7898421B4B6395DA5848E1B2C94FB'
    '53F7B650CC467909BC4DF7735B18522F2FAB6965E2349606BB9BDDBA2F551F6D'
    'D3E5A64A362A627524E91F1AD11EADCAB7A30AEB18754C76F9C7E719ED93E509'
    '8A68DBBA93D595FF9C974E11EF35DEC72A87129BC1EBF1FE263D27BFA06CEDAA'
    '376C7C05BDDFA24335D28FA785F0A4CA9DEF337F2792B8C54BDD587C3A5CA2D8'
    'DD3648450A241BEB688AFD37B8657BDF8422F27408BC7DAC9DA7D980E54FDBA9'
    '6E15E577BC83C4D290FEA4E6E1869E9D5C5F4529BF02E2AE68019C04DAA092FC'
    '78CAC3B990CF3E7B46221162AE4FF96C06F389CD164A7BEA2FD90EEA02694569'
    '8BDC5B11666FD86A2E94C8DC63BF053902B6300F83693C9DF7EAF2294216056'
    '7449479EEE36C8CD72F1AD91DA1D0F3934EDAC02E24C4DE820CAE7A6C59ED372'
    '31609089D4A51E423A7918AEFAFEFB50FEB4BE446191F83D509400023148505D'
    '7E5A1C27A6920432065B63C41257D9D3B5FA44E3429C5D29FB3362C3D94CEBB4'
    '70FD2D7FEB479B917E203DE94599E58BB6010E26E28D08FF758CAAFC8992C5D1'
    'B790D56F3FCA218038156F29D068096D87BF9AA3E39694B1ABC75F063A432AE5'
    'BFC62A4FD59AD93F71BE2920C54B968CC1FC0840C82843E52BE8146AFD489BF4'
    'F82F491BEF0F75484B4BAD4D4ABB56C160F3DDE614E6715C7736BDC5DAC38A34'
    '51885E903C17AADDD0A2F4B4FA9713F465C8B40A1A66105043339D7769D53D45'
    '40DDC9A934FD05327A5BA61629AF1E9292651659AFB28FC7B26E1AAC99AA2E96'
    'E2D93632B3DE0A74617F525999D2B3E685DEC60CD19F9457D5D5D8932E3B5149'
    'CFB1E98A7A03F43C6C0435767B340CFF3AD687E2699ADF47B7E724AE76C1B505'
    '7';
