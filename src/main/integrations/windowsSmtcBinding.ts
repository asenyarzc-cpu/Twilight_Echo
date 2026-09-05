import { existsSync, statSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { WindowsSmtcEvent, WindowsSmtcUpdate } from '../../shared/systemMedia.ts'

const require = createRequire(import.meta.url)

type ElectronModule = typeof import('electron')

function resolveElectronApp(): ElectronModule['app'] | null {
  try {
    const electronModule = require('electron') as ElectronModule | string
    if (typeof electronModule === 'object' && electronModule && 'app' in electronModule) {
      return electronModule.app
    }
  } catch {
    // Node-side tests may import this module without a running Electron app.
  }
  return null
}

function orderExistingCandidatesByFreshness(candidates: string[]): string[] {
  return candidates
    .map((candidate, index) => {
      let modifiedAt = -1
      try {
        if (existsSync(candidate)) modifiedAt = statSync(candidate).mtimeMs
      } catch {
        // Loading will surface the actual filesystem/module error later.
      }
      return { candidate, index, modifiedAt }
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.index - right.index)
    .map(({ candidate }) => candidate)
}

export function nativeWindowHandleToNumber(handle: Buffer | null | undefined): number | undefined {
  if (!handle || handle.length < 4) return undefined
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(value)
}

const electronApp = resolveElectronApp()

export interface WindowsSmtcBinding {
  Create: (
    callback: (event: WindowsSmtcEvent) => void,
    nativeWindowHandle?: number,
    appUserModelId?: string
  ) => boolean
  Update: (update: WindowsSmtcUpdate) => void
  Destroy: () => void
  SelfTest?: () => boolean
  GetLastError?: () => string
}

export interface WindowsSmtcBindingLoadResult {
  binding: WindowsSmtcBinding | null
  attempts: Array<{ candidate: string; error: string }>
  candidateCount: number
}

export function getWindowsSmtcAddonCandidates(): string[] {
  const binary = 'twilight_smtc_node.node'
  const appPath = electronApp?.getAppPath?.() ?? process.cwd()
  const packagedCandidates = [
    join(process.resourcesPath ?? '', 'audio-engine', binary),
    join(appPath, 'resources', 'audio-engine', binary)
  ]
  const developmentCandidates = [
    join(appPath, 'audio-engine', 'build', 'smtc-msvc-x64', 'Release', binary),
    join(appPath, 'audio-engine', 'build', 'smtc-msvc-x64', 'bin', 'Release', binary),
    join(appPath, '..', 'audio-engine', 'build', 'smtc-msvc-x64', 'Release', binary),
    join(appPath, '..', 'audio-engine', 'build', 'smtc-msvc-x64', 'bin', 'Release', binary)
  ]
  // Development can leave either the build output or staged resource locked by
  // a running Electron process. Prefer whichever existing addon was produced
  // most recently so a fresh build/stage can be picked up on the next restart
  // without relying on one fixed directory. Packaged apps always prefer their
  // immutable resources directory.
  const candidates = electronApp?.isPackaged
    ? [...packagedCandidates, ...developmentCandidates]
    : orderExistingCandidatesByFreshness([...developmentCandidates, ...packagedCandidates])
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index)
}

export function loadWindowsSmtcBinding(
  getCandidates: () => string[] = getWindowsSmtcAddonCandidates
): WindowsSmtcBindingLoadResult {
  const candidates = getCandidates()
  const attempts: Array<{ candidate: string; error: string }> = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      // Keep the staged VC runtime directory discoverable for transitive imports.
      const pathKey =
        Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
      const currentPath = process.env[pathKey] ?? ''
      const directory = dirname(candidate)
      if (!currentPath.split(';').includes(directory)) {
        process.env[pathKey] = [directory, currentPath].filter(Boolean).join(';')
      }
      const binding = require(candidate) as Partial<WindowsSmtcBinding>
      if (
        typeof binding.Create !== 'function' ||
        typeof binding.Update !== 'function' ||
        typeof binding.Destroy !== 'function'
      ) {
        throw new Error('SMTC addon does not expose Create/Update/Destroy')
      }
      return { binding: binding as WindowsSmtcBinding, attempts, candidateCount: candidates.length }
    } catch (error) {
      attempts.push({ candidate, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { binding: null, attempts, candidateCount: candidates.length }
}

export function describeWindowsSmtcBindingFailure(result: WindowsSmtcBindingLoadResult): string {
  const first = result.attempts[0]
  if (first) {
    const detail = first.error.split('\n')[0].trim() || 'unknown loader error'
    return `failed to load ${first.candidate}: ${detail}`
  }
  return `twilight_smtc_node.node was not found in ${result.candidateCount} candidate paths`
}
