import 'package:flutter/material.dart';

// Pure route helpers shared by the AppShell state machine (app_shell.dart)
// and the extracted shell widgets (widgets/). Kept in their own file so
// widgets/ never has to import the page file.

ColorScheme shellSchemeFor(String location, ColorScheme fallback) {
  return fallback;
}

bool isPlaylistLocation(String location) {
  return location == '/playlists' || location.startsWith('/playlists/');
}

bool isPlaylistDetailLocation(String location) {
  return location.startsWith('/playlists/') && location != '/playlists/import';
}

bool isImmersivePlaylistDetailLocation(String location) {
  return isPlaylistDetailLocation(location) ||
      location.startsWith('/discover/playlists/');
}

bool isDiscoveryLocation(String location) =>
    location == '/' || location.startsWith('/discover/');

bool isSongsLibraryLocation(String location) {
  return location == '/songs' || location == '/songs/search';
}

String normalizedPlayerReturnLocation(String primary, String fallback) {
  if (_isPlayerReturnLocation(primary)) return primary;
  if (_isPlayerReturnLocation(fallback)) return fallback;
  return '/songs';
}

bool _isPlayerReturnLocation(String location) {
  if (isDiscoveryLocation(location)) return true;
  if (isPlaylistLocation(location)) return true;
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
