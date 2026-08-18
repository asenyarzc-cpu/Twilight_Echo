import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:native_dio_adapter/native_dio_adapter.dart';

const String kMobileUserAgent =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

enum NetworkAdapterMode {
  system('system', '自动（推荐）', '按平台选择稳定适配器'),
  io('io', 'Dio IO', '兼容性最好'),
  native('native', 'Native', '使用高性能Cronet,部分设备不可用');

  const NetworkAdapterMode(this.code, this.label, this.description);

  final String code;
  final String label;
  final String description;

  static NetworkAdapterMode fromCode(String? code) {
    for (final mode in values) {
      if (mode.code == code) return mode;
    }
    return system;
  }
}

class NetworkAdapterPreference {
  const NetworkAdapterPreference._();

  static NetworkAdapterMode current = NetworkAdapterMode.system;
}

Dio createDio(BaseOptions options, {NetworkAdapterMode? adapterMode}) {
  final dio = Dio(options);
  configurePlatformAdapter(dio, adapterMode: adapterMode);
  return dio;
}

void configurePlatformAdapter(Dio dio, {NetworkAdapterMode? adapterMode}) {
  dio.httpClientAdapter = createPlatformAdapter(adapterMode: adapterMode);
}

HttpClientAdapter createPlatformAdapter({NetworkAdapterMode? adapterMode}) {
  final mode = adapterMode ?? NetworkAdapterPreference.current;
  switch (mode) {
    case NetworkAdapterMode.system:
      return _createSystemAdapter();
    case NetworkAdapterMode.io:
      return IOHttpClientAdapter();
    case NetworkAdapterMode.native:
      return _createNativeAdapter();
  }
}

HttpClientAdapter _createSystemAdapter() {
  if (Platform.isAndroid || Platform.isWindows || Platform.isLinux) {
    return IOHttpClientAdapter();
  }
  if (Platform.isIOS || Platform.isMacOS) {
    return _createNativeAdapter();
  }
  return IOHttpClientAdapter();
}

HttpClientAdapter _createNativeAdapter() {
  if (Platform.isIOS || Platform.isMacOS) {
    return NativeAdapter(
      createCupertinoConfiguration: () =>
          URLSessionConfiguration.ephemeralSessionConfiguration(),
    );
  }
  if (Platform.isAndroid) return NativeAdapter();
  // native_dio_adapter is only useful on mobile/apple platforms here. Keep
  // desktop on dart:io even if the experimental option is selected.
  if (Platform.isWindows || Platform.isLinux || Platform.isMacOS) {
    return IOHttpClientAdapter();
  }
  return NativeAdapter();
}

String currentNetworkAdapterLabel() {
  final mode = NetworkAdapterPreference.current;
  final platform = Platform.operatingSystem;
  final backend = switch (mode) {
    NetworkAdapterMode.system =>
      Platform.isIOS || Platform.isMacOS ? 'native' : 'io',
    NetworkAdapterMode.io => 'io',
    NetworkAdapterMode.native =>
      Platform.isAndroid || Platform.isIOS || Platform.isMacOS
          ? 'native'
          : 'io',
  };
  return '${mode.code}/$backend/$platform';
}
