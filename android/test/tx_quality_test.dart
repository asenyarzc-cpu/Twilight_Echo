import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/sdk/internal/tx_quality.dart';

void main() {
  test('parses all QQ search quality sizes without probing media URLs', () {
    final options = parseTxQualityOptions(
      fileData: {
        'size_128mp3': 3843167,
        'size_320mp3': 9607864,
        'size_flac': 26174554,
        'size_hires': 0,
        'size_new': [159023510, 25832444, 66663065],
      },
      versions: const ['BASE_VERSION', '', '', 'MASTER_MID', 'ATMOS_MID'],
    );
    final byType = {for (final option in options) option.type: option};

    expect(byType[Quality.k128]?.size, '3.67M');
    expect(byType[Quality.k320]?.size, '9.16M');
    expect(byType[Quality.flac]?.size, '24.96M');
    expect(byType, isNot(contains(Quality.flac24bit)));
    expect(byType[Quality.master]?.size, '151.66M');
    expect(byType[Quality.master]?.mediaInfo, 'MASTER_MID');
    expect(byType[Quality.atmosPlus]?.size, '63.57M');
    expect(byType[Quality.atmosPlus]?.mediaInfo, 'ATMOS_MID');
    expect(byType[Quality.atmos]?.size, '24.64M');
    expect(byType[Quality.atmos]?.mediaInfo, 'ATMOS_MID');
  });

  test('requires the matching QQ version MID for size_new formats', () {
    final options = parseTxQualityOptions(
      fileData: {
        'size_new': [2097152, 3145728, 4194304],
      },
      versions: const ['', '', '', 'MASTER_MID'],
    );

    expect(options.map((option) => option.type), [Quality.master]);
    expect(options.single.size, '2.00M');
  });

  test('ignores zero, non-numeric, and truncated QQ size arrays', () {
    final options = parseTxQualityOptions(
      fileData: {
        'size_128mp3': 0,
        'size_320mp3': 'not-a-number',
        'size_new': [0, 'bad'],
      },
      versions: const ['', '', '', 'MASTER_MID', 'ATMOS_MID'],
    );

    expect(options, isEmpty);
  });
}
