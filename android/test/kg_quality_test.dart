import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/sdk/internal/kg_quality.dart';

void main() {
  const baseHash = '8141FAA45AAD5BCFF5FF9873B89709E3';

  test('builds the verified Kugou Android signature over the exact body', () {
    final body = encodeKgPrivilegeRequestBody(const [
      KgPrivilegeResource(hash: baseHash, albumId: 0),
    ]);
    final signature = buildKgPrivilegeSignature(const {
      'appid': '1005',
      'clienttime': '1785420000',
      'clientver': '20489',
      'dfid': '-',
      'mid': '0123456789abcdef0123456789abcdef',
      'uuid': '-',
    }, body);

    expect(signature, '5fae9924263c6d6aa7fcc1a02f8d85d1');
  });

  test('parses Kugou batch details with a distinct hash for each quality', () {
    final details = parseKgPrivilegeQualityDetails(
      jsonEncode({
        'status': 1,
        'error_code': 0,
        'data': [
          {
            'hash': baseHash.toLowerCase(),
            'relate_goods': [
              _good('128', 3843167, baseHash),
              _good('320', 9607864, 'HASH_320'),
              _good('flac', 26174554, 'HASH_FLAC'),
              _good('high', 50331648, 'HASH_HIRES'),
              _good('viper_atmos', 56288830, 'HASH_ATMOS'),
              _good('viper_clear', 102927104, 'HASH_MASTER'),
              _good('super', 200000000, 'IGNORED'),
            ],
          },
        ],
      }),
    );
    final options = details[baseHash]!;
    final byType = {for (final option in options) option.type: option};

    expect(options.map((option) => option.type), [
      Quality.master,
      Quality.atmos,
      Quality.hires,
      Quality.flac,
      Quality.k320,
      Quality.k128,
    ]);
    expect(byType[Quality.master]?.size, '98.16M');
    expect(byType[Quality.master]?.hash, 'HASH_MASTER');
    expect(byType[Quality.atmos]?.size, '53.68M');
    expect(byType[Quality.atmos]?.hash, 'HASH_ATMOS');
    expect(byType[Quality.hires]?.size, '48.00M');
    expect(byType[Quality.hires]?.hash, 'HASH_HIRES');
    expect(byType[Quality.flac]?.size, '24.96M');
    expect(byType[Quality.flac]?.hash, 'HASH_FLAC');
    expect(byType[Quality.k320]?.size, '9.16M');
    expect(byType[Quality.k320]?.hash, 'HASH_320');
    expect(byType[Quality.k128]?.size, '3.67M');
    expect(byType[Quality.k128]?.hash, baseHash);
  });

  test('parses a cover from the string response used by Kugou', () {
    final cover = parseKgPrivilegeCoverUrl(
      jsonEncode({
        'status': 1,
        'error_code': 0,
        'data': [
          {
            'info': {
              'image': 'http://imge.kugou.com/stdmusic/{size}/cover.png',
              'imgsize': [480, 400, 240],
            },
          },
        ],
      }),
    );

    expect(cover, 'http://imge.kugou.com/stdmusic/480/cover.png');
  });

  test('merges detail results without dropping search-response fallbacks', () {
    final merged = mergeKgQualityOptions(
      const [
        QualityOption(type: Quality.k128, size: '3.67M', hash: 'BASE'),
        QualityOption(type: Quality.hires, size: '40.00M', hash: 'OLD_HIGH'),
      ],
      const [
        QualityOption(type: Quality.k128, size: '3.68M', hash: 'DETAIL'),
        QualityOption(type: Quality.master, size: '98.16M', hash: 'MASTER'),
      ],
    );
    final byType = {for (final option in merged) option.type: option};

    expect(byType[Quality.k128]?.hash, 'DETAIL');
    expect(byType[Quality.hires]?.hash, 'OLD_HIGH');
    expect(byType[Quality.master]?.hash, 'MASTER');
  });
}

Map<String, Object> _good(String quality, int filesize, String hash) => {
  'quality': quality,
  'hash': hash,
  'info': {'filesize': filesize, 'bitrate': 0, 'extname': ''},
};
