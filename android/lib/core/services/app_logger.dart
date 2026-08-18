import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

// File-backed log so the user can hand over a real trace when something
// looks wrong. Each line is `ISO8601 [scope] message`, persisted to
// `<app-documents>/logs/twilight_echo.log` (rotated at 1 MiB).
class AppLogger {
  const AppLogger._();

  static final _queue = StreamController<String>(sync: false);
  static final _live = StreamController<String>.broadcast(sync: false);
  static final List<String> _recent = <String>[];
  static File? _file;
  static IOSink? _sink;
  static Future<void>? _initFuture;
  static const _maxBytes = 1024 * 1024;
  static const _maxRecentLines = 500;

  static Future<void> _ensureInit() => _initFuture ??= _initialize();

  static Future<void> _initialize() async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final dir = Directory(p.join(docs.path, 'logs'));
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final file = File(p.join(dir.path, 'twilight_echo.log'));
      if (file.existsSync() && file.lengthSync() > _maxBytes) {
        final backup = File(p.join(dir.path, 'twilight_echo.prev.log'));
        if (backup.existsSync()) backup.deleteSync();
        file.renameSync(backup.path);
      }
      _file = file;
      _sink = file.openWrite(mode: FileMode.writeOnlyAppend);
      _queue.stream.listen((line) {
        try {
          _sink?.writeln(line);
        } catch (_) {}
      });
    } catch (_) {
      // Persistence is best-effort; console logging still works.
    }
  }

  static Future<void> write(String scope, String message) async {
    final line = '${DateTime.now().toIso8601String()} [$scope] $message';
    developer.log(message, name: 'lx.$scope');
    _remember(line);
    await _ensureInit();
    if (!_queue.isClosed) _queue.add(line);
  }

  static Stream<String> get liveLines => _live.stream;

  static List<String> get recentMemoryLines => List.unmodifiable(_recent);

  static Future<List<String>> readRecentLines({int limit = 400}) async {
    await _ensureInit();
    try {
      final file = _file;
      if (file == null || !file.existsSync()) {
        return _tail(_recent, limit);
      }
      await flush();
      final lines = await file.readAsLines();
      return _tail(lines, limit);
    } catch (_) {
      return _tail(_recent, limit);
    }
  }

  static Future<void> clear() async {
    await _ensureInit();
    try {
      await _sink?.flush();
      await _sink?.close();
      final file = _file;
      if (file != null) {
        await file.writeAsString('');
        _sink = file.openWrite(mode: FileMode.writeOnlyAppend);
      }
      _recent.clear();
    } catch (_) {}
  }

  static Future<File?> currentLogFile() async {
    await _ensureInit();
    return _file;
  }

  static Future<void> flush() async {
    await _ensureInit();
    await _sink?.flush();
  }

  static void _remember(String line) {
    _recent.add(line);
    if (_recent.length > _maxRecentLines) {
      _recent.removeRange(0, _recent.length - _maxRecentLines);
    }
    if (!_live.isClosed) _live.add(line);
  }

  static List<String> _tail(List<String> lines, int limit) {
    if (lines.length <= limit) return List<String>.of(lines);
    return lines.sublist(lines.length - limit);
  }
}
