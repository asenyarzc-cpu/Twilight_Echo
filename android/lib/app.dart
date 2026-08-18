import 'dart:async';

// CorePalette is still the public Android palette returned by dynamic_color
// 1.8.x, even though material_color_utilities marks it deprecated internally.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dynamic_color/dynamic_color.dart';
import 'package:material_color_utilities/material_color_utilities.dart';

import 'core/services/app_logger.dart';
import 'core/services/permission_service.dart';
import 'core/storage/settings_store.dart';
import 'core/ui/app_toast.dart';
import 'features/downloads/download_history_store.dart';
import 'core/music_sources/music_source_controller.dart';
import 'features/player/player_controller.dart';
import 'features/songs/local_song_scan_cache.dart';
import 'features/startup/startup_gate.dart';
import 'features/update/app_update_prompt.dart';
import 'router.dart';
import 'theme/app_motion.dart';
import 'theme/app_theme.dart';
import 'theme/dynamic_color_scheme.dart';
import 'theme/dynamic_color_status.dart';
class TwilightEchoApp extends ConsumerStatefulWidget {
  const TwilightEchoApp({super.key});

  @override
  ConsumerState<TwilightEchoApp> createState() => _TwilightEchoAppState();
}

class _TwilightEchoAppState extends ConsumerState<TwilightEchoApp> {
  Future<CorePalette?>? _corePaletteFuture;
  String? _lastLoggedScheme;

  @override
  void initState() {
    super.initState();
    _corePaletteFuture = DynamicColorPlugin.getCorePalette();
    // Warm persisted library and player state behind the startup screen so
    // synchronous decoding and audio-source restoration stay off the first
    // interactive frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(downloadHistoryProvider);
      ref.read(musicSourceControllerProvider);
      ref.read(playerControllerProvider.notifier);
      final scanCache = ref.read(localSongScanCacheProvider);
      unawaited(
        scanCache.ensureScan(
          directory: ref.read(settingsProvider).localMusicDir,
        ),
      );
    });
  }

  Future<void> _onStartupReady() async {
    final canCheckForUpdate = await _checkPermission();
    if (!canCheckForUpdate) return;
    final context = rootNavigatorKey.currentContext;
    if (context == null || !context.mounted) return;
    await checkForAppUpdate(context, ref);
  }

  Future<bool> _checkPermission() async {
    final granted = await PermissionService.hasExternalStorageWrite();
    await AppLogger.write('app', 'startup permission status granted=$granted');
    if (granted) return true;
    // Wait one frame so the router has a chance to mount its home screen.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final ctx = rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) return false;
    final shouldRequest = await _showPermissionDialog(ctx);
    if (!shouldRequest) return true;

    final ok = await PermissionService.ensureExternalStorageWrite();
    await AppLogger.write(
      'app',
      'startup permission user-triggered granted=$ok',
    );
    final root = rootNavigatorKey.currentContext;
    if (root == null || !root.mounted) return false;
    showAppToast(
      root,
      ok ? '已授予存储权限' : '未授权，可在「设置→打开系统应用设置」手动开启',
      type: ok ? AppToastType.success : AppToastType.warning,
    );
    // Requesting all-files access can switch to system UI. Avoid showing an
    // update dialog behind it; the next cold start will check normally.
    return false;
  }

  Future<bool> _showPermissionDialog(BuildContext context) async {
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.folder_shared_outlined, size: 36),
            title: const Text('需要存储权限'),
            content: const Text(
              '为了把下载好的音乐保存到「音乐」目录，'
              '需要授予「所有文件访问」权限。\n\n',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('稍后再说'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('去授权'),
              ),
            ],
          ),
        ) ??
        false;
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);
    final themeMode = settings.themeMode;

    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        return FutureBuilder<CorePalette?>(
          future: _corePaletteFuture,
          builder: (context, snapshot) {
            final corePalette = snapshot.data;
            final lightScheme = corePalette == null
                ? lightDynamic
                : DynamicColorScheme.fromCorePalette(
                    corePalette,
                    brightness: Brightness.light,
                  );
            final darkScheme = corePalette == null
                ? darkDynamic
                : DynamicColorScheme.fromCorePalette(
                    corePalette,
                    brightness: Brightness.dark,
                  );

            final dynamicSeed = lightScheme?.primary ?? darkScheme?.primary;
            WidgetsBinding.instance.addPostFrameCallback((_) {
              final next = DynamicColorStatus(
                available: dynamicSeed != null,
                seed: dynamicSeed,
              );
              final current = ref.read(dynamicColorStatusProvider);
              if (current.available != next.available ||
                  current.seed?.toARGB32() != next.seed?.toARGB32()) {
                ref.read(dynamicColorStatusProvider.notifier).state = next;
              }
            });

            final useDynamicScheme =
                settings.useDynamicColor &&
                lightScheme != null &&
                darkScheme != null;
            final lightTheme = useDynamicScheme
                ? AppTheme.fromScheme(lightScheme)
                : AppTheme.light(settings.themeSeed);
            final darkTheme = useDynamicScheme
                ? AppTheme.fromScheme(darkScheme)
                : AppTheme.dark(settings.themeSeed);
            final isDark = switch (themeMode) {
              ThemeMode.light => false,
              ThemeMode.dark => true,
              ThemeMode.system =>
                MediaQuery.platformBrightnessOf(context) == Brightness.dark,
            };
            _logColorSchemeOnce(
              useDynamicScheme ? (isDark ? darkScheme : lightScheme) : null,
              fromCorePalette: corePalette != null,
            );
            SystemChrome.setSystemUIOverlayStyle(
              SystemUiOverlayStyle(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: Colors.transparent,
                systemNavigationBarDividerColor: Colors.transparent,
                systemStatusBarContrastEnforced: false,
                systemNavigationBarContrastEnforced: false,
                statusBarIconBrightness: isDark
                    ? Brightness.light
                    : Brightness.dark,
                statusBarBrightness: isDark
                    ? Brightness.dark
                    : Brightness.light,
                systemNavigationBarIconBrightness: isDark
                    ? Brightness.light
                    : Brightness.dark,
              ),
            );

            return MaterialApp.router(
              title: 'Twilight Echo',
              debugShowCheckedModeBanner: false,
              themeAnimationDuration: AppMotion.long,
              themeAnimationCurve: AppMotion.emphasized,
              themeMode: themeMode,
              theme: lightTheme,
              darkTheme: darkTheme,
              routerConfig: appRouter,
              builder: (context, child) {
                return AppToastOverlay(
                  child: StartupGate(
                    onReady: _onStartupReady,
                    child: child ?? const SizedBox.shrink(),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  void _logColorSchemeOnce(
    ColorScheme? scheme, {
    required bool fromCorePalette,
  }) {
    if (scheme == null) return;
    final signature =
        '${scheme.brightness}:${scheme.primary.toARGB32()}:'
        '${scheme.surfaceContainerHigh.toARGB32()}:$fromCorePalette';
    if (_lastLoggedScheme == signature) return;
    _lastLoggedScheme = signature;
    AppLogger.write(
      'theme',
      'dynamic=$fromCorePalette brightness=${scheme.brightness.name} '
          'surface=${_hex(scheme.surface)} '
          'surfaceContainerHigh=${_hex(scheme.surfaceContainerHigh)} '
          'primary=${_hex(scheme.primary)} '
          'primaryContainer=${_hex(scheme.primaryContainer)}',
    );
  }

  String _hex(Color color) {
    return '#${color.toARGB32().toRadixString(16).padLeft(8, '0').substring(2).toUpperCase()}';
  }
}
