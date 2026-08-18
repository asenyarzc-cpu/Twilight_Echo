import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:material_symbols_icons/symbols.dart';

import '../../core/app_info.dart';
import '../../core/api/dio_factory.dart';
import '../../core/models/enums.dart';
import '../../core/music_sources/music_source_controller.dart';
import '../../core/services/permission_service.dart';
import '../../core/storage/settings_store.dart';
import '../../core/ui/app_toast.dart';
import '../../theme/dynamic_color_status.dart';
import '../shell/shell_toolbar_visibility.dart';
import '../songs/local_song_scan_cache.dart';
import '../update/app_update_prompt.dart';
import 'widgets/color_picker_sheet.dart';
import 'widgets/settings_action.dart';
import 'widgets/settings_menu.dart';
import 'widgets/storage_folder_picker_sheet.dart';
import 'widgets/theme_mode_row.dart';
import 'widgets/theme_seed_row.dart';

class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final sourceState = ref.watch(musicSourceControllerProvider);
    final dynamicColor = ref.watch(dynamicColorStatusProvider);
    final versionLabel = ref.watch(appVersionLabelProvider);
    final baseTheme = Theme.of(context);
    final scheme = baseTheme.colorScheme;

    return Theme(
      data: baseTheme.copyWith(scaffoldBackgroundColor: scheme.surface),
      child: Scaffold(
        backgroundColor: scheme.surface,
        body: CustomScrollView(
          key: const PageStorageKey('settings-scroll'),
          physics: const BouncingScrollPhysics(
            parent: AlwaysScrollableScrollPhysics(),
          ),
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(28, 2, 28, 118),
              sliver: SliverToBoxAdapter(
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 640),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SettingsCard(
                          title: '音源与网络',
                          children: [
                            SettingsAction(
                              icon: Symbols.audio_file,
                              title: '音源管理',
                              subtitle: sourceState.when(
                                data: (value) => value.primary == null
                                    ? '未启用音源'
                                    : '已启用 ${value.enabledIds.length} 个 · '
                                          '首选：${value.primary!.name}',
                                loading: () => '正在加载音源',
                                error: (_, _) => '音源状态读取失败',
                              ),
                              trailing: Symbols.chevron_right,
                              onTap: () => context.go('/settings/sources'),
                            ),
                            SettingsMenuAction(
                              key: const ValueKey('network-adapter-menu'),
                              menuId: 'network-adapter-menu',
                              icon: Icons.cable_rounded,
                              title: '网络适配器',
                              subtitle:
                                  '${settings.networkAdapterMode.label} · '
                                  '${settings.networkAdapterMode.description}',
                              options: [
                                for (final mode in NetworkAdapterMode.values)
                                  SettingsMenuOption(
                                    id: mode.code,
                                    label: mode.label,
                                    selected:
                                        mode == settings.networkAdapterMode,
                                    onSelected: () =>
                                        _setNetworkAdapter(context, ref, mode),
                                  ),
                              ],
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '搜索与播放',
                          children: [
                            SettingsMenuAction(
                              key: const ValueKey('search-source-menu'),
                              menuId: 'search-source-menu',
                              icon: Icons.manage_search_rounded,
                              title: '搜索源管理',
                              subtitle:
                                  '已启用 ${settings.enabledSearchSources.map((source) => source.label).join('、')}',
                              multiSelect: true,
                              options: [
                                for (final source in kManageableSearchSources)
                                  SettingsMenuOption(
                                    id: source.code,
                                    label: source.label,
                                    selected: settings.enabledSearchSources
                                        .contains(source),
                                    enabled:
                                        settings.enabledSearchSources.length !=
                                            1 ||
                                        !settings.enabledSearchSources.contains(
                                          source,
                                        ),
                                    onSelected: () => _setSearchSourceEnabled(
                                      context,
                                      ref,
                                      source,
                                      !settings.enabledSearchSources.contains(
                                        source,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                            SettingsMenuAction(
                              key: const ValueKey('online-quality-menu'),
                              menuId: 'online-quality-menu',
                              icon: Icons.high_quality_rounded,
                              title: '在线播放音质',
                              subtitle:
                                  '${settings.onlinePlaybackQuality.label} · '
                                  '${settings.onlinePlaybackQuality.description}',
                              options: [
                                for (final quality
                                    in OnlinePlaybackQuality.values)
                                  SettingsMenuOption(
                                    id: quality.code,
                                    label: quality.label,
                                    selected:
                                        quality ==
                                        settings.onlinePlaybackQuality,
                                    onSelected: () => _setOnlinePlaybackQuality(
                                      context,
                                      ref,
                                      quality,
                                    ),
                                  ),
                              ],
                            ),
                            SettingsSwitchAction(
                              key: const ValueKey('bluetooth-lyric-setting'),
                              icon: Icons.bluetooth_audio_rounded,
                              title: '显示蓝牙歌词',
                              subtitle: '将当前歌词行作为媒体标题发送到车机或蓝牙设备',
                              value: settings.bluetoothLyricEnabled,
                              onChanged: (value) => _setBluetoothLyricEnabled(
                                context,
                                ref,
                                value,
                              ),
                            ),
                            SettingsSwitchAction(
                              key: const ValueKey(
                                'bluetooth-full-lyric-setting',
                              ),
                              icon: Icons.lyrics_rounded,
                              title: '显示完整蓝牙歌词',
                              subtitle: '写入完整 LRC，需接收设备支持',
                              value: settings.bluetoothFullLyricEnabled,
                              onChanged: (value) =>
                                  _setBluetoothFullLyricEnabled(
                                    context,
                                    ref,
                                    value,
                                  ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '下载',
                          children: [
                            SettingsMenuAction(
                              key: const ValueKey(
                                'batch-download-quality-menu',
                              ),
                              menuId: 'batch-download-quality-menu',
                              icon: Icons.download_for_offline_rounded,
                              title: '批量下载音质',
                              subtitle:
                                  '${settings.batchDownloadQuality.label} · '
                                  '${settings.batchDownloadQuality.description}',
                              options: [
                                for (final quality
                                    in OnlinePlaybackQuality.values)
                                  SettingsMenuOption(
                                    id: quality.code,
                                    label: quality.label,
                                    selected:
                                        quality ==
                                        settings.batchDownloadQuality,
                                    onSelected: () => _setBatchDownloadQuality(
                                      context,
                                      ref,
                                      quality,
                                    ),
                                  ),
                              ],
                            ),
                            SettingsAction(
                              icon: Icons.folder_outlined,
                              title: '下载位置',
                              subtitle: settings.downloadDir,
                              trailing: Symbols.chevron_right,
                              onTap: () => _pickDownloadDir(context, ref),
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(4, 12, 8, 0),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Wrap(
                                  spacing: 10,
                                  runSpacing: 8,
                                  children: [
                                    FilledButton.tonalIcon(
                                      onPressed: () =>
                                          _resetDownloadDir(context, ref),
                                      icon: VariedIcon.varied(
                                        Symbols.restart_alt,
                                        size: 18,
                                        weight: 300,
                                      ),
                                      label: const Text('恢复默认'),
                                      style: FilledButton.styleFrom(
                                        minimumSize: const Size(0, 40),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 20,
                                          vertical: 10,
                                        ),
                                        shape: const StadiumBorder(),
                                      ),
                                    ),
                                    FilledButton.tonalIcon(
                                      onPressed: () =>
                                          _browseDownloadDir(context, ref),
                                      icon: const Icon(
                                        Icons.storage_rounded,
                                        size: 18,
                                      ),
                                      label: const Text('浏览U盘'),
                                      style: FilledButton.styleFrom(
                                        minimumSize: const Size(0, 40),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 20,
                                          vertical: 10,
                                        ),
                                        shape: const StadiumBorder(),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '本地音乐',
                          children: [
                            SettingsAction(
                              icon: Icons.library_music_outlined,
                              title: '扫描文件夹',
                              subtitle: settings.localMusicDir,
                              trailing: Symbols.chevron_right,
                              onTap: () => _pickLocalMusicDir(context, ref),
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(4, 12, 8, 0),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Wrap(
                                  spacing: 10,
                                  runSpacing: 8,
                                  children: [
                                    FilledButton.tonalIcon(
                                      onPressed: () =>
                                          _resetLocalMusicDir(context, ref),
                                      icon: const Icon(
                                        Icons.sync_rounded,
                                        size: 18,
                                      ),
                                      label: const Text('恢复为下载位置'),
                                      style: FilledButton.styleFrom(
                                        minimumSize: const Size(0, 40),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 20,
                                          vertical: 10,
                                        ),
                                        shape: const StadiumBorder(),
                                      ),
                                    ),
                                    FilledButton.tonalIcon(
                                      onPressed: () =>
                                          _browseLocalMusicDir(context, ref),
                                      icon: const Icon(
                                        Icons.storage_rounded,
                                        size: 18,
                                      ),
                                      label: const Text('浏览U盘'),
                                      style: FilledButton.styleFrom(
                                        minimumSize: const Size(0, 40),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 20,
                                          vertical: 10,
                                        ),
                                        shape: const StadiumBorder(),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '外观',
                          children: [
                            ThemeModeRow(value: settings.themeMode),
                            const SizedBox(height: 18),
                            ThemeSeedRow(
                              value: settings.themeSeed,
                              onPick: (color) => ref
                                  .read(settingsProvider.notifier)
                                  .setThemeSeed(color),
                              onCustomize: () => _pickThemeSeed(context, ref),
                            ),
                            const SizedBox(height: 18),
                            DynamicColorRow(
                              value: settings.useDynamicColor,
                              available: dynamicColor.available,
                              onChanged: (value) => ref
                                  .read(settingsProvider.notifier)
                                  .setUseDynamicColor(value),
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '关于',
                          children: [
                            SettingsAction(
                              key: const ValueKey('check-update-setting'),
                              icon: Icons.system_update_alt_rounded,
                              title: '检查更新',
                              subtitle: '当前版本：$versionLabel',
                              trailing: Symbols.chevron_right,
                              onTap: () => unawaited(
                                checkForAppUpdate(
                                  context,
                                  ref,
                                  showFeedback: true,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 30),
                        SettingsCard(
                          title: '调试',
                          children: [
                            DebugModeRow(
                              value: settings.debugMode,
                              onChanged: (value) => ref
                                  .read(settingsProvider.notifier)
                                  .setDebugMode(value),
                            ),
                            if (settings.debugMode) ...[
                              const SizedBox(height: 12),
                              SettingsAction(
                                icon: Icons.terminal_rounded,
                                title: '日志控制台',
                                subtitle: '实时查看搜索、下载和网络错误',
                                trailing: Symbols.chevron_right,
                                onTap: () => context.go('/debug'),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 72),
                        Text(
                          versionLabel,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: scheme.outline,
                            fontSize: 10,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 2,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _setBluetoothLyricEnabled(
    BuildContext context,
    WidgetRef ref,
    bool value,
  ) async {
    if (value) await _ensureBluetoothLyricNotice(context, ref);
    if (!context.mounted) return;
    await ref.read(settingsProvider.notifier).setBluetoothLyricEnabled(value);
  }

  Future<void> _setBluetoothFullLyricEnabled(
    BuildContext context,
    WidgetRef ref,
    bool value,
  ) async {
    if (value) await _ensureBluetoothLyricNotice(context, ref);
    if (!context.mounted) return;
    await ref
        .read(settingsProvider.notifier)
        .setBluetoothFullLyricEnabled(value);
  }

  Future<void> _ensureBluetoothLyricNotice(
    BuildContext context,
    WidgetRef ref,
  ) async {
    if (ref.read(settingsProvider).bluetoothLyricNoticeSeen) return;
    await showDialog<void>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.directions_car_filled_rounded),
        title: const Text('蓝牙歌词提示'),
        content: const Text(
          '蓝牙歌词通过媒体信息兼容发送，不同车机或蓝牙设备的支持情况可能不同。'
          '\n\n驾车时请勿操作手机，注意道路安全。',
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('我知道了'),
          ),
        ],
      ),
    );
    await ref.read(settingsProvider.notifier).markBluetoothLyricNoticeSeen();
  }

  Future<void> _resetDownloadDir(BuildContext context, WidgetRef ref) async {
    await ref
        .read(settingsProvider.notifier)
        .setDownloadDir(kDefaultDownloadDir);
    if (!context.mounted) return;
    showAppToast(context, '已恢复默认下载位置', type: AppToastType.success);
  }

  Future<void> _resetLocalMusicDir(BuildContext context, WidgetRef ref) async {
    final downloadDir = ref.read(settingsProvider).downloadDir;
    await ref.read(settingsProvider.notifier).setLocalMusicDir(downloadDir);
    unawaited(
      ref.read(localSongScanCacheProvider).refresh(directory: downloadDir),
    );
    if (!context.mounted) return;
    showAppToast(context, '已恢复为下载位置', type: AppToastType.success);
  }

  Future<void> _pickDownloadDir(BuildContext context, WidgetRef ref) async {
    final ok = await PermissionService.ensureExternalStorageWrite();
    if (!context.mounted) return;
    if (!ok) {
      showAppToast(context, '未授予存储权限，将无法写入公共目录', type: AppToastType.warning);
      return;
    }

    String? path;
    try {
      path = await FilePicker.platform.getDirectoryPath(
        dialogTitle: '选择下载目录',
        lockParentWindow: true,
      );
    } on PlatformException catch (_) {
      if (!context.mounted) return;
      path = await _showStorageFolderPicker(
        context,
        ref,
        title: '选择下载目录',
        initialPath: ref.read(settingsProvider).downloadDir,
      );
    }
    if (!context.mounted) return;
    if (path == null || path.isEmpty) return;

    if (!await _validateWritableDirectory(context, path)) return;
    await ref.read(settingsProvider.notifier).setDownloadDir(path);
    if (!context.mounted) return;
    showAppToast(context, '下载目录已切换到 $path', type: AppToastType.success);
  }

  Future<void> _browseDownloadDir(BuildContext context, WidgetRef ref) async {
    final ok = await PermissionService.ensureExternalStorageWrite();
    if (!context.mounted) return;
    if (!ok) {
      showAppToast(context, '未授予存储权限，将无法写入公共目录', type: AppToastType.warning);
      return;
    }

    final path = await _showStorageFolderPicker(
      context,
      ref,
      title: '选择下载目录',
      initialPath: ref.read(settingsProvider).downloadDir,
    );
    if (!context.mounted || path == null || path.isEmpty) return;

    if (!await _validateWritableDirectory(context, path)) return;
    await ref.read(settingsProvider.notifier).setDownloadDir(path);
    if (!context.mounted) return;
    showAppToast(context, '下载目录已切换到 $path', type: AppToastType.success);
  }

  Future<void> _pickLocalMusicDir(BuildContext context, WidgetRef ref) async {
    final ok = await PermissionService.ensureExternalStorageRead();
    if (!context.mounted) return;
    if (!ok) {
      showAppToast(context, '未授予存储权限，将无法读取本地音乐', type: AppToastType.warning);
      return;
    }

    String? path;
    try {
      path = await FilePicker.platform.getDirectoryPath(
        dialogTitle: '选择扫描文件夹',
        lockParentWindow: true,
      );
    } on PlatformException catch (_) {
      if (!context.mounted) return;
      path = await _showStorageFolderPicker(
        context,
        ref,
        title: '选择扫描文件夹',
        initialPath: ref.read(settingsProvider).localMusicDir,
      );
    }
    if (!context.mounted || path == null || path.isEmpty) return;

    await _applyLocalMusicDir(context, ref, path);
  }

  Future<void> _browseLocalMusicDir(BuildContext context, WidgetRef ref) async {
    final ok = await PermissionService.ensureExternalStorageRead();
    if (!context.mounted) return;
    if (!ok) {
      showAppToast(context, '未授予存储权限，将无法读取本地音乐', type: AppToastType.warning);
      return;
    }

    final path = await _showStorageFolderPicker(
      context,
      ref,
      title: '从U盘选择扫描文件夹',
      initialPath: ref.read(settingsProvider).localMusicDir,
    );
    if (!context.mounted || path == null || path.isEmpty) return;

    await _applyLocalMusicDir(context, ref, path);
  }

  Future<void> _applyLocalMusicDir(
    BuildContext context,
    WidgetRef ref,
    String path,
  ) async {
    if (!await _validateReadableDirectory(context, path)) return;
    await ref.read(settingsProvider.notifier).setLocalMusicDir(path);
    unawaited(ref.read(localSongScanCacheProvider).refresh(directory: path));
    if (!context.mounted) return;
    showAppToast(context, '本地音乐扫描文件夹已切换到 $path', type: AppToastType.success);
  }

  Future<String?> _showStorageFolderPicker(
    BuildContext context,
    WidgetRef ref, {
    required String title,
    required String initialPath,
  }) async {
    FocusManager.instance.primaryFocus?.unfocus();
    final toolbar = ref.read(shellToolbarVisibleProvider.notifier);
    final wasToolbarVisible = ref.read(shellToolbarVisibleProvider);
    toolbar.state = false;
    try {
      return await showStorageFolderPickerSheet(
        context,
        title: title,
        initialPath: initialPath,
      );
    } finally {
      if (toolbar.mounted) toolbar.state = wasToolbarVisible;
    }
  }

  Future<bool> _validateWritableDirectory(
    BuildContext context,
    String path,
  ) async {
    try {
      final dir = Directory(path);
      if (!dir.existsSync()) await dir.create(recursive: true);
      final probe = File('${dir.path}${Platform.pathSeparator}.twilight_echo_probe');
      await probe.writeAsString('ok');
      await probe.delete();
    } catch (e) {
      if (!context.mounted) return false;
      showAppToast(context, '该目录不可写: $e', type: AppToastType.error);
      return false;
    }
    return true;
  }

  Future<bool> _validateReadableDirectory(
    BuildContext context,
    String path,
  ) async {
    try {
      final dir = Directory(path);
      if (!await dir.exists()) {
        throw FileSystemException('目录不存在', path);
      }
      await dir.list(followLinks: false).take(1).drain<void>();
    } catch (e) {
      if (!context.mounted) return false;
      showAppToast(context, '该目录不可读取: $e', type: AppToastType.error);
      return false;
    }
    return true;
  }

  Future<void> _setNetworkAdapter(
    BuildContext context,
    WidgetRef ref,
    NetworkAdapterMode selected,
  ) async {
    final current = ref.read(settingsProvider).networkAdapterMode;
    if (selected == current) return;
    await ref.read(settingsProvider.notifier).setNetworkAdapterMode(selected);
    if (!context.mounted) return;
    final type = selected == NetworkAdapterMode.native
        ? AppToastType.warning
        : AppToastType.success;
    showAppToast(context, '网络适配器已切换为 ${selected.label}', type: type);
  }

  Future<void> _setSearchSourceEnabled(
    BuildContext context,
    WidgetRef ref,
    MusicSource source,
    bool? enabled,
  ) async {
    if (enabled == null) return;
    final changed = await ref
        .read(settingsProvider.notifier)
        .setSearchSourceEnabled(source, enabled);
    if (!changed && context.mounted) {
      showAppToast(context, '至少保留一个搜索源', type: AppToastType.warning);
    }
  }

  Future<void> _setOnlinePlaybackQuality(
    BuildContext context,
    WidgetRef ref,
    OnlinePlaybackQuality quality,
  ) async {
    if (quality == ref.read(settingsProvider).onlinePlaybackQuality) return;
    await ref.read(settingsProvider.notifier).setOnlinePlaybackQuality(quality);
    if (!context.mounted) return;
    showAppToast(
      context,
      '在线播放音质已设为 ${quality.label}',
      type: AppToastType.success,
    );
  }

  Future<void> _setBatchDownloadQuality(
    BuildContext context,
    WidgetRef ref,
    OnlinePlaybackQuality quality,
  ) async {
    if (quality == ref.read(settingsProvider).batchDownloadQuality) return;
    await ref.read(settingsProvider.notifier).setBatchDownloadQuality(quality);
    if (!context.mounted) return;
    showAppToast(
      context,
      '批量下载音质已设为 ${quality.label}',
      type: AppToastType.success,
    );
  }

  Future<void> _pickThemeSeed(BuildContext context, WidgetRef ref) async {
    final current = ref.read(settingsProvider).themeSeed;
    final toolbar = ref.read(shellToolbarVisibleProvider.notifier);
    final wasToolbarVisible = ref.read(shellToolbarVisibleProvider);
    toolbar.state = false;
    Color? selected;
    try {
      selected = await showColorPickerSheet(context, current);
    } finally {
      if (toolbar.mounted) toolbar.state = wasToolbarVisible;
    }
    if (selected == null) return;
    await ref.read(settingsProvider.notifier).setThemeSeed(selected);
    if (!context.mounted) return;
    showAppToast(context, '主题颜色已更新', type: AppToastType.success);
  }
}
