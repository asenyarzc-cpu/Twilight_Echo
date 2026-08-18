import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/services/app_logger.dart';
import '../../core/ui/app_toast.dart';
import '../../theme/app_motion.dart';

class DebugLogPage extends StatefulWidget {
  const DebugLogPage({super.key});

  @override
  State<DebugLogPage> createState() => _DebugLogPageState();
}

class _DebugLogPageState extends State<DebugLogPage> {
  static const _maxLines = 800;

  final _scrollController = ScrollController();
  StreamSubscription<String>? _subscription;
  List<String> _lines = const [];
  var _loading = true;
  var _followTail = true;

  @override
  void initState() {
    super.initState();
    _loadInitialLines();
    _subscription = AppLogger.liveLines.listen((line) {
      if (!mounted) return;
      setState(() {
        final next = List<String>.of(_lines)..add(line);
        if (next.length > _maxLines) {
          next.removeRange(0, next.length - _maxLines);
        }
        _lines = next;
      });
      _scrollToTail();
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _loadInitialLines() async {
    final lines = await AppLogger.readRecentLines(limit: 500);
    if (!mounted) return;
    setState(() {
      _lines = lines;
      _loading = false;
    });
    _scrollToTail(immediate: true);
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    await _loadInitialLines();
  }

  Future<void> _copyAll() async {
    await Clipboard.setData(ClipboardData(text: _lines.join('\n')));
    if (!mounted) return;
    showAppToast(context, '日志已复制', type: AppToastType.success);
  }

  Future<void> _clear() async {
    await AppLogger.clear();
    if (!mounted) return;
    setState(() => _lines = const []);
    showAppToast(context, '日志已清空', type: AppToastType.success);
  }

  void _scrollToTail({bool immediate = false}) {
    if (!_followTail) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      final target = _scrollController.position.maxScrollExtent;
      if (immediate) {
        _scrollController.jumpTo(target);
      } else {
        _scrollController.animateTo(
          target,
          duration: AppMotion.short,
          curve: AppMotion.emphasizedDecelerate,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: scheme.surface,
      body: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _DebugToolbar(
              lineCount: _lines.length,
              followTail: _followTail,
              onToggleFollow: () {
                setState(() => _followTail = !_followTail);
                _scrollToTail(immediate: true);
              },
              onRefresh: _refresh,
              onCopy: _lines.isEmpty ? null : _copyAll,
              onClear: _lines.isEmpty ? null : _clear,
            ),
            const SizedBox(height: 12),
            Expanded(
              child: _TerminalPanel(
                loading: _loading,
                lines: _lines,
                controller: _scrollController,
              ),
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

class _DebugToolbar extends StatelessWidget {
  const _DebugToolbar({
    required this.lineCount,
    required this.followTail,
    required this.onToggleFollow,
    required this.onRefresh,
    required this.onCopy,
    required this.onClear,
  });

  final int lineCount;
  final bool followTail;
  final VoidCallback onToggleFollow;
  final VoidCallback onRefresh;
  final VoidCallback? onCopy;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: scheme.outlineVariant.withValues(alpha: 0.62),
            ),
          ),
          child: Text(
            '$lineCount 行',
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const Spacer(),
        IconButton(
          tooltip: followTail ? '暂停尾随' : '继续尾随',
          onPressed: onToggleFollow,
          icon: Icon(
            followTail
                ? Icons.vertical_align_bottom_rounded
                : Icons.pause_rounded,
          ),
        ),
        IconButton(
          tooltip: '刷新',
          onPressed: onRefresh,
          icon: const Icon(Icons.refresh_rounded),
        ),
        IconButton(
          tooltip: '复制',
          onPressed: onCopy,
          icon: const Icon(Icons.copy_rounded),
        ),
        IconButton(
          tooltip: '清空',
          onPressed: onClear,
          icon: const Icon(Icons.delete_outline_rounded),
        ),
      ],
    );
  }
}

class _TerminalPanel extends StatelessWidget {
  const _TerminalPanel({
    required this.loading,
    required this.lines,
    required this.controller,
  });

  final bool loading;
  final List<String> lines;
  final ScrollController controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final terminalBackground = scheme.brightness == Brightness.dark
        ? const Color(0xFF0C1116)
        : const Color(0xFF111418);
    final border = scheme.brightness == Brightness.dark
        ? Colors.white.withValues(alpha: 0.08)
        : Colors.black.withValues(alpha: 0.10);

    return Container(
      decoration: BoxDecoration(
        color: terminalBackground,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          if (loading)
            const Center(child: CircularProgressIndicator())
          else if (lines.isEmpty)
            const _EmptyTerminal()
          else
            Scrollbar(
              controller: controller,
              child: ListView.builder(
                controller: controller,
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 18),
                itemCount: lines.length,
                itemBuilder: (context, index) {
                  return _LogLine(line: lines[index]);
                },
              ),
            ),
        ],
      ),
    );
  }
}

class _EmptyTerminal extends StatelessWidget {
  const _EmptyTerminal();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        '等待日志输出...',
        style: TextStyle(
          color: Colors.white.withValues(alpha: 0.62),
          fontFamily: 'monospace',
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _LogLine extends StatelessWidget {
  const _LogLine({required this.line});

  final String line;

  @override
  Widget build(BuildContext context) {
    final color = _colorFor(line);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: SelectableText(
        line,
        style: TextStyle(
          color: color,
          fontFamily: 'monospace',
          fontSize: 11.5,
          height: 1.35,
        ),
      ),
    );
  }

  Color _colorFor(String line) {
    final lower = line.toLowerCase();
    if (lower.contains(' fail') ||
        lower.contains('failed') ||
        lower.contains('error') ||
        lower.contains('exception')) {
      return const Color(0xFFFFB4AB);
    }
    if (lower.contains(' ok') ||
        lower.contains('done') ||
        lower.contains('success')) {
      return const Color(0xFF8DE6A2);
    }
    if (line.contains('[search]')) return const Color(0xFFA8C7FA);
    if (line.contains('[download]')) return const Color(0xFFFFD28A);
    return const Color(0xFFE0E3E7);
  }
}
