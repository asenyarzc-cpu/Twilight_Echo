import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'features/debug/debug_log_page.dart';
import 'features/discovery/online_playlist_detail_page.dart';
import 'features/downloads/download_history_page.dart';
import 'core/models/enums.dart';
import 'core/models/playlist_summary.dart';
import 'features/playlists/online_playlist_import_page.dart';
import 'features/playlists/playlist_detail_page.dart';
import 'features/playlists/playlist_management_page.dart';
import 'features/search/search_page.dart';
import 'features/settings/settings_page.dart';
import 'features/music_sources/music_source_page.dart';
import 'features/shell/app_shell.dart';
import 'features/shell/shell_page_storage.dart';
import 'features/songs/songs_page.dart';
import 'theme/app_motion.dart';

// Exposed so app-level overlays (e.g. the startup permission dialog) can find
// a stable BuildContext after the router mounts.
final rootNavigatorKey = GlobalKey<NavigatorState>();

final appRouter = createAppRouter(navigatorKey: rootNavigatorKey);

GoRouter createAppRouter({
  String initialLocation = '/',
  GlobalKey<NavigatorState>? navigatorKey,
}) {
  return GoRouter(
    navigatorKey: navigatorKey,
    initialLocation: initialLocation,
    routes: [
      ShellRoute(
        builder: (context, state, child) {
          return AppShell(
            location: state.uri.path,
            routeLocation: state.uri.toString(),
            playerReturnLocation: _playerReturnLocationFromExtra(state.extra),
            playlistBackLocation: _playlistBackLocationFromUri(state.uri),
            child: child,
          );
        },
        routes: [
          GoRoute(
            path: '/',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: SearchPage()),
            ),
          ),
          GoRoute(
            path: '/discover/playlists/:source/:id',
            pageBuilder: (context, state) {
              final source = MusicSource.tryFromCode(
                state.pathParameters['source'] ?? '',
              );
              final id = state.pathParameters['id'] ?? '';
              final reduceMotion = MediaQuery.disableAnimationsOf(context);
              return CustomTransitionPage<void>(
                key: state.pageKey,
                transitionDuration: reduceMotion
                    ? Duration.zero
                    : AppMotion.long,
                reverseTransitionDuration: reduceMotion
                    ? Duration.zero
                    : AppMotion.medium,
                child: ShellPageStorage(
                  child: OnlinePlaylistDetailPage(
                    source: source == null || source == MusicSource.all
                        ? MusicSource.kw
                        : source,
                    playlistId: id,
                    summary: state.extra is PlaylistSummary
                        ? state.extra! as PlaylistSummary
                        : null,
                  ),
                ),
                // Keep the page opaque while the non-zero route duration
                // drives the shared artwork Hero transition.
                transitionsBuilder: (_, _, _, child) => child,
              );
            },
          ),
          GoRoute(
            path: '/downloads',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: DownloadHistoryPage()),
            ),
          ),
          GoRoute(
            path: '/player',
            // The player itself is hosted by AppShell as a drag-driven layer
            // above the route content, so entering and leaving `/player` never
            // remounts it. The route only carries the location and its
            // `extra` return target; see AppShell's player pull layer.
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: SizedBox.shrink()),
          ),
          GoRoute(path: '/history', redirect: (_, _) => '/downloads'),
          GoRoute(
            path: '/songs',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: SongsPage()),
            ),
          ),
          GoRoute(
            path: '/songs/search',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: SongsPage(searchMode: true)),
            ),
          ),
          GoRoute(
            path: '/playlists',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: PlaylistManagementPage()),
            ),
          ),
          GoRoute(
            path: '/playlists/import',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: OnlinePlaylistImportPage()),
            ),
          ),
          GoRoute(
            path: '/playlists/:id',
            pageBuilder: (context, state) => NoTransitionPage(
              child: ShellPageStorage(
                child: PlaylistDetailPage(
                  playlistId: state.pathParameters['id'] ?? '',
                  returnLocation: state.uri.toString(),
                ),
              ),
            ),
          ),
          GoRoute(
            path: '/settings',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: SettingsPage()),
            ),
          ),
          GoRoute(
            path: '/settings/sources',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: MusicSourcePage()),
            ),
          ),
          GoRoute(
            path: '/debug',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ShellPageStorage(child: DebugLogPage()),
            ),
          ),
        ],
      ),
    ],
  );
}

String _playerReturnLocationFromExtra(Object? extra) {
  if (extra is String && _isPlayerReturnLocation(extra)) return extra;
  return '/songs';
}

bool _isPlayerReturnLocation(String location) {
  if (location.startsWith('/discover/playlists/')) return true;
  if (location == '/playlists' || location.startsWith('/playlists/')) {
    return true;
  }
  return switch (location) {
    '/' ||
    '/downloads' ||
    '/songs' ||
    '/songs/search' ||
    '/settings' ||
    '/settings/sources' ||
    '/debug' => true,
    _ => false,
  };
}

String _playlistBackLocationFromUri(Uri uri) {
  if (uri.path == '/playlists/import') return '/playlists';
  if (uri.path.startsWith('/playlists/') &&
      uri.queryParameters['from'] == 'manage') {
    return '/playlists';
  }
  return '/songs';
}
