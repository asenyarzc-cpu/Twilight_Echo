import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/api/music_api.dart';
import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/models/music_info.dart';
import 'package:twilight_echo/core/models/playlist_info.dart';
import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/discovery/online_playlist_detail_page.dart';
import 'package:twilight_echo/features/playlists/playlist_detail_page.dart';
import 'package:twilight_echo/features/playlists/playlist_models.dart';
import 'package:twilight_echo/features/playlists/playlist_store.dart';

const _wideLayoutKey = ValueKey('playlist-wide-layout');
const _infoPaneKey = ValueKey('playlist-wide-info-pane');
const _headerKey = ValueKey('immersive-playlist-header');
const _playAllKey = ValueKey('playlist-play-all');
const _favoriteKey = ValueKey('playlist-favorite');
const _skeletonKey = ValueKey('detail-track-skeleton');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('local detail switches to the wide two-pane layout at 1024x600', (
    tester,
  ) async {
    await _useViewport(tester, const Size(1024, 600));
    await _pumpLocalDetail(tester, playlist: _localPlaylist());

    expect(find.byKey(_wideLayoutKey), findsOneWidget);
    expect(find.byKey(_infoPaneKey), findsOneWidget);
    expect(find.byKey(_headerKey), findsNothing);
    expect(find.byKey(_playAllKey), findsOneWidget);
    // 非在线导入歌单没有「取消收藏」。
    expect(find.byKey(_favoriteKey), findsNothing);
    expect(find.text('第一首'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('local detail keeps the immersive header on phones', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    await _pumpLocalDetail(tester, playlist: _localPlaylist());

    expect(find.byKey(_headerKey), findsOneWidget);
    expect(find.byKey(_wideLayoutKey), findsNothing);
    expect(find.byKey(_playAllKey), findsOneWidget);
    expect(find.byKey(_favoriteKey), findsNothing);
    // 「添加到下一首播放」已从歌单行移除。
    expect(find.byIcon(Icons.playlist_add_rounded), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unfavorite flow confirms, deletes and returns to /playlists', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final container = _newContainer(
      await _seedPreferences(_localPlaylist(online: true)),
    );
    final router = GoRouter(
      initialLocation: '/playlists/fav',
      routes: [
        GoRoute(
          path: '/playlists',
          builder: (_, _) => const Scaffold(body: Text('歌单列表桩')),
        ),
        GoRoute(
          path: '/playlists/:id',
          builder: (_, state) =>
              PlaylistDetailPage(playlistId: state.pathParameters['id']!),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(theme: _theme(), routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(_favoriteKey), findsOneWidget);
    expect(find.text('取消收藏'), findsOneWidget);

    // 取消分支：歌单保留、停在详情页。
    await tester.tap(find.byKey(_favoriteKey));
    await tester.pumpAndSettle();
    expect(find.text('取消收藏这个歌单？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();
    expect(container.read(localPlaylistsProvider), hasLength(1));
    expect(router.routeInformationProvider.value.uri.path, '/playlists/fav');

    // 确认分支：删除并回到歌单列表。
    await tester.tap(find.byKey(_favoriteKey));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.widgetWithText(FilledButton, '取消收藏'),
      ),
    );
    await tester.pumpAndSettle();
    expect(container.read(localPlaylistsProvider), isEmpty);
    expect(router.routeInformationProvider.value.uri.path, '/playlists');
    expect(find.text('歌单列表桩'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('online detail renders wide skeleton then data at 1024x600', (
    tester,
  ) async {
    await _useViewport(tester, const Size(1024, 600));
    final fake = _FakePlaylistApi(delayDetail: true);
    final container = _newContainer(
      await SharedPreferences.getInstance(),
      musicApi: fake,
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: _theme(),
          home: const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(_wideLayoutKey), findsOneWidget);
    expect(find.byKey(_headerKey), findsNothing);
    expect(find.byKey(_skeletonKey), findsNWidgets(8));
    expect(find.byKey(_playAllKey), findsOneWidget);

    fake.completeDetail();
    await tester.pumpAndSettle();

    expect(find.byKey(_wideLayoutKey), findsOneWidget);
    expect(find.byKey(_skeletonKey), findsNothing);
    expect(find.text('在线曲目'), findsOneWidget);
    expect(find.byKey(_favoriteKey), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('wide info pane stacks play/favorite onto two rows', (
    tester,
  ) async {
    await _useViewport(tester, const Size(1024, 600));
    final container = _newContainer(
      await SharedPreferences.getInstance(),
      musicApi: _FakePlaylistApi(),
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: _theme(),
          home: const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 340dp 左列放不下两个并排按钮：收藏按钮换行，且都占满整行宽。
    final playRect = tester.getRect(find.byKey(_playAllKey));
    final favoriteRect = tester.getRect(find.byKey(_favoriteKey));
    expect(favoriteRect.top, greaterThanOrEqualTo(playRect.bottom));
    expect(favoriteRect.width, playRect.width);
    expect(tester.takeException(), isNull);
  });

  testWidgets('phone width keeps play/favorite on one row', (tester) async {
    await _useViewport(tester, const Size(390, 844));
    final container = _newContainer(
      await SharedPreferences.getInstance(),
      musicApi: _FakePlaylistApi(),
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: _theme(),
          home: const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final playRect = tester.getRect(find.byKey(_playAllKey));
    final favoriteRect = tester.getRect(find.byKey(_favoriteKey));
    expect(favoriteRect.top, playRect.top);
    expect(favoriteRect.left, greaterThan(playRect.right));
    expect(tester.takeException(), isNull);
  });

  testWidgets('detail skeleton rows match the real row geometry on phones', (
    tester,
  ) async {
    await _useViewport(tester, const Size(390, 844));
    final fake = _FakePlaylistApi(delayDetail: true);
    final container = _newContainer(
      await SharedPreferences.getInstance(),
      musicApi: fake,
    );
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: _theme(),
          home: const OnlinePlaylistDetailPage(
            source: MusicSource.kw,
            playlistId: '1',
          ),
        ),
      ),
    );
    await tester.pump();

    final skeletons = find.byKey(_skeletonKey);
    expect(skeletons, findsNWidgets(5));
    final size = tester.getSize(skeletons.first);
    expect(size.height, 62);
    // SliverPadding 左右各 12，与数据行同宽。
    expect(size.width, 390 - 24);
    expect(find.byType(Divider), findsNWidgets(4));
    expect(tester.takeException(), isNull);
  });
}

ThemeData _theme() {
  return ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
  );
}

Future<void> _useViewport(WidgetTester tester, Size size) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(() {
    tester.view.resetDevicePixelRatio();
    tester.view.resetPhysicalSize();
  });
}

ProviderContainer _newContainer(SharedPreferences prefs, {MusicApi? musicApi}) {
  final container = ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
      if (musicApi != null) musicApiProvider.overrideWithValue(musicApi),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

Future<SharedPreferences> _seedPreferences(LocalPlaylist playlist) async {
  SharedPreferences.setMockInitialValues({
    localPlaylistsStorageKey: [jsonEncode(playlist.toJson())],
  });
  return SharedPreferences.getInstance();
}

Future<ProviderContainer> _pumpLocalDetail(
  WidgetTester tester, {
  required LocalPlaylist playlist,
}) async {
  final container = _newContainer(await _seedPreferences(playlist));
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: _theme(),
        home: PlaylistDetailPage(playlistId: playlist.id),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

LocalPlaylist _localPlaylist({bool online = false}) {
  return LocalPlaylist(
    id: online ? 'fav' : 'plain',
    name: online ? '收藏的歌单' : '本地歌单',
    tracks: [
      PlaylistTrack.fromMusicInfo(_music('track-1', '第一首')),
      PlaylistTrack.fromMusicInfo(_music('track-2', '第二首')),
    ],
    createdAt: DateTime.utc(2026, 8, 1),
    updatedAt: DateTime.utc(2026, 8, 1),
    originPlaylistId: online ? 'origin-1' : null,
    originSourceCode: online ? MusicSource.kw.code : null,
  );
}

MusicInfo _music(String id, String name) {
  return MusicInfo.fromJson({
    'id': id,
    'name': name,
    'singer': '测试歌手',
    'source': MusicSource.kw.code,
    'interval': '03:30',
    'meta': {
      'songId': id,
      'albumName': '测试专辑',
      'qualitys': [
        {'type': Quality.k320.code, 'size': '1024'},
      ],
    },
  });
}

class _FakePlaylistApi extends MusicApi {
  _FakePlaylistApi({this.delayDetail = false});

  final bool delayDetail;
  final Completer<PlaylistInfo> _detail = Completer<PlaylistInfo>();

  PlaylistInfo get _playlist => PlaylistInfo(
    id: '1',
    name: '在线歌单',
    source: MusicSource.kw,
    creator: '在线作者',
    description: '在线歌单简介',
    playCount: 1200,
    trackCount: 1,
    tracks: [_music('online-1', '在线曲目')],
  );

  void completeDetail() => _detail.complete(_playlist);

  @override
  Future<PlaylistInfo> parsePlaylist({
    required String input,
    MusicSource source = MusicSource.all,
    int? maxTracks,
  }) {
    return delayDetail ? _detail.future : Future.value(_playlist);
  }
}
