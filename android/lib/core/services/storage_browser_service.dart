import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

@immutable
class StorageBrowserEntry {
  const StorageBrowserEntry({
    required this.path,
    required this.name,
    required this.isDirectory,
    required this.isRoot,
    required this.canRead,
    required this.canWrite,
    required this.totalBytes,
    required this.freeBytes,
    this.isRemovable,
    this.state,
  });

  final String path;
  final String name;
  final bool isDirectory;
  final bool isRoot;
  final bool canRead;
  final bool canWrite;
  final int totalBytes;
  final int freeBytes;
  final bool? isRemovable;
  final String? state;

  bool get isReadOnly => canRead && !canWrite;

  factory StorageBrowserEntry.fromMap(Map<Object?, Object?> raw) {
    return StorageBrowserEntry(
      path: raw['path'] as String? ?? '',
      name: raw['name'] as String? ?? '',
      isDirectory: raw['isDirectory'] as bool? ?? false,
      isRoot: raw['isRoot'] as bool? ?? false,
      canRead: raw['canRead'] as bool? ?? false,
      canWrite: raw['canWrite'] as bool? ?? false,
      totalBytes: _intValue(raw['totalBytes']),
      freeBytes: _intValue(raw['freeBytes']),
      isRemovable: raw['isRemovable'] as bool?,
      state: raw['state'] as String?,
    );
  }

  static int _intValue(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return 0;
  }
}

class StorageBrowserService {
  const StorageBrowserService({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(_channelName);

  static const _channelName = 'twilight_echo/storage_browser';

  final MethodChannel _channel;

  bool get isSupported => Platform.isAndroid;

  Future<List<StorageBrowserEntry>> listRoots() async {
    if (!isSupported) return const [];
    final raw = await _channel.invokeListMethod<Object?>('listRoots');
    return _decodeEntries(raw);
  }

  Future<List<StorageBrowserEntry>> listChildren(String path) async {
    if (!isSupported) return const [];
    final raw = await _channel.invokeListMethod<Object?>('listChildren', {
      'path': path,
    });
    return _decodeEntries(raw);
  }

  List<StorageBrowserEntry> _decodeEntries(List<Object?>? raw) {
    if (raw == null) return const [];
    final entries = <StorageBrowserEntry>[];
    for (final item in raw) {
      if (item is Map<Object?, Object?>) {
        final entry = StorageBrowserEntry.fromMap(item);
        if (entry.path.isNotEmpty && entry.name.isNotEmpty) {
          entries.add(entry);
        }
      }
    }
    return List.unmodifiable(entries);
  }
}
