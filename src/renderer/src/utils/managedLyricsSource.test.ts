import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResolverLyricsState } from './managedLyricsSource.ts'

const { resolverLyricsInput } = (await import(
  new URL('./managedLyricsSource.ts', import.meta.url).href
)) as typeof import('./managedLyricsSource')

test('forced source reloads from a clean automatic baseline and Auto restores that baseline', () => {
  const automatic: ResolverLyricsState = {
    lyrics: '[00:01]Embedded',
    translatedLyrics: '[00:01]Auto translation',
    lyricsSource: 'embedded',
    translatedLyricsSource: 'provider'
  }
  const forcedProvider: ResolverLyricsState = {
    lyrics: '[00:01]Provider replacement',
    translatedLyrics: null,
    lyricsSource: 'provider',
    translatedLyricsSource: null
  }

  assert.deepEqual(resolverLyricsInput(forcedProvider, automatic, 'provider'), {
    lyrics: null,
    translatedLyrics: null,
    lyricsSource: null,
    translatedLyricsSource: null
  })
  assert.equal(resolverLyricsInput(forcedProvider, automatic, 'auto'), automatic)
})
