import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/sdk/internal/wy_quality.dart';

void main() {
  test(
    'builds NetEase batch values as JSON strings with unique slash keys',
    () {
      final payload = buildWyQualityBatchPayload([
        2648947831,
        '2122266590',
        null,
        'not-a-song',
        1961340800,
      ]);

      expect(payload, {
        '/api/song/music/detail/get': '{"songId":2648947831}',
        '/api/song/music/detail/get/': '{"songId":2122266590}',
        '/api/song/music/detail/get//': '{"songId":1961340800}',
      });
      expect(payload.values, everyElement(isA<String>()));
    },
  );

  test('parses all seven NetEase quality-detail fields and direct sizes', () {
    final options = parseWyQualityDetail({
      'code': 200,
      'data': {
        'songId': 2648947831,
        'l': {'size': 4320813},
        'h': {'size': 10801965},
        'sq': {'size': 13086123},
        'hr': {'size': 34821887},
        'je': {'size': 75733076},
        'sk': {'size': 19096709},
        'jm': {'size': 101734762},
      },
    });
    final byType = {for (final option in options) option.type: option};

    expect(options.map((option) => option.type), [
      Quality.master,
      Quality.atmosPlus,
      Quality.atmos,
      Quality.hires,
      Quality.flac,
      Quality.k320,
      Quality.k128,
    ]);
    expect(byType[Quality.master]?.size, '97.02M');
    expect(byType[Quality.atmosPlus]?.size, '18.21M');
    expect(byType[Quality.atmos]?.size, '72.22M');
    expect(byType[Quality.hires]?.size, '33.21M');
    expect(byType[Quality.flac]?.size, '12.48M');
    expect(byType[Quality.k320]?.size, '10.30M');
    expect(byType[Quality.k128]?.size, '4.12M');
  });

  test('indexes batch quality details by returned NetEase songId', () {
    final details = parseWyBatchQualityDetails({
      'code': 200,
      '/api/song/music/detail/get': {
        'code': 200,
        'data': {
          'songId': 2648947831,
          'l': {'size': 4320813},
          'jm': {'size': 101734762},
        },
      },
      '/api/song/music/detail/get/': {
        'code': 404,
        'data': {'songId': 2122266590},
      },
    });

    expect(details.keys, ['2648947831']);
    expect(details['2648947831']?.map((option) => option.type), [
      Quality.master,
      Quality.k128,
    ]);
  });

  test('keeps fallback options when a detail response is partial', () {
    final merged = mergeWyQualityOptions(
      const [
        QualityOption(type: Quality.k128, size: '4.00M'),
        QualityOption(type: Quality.flac, size: '12.00M'),
      ],
      const [
        QualityOption(type: Quality.k128, size: '4.12M'),
        QualityOption(type: Quality.master, size: '97.02M'),
      ],
    );
    final byType = {for (final option in merged) option.type: option};

    expect(byType[Quality.k128]?.size, '4.12M');
    expect(byType[Quality.flac]?.size, '12.00M');
    expect(byType[Quality.master]?.size, '97.02M');
  });
}
