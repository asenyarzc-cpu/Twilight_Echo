import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/dio_factory.dart';
import '../storage/settings_store.dart';

const _githubApiBaseUrl = 'https://api.github.com';
const _latestReleasePath = '/repos/asenyarzc-cpu/Twilight_Echo/releases/latest';

class AppRelease {
  const AppRelease({
    required this.version,
    required this.tagName,
    required this.pageUri,
    required this.title,
  });

  final Version version;
  final String tagName;
  final Uri pageUri;
  final String title;
}

class AppUpdateService {
  AppUpdateService({required Dio dio}) : _dio = dio;

  final Dio _dio;

  Future<AppRelease?> fetchLatestRelease() async {
    final response = await _dio.get<Object?>(_latestReleasePath);
    final data = response.data;
    if (data is! Map) {
      throw const FormatException('GitHub release response is not an object');
    }
    if (data['draft'] == true || data['prerelease'] == true) return null;

    final tagName = data['tag_name']?.toString().trim() ?? '';
    final pageValue = data['html_url']?.toString().trim() ?? '';
    final version = parseAppVersion(tagName);
    final pageUri = Uri.tryParse(pageValue);
    if (version == null || !_isGithubReleaseUri(pageUri)) {
      throw const FormatException('GitHub release fields are invalid');
    }

    final name = data['name']?.toString().trim();
    return AppRelease(
      version: version,
      tagName: tagName,
      pageUri: pageUri!,
      title: name == null || name.isEmpty ? tagName : name,
    );
  }
}

final appUpdateServiceProvider = Provider<AppUpdateService>((ref) {
  final adapterMode = ref.watch(
    settingsProvider.select((settings) => settings.networkAdapterMode),
  );
  final dio = _createGithubDio(adapterMode: adapterMode);
  ref.onDispose(dio.close);
  return AppUpdateService(dio: dio);
});

typedef ExternalUriLauncher = Future<bool> Function(Uri uri);

final externalUriLauncherProvider = Provider<ExternalUriLauncher>((ref) {
  return (uri) => launchUrl(uri, mode: LaunchMode.externalApplication);
});

Version? parseAppVersion(String value) {
  var normalized = value.trim();
  if (normalized.startsWith('v') || normalized.startsWith('V')) {
    normalized = normalized.substring(1);
  }
  normalized = normalized.split('+').first;
  if (normalized.isEmpty) return null;
  try {
    return Version.parse(normalized);
  } on FormatException {
    return null;
  }
}

bool isNewerAppVersion({
  required String currentVersion,
  required String latestVersion,
}) {
  final current = parseAppVersion(currentVersion);
  final latest = parseAppVersion(latestVersion);
  return current != null && latest != null && latest > current;
}

Dio _createGithubDio({NetworkAdapterMode? adapterMode}) {
  return createDio(
    BaseOptions(
      baseUrl: _githubApiBaseUrl,
      connectTimeout: const Duration(seconds: 5),
      receiveTimeout: const Duration(seconds: 8),
      sendTimeout: const Duration(seconds: 5),
      responseType: ResponseType.json,
      headers: const {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TwilightEcho-Android',
      },
    ),
    adapterMode: adapterMode,
  );
}

bool _isGithubReleaseUri(Uri? uri) {
  if (uri == null || uri.scheme != 'https' || uri.host != 'github.com') {
    return false;
  }
  return uri.path.startsWith('/asenyarzc-cpu/Twilight_Echo/releases/');
}
