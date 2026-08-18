import '../../models/enums.dart';
import '../../models/music_info.dart';
import 'format.dart';

/// Parses the quality metadata returned with a QQ song search result.
///
/// QQ exposes the common formats as named `size_*` fields. Newer premium
/// formats use parallel `size_new` and `vs` arrays; a non-empty version MID is
/// required for those formats to be usable.
List<QualityOption> parseTxQualityOptions({
  required Object? fileData,
  Object? versions,
  Object? legacyData,
}) {
  final file = fileData is Map ? fileData : const <Object?, Object?>{};
  final legacy = legacyData is Map ? legacyData : const <Object?, Object?>{};
  final result = <QualityOption>[];

  void add(Quality type, Object? size, {String? mediaInfo}) {
    final formatted = sizeFormat(size);
    if (formatted == null) return;
    result.add(
      QualityOption(type: type, size: formatted, mediaInfo: mediaInfo),
    );
  }

  add(Quality.k128, file['size_128mp3'] ?? legacy['size128']);
  add(Quality.k320, file['size_320mp3'] ?? legacy['size320']);
  add(Quality.flac, file['size_flac'] ?? legacy['sizeflac']);
  add(Quality.flac24bit, file['size_hires'] ?? legacy['size_hires']);

  final sizeNew = _asList(file['size_new'] ?? legacy['size_new']);
  final versionMids = _asList(versions ?? legacy['vs']);

  void addVersioned(
    Quality type, {
    required int sizeIndex,
    required int versionIndex,
  }) {
    final size = _at(sizeNew, sizeIndex);
    final mediaInfo = _at(versionMids, versionIndex)?.toString().trim();
    if (mediaInfo == null || mediaInfo.isEmpty) return;
    add(type, size, mediaInfo: mediaInfo);
  }

  // QQ definitions: MASTER=size_new[0], ATMOS_2=size_new[1],
  // ATMOS_51=size_new[2]. Old app pairs them with vs[3], vs[4], vs[4].
  addVersioned(Quality.master, sizeIndex: 0, versionIndex: 3);
  addVersioned(Quality.atmos, sizeIndex: 1, versionIndex: 4);
  addVersioned(Quality.atmosPlus, sizeIndex: 2, versionIndex: 4);

  return result;
}

List<Object?> _asList(Object? value) =>
    value is List ? List<Object?>.from(value) : const <Object?>[];

Object? _at(List<Object?> values, int index) =>
    index < values.length ? values[index] : null;
