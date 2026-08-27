import assert from 'node:assert/strict'
import test from 'node:test'
import { LyricsDecodeError, MAX_LYRICS_BYTES, decodeLyrics } from './lyricsEncoding.ts'

const UTF8_LYRICS = '[00:01.00]歌词测试\n[00:03.50]第二行\n'

test('lyrics decoder accepts UTF-8 with and without BOM', () => {
  const plain = decodeLyrics(Buffer.from(UTF8_LYRICS, 'utf8'))
  assert.equal(plain.encoding, 'utf-8')
  assert.equal(plain.text, UTF8_LYRICS)

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(UTF8_LYRICS, 'utf8')])
  const withBom = decodeLyrics(bom)
  assert.equal(withBom.encoding, 'utf-8-bom')
  assert.equal(withBom.text, UTF8_LYRICS)
})

test('lyrics decoder detects GBK and GB18030 instead of replacing malformed bytes', () => {
  // "[00:01.00]歌词测试" encoded as GBK.
  const gbk = Buffer.from([
    0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xb8, 0xe8, 0xb4, 0xca, 0xb2, 0xe2,
    0xca, 0xd4
  ])
  const decoded = decodeLyrics(gbk)
  assert.equal(decoded.encoding, 'gbk')
  assert.equal(decoded.text, '[00:01.00]歌词测试')

  // U+1F600 uses the unambiguous GB18030 four-byte form 94 39 FC 36. ICU may also accept this
  // through a decoder labelled GBK, so decodeLyrics performs byte-form detection before decoding.
  const gb18030 = Buffer.concat([
    Buffer.from('[00:01.00]', 'ascii'),
    Buffer.from([0x94, 0x39, 0xfc, 0x36]),
    Buffer.from('ok\n', 'ascii')
  ])
  const extended = decodeLyrics(gb18030)
  assert.equal(extended.encoding, 'gb18030')
  assert.match(extended.text, /😀/u)
  assert.match(extended.text, /ok\n$/)
})

test('lyrics decoder rejects empty, malformed, and oversize lyrics bytes', () => {
  assert.throws(() => decodeLyrics(Buffer.alloc(0)), /empty/)
  assert.throws(() => decodeLyrics(Buffer.from([0xff, 0xfe, 0xfd])), LyricsDecodeError)
  assert.throws(() => decodeLyrics(Buffer.from([0x81])), /Unsupported|malformed|Invalid/)
  assert.throws(() => decodeLyrics(Buffer.alloc(MAX_LYRICS_BYTES + 1)), /1 MiB/)
})
