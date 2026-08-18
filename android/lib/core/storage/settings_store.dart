import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/dio_factory.dart';
import '../models/enums.dart';
import '../../theme/seed_palette.dart';
import 'base_url.dart';

export 'base_url.dart';

const String _kDownloadDirKey = 'download_dir';
const String _kLocalMusicDirKey = 'local_music_dir';
const String _kThemeModeKey = 'theme_mode';
const String _kThemeSeedKey = 'theme_seed_argb';
const String _kUseDynamicColorKey = 'use_dynamic_color';
const String _kNetworkAdapterModeKey = 'network_adapter_mode';
const String _kEnabledSearchSourcesKey = 'enabled_search_source_codes';
const String _kOnlinePlaybackQualityKey = 'online_playback_quality';
const String _kBatchDownloadQualityKey = 'batch_download_quality';
const String _kShowMiniLyricsKey = 'show_mini_lyrics';
const String _kBluetoothLyricEnabledKey = 'bluetooth_lyric_enabled';
const String _kBluetoothFullLyricEnabledKey = 'bluetooth_full_lyric_enabled';
const String _kBluetoothLyricNoticeSeenKey = 'bluetooth_lyric_notice_seen';
const String _kLegacyBaseUrlKey = 'base_url';

@immutable
class AppSettings {
  const AppSettings({
    required this.downloadDir,
    required this.localMusicDir,
    required this.themeMode,
    required this.themeSeed,
    required this.useDynamicColor,
    required this.networkAdapterMode,
    required this.enabledSearchSources,
    required this.onlinePlaybackQuality,
    required this.batchDownloadQuality,
    required this.showMiniLyrics,
    required this.bluetoothLyricEnabled,
    required this.bluetoothFullLyricEnabled,
    required this.bluetoothLyricNoticeSeen,
  });

  final String downloadDir;
  final String localMusicDir;
  final ThemeMode themeMode;
  final Color themeSeed;
  final bool useDynamicColor;
  final NetworkAdapterMode networkAdapterMode;
  final Set<MusicSource> enabledSearchSources;
  final OnlinePlaybackQuality onlinePlaybackQuality;
  final OnlinePlaybackQuality batchDownloadQuality;
  final bool showMiniLyrics;
  final bool bluetoothLyricEnabled;
  final bool bluetoothFullLyricEnabled;
  final bool bluetoothLyricNoticeSeen;

  AppSettings copyWith({
    String? downloadDir,
    String? localMusicDir,
    ThemeMode? themeMode,
    Color? themeSeed,
    bool? useDynamicColor,
    NetworkAdapterMode? networkAdapterMode,
    Set<MusicSource>? enabledSearchSources,
    OnlinePlaybackQuality? onlinePlaybackQuality,
    OnlinePlaybackQuality? batchDownloadQuality,
    bool? showMiniLyrics,
    bool? bluetoothLyricEnabled,
    bool? bluetoothFullLyricEnabled,
    bool? bluetoothLyricNoticeSeen,
  }) => AppSettings(
    downloadDir: downloadDir ?? this.downloadDir,
    localMusicDir: localMusicDir ?? this.localMusicDir,
    themeMode: themeMode ?? this.themeMode,
    themeSeed: themeSeed ?? this.themeSeed,
    useDynamicColor: useDynamicColor ?? this.useDynamicColor,
    networkAdapterMode: networkAdapterMode ?? this.networkAdapterMode,
    enabledSearchSources: enabledSearchSources ?? this.enabledSearchSources,
    onlinePlaybackQuality: onlinePlaybackQuality ?? this.onlinePlaybackQuality,
    batchDownloadQuality: batchDownloadQuality ?? this.batchDownloadQuality,
    showMiniLyrics: showMiniLyrics ?? this.showMiniLyrics,
    bluetoothLyricEnabled: bluetoothLyricEnabled ?? this.bluetoothLyricEnabled,
    bluetoothFullLyricEnabled:
        bluetoothFullLyricEnabled ?? this.bluetoothFullLyricEnabled,
    bluetoothLyricNoticeSeen:
        bluetoothLyricNoticeSeen ?? this.bluetoothLyricNoticeSeen,
  );

  static const AppSettings fallback = AppSettings(
    downloadDir: kDefaultDownloadDir,
    localMusicDir: kDefaultDownloadDir,
    themeMode: ThemeMode.system,
    themeSeed: SeedPalette.defaultSeed,
    useDynamicColor: false,
    networkAdapterMode: NetworkAdapterMode.system,
    enabledSearchSources: kDefaultEnabledSearchSources,
    onlinePlaybackQuality: OnlinePlaybackQuality.highest,
    batchDownloadQuality: OnlinePlaybackQuality.highest,
    showMiniLyrics: true,
    bluetoothLyricEnabled: false,
    bluetoothFullLyricEnabled: false,
    bluetoothLyricNoticeSeen: false,
  );
}

final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('Override sharedPreferencesProvider before runApp');
});

class SettingsNotifier extends Notifier<AppSettings> {
  late SharedPreferences _prefs;

  @override
  AppSettings build() {
    _prefs = ref.read(sharedPreferencesProvider);
    hydrateNetworkAdapterPreference(_prefs);
    if (_prefs.containsKey(_kLegacyBaseUrlKey)) {
      unawaited(_prefs.remove(_kLegacyBaseUrlKey));
    }
    final downloadDir =
        _prefs.getString(_kDownloadDirKey) ?? kDefaultDownloadDir;
    return AppSettings(
      downloadDir: downloadDir,
      localMusicDir: _prefs.getString(_kLocalMusicDirKey) ?? downloadDir,
      themeMode: _decodeThemeMode(_prefs.getString(_kThemeModeKey)),
      themeSeed: Color(
        _prefs.getInt(_kThemeSeedKey) ?? SeedPalette.defaultSeed.toARGB32(),
      ),
      useDynamicColor: _prefs.getBool(_kUseDynamicColorKey) ?? false,
      networkAdapterMode: NetworkAdapterPreference.current,
      enabledSearchSources: decodeEnabledSearchSources(
        _prefs.getStringList(_kEnabledSearchSourcesKey),
      ),
      onlinePlaybackQuality: OnlinePlaybackQuality.fromCode(
        _prefs.getString(_kOnlinePlaybackQualityKey),
      ),
      batchDownloadQuality: OnlinePlaybackQuality.fromCode(
        _prefs.getString(_kBatchDownloadQualityKey),
      ),
      showMiniLyrics: _prefs.getBool(_kShowMiniLyricsKey) ?? true,
      bluetoothLyricEnabled:
          _prefs.getBool(_kBluetoothLyricEnabledKey) ?? false,
      bluetoothFullLyricEnabled:
          _prefs.getBool(_kBluetoothFullLyricEnabledKey) ?? false,
      bluetoothLyricNoticeSeen:
          _prefs.getBool(_kBluetoothLyricNoticeSeenKey) ?? false,
    );
  }

  Future<void> setDownloadDir(String value) async {
    final localMusicFollowsDownload =
        !_prefs.containsKey(_kLocalMusicDirKey) ||
        state.localMusicDir == state.downloadDir;
    await _prefs.setString(_kDownloadDirKey, value);
    if (localMusicFollowsDownload) {
      await _prefs.setString(_kLocalMusicDirKey, value);
      state = state.copyWith(downloadDir: value, localMusicDir: value);
    } else {
      state = state.copyWith(downloadDir: value);
    }
  }

  Future<void> setLocalMusicDir(String value) async {
    await _prefs.setString(_kLocalMusicDirKey, value);
    state = state.copyWith(localMusicDir: value);
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    await _prefs.setString(_kThemeModeKey, _encodeThemeMode(mode));
    state = state.copyWith(themeMode: mode);
  }

  Future<void> setThemeSeed(Color color) async {
    await _prefs.setInt(_kThemeSeedKey, color.toARGB32());
    state = state.copyWith(themeSeed: color);
  }

  Future<void> setUseDynamicColor(bool value) async {
    await _prefs.setBool(_kUseDynamicColorKey, value);
    state = state.copyWith(useDynamicColor: value);
  }

  Future<void> setNetworkAdapterMode(NetworkAdapterMode mode) async {
    NetworkAdapterPreference.current = mode;
    await _prefs.setString(_kNetworkAdapterModeKey, mode.code);
    state = state.copyWith(networkAdapterMode: mode);
  }

  Future<bool> setSearchSourceEnabled(MusicSource source, bool enabled) async {
    if (!kManageableSearchSources.contains(source)) return false;
    final next = {...state.enabledSearchSources};
    enabled ? next.add(source) : next.remove(source);
    if (next.isEmpty) return false;

    final ordered = {
      for (final candidate in kManageableSearchSources)
        if (next.contains(candidate)) candidate,
    };
    await _prefs.setStringList(
      _kEnabledSearchSourcesKey,
      ordered.map((candidate) => candidate.code).toList(growable: false),
    );
    state = state.copyWith(
      enabledSearchSources: Set<MusicSource>.unmodifiable(ordered),
    );
    return true;
  }

  Future<void> setOnlinePlaybackQuality(OnlinePlaybackQuality quality) async {
    await _prefs.setString(_kOnlinePlaybackQualityKey, quality.code);
    state = state.copyWith(onlinePlaybackQuality: quality);
  }

  Future<void> setBatchDownloadQuality(OnlinePlaybackQuality quality) async {
    await _prefs.setString(_kBatchDownloadQualityKey, quality.code);
    state = state.copyWith(batchDownloadQuality: quality);
  }

  Future<void> setShowMiniLyrics(bool value) async {
    await _prefs.setBool(_kShowMiniLyricsKey, value);
    state = state.copyWith(showMiniLyrics: value);
  }

  Future<void> setBluetoothLyricEnabled(bool value) async {
    await _prefs.setBool(_kBluetoothLyricEnabledKey, value);
    state = state.copyWith(bluetoothLyricEnabled: value);
  }

  Future<void> setBluetoothFullLyricEnabled(bool value) async {
    await _prefs.setBool(_kBluetoothFullLyricEnabledKey, value);
    state = state.copyWith(bluetoothFullLyricEnabled: value);
  }

  Future<void> markBluetoothLyricNoticeSeen() async {
    if (state.bluetoothLyricNoticeSeen) return;
    await _prefs.setBool(_kBluetoothLyricNoticeSeenKey, true);
    state = state.copyWith(bluetoothLyricNoticeSeen: true);
  }
}

final settingsProvider = NotifierProvider<SettingsNotifier, AppSettings>(
  SettingsNotifier.new,
);

String _encodeThemeMode(ThemeMode mode) {
  switch (mode) {
    case ThemeMode.system:
      return 'system';
    case ThemeMode.light:
      return 'light';
    case ThemeMode.dark:
      return 'dark';
  }
}

ThemeMode _decodeThemeMode(String? raw) {
  switch (raw) {
    case 'light':
      return ThemeMode.light;
    case 'dark':
      return ThemeMode.dark;
    default:
      return ThemeMode.system;
  }
}

void hydrateNetworkAdapterPreference(SharedPreferences prefs) {
  NetworkAdapterPreference.current = NetworkAdapterMode.fromCode(
    prefs.getString(_kNetworkAdapterModeKey),
  );
}

Set<MusicSource> decodeEnabledSearchSources(List<String>? codes) {
  if (codes == null) return kDefaultEnabledSearchSources;
  final decoded = <MusicSource>{};
  for (final code in codes) {
    final source = MusicSource.tryFromCode(code);
    if (source != null && kManageableSearchSources.contains(source)) {
      decoded.add(source);
    }
  }
  if (decoded.isEmpty) return kDefaultEnabledSearchSources;
  return Set<MusicSource>.unmodifiable({
    for (final source in kManageableSearchSources)
      if (decoded.contains(source)) source,
  });
}
