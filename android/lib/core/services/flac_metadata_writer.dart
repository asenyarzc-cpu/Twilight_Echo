import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class FlacMetadataWriteResult {
  const FlacMetadataWriteResult({
    required this.lyricsLength,
    required this.artworkLength,
  });

  final int lyricsLength;
  final int artworkLength;
}

class FlacMetadataSummary {
  const FlacMetadataSummary({
    required this.comments,
    required this.artworkLength,
    required this.artworkBytes,
  });

  final Map<String, List<String>> comments;
  final int artworkLength;
  final Uint8List? artworkBytes;

  String? firstComment(String key) {
    final values = comments[key.toUpperCase()];
    if (values == null || values.isEmpty) return null;
    return values.first;
  }
}

class FlacMetadataWriter {
  const FlacMetadataWriter._();

  static const _flacMagic = [0x66, 0x4C, 0x61, 0x43]; // "fLaC"
  static const _typeVorbisComment = 4;
  static const _typePicture = 6;
  static const _maxMetadataPayload = 0xFFFFFF;

  /// Rewrites FLAC metadata without reading the audio frames into memory.
  ///
  /// Returns null when the file is not a FLAC stream. Existing comments and
  /// pictures are preserved unless the matching replacement value is provided.
  static Future<FlacMetadataWriteResult?> write(
    String path, {
    String? title,
    String? artist,
    String? album,
    String? lyrics,
    Uint8List? pictureBytes,
    String pictureMimeType = 'image/jpeg',
  }) async {
    final file = File(path);
    final layout = await _readLayout(file);
    if (layout == null) return null;

    final updateKeys = <String>{
      if (_hasText(title)) 'TITLE',
      if (_hasText(artist)) 'ARTIST',
      if (_hasText(album)) 'ALBUM',
      if (_hasText(lyrics)) 'LYRICS',
    };
    final replacePicture = pictureBytes != null && pictureBytes.isNotEmpty;

    final existingComments = <_VorbisComment>[];
    var vendor = 'twilight_echo';
    var sawVorbisComment = false;
    for (final block in layout.blocks) {
      if (block.type != _typeVorbisComment) continue;
      sawVorbisComment = true;
      final parsed = _parseVorbisComment(block.data);
      if (parsed == null) continue;
      if (parsed.vendor.isNotEmpty) vendor = parsed.vendor;
      existingComments.addAll(parsed.comments);
    }

    final comments = <_VorbisComment>[
      for (final comment in existingComments)
        if (!updateKeys.contains(comment.normalizedKey)) comment,
    ];
    _setComment(comments, 'TITLE', title);
    _setComment(comments, 'ARTIST', artist);
    _setComment(comments, 'ALBUM', album);
    _setComment(comments, 'LYRICS', lyrics);

    final outBlocks = <_FlacBlock>[];
    var insertedVorbisComment = false;
    for (final block in layout.blocks) {
      if (block.type == _typeVorbisComment) {
        if (!insertedVorbisComment) {
          outBlocks.add(
            _FlacBlock(
              _typeVorbisComment,
              _buildVorbisComment(vendor, comments),
            ),
          );
          insertedVorbisComment = true;
        }
        continue;
      }
      if (block.type == _typePicture && replacePicture) continue;
      outBlocks.add(block);
    }

    if (!sawVorbisComment && comments.isNotEmpty) {
      final insertAt = outBlocks.isNotEmpty && outBlocks.first.type == 0
          ? 1
          : 0;
      outBlocks.insert(
        insertAt,
        _FlacBlock(_typeVorbisComment, _buildVorbisComment(vendor, comments)),
      );
    }

    if (replacePicture) {
      outBlocks.add(
        _FlacBlock(
          _typePicture,
          _buildPicturePayload(pictureBytes, mimeType: pictureMimeType),
        ),
      );
    }

    if (outBlocks.isEmpty) {
      throw const FormatException('FLAC metadata block list is empty');
    }

    final temp = await _uniqueSidecar(path, '.twilight_echo_tag.tmp');
    var installed = false;
    try {
      final sink = temp.openWrite();
      sink.add(_flacMagic);
      for (var i = 0; i < outBlocks.length; i++) {
        sink.add(_encodeBlock(outBlocks[i], isLast: i == outBlocks.length - 1));
      }
      await sink.flush();
      await file.openRead(layout.audioStart).pipe(sink);

      await _replaceWithBackup(file, temp);
      installed = true;

      final summary = await readSummary(path);
      return FlacMetadataWriteResult(
        lyricsLength: summary?.firstComment('LYRICS')?.length ?? 0,
        artworkLength: summary?.artworkLength ?? 0,
      );
    } finally {
      if (!installed) {
        try {
          if (await temp.exists()) await temp.delete();
        } catch (_) {}
      }
    }
  }

  static Future<FlacMetadataSummary?> readSummary(
    String path, {
    bool includeLyrics = true,
    bool includeArtwork = true,
  }) async {
    final layout = await _readLayout(
      File(path),
      skippedBlockTypes: includeArtwork ? const {} : const {_typePicture},
    );
    if (layout == null) return null;

    final comments = <String, List<String>>{};
    Uint8List? artworkBytes;
    for (final block in layout.blocks) {
      if (block.type == _typeVorbisComment) {
        final parsed = _parseVorbisComment(
          block.data,
          ignoredKeys: includeLyrics ? const {} : const {'LYRICS'},
        );
        if (parsed == null) continue;
        for (final comment in parsed.comments) {
          comments
              .putIfAbsent(comment.normalizedKey, () => <String>[])
              .add(comment.value);
        }
      } else if (includeArtwork &&
          block.type == _typePicture &&
          artworkBytes == null) {
        artworkBytes = _pictureData(block.data);
      }
    }

    return FlacMetadataSummary(
      comments: comments,
      artworkLength: artworkBytes?.length ?? 0,
      artworkBytes: artworkBytes,
    );
  }

  static Future<_FlacLayout?> _readLayout(
    File file, {
    Set<int> skippedBlockTypes = const {},
  }) async {
    if (!await file.exists()) return null;
    final fileLength = await file.length();
    final raf = await file.open(mode: FileMode.read);
    try {
      final magic = await _readExactly(raf, 4);
      if (magic == null) return null;
      for (var i = 0; i < _flacMagic.length; i++) {
        if (magic[i] != _flacMagic[i]) return null;
      }

      final blocks = <_FlacBlock>[];
      while (true) {
        final header = await _readExactly(raf, 4);
        if (header == null) {
          throw const FormatException('truncated FLAC metadata header');
        }

        final isLast = (header[0] & 0x80) != 0;
        final type = header[0] & 0x7F;
        final length = (header[1] << 16) | (header[2] << 8) | header[3];
        Uint8List data;
        if (skippedBlockTypes.contains(type)) {
          final currentPosition = await raf.position();
          final nextPosition = currentPosition + length;
          if (nextPosition > fileLength) {
            throw const FormatException('truncated FLAC metadata block');
          }
          await raf.setPosition(nextPosition);
          data = Uint8List(0);
        } else {
          final blockData = await _readExactly(raf, length);
          if (blockData == null) {
            throw const FormatException('truncated FLAC metadata block');
          }
          data = blockData;
        }
        blocks.add(_FlacBlock(type, data));
        if (isLast) break;
      }

      final audioStart = await raf.position();
      return _FlacLayout(blocks: blocks, audioStart: audioStart);
    } finally {
      await raf.close();
    }
  }

  static Future<Uint8List?> _readExactly(
    RandomAccessFile raf,
    int length,
  ) async {
    final out = Uint8List(length);
    var offset = 0;
    while (offset < length) {
      final chunk = await raf.read(length - offset);
      if (chunk.isEmpty) return null;
      out.setRange(offset, offset + chunk.length, chunk);
      offset += chunk.length;
    }
    return out;
  }

  static Uint8List _encodeBlock(_FlacBlock block, {required bool isLast}) {
    final length = block.data.length;
    if (length > _maxMetadataPayload) {
      throw FormatException('FLAC metadata block too large: $length');
    }
    final out = Uint8List(4 + length);
    out[0] = (isLast ? 0x80 : 0x00) | (block.type & 0x7F);
    out[1] = (length >> 16) & 0xFF;
    out[2] = (length >> 8) & 0xFF;
    out[3] = length & 0xFF;
    out.setRange(4, out.length, block.data);
    return out;
  }

  static _VorbisCommentBlock? _parseVorbisComment(
    Uint8List data, {
    Set<String> ignoredKeys = const {},
  }) {
    var offset = 0;

    int? readU32() {
      if (offset + 4 > data.length) return null;
      final value =
          data[offset] |
          (data[offset + 1] << 8) |
          (data[offset + 2] << 16) |
          (data[offset + 3] << 24);
      offset += 4;
      return value;
    }

    Uint8List? readBytes(int length) {
      if (length < 0 || offset + length > data.length) return null;
      final bytes = Uint8List.sublistView(data, offset, offset + length);
      offset += length;
      return bytes;
    }

    final vendorLength = readU32();
    if (vendorLength == null) return null;
    final vendorBytes = readBytes(vendorLength);
    if (vendorBytes == null) return null;
    final vendor = utf8.decode(vendorBytes, allowMalformed: true);

    final count = readU32();
    if (count == null) return null;
    final comments = <_VorbisComment>[];
    for (var i = 0; i < count; i++) {
      final length = readU32();
      if (length == null) return null;
      final bytes = readBytes(length);
      if (bytes == null) return null;
      final split = bytes.indexOf(0x3D); // '='
      if (split <= 0) continue;
      final key = utf8.decode(
        Uint8List.sublistView(bytes, 0, split),
        allowMalformed: true,
      );
      if (ignoredKeys.contains(key.toUpperCase())) continue;
      final value = utf8.decode(
        Uint8List.sublistView(bytes, split + 1),
        allowMalformed: true,
      );
      comments.add(_VorbisComment(key, value));
    }

    return _VorbisCommentBlock(vendor: vendor, comments: comments);
  }

  static Uint8List _buildVorbisComment(
    String vendor,
    List<_VorbisComment> comments,
  ) {
    final vendorBytes = utf8.encode(vendor);
    final encodedComments = [
      for (final comment in comments)
        utf8.encode('${comment.key}=${comment.value}'),
    ];
    final payloadLength =
        4 +
        vendorBytes.length +
        4 +
        encodedComments.fold<int>(0, (sum, bytes) => sum + 4 + bytes.length);
    final out = Uint8List(payloadLength);
    var offset = 0;

    void writeU32(int value) {
      out[offset++] = value & 0xFF;
      out[offset++] = (value >> 8) & 0xFF;
      out[offset++] = (value >> 16) & 0xFF;
      out[offset++] = (value >> 24) & 0xFF;
    }

    void writeBytes(List<int> bytes) {
      out.setRange(offset, offset + bytes.length, bytes);
      offset += bytes.length;
    }

    writeU32(vendorBytes.length);
    writeBytes(vendorBytes);
    writeU32(encodedComments.length);
    for (final bytes in encodedComments) {
      writeU32(bytes.length);
      writeBytes(bytes);
    }
    return out;
  }

  static Uint8List _buildPicturePayload(
    Uint8List picture, {
    required String mimeType,
  }) {
    final mime = ascii.encode(mimeType);
    final desc = utf8.encode('');
    final payloadLength =
        4 + // picture type
        4 +
        mime.length +
        4 +
        desc.length +
        4 +
        4 +
        4 +
        4 +
        4 +
        picture.length;

    final out = Uint8List(payloadLength);
    var offset = 0;

    void writeU32(int value) {
      out[offset++] = (value >> 24) & 0xFF;
      out[offset++] = (value >> 16) & 0xFF;
      out[offset++] = (value >> 8) & 0xFF;
      out[offset++] = value & 0xFF;
    }

    writeU32(3); // front cover
    writeU32(mime.length);
    out.setRange(offset, offset + mime.length, mime);
    offset += mime.length;
    writeU32(desc.length);
    out.setRange(offset, offset + desc.length, desc);
    offset += desc.length;
    writeU32(0); // width unknown
    writeU32(0); // height unknown
    writeU32(0); // color depth unknown
    writeU32(0); // colors used
    writeU32(picture.length);
    out.setRange(offset, offset + picture.length, picture);
    return out;
  }

  static Uint8List? _pictureData(Uint8List data) {
    var offset = 0;

    int? readU32() {
      if (offset + 4 > data.length) return null;
      final value =
          (data[offset] << 24) |
          (data[offset + 1] << 16) |
          (data[offset + 2] << 8) |
          data[offset + 3];
      offset += 4;
      return value;
    }

    bool skip(int length) {
      if (length < 0 || offset + length > data.length) return false;
      offset += length;
      return true;
    }

    if (readU32() == null) return null; // picture type
    final mimeLength = readU32();
    if (mimeLength == null || !skip(mimeLength)) return null;
    final descLength = readU32();
    if (descLength == null || !skip(descLength)) return null;
    for (var i = 0; i < 4; i++) {
      if (readU32() == null) return null;
    }
    final pictureLength = readU32();
    if (pictureLength == null) return null;
    if (offset + pictureLength > data.length) return null;
    return Uint8List.sublistView(data, offset, offset + pictureLength);
  }

  static Future<File> _uniqueSidecar(String path, String suffix) async {
    for (var i = 0; i < 1000; i++) {
      final candidate = File(i == 0 ? '$path$suffix' : '$path$suffix.$i');
      if (!await candidate.exists()) return candidate;
    }
    throw FileSystemException(
      'Could not allocate temporary FLAC tag file',
      path,
    );
  }

  static Future<void> _replaceWithBackup(File original, File temp) async {
    final backup = await _uniqueSidecar(original.path, '.twilight_echo_tag.bak');
    await original.rename(backup.path);
    try {
      await temp.rename(original.path);
    } catch (_) {
      try {
        if (await File(original.path).exists()) {
          await File(original.path).delete();
        }
        await backup.rename(original.path);
      } catch (_) {}
      rethrow;
    }

    try {
      if (await backup.exists()) await backup.delete();
    } catch (_) {}
  }

  static bool _hasText(String? value) => value != null && value.isNotEmpty;

  static void _setComment(
    List<_VorbisComment> comments,
    String key,
    String? value,
  ) {
    if (!_hasText(value)) return;
    comments.add(_VorbisComment(key, value!));
  }
}

class _FlacLayout {
  const _FlacLayout({required this.blocks, required this.audioStart});

  final List<_FlacBlock> blocks;
  final int audioStart;
}

class _FlacBlock {
  const _FlacBlock(this.type, this.data);

  final int type;
  final Uint8List data;
}

class _VorbisCommentBlock {
  const _VorbisCommentBlock({required this.vendor, required this.comments});

  final String vendor;
  final List<_VorbisComment> comments;
}

class _VorbisComment {
  const _VorbisComment(this.key, this.value);

  final String key;
  final String value;

  String get normalizedKey => key.toUpperCase();
}
