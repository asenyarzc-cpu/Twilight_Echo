// Inspect picUrl from KW/KG/WY/MG/TX search results to find why some sources
// do not display covers in the Android UI.
//
//   dart test test/diag_covers.dart -r expanded

import 'package:test/test.dart';

import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/sdk/kg_sdk.dart';
import 'package:twilight_echo/core/sdk/kw_sdk.dart';
import 'package:twilight_echo/core/sdk/mg_sdk.dart';
import 'package:twilight_echo/core/sdk/tx_sdk.dart';
import 'package:twilight_echo/core/sdk/wy_sdk.dart';

void main() {
  Future<void> probe(
    String name,
    Future<List<MusicInfo>> Function() doSearch,
  ) async {
    try {
      final list = await doSearch();
      print('[$name] ${list.length} results');
      for (final m in list.take(3)) {
        print('  $name | ${m.name} - ${m.singer}');
        print('     picUrl=${m.meta.picUrl}');
      }
    } catch (e) {
      print('[$name] FAILED: $e');
    }
  }

  test('Cover URL audit across all sources', () async {
    const keyword = 'Jay Chou';
    await probe('KW', () => KwSdk.search(keyword));
    await probe('KG', () => KgSdk.search(keyword));
    await probe('MG', () => MgSdk.search(keyword));
    await probe('WY', () => WySdk.search(keyword));
    await probe('TX', () => TxSdk.search(keyword));
  });
}

// ignore_for_file: avoid_print
