/// Pure-Dart base-URL constants and normalization.
///
/// Keep this file free of Flutter imports: `test/unit_test.dart` runs under
/// `dart test` (plain Dart VM) and imports it directly.
library;

const String kPrimaryBaseUrl = 'https://example.com';
const String kDefaultBaseUrl = kPrimaryBaseUrl;
const String kDefaultDownloadDir = '/storage/emulated/0/Music/Twilight Echo';
const String _kRetiredPrimaryBaseUrl = 'https://legacy.example.com';

String normalizeBaseUrl(String value) {
  var trimmed = value.trim();
  if (trimmed.isEmpty) return kDefaultBaseUrl;
  if (!trimmed.contains('://')) {
    final uri = Uri.tryParse('http://$trimmed');
    final hasExplicitPort = uri?.hasPort ?? false;
    trimmed = '${hasExplicitPort ? 'http' : 'https'}://$trimmed';
  }
  final normalized = trimmed.endsWith('/')
      ? trimmed.substring(0, trimmed.length - 1)
      : trimmed;
  return normalized == _kRetiredPrimaryBaseUrl ? kDefaultBaseUrl : normalized;
}
