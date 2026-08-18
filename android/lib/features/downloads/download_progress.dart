import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/music_info.dart';

enum DownloadStage {
  idle,
  resolvingUrl,
  downloading,
  fetchingMeta,
  tagging,
  finishing,
  done,
  failed,
}

class DownloadTask {
  const DownloadTask({
    required this.id,
    required this.musicId,
    required this.name,
    required this.singer,
    this.stage = DownloadStage.idle,
    this.received = 0,
    this.total,
    this.message,
    this.savedPath,
  });

  final String id;
  final String musicId;
  final String name;
  final String singer;
  final DownloadStage stage;
  final int received;
  final int? total;
  final String? message;
  final String? savedPath;

  bool get isBusy =>
      stage != DownloadStage.idle &&
      stage != DownloadStage.done &&
      stage != DownloadStage.failed;

  double? get fraction {
    if (total == null || total! <= 0) return null;
    final value = received / total!;
    if (value.isNaN || value.isInfinite) return null;
    return value.clamp(0.0, 1.0);
  }

  DownloadTask copyWith({
    DownloadStage? stage,
    int? received,
    Object? total = _sentinel,
    Object? message = _sentinel,
    Object? savedPath = _sentinel,
  }) {
    return DownloadTask(
      id: id,
      musicId: musicId,
      name: name,
      singer: singer,
      stage: stage ?? this.stage,
      received: received ?? this.received,
      total: identical(total, _sentinel) ? this.total : total as int?,
      message: identical(message, _sentinel)
          ? this.message
          : message as String?,
      savedPath: identical(savedPath, _sentinel)
          ? this.savedPath
          : savedPath as String?,
    );
  }

  static const _sentinel = Object();
}

class DownloadProgress {
  const DownloadProgress({this.tasks = const []});

  final List<DownloadTask> tasks;

  DownloadTask? get activeTask {
    for (final task in tasks.reversed) {
      if (task.isBusy) return task;
    }
    return tasks.isNotEmpty ? tasks.last : null;
  }

  bool get hasTasks => tasks.isNotEmpty;
  bool get isBusy => tasks.any((task) => task.isBusy);

  DownloadTask? taskForMusic(String id) {
    for (final task in tasks.reversed) {
      if (task.musicId == id && task.isBusy) return task;
    }
    return null;
  }

  DownloadTask? latestTaskForMusic(String id) {
    for (final task in tasks.reversed) {
      if (task.musicId == id) return task;
    }
    return null;
  }

  bool isMusicBusy(String id) => taskForMusic(id) != null;
}

class DownloadProgressNotifier extends Notifier<DownloadProgress> {
  var _sequence = 0;

  /// dio's onReceiveProgress fires on every received chunk — hundreds of
  /// times per second on a fast link. Emitting state that often starves the
  /// raster thread, so byte updates are coalesced to one emission per
  /// interval (leading edge immediate, trailing edge via timer).
  static const _bytesFlushInterval = Duration(milliseconds: 100);
  final Map<String, ({int received, int? total})> _pendingBytes = {};
  Timer? _bytesFlushTimer;

  @override
  DownloadProgress build() {
    ref.onDispose(() {
      _bytesFlushTimer?.cancel();
      _bytesFlushTimer = null;
      _pendingBytes.clear();
    });
    return const DownloadProgress();
  }

  String start(MusicInfo music) {
    final taskId =
        '${music.id}-${DateTime.now().microsecondsSinceEpoch}-${_sequence++}';
    final task = DownloadTask(
      id: taskId,
      musicId: music.id,
      name: music.name,
      singer: music.singer,
      stage: DownloadStage.resolvingUrl,
    );
    state = DownloadProgress(tasks: [...state.tasks, task]);
    return task.id;
  }

  void updateStage(String id, DownloadStage stage, {String? message}) {
    _update(id, (task) => task.copyWith(stage: stage, message: message));
  }

  void updateBytes(String id, int received, int? total) {
    _pendingBytes[id] = (received: received, total: total);
    if (_bytesFlushTimer != null) return;
    _flushPendingBytes();
    _bytesFlushTimer = Timer(_bytesFlushInterval, _onBytesFlushTimer);
  }

  void _onBytesFlushTimer() {
    _bytesFlushTimer = null;
    if (_pendingBytes.isEmpty) return;
    _flushPendingBytes();
    _bytesFlushTimer = Timer(_bytesFlushInterval, _onBytesFlushTimer);
  }

  void _flushPendingBytes() {
    if (_pendingBytes.isEmpty) return;
    final updates = Map.of(_pendingBytes);
    _pendingBytes.clear();
    final next = [...state.tasks];
    var changed = false;
    for (final entry in updates.entries) {
      final index = next.lastIndexWhere(
        (task) => task.id == entry.key && task.isBusy,
      );
      if (index < 0) continue;
      next[index] = next[index].copyWith(
        received: entry.value.received,
        total: entry.value.total,
      );
      changed = true;
    }
    if (changed) state = DownloadProgress(tasks: next);
  }

  void finish(String id, String savedPath) {
    _pendingBytes.remove(id);
    _update(
      id,
      (task) => task.copyWith(
        stage: DownloadStage.done,
        savedPath: savedPath,
        message: null,
      ),
    );
  }

  void fail(String id, String message) {
    _pendingBytes.remove(id);
    _update(
      id,
      (task) => task.copyWith(stage: DownloadStage.failed, message: message),
    );
  }

  void reset() {
    _pendingBytes.clear();
    state = const DownloadProgress();
  }

  void clearFinished() {
    state = DownloadProgress(
      tasks: state.tasks.where((task) => task.isBusy).toList(),
    );
  }

  void remove(String id) {
    state = DownloadProgress(
      tasks: state.tasks.where((task) => task.id != id || task.isBusy).toList(),
    );
  }

  void _update(String id, DownloadTask Function(DownloadTask task) update) {
    final index = state.tasks.lastIndexWhere(
      (task) => task.id == id && task.isBusy,
    );
    if (index < 0) return;
    final next = [...state.tasks];
    next[index] = update(next[index]);
    state = DownloadProgress(tasks: next);
  }
}

final downloadProgressProvider =
    NotifierProvider<DownloadProgressNotifier, DownloadProgress>(
      DownloadProgressNotifier.new,
    );

String describeStage(DownloadStage stage) {
  switch (stage) {
    case DownloadStage.idle:
      return '空闲';
    case DownloadStage.resolvingUrl:
      return '解析下载地址';
    case DownloadStage.downloading:
      return '下载中';
    case DownloadStage.fetchingMeta:
      return '获取封面与歌词';
    case DownloadStage.tagging:
      return '写入标签';
    case DownloadStage.finishing:
      return '移动到下载目录';
    case DownloadStage.done:
      return '完成';
    case DownloadStage.failed:
      return '失败';
  }
}
