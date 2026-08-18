package com.twilight.echo.music.source;

import android.util.Base64;

import org.json.JSONArray;

import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.spec.X509EncodedKeySpec;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class MusicSourceCrypto {
    private MusicSourceCrypto() {}

    static String md5(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("MD5")
            .digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder(digest.length * 2);
        for (byte item : digest) output.append(String.format("%02x", item));
        return output.toString();
    }

    static String bytesToBase64(String jsonBytes) throws Exception {
        JSONArray array = new JSONArray(jsonBytes);
        byte[] bytes = new byte[array.length()];
        for (int index = 0; index < array.length(); index++) {
            bytes[index] = (byte) array.getInt(index);
        }
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    static String base64ToBytes(String value) throws Exception {
        byte[] bytes = Base64.decode(value, Base64.DEFAULT);
        JSONArray array = new JSONArray();
        for (byte item : bytes) array.put(item & 0xff);
        return array.toString();
    }

    static String aesEncrypt(
        String dataBase64,
        String keyBase64,
        String ivBase64,
        String transformation
    ) throws Exception {
        byte[] data = Base64.decode(dataBase64, Base64.DEFAULT);
        byte[] key = Base64.decode(keyBase64, Base64.DEFAULT);
        String resolved = transformation.replace("PKCS7Padding", "PKCS5Padding");
        Cipher cipher = Cipher.getInstance(resolved);
        SecretKeySpec secretKey = new SecretKeySpec(key, "AES");
        if (resolved.contains("/CBC/")) {
            byte[] sourceIv = Base64.decode(ivBase64, Base64.DEFAULT);
            byte[] iv = new byte[16];
            System.arraycopy(sourceIv, 0, iv, 0, Math.min(sourceIv.length, iv.length));
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new IvParameterSpec(iv));
        } else {
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
        }
        return Base64.encodeToString(cipher.doFinal(data), Base64.NO_WRAP);
    }

    static String rsaEncrypt(String dataBase64, String publicKey, String padding)
        throws Exception {
        String normalizedKey = publicKey
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replaceAll("\\s", "");
        KeyFactory factory = KeyFactory.getInstance("RSA");
        Key key = factory.generatePublic(
            new X509EncodedKeySpec(Base64.decode(normalizedKey, Base64.DEFAULT))
        );
        Cipher cipher = Cipher.getInstance(padding);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] data = Base64.decode(dataBase64, Base64.DEFAULT);
        return Base64.encodeToString(cipher.doFinal(data), Base64.NO_WRAP);
    }
}
