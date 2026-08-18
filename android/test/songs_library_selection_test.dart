import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:twilight_echo/core/storage/settings_store.dart';
import 'package:twilight_echo/features/songs/songs_toolbar_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('songs library selection survives a provider restart', () async {
    SharedPreferences.setMockInitialValues({
      songsLibraryPlaylistIdStorageKey: 'night',
    });
    final prefs = await SharedPreferences.getInstance();
    final first = _containerWith(prefs);

    expect(first.read(songsLibraryPlaylistIdProvider), 'night');
    first.read(songsLibraryPlaylistIdProvider.notifier).select('favorites');
    expect(prefs.getString(songsLibraryPlaylistIdStorageKey), 'favorites');
    first.dispose();

    final restarted = _containerWith(prefs);
    expect(restarted.read(songsLibraryPlaylistIdProvider), 'favorites');
    restarted.dispose();
  });

  test('selecting local songs clears the persisted playlist', () async {
    SharedPreferences.setMockInitialValues({
      songsLibraryPlaylistIdStorageKey: 'night',
    });
    final prefs = await SharedPreferences.getInstance();
    final container = _containerWith(prefs);

    container.read(songsLibraryPlaylistIdProvider.notifier).select(null);

    expect(container.read(songsLibraryPlaylistIdProvider), isNull);
    expect(prefs.containsKey(songsLibraryPlaylistIdStorageKey), isFalse);
    container.dispose();
  });
}

ProviderContainer _containerWith(SharedPreferences prefs) {
  return ProviderContainer(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
  );
}
