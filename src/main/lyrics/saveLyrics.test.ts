import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const { saveLyricsFromDialog, writeLyricsAtomically } = (await import(
  new URL('./saveLyrics.ts', import.meta.url).href
)) as typeof import('./saveLyrics')

test('LRC save is canceled without creating a file', async () => {
  assert.equal(
    await saveLyricsFromDialog({ canceled: true, filePath: '' }, '[00:01.00]Unused'),
    null
  )
})

test('LRC save writes through a main-process authorized dialog result and retains backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-save-lrc-'))
  try {
    const filePath = join(directory, 'song.lrc')
    writeFileSync(filePath, '[00:01.00]Previous', 'utf8')
    const saved = await saveLyricsFromDialog(
      { canceled: false, filePath },
      '\uFEFF[00:02.00]Edited'
    )
    assert.deepEqual(saved, { filePath, backupPath: `${filePath}.bak` })
    assert.equal(readFileSync(filePath, 'utf8'), '[00:02.00]Edited')
    assert.equal(readFileSync(`${filePath}.bak`, 'utf8'), '[00:01.00]Previous')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('failed replacement restores the previous LRC from its backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-save-lrc-rollback-'))
  try {
    const filePath = join(directory, 'song.lrc')
    writeFileSync(filePath, '[00:01.00]Previous', 'utf8')
    await assert.rejects(
      () =>
        writeLyricsAtomically(filePath, '[00:02.00]Edited', {
          exists: async () => true,
          copy: async (source, destination) => writeFileSync(destination, readFileSync(source)),
          writeSynced: async (destination, contents) =>
            writeFileSync(destination, contents, 'utf8'),
          replace: async (_source, destination) => {
            writeFileSync(destination, '[00:99.00]Damaged', 'utf8')
            throw new Error('replace failed')
          },
          remove: async () => undefined
        }),
      /replace failed/
    )
    assert.equal(readFileSync(filePath, 'utf8'), '[00:01.00]Previous')
    assert.equal(readFileSync(`${filePath}.bak`, 'utf8'), '[00:01.00]Previous')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LRC save rejects non-LRC destinations and invalid content before writing', async () => {
  await assert.rejects(
    () => saveLyricsFromDialog({ canceled: false, filePath: 'song.txt' }, '[00:01.00]Line'),
    /.lrc extension/
  )
  await assert.rejects(
    () => saveLyricsFromDialog({ canceled: false, filePath: 'song.lrc' }, 'plain text'),
    /LRC timestamp/
  )
})
