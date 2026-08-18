import { randomUUID } from 'crypto'
import { open, mkdir, readFile, rename, stat, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { TwilightPluginSource, TwilightPluginStateRecord } from './types.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

export type PluginStateFile = Record<string, TwilightPluginStateRecord>

export const MAX_PLUGIN_STATE_BYTES = 1024 * 1024

export type PluginStateLoadResult =
  | { status: 'missing'; state: PluginStateFile }
  | { status: 'loaded'; state: PluginStateFile }
  | {
      status: 'recovered'
      state: PluginStateFile
      warning: string
      corruptCopyPath: string | null
    }
  | {
      status: 'unrecoverable'
      state: PluginStateFile
      warning: string
      corruptCopyPaths: string[]
    }

type PluginStateCandidate =
  | { status: 'missing' }
  | { status: 'loaded'; state: PluginStateFile; raw: string }
  | { status: 'invalid'; error: string }

const PLUGIN_SOURCES = new Set<TwilightPluginSource>(['directory', 'tep', 'bundled', 'index'])

/**
 * Serializes writes for one plugin-state.json path. Each queued item captures a
 * JSON snapshot immediately, so later in-memory mutations cannot reorder it.
 */
export class PluginStatePersistence {
  private writeTail: Promise<void> = Promise.resolve()
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<PluginStateLoadResult> {
    const primary = await readPluginStateCandidate(this.filePath)
    if (primary.status === 'loaded') return { status: 'loaded', state: primary.state }

    const backupPath = pluginStateBackupPath(this.filePath)
    const backup = await readPluginStateCandidate(backupPath)
    if (backup.status === 'loaded') {
      const corruptCopyPath =
        primary.status === 'invalid' ? await preserveCorruptCopy(this.filePath) : null
      let restoreError: string | null = null
      try {
        await writeRawFileAtomically(this.filePath, backup.raw)
      } catch (error) {
        restoreError = errorMessage(error)
      }
      const recoveryReason =
        primary.status === 'missing'
          ? `the primary file was missing`
          : `the primary file was corrupt: ${primary.error}`
      return {
        status: 'recovered',
        state: backup.state,
        warning: restoreError
          ? `Plugin state was loaded from ${backupPath} because ${recoveryReason}, but restoring the primary file failed: ${restoreError}`
          : `Plugin state was restored from ${backupPath} because ${recoveryReason}.`,
        corruptCopyPath
      }
    }

    if (primary.status === 'missing' && backup.status === 'missing') {
      return { status: 'missing', state: {} }
    }

    const corruptCopyPaths = (
      await Promise.all([
        primary.status === 'invalid' ? preserveCorruptCopy(this.filePath) : null,
        backup.status === 'invalid' ? preserveCorruptCopy(backupPath) : null
      ])
    ).filter((path): path is string => path !== null)
    return {
      status: 'unrecoverable',
      state: {},
      warning: `Plugin state is corrupt and no valid backup is available. Primary: ${candidateError(primary)}. Backup: ${candidateError(backup)}. Corrupt input was preserved at: ${corruptCopyPaths.join(', ') || 'unavailable'}.`,
      corruptCopyPaths
    }
  }

  save(state: PluginStateFile): Promise<void> {
    const snapshot = clonePluginState(state)
    const pending = this.writeTail.then(() =>
      writePluginStateFileAtomically(this.filePath, snapshot)
    )
    this.writeTail = pending.catch(() => undefined)
    return pending
  }

  /** Wait until every snapshot accepted by save() has reached a terminal state. */
  async flush(): Promise<void> {
    await this.writeTail
  }
}

export function cloneStateRecord(
  record: TwilightPluginStateRecord | undefined
): TwilightPluginStateRecord | undefined {
  if (!record) return undefined
  return {
    ...record,
    nativeDspParameters: record.nativeDspParameters ? { ...record.nativeDspParameters } : undefined
  }
}

export function pluginStateBackupPath(filePath: string): string {
  return `${filePath}.bak`
}

export function pluginStateCorruptPath(filePath: string): string {
  return `${filePath}.corrupt`
}

export async function writePluginStateFileAtomically(
  filePath: string,
  state: PluginStateFile
): Promise<void> {
  const snapshot = clonePluginState(state)
  const json = JSON.stringify(snapshot, null, 2)
  if (Buffer.byteLength(json, 'utf-8') > MAX_PLUGIN_STATE_BYTES) {
    throw new Error('Plugin state is too large to persist.')
  }

  const primary = await readPluginStateCandidate(filePath)
  const backupPath = pluginStateBackupPath(filePath)
  const backup = await readPluginStateCandidate(backupPath)
  const backupRaw =
    primary.status === 'loaded' ? primary.raw : backup.status === 'loaded' ? backup.raw : json

  // The recovery point is durable before the primary pointer is replaced.
  await writeRawFileAtomically(backupPath, backupRaw)
  await writeRawFileAtomically(filePath, json)
}

export function isPluginStateFile(value: unknown): value is PluginStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const [id, record] of Object.entries(value)) {
    if (!id || !isPluginStateRecord(record)) return false
  }
  return true
}

async function readPluginStateCandidate(filePath: string): Promise<PluginStateCandidate> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return { status: 'invalid', error: 'path is not a file' }
    if (fileStat.size <= 0) return { status: 'invalid', error: 'file is empty' }
    if (fileStat.size > MAX_PLUGIN_STATE_BYTES)
      return { status: 'invalid', error: 'file is too large' }
    const raw = await readFile(filePath, 'utf-8')
    if (Buffer.byteLength(raw, 'utf-8') > MAX_PLUGIN_STATE_BYTES) {
      return { status: 'invalid', error: 'file is too large' }
    }
    const parsed = tryParseJsonWithNestingLimit(raw)
    if (!parsed.ok) {
      return {
        status: 'invalid',
        error: parsed.reason === 'too-deep' ? 'JSON is too deeply nested' : 'JSON is invalid'
      }
    }
    if (!isPluginStateFile(parsed.value)) {
      return { status: 'invalid', error: 'JSON structure is invalid' }
    }
    return { status: 'loaded', state: parsed.value, raw }
  } catch (error) {
    if (isMissingFileError(error)) return { status: 'missing' }
    return { status: 'invalid', error: errorMessage(error) }
  }
}

async function writeRawFileAtomically(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, 'w', 0o600)
    await handle.writeFile(contents, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, filePath)
    await syncDirectory(dirname(filePath))
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Windows commonly rejects directory handles. The already-fsynced temp file is still durable.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function preserveCorruptCopy(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const corruptPath = pluginStateCorruptPath(filePath)
    await writeRawFileAtomically(corruptPath, raw)
    return corruptPath
  } catch {
    return null
  }
}

function clonePluginState(state: PluginStateFile): PluginStateFile {
  if (!isPluginStateFile(state)) throw new Error('Plugin state has an invalid structure.')
  return JSON.parse(JSON.stringify(state)) as PluginStateFile
}

function isPluginStateRecord(value: unknown): value is TwilightPluginStateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.enabled !== 'boolean' ||
    !isTimestamp(record.installedAt) ||
    !isTimestamp(record.updatedAt) ||
    typeof record.source !== 'string' ||
    !PLUGIN_SOURCES.has(record.source as TwilightPluginSource)
  ) {
    return false
  }
  if (record.lastError !== undefined && typeof record.lastError !== 'string') return false
  if (record.activeVersion !== undefined && !isSafeVersion(record.activeVersion)) return false
  if (
    record.nativeDspParameters !== undefined &&
    !isNativeDspParameters(record.nativeDspParameters)
  ) {
    return false
  }
  return true
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isSafeVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}

function isNativeDspParameters(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([name, parameter]) =>
      name.trim().length > 0 && typeof parameter === 'number' && Number.isFinite(parameter)
  )
}

function candidateError(candidate: PluginStateCandidate): string {
  return candidate.status === 'invalid' ? candidate.error : 'file is missing'
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
