import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  cloneMiniPlayerSettings
} from '../../../shared/miniPlayer.ts'
import { useMiniPlayerCustomizationDraft } from './useMiniPlayerCustomizationDraft.ts'

test('draft previews immediately and persists only when flushed', async () => {
  const saved: string[] = []
  const draft = useMiniPlayerCustomizationDraft({
    initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
    persist: async (settings) => {
      saved.push(settings.profiles[settings.activeStyleId].background.solidColor)
      return cloneMiniPlayerSettings(settings)
    },
    debounceMs: 60_000
  })

  draft.beginSession()
  draft.updateActiveProfile((profile) => ({
    ...profile,
    background: { ...profile.background, solidColor: '#123456' }
  }))
  assert.equal(draft.activeProfile.value.background.solidColor, '#123456')
  assert.deepEqual(saved, [])
  await draft.flush()
  assert.deepEqual(saved, ['#123456'])
  assert.equal(draft.error.value, '')
  draft.dispose()
})

test('undo restores the opening snapshot and persists it', async () => {
  const saved: string[] = []
  const draft = useMiniPlayerCustomizationDraft({
    initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
    persist: async (settings) => {
      saved.push(settings.activeStyleId)
      return cloneMiniPlayerSettings(settings)
    },
    debounceMs: 60_000
  })
  draft.beginSession()
  draft.selectTheme('porcelain')
  await draft.undoSession()
  assert.equal(draft.settings.value.activeStyleId, 'aurora-glass')
  assert.equal(saved.at(-1), 'aurora-glass')
  draft.dispose()
})

test('failed persistence rolls back to the last confirmed settings', async () => {
  const draft = useMiniPlayerCustomizationDraft({
    initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
    persist: async () => {
      throw new Error('disk unavailable')
    },
    debounceMs: 60_000
  })
  draft.updateActiveProfile((profile) => ({
    ...profile,
    appearance: { ...profile.appearance, cornerRadius: 36 }
  }))
  await assert.rejects(draft.flush(), /disk unavailable/)
  assert.equal(
    draft.activeProfile.value.appearance.cornerRadius,
    DEFAULT_MINI_PLAYER_SETTINGS.profiles[DEFAULT_MINI_PLAYER_SETTINGS.activeStyleId].appearance.cornerRadius
  )
  assert.match(draft.error.value, /disk unavailable/)
  draft.dispose()
})

test('reset replaces only the active theme profile with registered defaults', async () => {
  const initial = cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS)
  initial.profiles.porcelain.background.solidColor = '#abcdef'
  const draft = useMiniPlayerCustomizationDraft({
    initial,
    persist: async (settings) => cloneMiniPlayerSettings(settings),
    debounceMs: 60_000
  })
  draft.updateActiveProfile((profile) => ({
    ...profile,
    appearance: { ...profile.appearance, cornerRadius: 4 }
  }))
  draft.resetActiveTheme()
  assert.equal(
    draft.activeProfile.value.appearance.cornerRadius,
    DEFAULT_MINI_PLAYER_SETTINGS.profiles[DEFAULT_MINI_PLAYER_SETTINGS.activeStyleId].appearance.cornerRadius
  )
  assert.equal(draft.settings.value.profiles.porcelain.background.solidColor, '#abcdef')
  await draft.flush()
  draft.dispose()
})

test('replace settings clones the editor candidate before scheduling persistence', () => {
  const draft = useMiniPlayerCustomizationDraft({
    initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
    persist: async (settings) => cloneMiniPlayerSettings(settings),
    debounceMs: 60_000
  })
  const candidate = cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS)
  candidate.profiles['aurora-glass'].appearance.cornerRadius = 12
  draft.replaceSettings(candidate)
  candidate.profiles['aurora-glass'].appearance.cornerRadius = 30
  assert.equal(draft.activeProfile.value.appearance.cornerRadius, 12)
  draft.dispose()
})

test('flush waits for persistence that is already in progress', async () => {
  let releaseSave: ((settings: typeof DEFAULT_MINI_PLAYER_SETTINGS) => void) | null = null
  const draft = useMiniPlayerCustomizationDraft({
    initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
    persist: async (settings) =>
      await new Promise((resolve) => {
        releaseSave = () => resolve(cloneMiniPlayerSettings(settings))
      }),
    debounceMs: 60_000
  })

  const candidate = cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS)
  candidate.profiles['aurora-glass'].appearance.cornerRadius = 12
  draft.replaceSettings(candidate)
  const firstFlush = draft.flush()
  let secondFlushFinished = false
  const secondFlush = draft.flush().then(() => {
    secondFlushFinished = true
  })

  await Promise.resolve()
  assert.equal(secondFlushFinished, false)
  assert.ok(releaseSave)
  ;(releaseSave as ((settings: typeof DEFAULT_MINI_PLAYER_SETTINGS) => void) | null)?.(candidate)
  await Promise.all([firstFlush, secondFlush])
  assert.equal(secondFlushFinished, true)
  draft.dispose()
})
