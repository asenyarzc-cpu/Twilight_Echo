import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../storage/settings_store.dart';
import 'dio_factory.dart';

Dio _buildDio(NetworkAdapterMode adapterMode) => createDio(
  BaseOptions(
    connectTimeout: const Duration(seconds: 15),
    sendTimeout: const Duration(seconds: 30),
    receiveTimeout: const Duration(seconds: 60),
    headers: const {
      'Accept': 'application/json',
      'User-Agent': kMobileUserAgent,
    },
    contentType: 'application/json',
    responseType: ResponseType.json,
  ),
  adapterMode: adapterMode,
);

final apiClientProvider = Provider<Dio>((ref) {
  final adapterMode = ref.watch(
    settingsProvider.select((s) => s.networkAdapterMode),
  );
  final dio = _buildDio(adapterMode);
  ref.onDispose(dio.close);
  return dio;
});
