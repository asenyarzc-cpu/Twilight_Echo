import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canNavigateSystemMediaQueue,
  miniPlayerPlayModeToSmtcRepeatMode,
  smtcRepeatModeToMiniPlayerPlayMode
} from './systemMedia.ts'

test('SMTC repeat mapping preserves the player repeat modes', () => {
  assert.equal(miniPlayerPlayModeToSmtcRepeatMode('sequential'), 0)
  assert.equal(miniPlayerPlayModeToSmtcRepeatMode('shuffle'), 0)
  assert.equal(miniPlayerPlayModeToSmtcRepeatMode('heart'), 0)
  assert.equal(miniPlayerPlayModeToSmtcRepeatMode('repeat'), 1)
  assert.equal(miniPlayerPlayModeToSmtcRepeatMode('listLoop'), 2)

  assert.equal(smtcRepeatModeToMiniPlayerPlayMode(0), 'sequential')
  assert.equal(smtcRepeatModeToMiniPlayerPlayMode(1), 'repeat')
  assert.equal(smtcRepeatModeToMiniPlayerPlayMode(2), 'listLoop')
  assert.equal(smtcRepeatModeToMiniPlayerPlayMode(99), 'sequential')
})

test('SMTC queue transport remains enabled at queue boundaries because player navigation wraps', () => {
  assert.equal(canNavigateSystemMediaQueue(true, 1), true)
  assert.equal(canNavigateSystemMediaQueue(true, 2), true)
  assert.equal(canNavigateSystemMediaQueue(true, 200), true)
  assert.equal(canNavigateSystemMediaQueue(true, 0), false)
  assert.equal(canNavigateSystemMediaQueue(false, 10), false)
})
