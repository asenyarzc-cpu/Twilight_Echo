import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/music_sources/music_source_controller.dart';
import '../../core/music_sources/music_source_models.dart';
import '../../core/ui/app_toast.dart';
import 'music_source_import_dialog.dart';
import 'widgets/music_source_card.dart';

class MusicSourcePage extends ConsumerStatefulWidget {
  const MusicSourcePage({super.key});

  @override
  ConsumerState<MusicSourcePage> createState() => _MusicSourcePageState();
}

class _MusicSourcePageState extends ConsumerState<MusicSourcePage> {
  bool _importing = false;

  @override
  Widget build(BuildContext context) {
    final sourceState = ref.watch(musicSourceControllerProvider);
    return CustomScrollView(
      key: const PageStorageKey('music-source-scroll'),
      physics: const BouncingScrollPhysics(
        parent: AlwaysScrollableScrollPhysics(),
      ),
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(28, 2, 28, 126),
          sliver: SliverToBoxAdapter(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _ImportToolbar(
                      busy: _importing,
                      onFile: _importFile,
                      onUrl: _importUrl,
                    ),
                    const SizedBox(height: 22),
                    sourceState.when(
                      loading: () => const Center(
                        child: Padding(
                          padding: EdgeInsets.all(40),
                          child: CircularProgressIndicator(),
                        ),
                      ),
                      error: (error, _) => _MessagePanel(
                        icon: Icons.error_outline_rounded,
                        message: '读取音源失败：$error',
                      ),
                      data: (value) => _buildSources(value),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSources(MusicSourceState value) {
    if (value.records.isEmpty) {
      return const _MessagePanel(
        icon: Icons.audio_file_outlined,
        message: '还没有音源',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(
              '已导入音源',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            const Spacer(),
            Text(
              '已启用 ${value.enabledIds.length}/$kMaxEnabledMusicSourceCount',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 13,
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        for (var index = 0; index < value.records.length; index++) ...[
          MusicSourceCard(
            record: value.records[index],
            enabled: value.isEnabled(value.records[index].id),
            priority: value.priorityOf(value.records[index].id),
            busy: value.activatingId != null,
            activating: value.activatingId == value.records[index].id,
            onToggle: (enabled) => _toggle(value.records[index], enabled),
            onDelete: () => _delete(value.records[index]),
          ),
          if (index != value.records.length - 1) const SizedBox(height: 10),
        ],
      ],
    );
  }

  Future<void> _importFile() async {
    if (!await confirmThirdPartySourceRisk(context)) return;
    final result = await FilePicker.platform.pickFiles(
      dialogTitle: '选择音源脚本',
      type: FileType.custom,
      allowedExtensions: const ['js'],
      withData: true,
    );
    if (result == null || !mounted) return;
    final picked = result.files.single;
    try {
      final script = picked.bytes != null
          ? utf8.decode(picked.bytes!)
          : await File(picked.path!).readAsString();
      await _import(script, picked.path ?? picked.name);
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _importUrl() async {
    final url = await showMusicSourceUrlDialog(context);
    if (url == null || !mounted) return;
    if (!await confirmThirdPartySourceRisk(context)) return;
    setState(() => _importing = true);
    try {
      final response = await ref
          .read(apiClientProvider)
          .get<String>(url, options: Options(responseType: ResponseType.plain));
      await _import(response.data ?? '', url, alreadyBusy: true);
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted) setState(() => _importing = false);
    }
  }

  Future<void> _import(
    String script,
    String origin, {
    bool alreadyBusy = false,
  }) async {
    if (!alreadyBusy) setState(() => _importing = true);
    try {
      final record = await ref
          .read(musicSourceControllerProvider.notifier)
          .importScript(script: script, origin: origin);
      if (!mounted) return;
      final enabled = ref
          .read(musicSourceControllerProvider)
          .valueOrNull
          ?.isEnabled(record.id);
      showAppToast(
        context,
        enabled == true
            ? '已导入并启用 ${record.name}'
            : '已导入 ${record.name}，启用数量已达上限',
        type: AppToastType.success,
      );
    } finally {
      if (!alreadyBusy && mounted) setState(() => _importing = false);
    }
  }

  Future<void> _toggle(MusicSourceRecord record, bool enabled) async {
    try {
      final controller = ref.read(musicSourceControllerProvider.notifier);
      if (enabled) {
        await controller.activate(record.id);
      } else {
        await controller.deactivate(record.id);
      }
      if (!mounted) return;
      showAppToast(
        context,
        enabled ? '已启用 ${record.name}' : '已停用 ${record.name}',
        type: AppToastType.success,
      );
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _delete(MusicSourceRecord record) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除音源'),
        content: Text('确定删除「${record.name}」吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(musicSourceControllerProvider.notifier).remove(record.id);
  }

  void _showError(Object error) {
    if (!mounted) return;
    showAppToast(context, '音源操作失败：$error', type: AppToastType.error);
  }
}

class _ImportToolbar extends StatelessWidget {
  const _ImportToolbar({
    required this.busy,
    required this.onFile,
    required this.onUrl,
  });

  final bool busy;
  final VoidCallback onFile;
  final VoidCallback onUrl;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: SizedBox(
            height: 48,
            child: FilledButton.icon(
              onPressed: busy ? null : onFile,
              icon: const Icon(Icons.file_open_rounded, size: 20),
              label: const Text('本地导入'),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: SizedBox(
            height: 48,
            child: OutlinedButton.icon(
              onPressed: busy ? null : onUrl,
              icon: const Icon(Icons.link_rounded, size: 20),
              label: const Text('URL 导入'),
            ),
          ),
        ),
      ],
    );
  }
}

class _MessagePanel extends StatelessWidget {
  const _MessagePanel({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 56),
      child: Column(
        children: [
          Icon(icon, size: 38, color: scheme.outline),
          const SizedBox(height: 12),
          Text(message, style: TextStyle(color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}
