import assert from 'node:assert/strict'
import test from 'node:test'

const { importLyricsFromDialog, validateImportedLyrics } = (await import(
  new URL('./importLyrics.ts', import.meta.url).href
)) as typeof import('./importLyrics')

test('lyrics import returns null on dialog cancel without reading a path', async () => {
  let reads = 0
  assert.equal(
    await importLyricsFromDialog({ canceled: true, filePaths: [] }, async () => {
      reads++
      return '[00:01]unused'
    }),
    null
  )
  assert.equal(reads, 0)
})

test('lyrics import strips BOM and accepts valid selected LRC text', async () => {
  assert.equal(
    await importLyricsFromDialog(
      { canceled: false, filePaths: ['D:/lyrics/song.LRC'] },
      async () => '\uFEFF[00:01.00]Line'
    ),
    '[00:01.00]Line'
  )
})

test('lyrics import rejects invalid extension and oversized selected file before reading it', async () => {
  let reads = 0
  await assert.rejects(
    () =>
      importLyricsFromDialog({ canceled: false, filePaths: ['D:/lyrics/song.exe'] }, async () => {
        reads++
        return '[00:01]unused'
      }),
    /.lrc or .txt/
  )
  await assert.rejects(
    () =>
      importLyricsFromDialog(
        { canceled: false, filePaths: ['D:/lyrics/song.lrc'] },
        async () => {
          reads++
          return '[00:01]unused'
        },
        async () => 1024 * 1024 + 1
      ),
    /1 MiB/
  )
  assert.equal(reads, 0)
})

test('lyrics import accepts decoded legacy-encoding text but rejects binary or replacement text', () => {
  assert.equal(validateImportedLyrics('song.txt', 'Untimed lyric'), 'Untimed lyric')
  // The dialog wiring decodes GBK bytes before validation, so a legacy file
  // reaches this point as ordinary Chinese text instead of U+FFFD mojibake.
  assert.equal(validateImportedLyrics('song.lrc', '[00:01.00]歌词测试'), '[00:01.00]歌词测试')
  assert.throws(() => validateImportedLyrics('song.txt', 'bad\0text'), /valid non-empty text/)
  assert.throws(() => validateImportedLyrics('song.txt', '\uFFFD'), /valid non-empty text/)
})

test('lyrics import rejects invalid extension, invalid LRC type, and oversize text', () => {
  assert.throws(() => validateImportedLyrics('song.exe', '[00:01]Line'), /\.lrc or \.txt/)
  assert.throws(() => validateImportedLyrics('song.lrc', 'plain text'), /LRC timestamp/)
  assert.throws(() => validateImportedLyrics('song.txt', 'x'.repeat(1024 * 1024 + 1)), /1 MiB/)
})
