import 'package:flutter_test/flutter_test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/sdk/internal/kw_quality.dart';

void main() {
  test('parses all seven Kuwo N_MINFO qualities and their direct sizes', () {
    const minfo =
        'level:zp,bitrate:20900,format:mflac,size:151.66Mb;'
        'level:zp,bitrate:20501,format:mflac,size:63.57Mb;'
        'level:zp,bitrate:20201,format:mflac,size:24.64Mb;'
        'level:hires,bitrate:4000,format:flac,size:72.11Mb;'
        'level:lossless,bitrate:2000,format:flac,size:24.96Mb;'
        'level:high,bitrate:320,format:mp3,size:9.16Mb;'
        'level:standard,bitrate:128,format:mp3,size:3.67Mb';

    final options = parseKwQualityOptions(minfo);
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
    expect(byType[Quality.master]?.size, '151.66MB');
    expect(byType[Quality.atmosPlus]?.size, '63.57MB');
    expect(byType[Quality.atmos]?.size, '24.64MB');
    expect(byType[Quality.hires]?.size, '72.11MB');
    expect(byType[Quality.flac]?.size, '24.96MB');
    expect(byType[Quality.k320]?.size, '9.16MB');
    expect(byType[Quality.k128]?.size, '3.67MB');
  });

  test('ignores unsupported, zero-sized, and duplicate Kuwo formats', () {
    final options = parseKwQualityOptions(
      'level:x,bitrate:25000,format:mflac,size:200Mb;'
      'level:x,bitrate:320,format:mp3,size:0Mb;'
      'size:9.16Mb,format:mp3,bitrate:320,level:high;'
      'level:x,bitrate:320,format:mp3,size:10.00Mb',
    );

    expect(options, hasLength(1));
    expect(options.single.type, Quality.k320);
    expect(options.single.size, '9.16MB');
  });
}
