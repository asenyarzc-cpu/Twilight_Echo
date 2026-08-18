// Standalone diagnostic: probes the NetEase eapi lyric/v1 endpoint for the
// word-timed `yrc` track, using the same eapi envelope as WySdk.
//
//   dart run test/diag_wy_yrc.dart [songId]

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:twilight_echo/core/sdk/internal/crypto_util.dart';
import 'package:twilight_echo/core/sdk/internal/wy_yrc.dart';

final Uint8List _eapiKey = Uint8List.fromList(utf8.encode('e82ckenh8dichen8'));

Map<String, String> _eapi(String path, Object payload) {
  final text = payload is String ? payload : jsonEncode(payload);
  final message = 'nobody${path}use${text}md5forencrypt';
  final digest = CryptoUtil.md5Hex(message);
  final data = '$path-36cd479b6b5-$text-36cd479b6b5-$digest';
  final encrypted = CryptoUtil.aesEncryptEcbPkcs7(
    Uint8List.fromList(utf8.encode(data)),
    _eapiKey,
  );
  return {'params': CryptoUtil.bytesToHex(encrypted, upper: true)};
}

Future<void> main(List<String> args) async {
  final songId = args.isNotEmpty ? args.first : '2652820720'; // 晴天
  const path = '/api/song/lyric/v1';
  final form = _eapi(path, {
    'id': songId,
    'cp': false,
    'tv': -1,
    'lv': -1,
    'rv': -1,
    'kv': -1,
    'yv': -1,
    'ytv': -1,
    'yrv': -1,
  });

  final client = HttpClient();
  final request = await client.postUrl(
    Uri.parse('https://interface3.music.163.com/eapi/song/lyric/v1'),
  );
  request.headers.set('Content-Type', 'application/x-www-form-urlencoded');
  request.headers.set('origin', 'https://music.163.com');
  request.headers.set('Cookie', 'os=pc; appver=2.10.13');
  request.headers.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  );
  request.write(
    form.entries
        .map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}')
        .join('&'),
  );
  final response = await request.close();
  final body = await response.transform(utf8.decoder).join();
  client.close();

  final json = jsonDecode(body) as Map;
  stdout.writeln('code: ${json['code']}');
  stdout.writeln('keys: ${json.keys.toList()..sort()}');
  for (final key in ['yrc', 'klyric']) {
    final track = json[key]?['lyric']?.toString() ?? '';
    stdout.writeln('$key present: ${track.isNotEmpty} (len ${track.length})');
    if (track.isNotEmpty) {
      for (final line in const LineSplitter().convert(track).take(3)) {
        stdout.writeln(
          '$key| ${line.length > 110 ? line.substring(0, 110) : line}',
        );
      }
    }
  }
  final yrc = json['yrc']?['lyric']?.toString() ?? '';
  if (yrc.isNotEmpty) {
    final lines = const LineSplitter().convert(yrc);
    for (final line in lines.take(4)) {
      stdout.writeln(
        'yrc| ${line.length > 110 ? line.substring(0, 110) : line}',
      );
    }
    final lx = wyYrcToLxLyric(yrc);
    stdout.writeln(
      'lxlyric lines: ${lx == null ? 0 : LineSplitter.split(lx).length}',
    );
    if (lx != null) {
      for (final line in LineSplitter.split(lx).take(3)) {
        stdout.writeln(
          'lx | ${line.length > 110 ? line.substring(0, 110) : line}',
        );
      }
    }
  }
}
