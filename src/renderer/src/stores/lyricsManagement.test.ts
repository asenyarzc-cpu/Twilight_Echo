import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricsManagementDocument } from '../../../shared/lyricsManagement.ts'

const initial: LyricsManagementDocument = {
  schemaVersion: 1,
  globalOffsetMs: 0,
  showOriginal: true,
  showTranslation: true,
  showRomanization: false,
  tracks: {}
}

let authoritative = structuredClone(initial)
let revision = 3
let rejectNextSave = false

;(globalThis as unknown as { window: unknown }).window = {
  api: {
    data: {
      loadLyricsManagement: async () => ({
        version: 2 as const,
        revision,
        savedAt: '2026-07-18T00:00:00.000Z',
        data: structuredClone(authoritative)
      }),
      saveLyricsManagement: async (
        document: LyricsManagementDocument,
        expectedRevision: number
      ) => {
        if (rejectNextSave) {
          rejectNextSave = false
          throw Object.assign(new Error('conflict'), {
            code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
            expectedRevision,
            current: {
              version: 2 as const,
              revision,
              savedAt: '2026-07-18T00:00:01.000Z',
              data: structuredClone(authoritative)
            }
          })
        }
        assert.equal(expectedRevision, revision)
        authoritative = structuredClone(document)
        revision += 1
        return {
          version: 2 as const,
          revision,
          savedAt: '2026-07-18T00:00:02.000Z',
          data: structuredClone(authoritative)
        }
      }
    }
  }
}

const { useLyricsManagement } = (await import(
  new URL('./lyricsManagement.ts', import.meta.url).href
)) as typeof import('./lyricsManagement')

test('lyrics management persists independent display toggles through the renderer IPC store', async () => {
  const management = useLyricsManagement()
  await management.ensureLoaded()
  await management.updateVisibility({ showOriginal: false, showRomanization: true })

  assert.equal(authoritative.showOriginal, false)
  assert.equal(authoritative.showTranslation, true)
  assert.equal(authoritative.showRomanization, true)
  assert.equal(management.document.value.showRomanization, true)
})

test('lyrics management surfaces a CAS conflict by restoring the authoritative UI document', async () => {
  const management = useLyricsManagement()
  authoritative = {
    ...authoritative,
    globalOffsetMs: 875,
    showTranslation: false
  }
  revision += 1
  rejectNextSave = true

  await assert.rejects(() => management.updateGlobalOffset(-200), /conflict/)
  assert.equal(management.document.value.globalOffsetMs, 875)
  assert.equal(management.document.value.showTranslation, false)
})
