import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/music_sources/music_source_metadata_parser.dart';
import 'package:twilight_echo/core/music_sources/music_source_models.dart';
import 'package:twilight_echo/core/music_sources/music_source_runtime.dart';
import 'package:twilight_echo/core/music_sources/music_url_resolver.dart';

void main() {
  test(
    'parses legacy metadata and keeps a stable identity across versions',
    () {
      final script = File(
        'test/fixtures/legacy_music_source_fixture.js',
      ).readAsStringSync();
      final metadata = parseMusicSourceMetadata(script);

      expect(metadata.name, 'Codex Runtime Fixture');
      expect(metadata.author, 'Codex');
      expect(metadata.version, '1.0.0');
      expect(
        musicSourceId(metadata),
        musicSourceId(
          const MusicSourceMetadata(
            name: 'Codex Runtime Fixture',
            author: 'Codex',
            version: '2.0.0',
          ),
        ),
      );
    },
  );

  test('rejects a script without required metadata', () {
    expect(
      () => parseMusicSourceMetadata('lx.send("inited", {})'),
      throwsFormatException,
    );
  });

  test('parses only supported musicUrl capabilities', () {
    final capabilities = MusicSourceRecord.parseRuntimeCapabilities({
      'sources': {
        'kw': {
          'actions': ['musicUrl'],
          'qualitys': ['128k', '320k', 'unknown'],
        },
        'tx': {
          'actions': ['lyric'],
          'qualitys': ['flac'],
        },
        'other': {
          'actions': ['musicUrl'],
          'qualitys': ['128k'],
        },
      },
    });

    expect(capabilities.keys, [MusicSource.kw]);
    expect(capabilities[MusicSource.kw], [Quality.k128, Quality.k320]);
  });

  test('quality selection falls back downward within the intersection', () {
    expect(
      chooseMusicSourceQuality(
        requested: Quality.hires,
        sourceQualities: const [Quality.hires, Quality.flac, Quality.k320],
        trackQualities: const [Quality.flac, Quality.k320],
      ),
      Quality.hires,
    );
    expect(
      chooseMusicSourceQuality(
        requested: Quality.hires,
        sourceQualities: const [Quality.flac, Quality.k320, Quality.k128],
        trackQualities: const [Quality.hires, Quality.flac, Quality.k320],
      ),
      Quality.flac,
    );
    expect(
      () => chooseMusicSourceQuality(
        requested: Quality.flac,
        sourceQualities: const [Quality.k128],
        trackQualities: const [Quality.flac],
      ),
      throwsA(isA<MusicSourceRuntimeException>()),
    );
  });

  test('quality fallback starts requested and only moves downward', () {
    expect(
      musicSourceQualityFallbacks(
        requested: Quality.master,
        sourceQualities: const [
          Quality.k128,
          Quality.atmos,
          Quality.master,
          Quality.atmosPlus,
        ],
      ),
      [Quality.master, Quality.atmosPlus, Quality.atmos, Quality.k128],
    );
    expect(
      musicSourceQualityFallbacks(
        requested: Quality.flac,
        sourceQualities: const [Quality.master, Quality.k320],
      ),
      [Quality.flac, Quality.k320],
    );
  });

  test('automatic downloads use the enabled sources highest quality', () {
    expect(
      highestMusicSourceQuality(
        sourceQualities: const [Quality.k128, Quality.flac, Quality.hires],
        trackQualities: const [Quality.k128, Quality.flac],
      ),
      Quality.hires,
    );
    expect(
      highestMusicSourceQuality(
        sourceQualities: const [],
        trackQualities: const [Quality.k320, Quality.flac],
      ),
      Quality.flac,
    );
  });
}
