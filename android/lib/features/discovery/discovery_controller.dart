import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/music_api.dart';
import '../../core/models/enums.dart';
import '../../core/models/music_info.dart';
import '../../core/models/playlist_category.dart';
import '../../core/models/playlist_info.dart';
import '../../core/models/playlist_summary.dart';

const int discoveryPlaylistArtworkSize = 640;
const int discoveryPlaylistPageSize = 30;
const int onlinePlaylistDetailInitialTrackLimit = 40;
const int onlinePlaylistDetailTrackPageSize = 40;
const List<MusicSource> kDiscoverySources = <MusicSource>[
  MusicSource.kw,
  MusicSource.kg,
  MusicSource.tx,
  MusicSource.wy,
  MusicSource.mg,
];

typedef OnlinePlaylistIdentity = ({MusicSource source, String id});

final onlinePlaylistSummaryCacheProvider =
    Provider<Map<OnlinePlaylistIdentity, PlaylistSummary>>((ref) => {});

String onlinePlaylistArtworkHeroTag(MusicSource source, String playlistId) {
  return 'online-playlist-artwork:${source.code}:$playlistId';
}

final selectedDiscoverySourceProvider = StateProvider<MusicSource>(
  (ref) => MusicSource.kw,
);

final selectedDiscoveryCategoryProvider =
    StateProvider.family<String, MusicSource>(
      (ref, source) => defaultPlaylistCatalogCategoryFor(source).id,
    );

final featuredPlaylistsProvider =
    FutureProvider.family<List<PlaylistSummary>, MusicSource>((ref, source) {
      final categoryId = ref.watch(selectedDiscoveryCategoryProvider(source));
      return ref
          .watch(musicApiProvider)
          .featuredPlaylists(
            source: source,
            page: 1,
            limit: discoveryPlaylistPageSize,
            categoryId: categoryId,
          );
    });

class OnlinePlaylistKey {
  const OnlinePlaylistKey({
    required this.source,
    required this.id,
    this.maxTracks = onlinePlaylistDetailInitialTrackLimit,
  });

  final MusicSource source;
  final String id;
  final int? maxTracks;

  @override
  bool operator ==(Object other) =>
      other is OnlinePlaylistKey &&
      other.source == source &&
      other.id == id &&
      other.maxTracks == maxTracks;

  @override
  int get hashCode => Object.hash(source, id, maxTracks);
}

final onlinePlaylistDetailProvider =
    FutureProvider.family<PlaylistInfo, OnlinePlaylistKey>((ref, key) {
      return ref
          .watch(musicApiProvider)
          .parsePlaylist(
            input: key.id,
            source: key.source,
            maxTracks: key.maxTracks,
          );
    });

class OnlineTrackCoverKey {
  const OnlineTrackCoverKey(this.music);

  final MusicInfo music;

  @override
  bool operator ==(Object other) =>
      other is OnlineTrackCoverKey &&
      other.music.source == music.source &&
      other.music.id == music.id;

  @override
  int get hashCode => Object.hash(music.source, music.id);
}

final onlineTrackCoverProvider =
    FutureProvider.family<String?, OnlineTrackCoverKey>((ref, key) {
      return ref
          .watch(musicApiProvider)
          .getPicUrl(musicInfo: key.music, preferCached: false);
    });
