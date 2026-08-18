import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/ui/radio_menu.dart';
import '../../../theme/app_motion.dart';
import '../../playlists/playlist_store.dart';

/// Header title that doubles as a library view switcher: tapping it opens a
/// menu listing "本地歌曲" plus every local playlist. Selection is handed
/// back to SongsPage so the list can switch in place.
///
/// The playlist list is read lazily when the menu opens, so rendering the
/// header never touches [localPlaylistsProvider] (which requires
/// SharedPreferences and would throw in detached widget tests).
class LibraryViewMenu extends ConsumerWidget {
  const LibraryViewMenu({
    super.key,
    required this.title,
    required this.activePlaylistId,
    required this.scheme,
    required this.onSelected,
  });

  final String title;

  /// Currently displayed playlist id, or null when the local library is shown.
  final String? activePlaylistId;
  final ColorScheme scheme;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = this.scheme;
    final titleText = Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: Theme.of(context).textTheme.headlineSmall?.copyWith(
        color: scheme.onSurface,
        fontSize: 22,
        fontWeight: FontWeight.w600,
        height: 1.05,
      ),
    );
    return RadioMenuAnchor(
      key: const ValueKey('library-view-menu-anchor'),
      menuId: 'library-view-menu',
      minimumWidth: 156,
      maximumWidth: 240,
      maximumHeight: 300,
      optionsBuilder: () {
        final playlists = ref.read(localPlaylistsProvider);
        return [
          RadioMenuOption(
            id: 'local',
            label: '本地歌曲',
            selected: activePlaylistId == null,
            onSelected: () => onSelected(null),
          ),
          for (final playlist in playlists)
            RadioMenuOption(
              id: 'playlist-${playlist.id}',
              label: playlist.name,
              selected: playlist.id == activePlaylistId,
              onSelected: () => onSelected(playlist.id),
            ),
        ];
      },
      anchorBuilder: (context, expanded, onTapDown, onTap) {
        return Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTapDown: onTapDown,
            onTap: onTap,
            child: Semantics(
              button: true,
              expanded: expanded,
              hint: '切换歌单视图',
              child: Padding(
                padding: const EdgeInsets.fromLTRB(2, 4, 0, 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(child: titleText),
                    AnimatedRotation(
                      turns: expanded ? 0.5 : 0,
                      duration: AppMotion.short,
                      curve: AppMotion.emphasized,
                      child: Icon(
                        Icons.arrow_drop_down_rounded,
                        color: scheme.onSurfaceVariant,
                        size: 26,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
