import 'dart:io';
import 'dart:isolate';

import 'package:flutter/services.dart';
import 'package:flutter_audio_tagger/flutter_audio_tagger.dart';
import 'package:flutter_audio_tagger/tag.dart';

import 'app_logger.dart';
import 'flac_metadata_writer.dart';

class TaggingPayload {
  const TaggingPayload({
    required this.title,
    required this.artist,
    required this.album,
    this.coverBytes,
    this.lyrics,
  });

  final String title;
  final String artist;
  final String album;
  final Uint8List? coverBytes;
  final String? lyrics;
}

class TaggingVerifyResult {
  const TaggingVerifyResult({
    required this.lyricsLength,
    required this.artworkLength,
  });

  final int lyricsLength;
  final int artworkLength;
}

class EmbeddedAudioTags {
  const EmbeddedAudioTags({
    this.title,
    this.artist,
    this.album,
    this.lyrics,
    this.artworkBytes,
  });

  final String? title;
  final String? artist;
  final String? album;
  final String? lyrics;
  final Uint8List? artworkBytes;

  bool get hasLyrics => lyrics != null && lyrics!.trim().isNotEmpty;
  bool get hasArtwork => artworkBytes != null && artworkBytes!.isNotEmpty;
  bool get isEmpty =>
      !_hasText(title) &&
      !_hasText(artist) &&
      !_hasText(album) &&
      !hasLyrics &&
      !hasArtwork;

  static bool _hasText(String? value) =>
      value != null && value.trim().isNotEmpty;
}

class Tagger {
  const Tagger._();

  static final FlutterAudioTagger _tagger = FlutterAudioTagger();
  static const MethodChannel _nativeTagger = MethodChannel(
    'twilight_echo/native_tagger',
  );

  /// Reads back the LYRICS tag written by [write], without touching audio
  /// frames. Used to show local-history lyrics without a network round trip.
  static Future<String?> readLyrics(String path) async {
    final tags = await readEmbeddedTags(path, includeArtwork: false);
    final lyrics = tags?.lyrics;
    return (lyrics != null && lyrics.isNotEmpty) ? lyrics : null;
  }

  /// Reads the small embedded tag payload needed by the local player. This is
  /// intentionally separated from playback so local lyrics and artwork can show
  /// immediately without a network lyric/cover round trip.
  static Future<EmbeddedAudioTags?> readEmbeddedTags(
    String path, {
    bool includeLyrics = true,
    bool includeArtwork = true,
  }) async {
    if (await _isFlacStream(path)) {
      final summary = await Isolate.run(
        () => FlacMetadataWriter.readSummary(
          path,
          includeLyrics: includeLyrics,
          includeArtwork: includeArtwork,
        ),
      );
      if (summary == null) return null;
      final tags = EmbeddedAudioTags(
        title: summary.firstComment('TITLE'),
        artist: summary.firstComment('ARTIST'),
        album: summary.firstComment('ALBUM'),
        lyrics: includeLyrics ? summary.firstComment('LYRICS') : null,
        artworkBytes: includeArtwork ? summary.artworkBytes : null,
      );
      return tags.isEmpty ? null : tags;
    }

    if (Platform.isAndroid) {
      try {
        final result = await _nativeTagger
            .invokeMapMethod<String, Object?>('read', <String, Object?>{
              'path': path,
              'includeLyrics': includeLyrics,
              'includeArtwork': includeArtwork,
            });
        // A non-null map is a successful native read even when the requested
        // projection is empty. Falling back here would re-read excluded fields.
        if (result != null) return _tagsFromMap(result);
      } on MissingPluginException {
        await AppLogger.write(
          'tagger',
          'android native metadata reader missing, falling back to plugin',
        );
      } catch (e) {
        await AppLogger.write(
          'tagger',
          'android native metadata read FAIL: $e',
        );
      }
    }

    try {
      final tags = await _tagger.getAllTags(path);
      if (tags == null) return null;
      final embedded = EmbeddedAudioTags(
        title: _emptyToNull(tags.title),
        artist: _emptyToNull(tags.artist),
        album: _emptyToNull(tags.album),
        lyrics: includeLyrics ? _emptyToNull(tags.lyrics) : null,
        artworkBytes: includeArtwork ? tags.artwork : null,
      );
      return embedded.isEmpty ? null : embedded;
    } catch (_) {
      return null;
    }
  }

  static Future<TaggingVerifyResult?> write(
    String path,
    TaggingPayload payload,
  ) async {
    final beforeSize = _safeFileSize(path);
    final hasLyrics = payload.lyrics != null && payload.lyrics!.isNotEmpty;
    final artworkMimeType = imageMimeTypeFromBytes(payload.coverBytes);
    final hasArtwork = artworkMimeType != null;

    await AppLogger.write(
      'tagger',
      'write start path=$path beforeSize=$beforeSize '
          'lyrics=${payload.lyrics?.length ?? 0} '
          'artwork=${payload.coverBytes?.length ?? 0} '
          'hasArtwork=$hasArtwork',
    );

    // Keep large files away from flutter_audio_tagger's stock methods when
    // possible: the plugin reads the edited audio back into a MethodChannel
    // result, which can OOM on large lossless files.
    var tagsOk = false;
    var artworkOk = false;
    final isFlac = await _isFlacStream(path);

    if (isFlac) {
      try {
        final result = await FlacMetadataWriter.write(
          path,
          title: payload.title.isEmpty ? null : payload.title,
          artist: payload.artist.isEmpty ? null : payload.artist,
          album: payload.album.isEmpty ? null : payload.album,
          lyrics: hasLyrics ? payload.lyrics : null,
          pictureBytes: hasArtwork ? payload.coverBytes : null,
          pictureMimeType: artworkMimeType ?? 'image/jpeg',
        );
        if (result != null) {
          await AppLogger.write(
            'tagger',
            'flac native metadata OK lyricsLen=${result.lyricsLength} '
                'artworkLen=${result.artworkLength}',
          );
          return TaggingVerifyResult(
            lyricsLength: result.lyricsLength,
            artworkLength: result.artworkLength,
          );
        }
        await AppLogger.write(
          'tagger',
          'flac native metadata skipped (not FLAC magic), falling back',
        );
      } catch (e, s) {
        await AppLogger.write('tagger', 'flac native metadata FAIL: $e');
        await AppLogger.write('tagger', 'flac native metadata stack: $s');
        throw StateError('flac native tagger failed: $e');
      }
    }

    if (Platform.isAndroid) {
      try {
        final result = await _writeWithNativeTagger(
          path,
          payload,
          hasLyrics: hasLyrics,
          hasArtwork: hasArtwork,
          artworkMimeType: artworkMimeType,
        );
        if (result != null) {
          await AppLogger.write(
            'tagger',
            'android native metadata OK lyricsLen=${result.lyricsLength} '
                'artworkLen=${result.artworkLength}',
          );
          return result;
        }
      } on MissingPluginException {
        await AppLogger.write(
          'tagger',
          'android native metadata missing, falling back to plugin',
        );
      } catch (e, s) {
        await AppLogger.write('tagger', 'android native metadata FAIL: $e');
        await AppLogger.write('tagger', 'android native metadata stack: $s');
        throw StateError('android native tagger failed: $e');
      }
    }

    try {
      await _tagger.editTags(
        Tag(
          artist: payload.artist.isEmpty ? null : payload.artist,
          title: payload.title.isEmpty ? null : payload.title,
          album: payload.album.isEmpty ? null : payload.album,
          lyrics: hasLyrics ? payload.lyrics : null,
        ),
        path,
      );
      tagsOk = true;
    } catch (e, s) {
      await AppLogger.write('tagger', 'editTags FAIL: $e');
      await AppLogger.write('tagger', 'editTags stack: $s');
    }

    if (hasArtwork) {
      try {
        await _tagger.setArtWork(payload.coverBytes, path);
        artworkOk = true;
      } catch (e, s) {
        await AppLogger.write('tagger', 'setArtWork FAIL: $e');
        await AppLogger.write('tagger', 'setArtWork stack: $s');
      }
    }

    final afterSize = _safeFileSize(path);
    await AppLogger.write(
      'tagger',
      'write done tagsOk=$tagsOk artworkOk=$artworkOk '
          'afterSize=$afterSize delta=${afterSize - beforeSize}',
    );

    if (afterSize <= 0) {
      throw StateError(
        'tagger produced an empty file (size=$afterSize, was=$beforeSize)',
      );
    }

    if (!tagsOk && !artworkOk) {
      throw StateError('tagger: both tags and artwork passes failed');
    }

    try {
      final written = await _tagger.getAllTags(path);
      final result = TaggingVerifyResult(
        lyricsLength: written?.lyrics?.length ?? 0,
        artworkLength: written?.artwork?.length ?? 0,
      );
      await AppLogger.write(
        'tagger',
        'verify lyricsLen=${result.lyricsLength} '
            'artworkLen=${result.artworkLength}',
      );
      return result;
    } catch (e) {
      await AppLogger.write('tagger', 'verify skipped (read failed): $e');
      return null;
    }
  }

  static Future<TaggingVerifyResult?> _writeWithNativeTagger(
    String path,
    TaggingPayload payload, {
    required bool hasLyrics,
    required bool hasArtwork,
    required String? artworkMimeType,
  }) async {
    final result = await _nativeTagger
        .invokeMapMethod<String, Object?>('write', <String, Object?>{
          'path': path,
          'title': payload.title.isEmpty ? null : payload.title,
          'artist': payload.artist.isEmpty ? null : payload.artist,
          'album': payload.album.isEmpty ? null : payload.album,
          'lyrics': hasLyrics ? payload.lyrics : null,
          'artwork': hasArtwork ? payload.coverBytes : null,
          'artworkMimeType': hasArtwork ? artworkMimeType : null,
        });
    if (result == null) return null;
    return TaggingVerifyResult(
      lyricsLength: _asInt(result['lyricsLength']),
      artworkLength: _asInt(result['artworkLength']),
    );
  }

  static int _asInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return 0;
  }

  static EmbeddedAudioTags? _tagsFromMap(Map<String, Object?>? map) {
    if (map == null) return null;
    final tags = EmbeddedAudioTags(
      title: _emptyToNull(map['title'] as String?),
      artist: _emptyToNull(map['artist'] as String?),
      album: _emptyToNull(map['album'] as String?),
      lyrics: _emptyToNull(map['lyrics'] as String?),
      artworkBytes: map['artwork'] as Uint8List?,
    );
    return tags.isEmpty ? null : tags;
  }

  static String? _emptyToNull(String? value) {
    final trimmed = value?.trim();
    return trimmed == null || trimmed.isEmpty ? null : trimmed;
  }

  static int _safeFileSize(String path) {
    try {
      return File(path).lengthSync();
    } catch (_) {
      return -1;
    }
  }

  static Future<bool> _isFlacStream(String path) async {
    RandomAccessFile? file;
    try {
      file = await File(path).open(mode: FileMode.read);
      final magic = await file.read(4);
      return magic.length == 4 &&
          magic[0] == 0x66 &&
          magic[1] == 0x4C &&
          magic[2] == 0x61 &&
          magic[3] == 0x43;
    } catch (_) {
      return false;
    } finally {
      await file?.close();
    }
  }
}

String? imageMimeTypeFromBytes(Uint8List? bytes) {
  if (bytes == null || bytes.isEmpty) return null;

  bool matches(int offset, List<int> signature) {
    if (offset < 0 || offset + signature.length > bytes.length) return false;
    for (var index = 0; index < signature.length; index++) {
      if (bytes[offset + index] != signature[index]) return false;
    }
    return true;
  }

  if (matches(0, const [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (matches(0, const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return 'image/png';
  }
  if (matches(0, const [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      matches(0, const [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  if (matches(0, const [0x52, 0x49, 0x46, 0x46]) &&
      matches(8, const [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  if (matches(0, const [0x42, 0x4D])) return 'image/bmp';

  // ISO BMFF images identify their major and compatible brands after `ftyp`.
  if (matches(4, const [0x66, 0x74, 0x79, 0x70])) {
    final scanEnd = bytes.length < 40 ? bytes.length : 40;
    for (var offset = 8; offset + 4 <= scanEnd; offset += 4) {
      if (matches(offset, const [0x61, 0x76, 0x69, 0x66]) ||
          matches(offset, const [0x61, 0x76, 0x69, 0x73])) {
        return 'image/avif';
      }
      if (matches(offset, const [0x68, 0x65, 0x69, 0x63]) ||
          matches(offset, const [0x68, 0x65, 0x69, 0x78]) ||
          matches(offset, const [0x68, 0x65, 0x76, 0x63]) ||
          matches(offset, const [0x68, 0x65, 0x76, 0x78]) ||
          matches(offset, const [0x6D, 0x69, 0x66, 0x31])) {
        return 'image/heic';
      }
    }
  }
  return null;
}
