import { app, ipcMain } from 'electron'
import { join } from 'path'

import { runtime } from '../core/runtime'
import { LoudnessAnalysisCache } from './loudnessCache.ts'
import {
  LoudnessAnalysisManager,
  type LoudnessAnalysisRequest,
  type LoudnessAnalysisRequestResult
} from './loudnessAnalysisManager.ts'
import { resolveAuthorizedAudioFile } from '../security/localPaths.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const LOUDNESS_ANALYSIS_CACHE_FILE = 'loudness-analysis-cache.json'
const MAX_LOUDNESS_TRACK_ID_LENGTH = 512
const MAX_LOUDNESS_FILE_PATH_LENGTH = 4096
// Whole-file loudness passes maxAnalysisSeconds: 0; the pool deadline must
// cover the same 14_400s bound the engine manager clamps loudnorm analysis to.
const LOUDNESS_WHOLE_FILE_TASK_TIMEOUT_MS = (14_400 + 120) * 1000

export function setupLoudnessAnalysisIpc(): void {
  runtime.loudnessAnalysisManager = new LoudnessAnalysisManager({
    cache: new LoudnessAnalysisCache(getLoudnessAnalysisCachePath()),
    analyzeFile: async (request) => {
      const service = runtime.audioAnalysisService
      if (!service) throw new Error('audio analysis service is unavailable')
      return await service.analyzeLoudness(
        request.filePath,
        JSON.stringify({ maxAnalysisSeconds: 0 }),
        { priority: request.priority ?? 50, timeoutMs: LOUDNESS_WHOLE_FILE_TASK_TIMEOUT_MS }
      )
    },
    cancelFile: (filePath) => {
      if (filePath) runtime.audioAnalysisService?.cancelBySource(filePath, 'loudness')
      else runtime.audioAnalysisService?.cancelAll('loudness')
    },
    onComplete: (event) => {
      runtime.mainWindow?.webContents.send('loudnessAnalysis:completed', event)
    }
  })
  runtime.audioEngineManager?.setLoudnessAnalysisManager(runtime.loudnessAnalysisManager)

  ipcMain.handle(
    'loudnessAnalysis:request',
    async (_event, raw: unknown): Promise<LoudnessAnalysisRequestResult> => {
      assertTrustedIpcSender(_event, 'Loudness IPC')
      const request = await normalizeLoudnessAnalysisRequest(raw)
      if (!request) return { status: 'skipped', reason: 'invalid-request' }
      return runtime.loudnessAnalysisManager!.requestAnalysis(request)
    }
  )

  ipcMain.handle('loudnessAnalysis:getCacheSize', async (event) => {
    assertTrustedIpcSender(event, 'Loudness IPC')
    return await new LoudnessAnalysisCache(getLoudnessAnalysisCachePath()).getSize()
  })

  ipcMain.handle('loudnessAnalysis:clearCache', async (event) => {
    assertTrustedIpcSender(event, 'Loudness IPC')
    const remaining = await new LoudnessAnalysisCache(getLoudnessAnalysisCachePath()).clear()
    // Drop stale loudnorm UI/runtime status so Settings/HiFi do not claim "cached" after wipe.
    await runtime.audioEngineManager?.notifyLoudnessCacheCleared()
    return remaining
  })

  ipcMain.handle('loudnessAnalysis:getStatus', async (event) => {
    assertTrustedIpcSender(event, 'Loudness IPC')
    return (
      runtime.audioEngineManager?.getLoudnormStatus() ?? {
        status: 'idle',
        source: null
      }
    )
  })

  ipcMain.handle('loudnessAnalysis:cancel', async (event, filePath?: unknown) => {
    assertTrustedIpcSender(event, 'Loudness IPC')
    const manager = runtime.loudnessAnalysisManager
    if (!manager) return
    if (typeof filePath === 'string' && filePath.trim()) {
      try {
        const authorized = await resolveAuthorizedAudioFile(
          normalizeIpcString(filePath, 'loudness file path', MAX_LOUDNESS_FILE_PATH_LENGTH)
        )
        manager.cancel(authorized)
        return
      } catch {
        manager.cancel(filePath.trim())
        return
      }
    }
    manager.cancel()
  })
}

function getLoudnessAnalysisCachePath(): string {
  return join(app.getPath('userData'), LOUDNESS_ANALYSIS_CACHE_FILE)
}

async function normalizeLoudnessAnalysisRequest(
  raw: unknown
): Promise<LoudnessAnalysisRequest | null> {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  let trackId: string
  let filePath: string
  try {
    trackId = normalizeIpcString(value.trackId, 'loudness track id', MAX_LOUDNESS_TRACK_ID_LENGTH)
    filePath = await resolveAuthorizedAudioFile(
      normalizeIpcString(value.filePath, 'loudness file path', MAX_LOUDNESS_FILE_PATH_LENGTH)
    )
  } catch {
    return null
  }
  return { trackId, filePath }
}
