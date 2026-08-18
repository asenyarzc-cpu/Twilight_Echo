import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/music_api.dart';
import 'playlist_models.dart';
import 'playlist_store.dart';

@immutable
class OnlinePlaylistUpdateResult {
  const OnlinePlaylistUpdateResult({
    required this.playlist,
    required this.addedTrackCount,
    required this.removedTrackCount,
  });

  final LocalPlaylist playlist;
  final int addedTrackCount;
  final int removedTrackCount;
}

class OnlinePlaylistUpdater {
  const OnlinePlaylistUpdater(this._api);

  final MusicApi _api;

  Future<OnlinePlaylistUpdateResult> update({
    required LocalPlaylist playlist,
    required LocalPlaylistNotifier store,
  }) async {
    final source = playlist.onlineSource;
    final originId = playlist.onlinePlaylistId;
    if (source == null || originId == null) {
      throw const PlaylistStoreException('只有在线歌单可以更新');
    }

    final existingTrackIds = {
      for (final track in playlist.tracks) track.identityKey,
    };
    final latest = await _api.parsePlaylist(input: originId, source: source);
    final updated = await store.importOnline(latest, synchronizeTracks: true);
    final updatedTrackIds = {
      for (final track in updated.tracks) track.identityKey,
    };
    final addedTrackCount = updated.tracks
        .where((track) => !existingTrackIds.contains(track.identityKey))
        .length;
    final removedTrackCount = existingTrackIds
        .where((trackId) => !updatedTrackIds.contains(trackId))
        .length;
    return OnlinePlaylistUpdateResult(
      playlist: updated,
      addedTrackCount: addedTrackCount,
      removedTrackCount: removedTrackCount,
    );
  }
}

final onlinePlaylistUpdaterProvider = Provider<OnlinePlaylistUpdater>((ref) {
  return OnlinePlaylistUpdater(ref.watch(musicApiProvider));
});

String onlinePlaylistUpdateMessage(OnlinePlaylistUpdateResult result) {
  final added = result.addedTrackCount;
  final removed = result.removedTrackCount;
  final changes = <String>[
    if (added > 0) '新增 $added 首',
    if (removed > 0) '移除 $removed 首',
  ];
  final detail = changes.isEmpty ? '' : '${changes.join('，')}，';
  return '歌单已更新，$detail共 ${result.playlist.tracks.length} 首';
}
