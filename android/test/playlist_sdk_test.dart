import 'package:test/test.dart';

import 'package:twilight_echo/core/models/enums.dart';
import 'package:twilight_echo/core/sdk/playlist_sdk.dart';

void main() {
  group('PlaylistSdk.parseTarget', () {
    test('recognizes NetEase standard and hash links', () {
      final standard = PlaylistSdk.parseTarget(
        'https://music.163.com/playlist?id=3778678',
      );
      final hash = PlaylistSdk.parseTarget(
        'https://music.163.com/#/playlist?id=3778678',
      );

      expect(standard?.source, MusicSource.wy);
      expect(standard?.id, '3778678');
      expect(hash?.source, MusicSource.wy);
      expect(hash?.id, '3778678');
    });

    test('recognizes QQ standard and share query links', () {
      final standard = PlaylistSdk.parseTarget(
        'https://y.qq.com/n/ryqq/playlist/1207922987',
      );
      final currentStandard = PlaylistSdk.parseTarget(
        'https://y.qq.com/n/ryqq_v2/playlist/1207922987',
      );
      final shared = PlaylistSdk.parseTarget(
        'https://c.y.qq.com/n/ryqq/playlist?disstid=1207922987',
      );
      final mobileShare = PlaylistSdk.parseTarget(
        'https://i.y.qq.com/n2/m/share/details/taoge.html?id=1207922987',
      );
      final redirectedShare = PlaylistSdk.parseTarget(
        'https://i2.y.qq.com/n3/other/pages/details/playlist.html'
        '?id=1207922987&redirect_from=node_v2',
      );

      expect(standard?.source, MusicSource.tx);
      expect(standard?.id, '1207922987');
      expect(currentStandard?.source, MusicSource.tx);
      expect(currentStandard?.id, '1207922987');
      expect(shared?.source, MusicSource.tx);
      expect(shared?.id, '1207922987');
      expect(mobileShare?.source, MusicSource.tx);
      expect(mobileShare?.id, '1207922987');
      expect(redirectedShare?.source, MusicSource.tx);
      expect(redirectedShare?.id, '1207922987');
    });

    test('extracts supported URLs from standard share text', () {
      final netEase = PlaylistSdk.parseTarget(
        '分享歌单《热歌榜》：https://music.163.com/#/playlist?id=3778678 '
        '（来自网易云音乐）',
      );
      final qq = PlaylistSdk.parseTarget(
        'QQ音乐分享：https://i.y.qq.com/n2/m/share/details/taoge.html?'
        'id=1207922987。',
      );

      expect(netEase?.source, MusicSource.wy);
      expect(netEase?.id, '3778678');
      expect(qq?.source, MusicSource.tx);
      expect(qq?.id, '1207922987');
    });

    test('recognizes Kuwo standard and mobile share links', () {
      final standard = PlaylistSdk.parseTarget(
        'https://www.kuwo.cn/playlist_detail/2681570244',
      );
      final mobile = PlaylistSdk.parseTarget(
        'https://m.kuwo.cn/newh5app/playlist_detail/2950907654?source=share',
      );

      expect(standard?.source, MusicSource.kw);
      expect(standard?.id, '2681570244');
      expect(mobile?.source, MusicSource.kw);
      expect(mobile?.id, '2950907654');
    });

    test('recognizes Kugou standard and mobile share links', () {
      final standard = PlaylistSdk.parseTarget(
        'https://www.kugou.com/yy/special/single/1254394.html',
      );
      final mobile = PlaylistSdk.parseTarget(
        'https://m.kugou.com/plist/list/1254394?uid=1234',
      );
      final global = PlaylistSdk.parseTarget(
        'https://m3ws.kugou.com/share/index.php?'
        'global_specialid=collection_3_509005732_35_0',
      );
      final chain = PlaylistSdk.parseTarget(
        'https://www.kugou.com/share/8eJsfc5xIV3.html?id=8eJsfc5xIV3',
      );
      final songList = PlaylistSdk.parseTarget(
        'https://www.kugou.com/songlist/8eJsfc5xIV3/?uid=1234&iszlist=1',
      );
      final gcid = PlaylistSdk.parseTarget(
        'https://www.kugou.com/songlist/gcid_3z9ly0fxznz0d1/这个歌单链接',
      );

      expect(standard?.source, MusicSource.kg);
      expect(standard?.id, '1254394');
      expect(mobile?.source, MusicSource.kg);
      expect(mobile?.id, '1254394');
      expect(global?.source, MusicSource.kg);
      expect(global?.id, 'global:collection_3_509005732_35_0');
      expect(chain?.source, MusicSource.kg);
      expect(chain?.id, 'chain:8eJsfc5xIV3');
      expect(songList?.source, MusicSource.kg);
      expect(songList?.id, 'chain:8eJsfc5xIV3');
      expect(gcid?.source, MusicSource.kg);
      expect(gcid?.id, 'gcid:gcid_3z9ly0fxznz0d1');
    });

    test('recognizes Migu standard and hash share links', () {
      final standard = PlaylistSdk.parseTarget(
        'https://music.migu.cn/v3/music/playlist/207393686',
      );
      final hash = PlaylistSdk.parseTarget(
        'https://m.music.migu.cn/#/playlist/207393686',
      );
      final mobileQuery = PlaylistSdk.parseTarget(
        'https://m.music.migu.cn/migu/remoting/playlistcontents_query_tag'
        '?playListId=207393686',
      );

      expect(standard?.source, MusicSource.mg);
      expect(standard?.id, '207393686');
      expect(hash?.source, MusicSource.mg);
      expect(hash?.id, '207393686');
      expect(mobileQuery?.source, MusicSource.mg);
      expect(mobileQuery?.id, '207393686');
    });

    test('requires an explicit source for bare numeric IDs', () {
      expect(PlaylistSdk.parseTarget('1207922987'), isNull);
      expect(
        PlaylistSdk.parseTarget('1207922987', source: MusicSource.wy)?.source,
        MusicSource.wy,
      );
      expect(
        PlaylistSdk.parseTarget('1207922987', source: MusicSource.tx)?.source,
        MusicSource.tx,
      );
      for (final source in [MusicSource.kw, MusicSource.kg, MusicSource.mg]) {
        expect(
          PlaylistSdk.parseTarget('1207922987', source: source)?.source,
          source,
        );
      }
    });

    test('does not recognize cross-domain lookalikes', () {
      expect(
        PlaylistSdk.parseTarget(
          'https://example.com/playlist/1207922987?id=3778678',
        ),
        isNull,
      );
      expect(
        PlaylistSdk.parseTarget(
          'https://example.com/?disstid=1207922987',
          source: MusicSource.tx,
        ),
        isNull,
      );
      expect(
        PlaylistSdk.parseTarget(
          'https://music.163.com.example.com/playlist?id=3778678',
        ),
        isNull,
      );
    });

    test('returns null for invalid URLs without throwing', () {
      expect(PlaylistSdk.parseTarget('not a playlist URL'), isNull);
      expect(PlaylistSdk.parseTarget('https://music.163.com/%E0%A4%A'), isNull);
      expect(
        PlaylistSdk.parseTarget('https://y.qq.com/?id=1207922987'),
        isNull,
      );
      expect(
        PlaylistSdk.parseTarget(
          '伪造链接 https://example.com/details/taoge.html?id=1207922987。',
        ),
        isNull,
      );
    });
  });
}
