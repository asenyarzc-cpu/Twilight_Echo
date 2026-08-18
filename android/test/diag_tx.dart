// Standalone diagnostic: hits TX (QQ Music) search + tip directly from
// desktop Dart, prints what we get back.
//
//   dart test test/diag_tx.dart -r expanded

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:test/test.dart';

import 'package:twilight_echo/core/sdk/internal/crypto_util.dart';
import 'package:twilight_echo/core/sdk/internal/sdk_http.dart';
import 'package:twilight_echo/core/sdk/tx_sdk.dart';

const _part1 = [23, 14, 6, 36, 16, 40, 7, 19];
const _part2 = [16, 1, 32, 12, 19, 27, 8, 5];
const _scramble = [
  89,
  39,
  179,
  150,
  218,
  82,
  58,
  252,
  177,
  52,
  186,
  123,
  120,
  64,
  242,
  133,
  143,
  161,
  121,
  179,
];

String zzcSignProbe(String text) {
  final hash = CryptoUtil.sha1Hex(text);
  String pick(List<int> indexes) =>
      indexes.map((i) => i < hash.length ? hash[i] : '').join();
  final scrambled = Uint8List(_scramble.length);
  for (var i = 0; i < _scramble.length; i++) {
    final pair = hash.substring(i * 2, i * 2 + 2);
    scrambled[i] = _scramble[i] ^ int.parse(pair, radix: 16);
  }
  final b64 = base64.encode(scrambled).replaceAll(RegExp(r'[\\/+=]'), '');
  return 'zzc${pick(_part1)}$b64${pick(_part2)}'.toLowerCase();
}

void main() {
  test('TX tip', () async {
    try {
      final tips = await TxSdk.tip('Jay Chou');
      print('[tx.tip] count=${tips.length}');
      for (final t in tips.take(5)) {
        print('  $t');
      }
      expect(tips, isNotEmpty);
    } catch (e, s) {
      print('[tx.tip] FAILED: $e');
      print(s);
      rethrow;
    }
  });

  test('TX search via SDK', () async {
    try {
      final list = await TxSdk.search('Jay Chou');
      print('[tx.search] count=${list.length}');
      for (final m in list.take(5)) {
        print(
          '  ${m.name} - ${m.singer} | '
          'qualitys=${m.meta.qualitys.map((q) => q.type.code).toList()}',
        );
      }
      expect(list, isNotEmpty);
    } catch (e, s) {
      print('[tx.search] FAILED: $e');
      print(s);
      rethrow;
    }
  });

  test('Raw TX POST with correct sign: dump full response', () async {
    final data = {
      'comm': {
        'ct': '11',
        'cv': '14090508',
        'v': '14090508',
        'tmeAppID': 'qqmusic',
        'phonetype': 'EBG-AN10',
        'deviceScore': '553.47',
        'devicelevel': '50',
        'newdevicelevel': '20',
        'rom': 'HuaWei/EMOTION/EmotionUI_14.2.0',
        'os_ver': '12',
        'OpenUDID': '0',
        'OpenUDID2': '0',
        'QIMEI36': '0',
        'udid': '0',
        'chid': '0',
        'aid': '0',
        'oaid': '0',
        'taid': '0',
        'tid': '0',
        'wid': '0',
        'uid': '0',
        'sid': '0',
        'modeSwitch': '6',
        'teenMode': '0',
        'ui_mode': '2',
        'nettype': '1020',
        'v4ip': '',
      },
      'req': {
        'module': 'music.search.SearchCgiService',
        'method': 'DoSearchForQQMusicMobile',
        'param': {
          'search_type': 0,
          'searchid': Random().nextInt(1 << 32).toString(),
          'query': 'Jay Chou',
          'page_num': 1,
          'num_per_page': 30,
          'highlight': 0,
          'nqc_flag': 0,
          'multi_zhida': 0,
          'cat': 2,
          'grp': 1,
          'sin': 0,
          'sem': 0,
        },
      },
    };
    final jsonBody = jsonEncode(data);
    final sign = zzcSignProbe(jsonBody);
    print('[tx.raw] sign=$sign');
    final result = await SdkHttp.fetch<dynamic>(
      'https://u.y.qq.com/cgi-bin/musics.fcg?sign=$sign',
      method: 'POST',
      headers: const {'User-Agent': 'QQMusic 14090508(android 12)'},
      body: data,
    );
    print('[tx.raw] status=${result.statusCode}');
    final body = result.body;
    print('[tx.raw] body type=${body.runtimeType}');
    final encoded = jsonEncode(body);
    print(
      '[tx.raw] body[0..min(2000,len)]='
      '${encoded.substring(0, encoded.length < 2000 ? encoded.length : 2000)}',
    );
    if (body is Map) {
      print('[tx.raw] top-level keys=${body.keys.toList()}');
      print('[tx.raw] code=${body['code']}');
      final req = body['req'];
      if (req is Map) {
        print('[tx.raw] req.code=${req['code']}');
        print('[tx.raw] req.data keys=${(req['data'] as Map?)?.keys.toList()}');
      }
    }
  });
}

// ignore_for_file: avoid_print
