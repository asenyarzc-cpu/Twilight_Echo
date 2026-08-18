import 'dart:io';

import 'package:permission_handler/permission_handler.dart';

class PermissionService {
  const PermissionService._();

  // Non-prompting check: returns true if either MANAGE_EXTERNAL_STORAGE or
  // legacy WRITE_EXTERNAL_STORAGE is already granted. Use this on startup to
  // decide whether to show the onboarding dialog — we never want to fire the
  // system request as a side-effect of opening the app.
  static Future<bool> hasExternalStorageWrite() async {
    if (!Platform.isAndroid) return true;
    if (await Permission.manageExternalStorage.isGranted) return true;
    if (await Permission.storage.isGranted) return true;
    return false;
  }

  // Returns true once we have permission to write into a user-chosen public
  // directory (e.g. /storage/emulated/0/Music). Strategy:
  //   1. On non-Android, no-op.
  //   2. Try MANAGE_EXTERNAL_STORAGE first (Android 11+).
  //   3. Fall back to WRITE_EXTERNAL_STORAGE (Android 10 and below, with
  //      requestLegacyExternalStorage in manifest).
  // If both are denied, callers should fall back to the app-private dir.
  static Future<bool> ensureExternalStorageWrite() async {
    if (!Platform.isAndroid) return true;

    final manage = await Permission.manageExternalStorage.request();
    if (manage.isGranted) return true;

    final legacy = await Permission.storage.request();
    return legacy.isGranted;
  }

  static Future<bool> ensureExternalStorageRead() async {
    if (!Platform.isAndroid) return true;

    final manage = await Permission.manageExternalStorage.request();
    if (manage.isGranted) return true;

    final audio = await Permission.audio.request();
    if (audio.isGranted) return true;

    final legacy = await Permission.storage.request();
    return legacy.isGranted;
  }

  static Future<void> openSystemAppSettings() => openAppSettings();
}
