import assert from 'node:assert/strict'
import test from 'node:test'
import { SUPPORTED_EXTENSIONS } from './libraryFiles.ts'
import {
  isWatchableFileExtension,
  looksLikeDirectoryEvent,
  LIBRARY_WATCH_EXTENSIONS
} from './watcherExtensions.ts'

test('watcher extensions cover all supported scan formats plus cue', () => {
  for (const ext of SUPPORTED_EXTENSIONS) {
    assert.equal(LIBRARY_WATCH_EXTENSIONS.has(ext), true, `watcher missing scan extension ${ext}`)
  }
  assert.equal(LIBRARY_WATCH_EXTENSIONS.has('.cue'), true)
  assert.equal(isWatchableFileExtension('.aiff'), true)
  assert.equal(isWatchableFileExtension('.wv'), true)
  assert.equal(isWatchableFileExtension('.mqa'), true)
  assert.equal(isWatchableFileExtension('.txt'), false)
})

test('directory-like events are detected without a file extension', () => {
  assert.equal(looksLikeDirectoryEvent('New Album', 'C:\\music\\New Album'), true)
  assert.equal(looksLikeDirectoryEvent('track.flac', 'C:\\music\\track.flac'), false)
})
