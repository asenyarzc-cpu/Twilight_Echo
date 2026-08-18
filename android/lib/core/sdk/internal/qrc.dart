import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

// QRC is QQ Music's lyric encryption used by the
// `music.musichallSong.PlayLyricInfo` endpoint when `crypt: 1` is requested.
//
// The encryption ships as a closed-source native binary (`qrc_decode.node`).
// This Dart port was recovered by reverse-engineering that binary in IDA Pro
// (session notes 2026-05-23). It is a CUSTOM Triple-DES — close to standard
// DES but with several deliberate deviations that defeat off-the-shelf DES
// libraries:
//
//   * IP / FP permutation tables are reshuffled (see _ipTable / _fpTable).
//   * Two S-box bytes differ from FIPS-46:
//       S2[1][7]=15 (canonical 14)   →  S-box index 23 in flat form
//       S4[3][5]=10 (canonical  1)   →  S-box index 53 in flat form
//   * The 32-bit P permutation after the S-box layer is encoded per-S-box
//     as (OUTPUT_PERMS, BLOCK_P_POS): for each S-box block b, the 4 output
//     bits at S-box positions OUTPUT_PERMS[b] are routed to the 4 absolute
//     output positions BLOCK_P_POS[b].
//   * Subkeys are pre-extracted from the binary (16 × 6 bytes per key) and
//     hardcoded here, so we don't need PC-1 / PC-2 / the shift schedule.
//
// Pipeline: hex → bytes → D_K1 → E_K2 → D_K3 → strip trailing 0x00 →
// zlib inflate → UTF-8.
class QrcDecoder {
  const QrcDecoder._();

  static String decrypt(String? hexInput) {
    if (hexInput == null) return '';
    final trimmed = hexInput.trim();
    if (trimmed.isEmpty) return '';
    final cipher = _hexDecode(trimmed);
    if (cipher.length % 8 != 0) {
      throw FormatException(
        'qrc payload not a multiple of 8 bytes (got ${cipher.length})',
      );
    }

    var data = _runBlocks(cipher, _subkeysK1Dec);
    data = _runBlocks(data, _subkeysK2Enc);
    data = _runBlocks(data, _subkeysK3Dec);

    var end = data.length;
    while (end > 0 && data[end - 1] == 0) {
      end--;
    }
    final inflated = ZLibDecoder().decodeBytes(
      Uint8List.sublistView(data, 0, end),
    );
    return utf8.decode(inflated, allowMalformed: true);
  }

  static Uint8List _runBlocks(Uint8List input, Uint8List subkeys) {
    final out = Uint8List(input.length);
    final block = Uint8List(8);
    for (var off = 0; off < input.length; off += 8) {
      for (var i = 0; i < 8; i++) {
        block[i] = input[off + i];
      }
      final result = _desBlock(block, subkeys);
      for (var i = 0; i < 8; i++) {
        out[off + i] = result[i];
      }
    }
    return out;
  }

  static Uint8List _desBlock(Uint8List block8, Uint8List subkeys) {
    final bits = _permuteBits(_bytesToBits(block8), _ipTable);
    var l = bits.sublist(0, 32);
    var r = bits.sublist(32, 64);
    for (var round = 0; round < 16; round++) {
      final kBytes = subkeys.sublist(round * 6, round * 6 + 6);
      final kBits = _bytesToBits(kBytes).sublist(0, 48);
      final fOut = _feistel(r, kBits);
      final next = List<int>.generate(32, (i) => l[i] ^ fOut[i]);
      l = r;
      r = next;
    }
    // Pre-output swap: R || L
    final swapped = [...r, ...l];
    return _bitsToBytes(_permuteBits(swapped, _fpTable));
  }

  // Feistel F: R(32) -> E(48) -> XOR K(48) -> 8 × (S-box -> custom P).
  static List<int> _feistel(List<int> rBits, List<int> kBits) {
    final out = List<int>.filled(32, 0);
    for (var b = 0; b < 8; b++) {
      var rowBit0 = rBits[_eTable[b * 6 + 0] - 1] ^ kBits[b * 6 + 0];
      var c1 = rBits[_eTable[b * 6 + 1] - 1] ^ kBits[b * 6 + 1];
      var c2 = rBits[_eTable[b * 6 + 2] - 1] ^ kBits[b * 6 + 2];
      var c3 = rBits[_eTable[b * 6 + 3] - 1] ^ kBits[b * 6 + 3];
      var c4 = rBits[_eTable[b * 6 + 4] - 1] ^ kBits[b * 6 + 4];
      var rowBit1 = rBits[_eTable[b * 6 + 5] - 1] ^ kBits[b * 6 + 5];
      final row = (rowBit0 << 1) | rowBit1;
      final col = (c1 << 3) | (c2 << 2) | (c3 << 1) | c4;
      final v = _sboxes[b][row * 16 + col];
      // Distribute v's 4 bits into out[] per the binary's custom P permutation.
      final op = _outputPerms[b];
      final pos = _blockPPos[b];
      for (var k = 0; k < 4; k++) {
        out[pos[k]] = (v >> (3 - op[k])) & 1;
      }
    }
    return out;
  }

  static List<int> _bytesToBits(Uint8List bytes) {
    final out = List<int>.filled(bytes.length * 8, 0);
    for (var i = 0; i < bytes.length; i++) {
      final b = bytes[i];
      for (var j = 0; j < 8; j++) {
        out[i * 8 + j] = (b >> (7 - j)) & 1;
      }
    }
    return out;
  }

  static Uint8List _bitsToBytes(List<int> bits) {
    final out = Uint8List(bits.length ~/ 8);
    for (var i = 0; i < out.length; i++) {
      var v = 0;
      for (var j = 0; j < 8; j++) {
        v = (v << 1) | bits[i * 8 + j];
      }
      out[i] = v;
    }
    return out;
  }

  static List<int> _permuteBits(List<int> bits, List<int> table) {
    return List<int>.generate(table.length, (i) => bits[table[i] - 1]);
  }

  static Uint8List _hexDecode(String hex) {
    final clean = hex.replaceAll(RegExp(r'[^0-9a-fA-F]'), '');
    if (clean.length.isOdd) {
      throw const FormatException('qrc hex has odd length');
    }
    final out = Uint8List(clean.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(clean.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  // -------------- tables --------------

  static const List<int> _ipTable = [
    34,
    42,
    50,
    58,
    2,
    10,
    18,
    26,
    36,
    44,
    52,
    60,
    4,
    12,
    20,
    28,
    38,
    46,
    54,
    62,
    6,
    14,
    22,
    30,
    40,
    48,
    56,
    64,
    8,
    16,
    24,
    32,
    33,
    41,
    49,
    57,
    1,
    9,
    17,
    25,
    35,
    43,
    51,
    59,
    3,
    11,
    19,
    27,
    37,
    45,
    53,
    61,
    5,
    13,
    21,
    29,
    39,
    47,
    55,
    63,
    7,
    15,
    23,
    31,
  ];

  static const List<int> _fpTable = [
    37,
    5,
    45,
    13,
    53,
    21,
    61,
    29,
    38,
    6,
    46,
    14,
    54,
    22,
    62,
    30,
    39,
    7,
    47,
    15,
    55,
    23,
    63,
    31,
    40,
    8,
    48,
    16,
    56,
    24,
    64,
    32,
    33,
    1,
    41,
    9,
    49,
    17,
    57,
    25,
    34,
    2,
    42,
    10,
    50,
    18,
    58,
    26,
    35,
    3,
    43,
    11,
    51,
    19,
    59,
    27,
    36,
    4,
    44,
    12,
    52,
    20,
    60,
    28,
  ];

  static const List<int> _eTable = [
    32,
    1,
    2,
    3,
    4,
    5,
    4,
    5,
    6,
    7,
    8,
    9,
    8,
    9,
    10,
    11,
    12,
    13,
    12,
    13,
    14,
    15,
    16,
    17,
    16,
    17,
    18,
    19,
    20,
    21,
    20,
    21,
    22,
    23,
    24,
    25,
    24,
    25,
    26,
    27,
    28,
    29,
    28,
    29,
    30,
    31,
    32,
    1,
  ];

  // Standard FIPS-46 S-boxes (4 rows × 16 cols, flat), with two deliberate
  // single-byte deviations: S2[23] (= S2 row 1 col 7) and S4[53] (= S4 row 3
  // col 5).
  static const List<List<int>> _sboxes = [
    [
      14,
      4,
      13,
      1,
      2,
      15,
      11,
      8,
      3,
      10,
      6,
      12,
      5,
      9,
      0,
      7,
      0,
      15,
      7,
      4,
      14,
      2,
      13,
      1,
      10,
      6,
      12,
      11,
      9,
      5,
      3,
      8,
      4,
      1,
      14,
      8,
      13,
      6,
      2,
      11,
      15,
      12,
      9,
      7,
      3,
      10,
      5,
      0,
      15,
      12,
      8,
      2,
      4,
      9,
      1,
      7,
      5,
      11,
      3,
      14,
      10,
      0,
      6,
      13,
    ],
    [
      15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
      3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5, // ← index 23 = 15
      0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
      13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
    ],
    [
      10,
      0,
      9,
      14,
      6,
      3,
      15,
      5,
      1,
      13,
      12,
      7,
      11,
      4,
      2,
      8,
      13,
      7,
      0,
      9,
      3,
      4,
      6,
      10,
      2,
      8,
      5,
      14,
      12,
      11,
      15,
      1,
      13,
      6,
      4,
      9,
      8,
      15,
      3,
      0,
      11,
      1,
      2,
      12,
      5,
      10,
      14,
      7,
      1,
      10,
      13,
      0,
      6,
      9,
      8,
      7,
      4,
      15,
      14,
      3,
      11,
      5,
      2,
      12,
    ],
    [
      7,
      13,
      14,
      3,
      0,
      6,
      9,
      10,
      1,
      2,
      8,
      5,
      11,
      12,
      4,
      15,
      13,
      8,
      11,
      5,
      6,
      15,
      0,
      3,
      4,
      7,
      2,
      12,
      1,
      10,
      14,
      9,
      10,
      6,
      9,
      0,
      12,
      11,
      7,
      13,
      15,
      1,
      3,
      14,
      5,
      2,
      8,
      4,
      3,
      15,
      0,
      6,
      10,
      10,
      13,
      8,
      9,
      4,
      5,
      11,
      12,
      7,
      2,
      14,
    ], // ← index 53 = 10
    [
      2,
      12,
      4,
      1,
      7,
      10,
      11,
      6,
      8,
      5,
      3,
      15,
      13,
      0,
      14,
      9,
      14,
      11,
      2,
      12,
      4,
      7,
      13,
      1,
      5,
      0,
      15,
      10,
      3,
      9,
      8,
      6,
      4,
      2,
      1,
      11,
      10,
      13,
      7,
      8,
      15,
      9,
      12,
      5,
      6,
      3,
      0,
      14,
      11,
      8,
      12,
      7,
      1,
      14,
      2,
      13,
      6,
      15,
      0,
      9,
      10,
      4,
      5,
      3,
    ],
    [
      12,
      1,
      10,
      15,
      9,
      2,
      6,
      8,
      0,
      13,
      3,
      4,
      14,
      7,
      5,
      11,
      10,
      15,
      4,
      2,
      7,
      12,
      9,
      5,
      6,
      1,
      13,
      14,
      0,
      11,
      3,
      8,
      9,
      14,
      15,
      5,
      2,
      8,
      12,
      3,
      7,
      0,
      4,
      10,
      1,
      13,
      11,
      6,
      4,
      3,
      2,
      12,
      9,
      5,
      15,
      10,
      11,
      14,
      1,
      7,
      6,
      0,
      8,
      13,
    ],
    [
      4,
      11,
      2,
      14,
      15,
      0,
      8,
      13,
      3,
      12,
      9,
      7,
      5,
      10,
      6,
      1,
      13,
      0,
      11,
      7,
      4,
      9,
      1,
      10,
      14,
      3,
      5,
      12,
      2,
      15,
      8,
      6,
      1,
      4,
      11,
      13,
      12,
      3,
      7,
      14,
      10,
      15,
      6,
      8,
      0,
      5,
      9,
      2,
      6,
      11,
      13,
      8,
      1,
      4,
      10,
      7,
      9,
      5,
      0,
      15,
      14,
      2,
      3,
      12,
    ],
    [
      13,
      2,
      8,
      4,
      6,
      15,
      11,
      1,
      10,
      9,
      3,
      14,
      5,
      0,
      12,
      7,
      1,
      15,
      13,
      8,
      10,
      3,
      7,
      4,
      12,
      5,
      6,
      11,
      0,
      14,
      9,
      2,
      7,
      11,
      4,
      1,
      9,
      12,
      14,
      2,
      0,
      6,
      10,
      13,
      15,
      3,
      5,
      8,
      2,
      1,
      14,
      7,
      4,
      10,
      8,
      13,
      15,
      12,
      9,
      0,
      3,
      5,
      6,
      11,
    ],
  ];

  // For each S-box block b: which standard S-box output bit position (MSB-
  // first, 0..3) maps to the k-th absolute output position.
  static const List<List<int>> _outputPerms = [
    [0, 1, 2, 3],
    [2, 0, 3, 1],
    [3, 1, 0, 2],
    [3, 2, 1, 0],
    [3, 0, 1, 2],
    [0, 2, 3, 1],
    [3, 1, 2, 0],
    [0, 2, 3, 1],
  ];

  // For each block b: the 4 absolute output positions in the 32-bit P-output
  // that receive that block's S-box result bits.
  static const List<List<int>> _blockPPos = [
    [8, 16, 22, 30],
    [1, 12, 17, 27],
    [5, 15, 23, 29],
    [0, 9, 19, 25],
    [2, 7, 13, 24],
    [3, 10, 18, 28],
    [6, 11, 21, 31],
    [4, 14, 20, 26],
  ];

  // 16 × 6-byte subkeys per round-key set, extracted from qrc_decode.node.
  // K1 and K3 use the DES-decrypt subkey order (round 16 first); K2 uses
  // encrypt order.
  static final Uint8List _subkeysK1Dec = _hexConst(
    'f03a0018caa23082024b5020d0808e1914194984a0408e98532401c28864042d'
    '8504106101691007508a1048496a001f13109032b0412502890462c9a90113dc'
    '008602c12330060664c140a1e2004054568b205000b640144c1120182600682c',
  );
  static final Uint8List _subkeysK2Enc = _hexConst(
    '30a04440a0c9c03c5464a45944e6402b944a42d5220cd422e881430c4c6421c2'
    '0bc8c8d021119281c6193408d19b160008595019123604694d1548a403650100'
    '28d5490da1a3a095d1a0892306831186821e00077018864640c4003e2044a8c2',
  );
  static final Uint8List _subkeysK3Dec = _hexConst(
    'd02c0400ca8210a40443422050288c981011190c80000e88132089c2c0240d09'
    '890810410b41110544880641494a8016075110721040244251046209a01152c8'
    '008220d222320404e0824200e201c094268b00c040a620140415400c26102808',
  );

  static Uint8List _hexConst(String hex) {
    final out = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}
