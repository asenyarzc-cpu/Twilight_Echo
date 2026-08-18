import 'dart:async';

import 'package:flutter/material.dart';

Future<String?> showMusicSourceUrlDialog(BuildContext context) async {
  final disposed = Completer<void>();
  final result = await showDialog<String>(
    context: context,
    builder: (dialogContext) => _MusicSourceUrlDialog(
      onDisposed: () {
        if (!disposed.isCompleted) disposed.complete();
      },
    ),
  );
  await disposed.future;
  return result;
}

class _MusicSourceUrlDialog extends StatefulWidget {
  const _MusicSourceUrlDialog({required this.onDisposed});

  final VoidCallback onDisposed;

  @override
  State<_MusicSourceUrlDialog> createState() => _MusicSourceUrlDialogState();
}

class _MusicSourceUrlDialogState extends State<_MusicSourceUrlDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    widget.onDisposed();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      icon: const Icon(Icons.link_rounded),
      title: const Text('从 URL 导入音源'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: TextInputType.url,
        decoration: const InputDecoration(
          labelText: '脚本地址',
          hintText: 'https://example.com/music-source.js',
        ),
        onSubmitted: (value) {
          if (_isHttpUrl(value)) Navigator.of(context).pop(value.trim());
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: _controller,
          builder: (context, value, _) => FilledButton(
            onPressed: _isHttpUrl(value.text)
                ? () => Navigator.of(context).pop(value.text.trim())
                : null,
            child: const Text('导入'),
          ),
        ),
      ],
    );
  }
}

Future<bool> confirmThirdPartySourceRisk(BuildContext context) async {
  return await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.security_rounded),
          title: const Text('运行第三方音源'),
          content: const Text('音源脚本可以访问网络。请只导入来源可信、内容明确的脚本。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('继续导入'),
            ),
          ],
        ),
      ) ??
      false;
}

bool _isHttpUrl(String raw) {
  final uri = Uri.tryParse(raw.trim());
  return uri != null && (uri.scheme == 'https' || uri.scheme == 'http');
}
