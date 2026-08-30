import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultMiniPlayerThemeProfile } from '../../../shared/miniPlayer.ts'
import {
  buildMiniPlayerCssVariables,
  readableTextColors,
  resolveMiniPlayerLayout,
  resolveMiniPlayerVisibility
} from './presentation.ts'

test('responsive layout resolves exact compact standard and wide boundaries', () => {
  assert.equal(resolveMiniPlayerLayout(459, 300, 'auto'), 'compact')
  assert.equal(resolveMiniPlayerLayout(500, 169, 'auto'), 'compact')
  assert.equal(resolveMiniPlayerLayout(460, 170, 'auto'), 'standard')
  assert.equal(resolveMiniPlayerLayout(679, 300, 'auto'), 'standard')
  assert.equal(resolveMiniPlayerLayout(680, 240, 'auto'), 'wide')
  assert.equal(resolveMiniPlayerLayout(500, 190, 'wide'), 'standard')
  assert.equal(resolveMiniPlayerLayout(700, 300, 'compact'), 'compact')
})

test('responsive visibility never re-enables a user-hidden element', () => {
  const visibility = createDefaultMiniPlayerThemeProfile('aurora-glass').visibility
  const compact = resolveMiniPlayerVisibility({ ...visibility, artwork: false }, 'compact')
  assert.equal(compact.artwork, false)
  assert.equal(compact.album, false)
  assert.equal(compact.volume, false)
  assert.equal(compact.playMode, true)
})

test('standard visibility keeps optional controls except wide-only queue position', () => {
  const visibility = createDefaultMiniPlayerThemeProfile('aurora-glass').visibility
  const standard = resolveMiniPlayerVisibility({ ...visibility, queuePosition: true }, 'standard')
  assert.equal(standard.volume, true)
  assert.equal(standard.time, true)
  assert.equal(standard.queuePosition, false)
  assert.equal('playbackState' in standard, false)
})

test('presentation variables keep controls opaque while background opacity changes', () => {
  const profile = createDefaultMiniPlayerThemeProfile('aurora-glass')
  profile.background.opacity = 25
  profile.appearance.cornerRadius = 36
  const variables = buildMiniPlayerCssVariables(profile, '#cc3366', 60)
  assert.equal(variables['--mini-background-opacity'], '0.25')
  assert.equal(variables['--mini-window-radius'], '36px')
  assert.equal(Object.hasOwn(variables, '--mini-progress'), false)
  assert.equal(variables['--mini-volume'], '60%')
  assert.equal(
    variables['--mini-bootstrap-surface'],
    'color-mix(in srgb, #0f172a 82%, transparent)'
  )
  assert.equal(variables['--mini-bootstrap-text'], '#f8fafc')
  assert.equal(
    variables['--mini-bootstrap-action-surface'],
    'color-mix(in srgb, #7c4dff 88%, #fff)'
  )
  assert.equal(variables['--mini-bootstrap-action-text'], '#fff')
  assert.equal(variables['--mini-surface-backdrop'], 'rgba(12, 12, 18, 0.92)')
  assert.equal(Object.hasOwn(variables, 'opacity'), false)
})

test('automatic text colors choose readable light and dark families', () => {
  assert.equal(readableTextColors('#11121d').primary, '#ffffff')
  assert.equal(readableTextColors('#f4f5fb').primary, '#1b2034')
})
