import 'enums.dart';

class PlaylistCatalogCategory {
  const PlaylistCatalogCategory({required this.id, required this.label});

  final String id;
  final String label;
}

const _kuwoPlaylistCategories = <PlaylistCatalogCategory>[
  PlaylistCatalogCategory(id: 'new', label: '最新'),
  PlaylistCatalogCategory(id: 'hot', label: '最热'),
];

const _kugouPlaylistCategories = <PlaylistCatalogCategory>[
  PlaylistCatalogCategory(id: '5', label: '推荐'),
  PlaylistCatalogCategory(id: '6', label: '最热'),
  PlaylistCatalogCategory(id: '7', label: '最新'),
  PlaylistCatalogCategory(id: '3', label: '热藏'),
  PlaylistCatalogCategory(id: '8', label: '飙升'),
];

const _qqPlaylistCategories = <PlaylistCatalogCategory>[
  PlaylistCatalogCategory(id: '5', label: '最热'),
  PlaylistCatalogCategory(id: '2', label: '最新'),
];

const _neteasePlaylistCategories = <PlaylistCatalogCategory>[
  PlaylistCatalogCategory(id: 'hot', label: '推荐'),
];

const _miguPlaylistCategories = <PlaylistCatalogCategory>[
  PlaylistCatalogCategory(id: '15127315', label: '推荐'),
];

List<PlaylistCatalogCategory> playlistCatalogCategoriesFor(
  MusicSource source,
) => switch (source) {
  MusicSource.kw => _kuwoPlaylistCategories,
  MusicSource.kg => _kugouPlaylistCategories,
  MusicSource.tx => _qqPlaylistCategories,
  MusicSource.wy => _neteasePlaylistCategories,
  MusicSource.mg => _miguPlaylistCategories,
  MusicSource.all => const <PlaylistCatalogCategory>[],
};

PlaylistCatalogCategory defaultPlaylistCatalogCategoryFor(MusicSource source) {
  final categories = playlistCatalogCategoriesFor(source);
  if (categories.isEmpty) {
    throw ArgumentError.value(source, 'source', '必须指定歌单平台');
  }
  return categories.first;
}
