import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class EmptyPlaylistDetail extends StatelessWidget {
  const EmptyPlaylistDetail({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 24, 28, 108),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.playlist_add_rounded,
            color: scheme.onSurfaceVariant,
            size: 52,
          ),
          const SizedBox(height: 14),
          Text(
            '歌单还是空的',
            style: TextStyle(
              color: scheme.onSurface,
              fontSize: 18,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '在歌曲页进入批量管理，即可把本地歌曲加入这里。',
            textAlign: TextAlign.center,
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
          ),
        ],
      ),
    );
  }
}

class MissingPlaylist extends StatelessWidget {
  const MissingPlaylist({super.key});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: FilledButton.tonalIcon(
        onPressed: () => context.go('/playlists'),
        icon: const Icon(Icons.queue_music_rounded),
        label: const Text('前往歌单管理'),
      ),
    );
  }
}
