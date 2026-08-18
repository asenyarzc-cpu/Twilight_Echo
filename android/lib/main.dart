import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/debug/debug_paint_guard.dart';
import 'core/storage/settings_store.dart';
import 'features/player/player_audio_handler.dart';

/// 应用入口。
///
/// 初始化顺序：Flutter 绑定 → 调试 Paint 保护 → Android 全屏 →
/// SharedPreferences 加载 → 网络适配器偏好 → 音频 Handler → ProviderScope。
///
/// 音频 Handler 是最耗时的异步步骤，在启动页显示时完成后才解除 Gate。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  DebugPaintGuard.install();
  if (Platform.isAndroid) {
    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.transparent,
        systemNavigationBarDividerColor: Colors.transparent,
        systemStatusBarContrastEnforced: false,
        systemNavigationBarContrastEnforced: false,
      ),
    );
    await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  }
  final prefs = await SharedPreferences.getInstance();
  hydrateNetworkAdapterPreference(prefs);
  final audioHandler = await initializePlayerAudioHandler();
  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        playerAudioHandlerProvider.overrideWithValue(audioHandler),
      ],
      child: const TwilightEchoApp(),
    ),
  );
}
