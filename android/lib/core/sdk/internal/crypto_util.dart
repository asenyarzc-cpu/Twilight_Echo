import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/api.dart';
import 'package:pointycastle/block/aes.dart';
import 'package:pointycastle/block/modes/cbc.dart';
import 'package:pointycastle/block/modes/ecb.dart';
import 'package:pointycastle/paddings/pkcs7.dart';
import 'package:pointycastle/padded_block_cipher/padded_block_cipher_impl.dart';

class CryptoUtil {
  CryptoUtil._();

  static String md5Hex(String input) =>
      crypto.md5.convert(utf8.encode(input)).toString();

  static String md5HexBytes(Uint8List input) =>
      crypto.md5.convert(input).toString();

  static String sha1Hex(String input) =>
      crypto.sha1.convert(utf8.encode(input)).toString();

  static Uint8List aesEncryptEcbPkcs7(Uint8List data, Uint8List key) {
    final cipher = PaddedBlockCipherImpl(
      PKCS7Padding(),
      ECBBlockCipher(AESEngine()),
    )..init(true, PaddedBlockCipherParameters(KeyParameter(key), null));
    return cipher.process(data);
  }

  static Uint8List aesDecryptEcbPkcs7(Uint8List data, Uint8List key) {
    final cipher = PaddedBlockCipherImpl(
      PKCS7Padding(),
      ECBBlockCipher(AESEngine()),
    )..init(false, PaddedBlockCipherParameters(KeyParameter(key), null));
    return cipher.process(data);
  }

  static Uint8List aesEncryptCbcPkcs7(
    Uint8List data,
    Uint8List key,
    Uint8List iv,
  ) {
    final cipher =
        PaddedBlockCipherImpl(PKCS7Padding(), CBCBlockCipher(AESEngine()))
          ..init(
            true,
            PaddedBlockCipherParameters(
              ParametersWithIV<KeyParameter>(KeyParameter(key), iv),
              null,
            ),
          );
    return cipher.process(data);
  }

  // Raw RSA encryption with no padding: c = m^e mod n.
  // Inputs and outputs are big-endian byte arrays the same width as the modulus.
  static Uint8List rsaNoPadding(
    Uint8List plaintext,
    BigInt modulus,
    BigInt exponent,
  ) {
    final m = _bytesToBigInt(plaintext);
    final c = m.modPow(exponent, modulus);
    final size = (modulus.bitLength + 7) ~/ 8;
    return _bigIntToBytes(c, size);
  }

  static String randomBase62(int length, [Random? rng]) {
    const charset =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    final r = rng ?? Random.secure();
    final buf = StringBuffer();
    for (var i = 0; i < length; i++) {
      buf.write(charset[r.nextInt(charset.length)]);
    }
    return buf.toString();
  }

  static String bytesToHex(Uint8List bytes, {bool upper = false}) {
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return upper ? hex.toUpperCase() : hex;
  }

  static Uint8List hexToBytes(String hex) {
    final cleaned = hex.length.isOdd ? '0$hex' : hex;
    final out = Uint8List(cleaned.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(cleaned.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  static BigInt _bytesToBigInt(Uint8List bytes) {
    var result = BigInt.zero;
    for (final b in bytes) {
      result = (result << 8) | BigInt.from(b);
    }
    return result;
  }

  static Uint8List _bigIntToBytes(BigInt v, int length) {
    final out = Uint8List(length);
    var value = v;
    final mask = BigInt.from(0xff);
    for (var i = length - 1; i >= 0; i--) {
      out[i] = (value & mask).toInt();
      value >>= 8;
    }
    return out;
  }
}
