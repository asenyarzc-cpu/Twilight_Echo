import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'
import { isJsonNestingWithinLimit, tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

export interface JsonFileOptions<T> {
  label: string
  maxBytes: number
  validate: (value: unknown) => value is T
}

export type JsonFileLoadResult<T> =
  | { status: 'missing' }
  | { status: 'loaded'; value: T }
  | {
      status: 'recovered'
      value: T
      corruptCopyPath: string | null
      restoreError: string | null
    }

type JsonCandidate<T> =
  | { status: 'missing' }
  | { status: 'loaded'; value: T }
  | { status: 'invalid'; error: string }

export class PersistentJsonFileError extends Error {
  readonly code = 'ERR_PERSISTENT_JSON_CORRUPT'
  readonly filePath: string
  readonly backupPath: string
  readonly primaryError: string
  readonly backupError: string
  readonly corruptCopyPath: string | null
  readonly corruptBackupCopyPath: string | null

  constructor(
    filePath: string,
    options: JsonFileOptions<unknown>,
    primaryError: string,
    backupError: string,
    corruptCopyPath: string | null,
    corruptBackupCopyPath: string | null
  ) {
    super(`${options.label} is corrupt and no valid backup is available`)
    this.name = 'PersistentJsonFileError'
    this.filePath = filePath
    this.backupPath = backupPathFor(filePath)
    this.primaryError = primaryError
    this.backupError = backupError
    this.corruptCopyPath = corruptCopyPath
    this.corruptBackupCopyPath = corruptBackupCopyPath
  }
}

export function loadJsonFileWithBackup<T>(
  filePath: string,
  options: JsonFileOptions<T>
): JsonFileLoadResult<T> {
  const primary = readJsonCandidate(filePath, options)
  if (primary.status === 'loaded') return primary

  const backupPath = backupPathFor(filePath)
  const backup = readJsonCandidate(backupPath, options)
  if (backup.status === 'loaded') {
    const corruptCopyPath = primary.status === 'invalid' ? preserveCorruptCopy(filePath) : null
    let restoreError: string | null = null
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      copyFileSync(backupPath, filePath)
    } catch (error) {
      restoreError = errorMessage(error)
    }
    return {
      status: 'recovered',
      value: backup.value,
      corruptCopyPath,
      restoreError
    }
  }

  if (primary.status === 'missing' && backup.status === 'missing') {
    return { status: 'missing' }
  }

  const corruptCopyPath = primary.status === 'invalid' ? preserveCorruptCopy(filePath) : null
  const corruptBackupCopyPath = backup.status === 'invalid' ? preserveCorruptCopy(backupPath) : null
  throw new PersistentJsonFileError(
    filePath,
    options as JsonFileOptions<unknown>,
    candidateError(primary),
    candidateError(backup),
    corruptCopyPath,
    corruptBackupCopyPath
  )
}

export function writeJsonFileAtomic<T>(
  filePath: string,
  json: string,
  options: JsonFileOptions<T>,
  value?: T
): void {
  if (Buffer.byteLength(json, 'utf-8') > options.maxBytes) {
    throw new Error(`${options.label} is too large`)
  }
  const parsed = tryParseJsonWithNestingLimit(json)
  if (!parsed.ok) {
    if (parsed.reason === 'too-deep') {
      throw new Error(`${options.label} is too deeply nested`)
    }
    throw new Error(`${options.label} is not valid JSON`)
  }
  const nextValue: unknown = value === undefined ? parsed.value : value
  if (!options.validate(nextValue)) {
    throw new Error(`${options.label} has an invalid structure`)
  }
  writeValidatedJsonFileAtomic(filePath, json, options)
}

/**
 * Serialize an already validated value without parsing the same large JSON
 * document again. JSON.stringify provides the syntax guarantee; the nesting
 * scan preserves the persisted-file safety limit.
 */
export function writeJsonValueAtomic<T>(
  filePath: string,
  value: T,
  options: JsonFileOptions<T>
): void {
  if (!options.validate(value)) {
    throw new Error(`${options.label} has an invalid structure`)
  }
  const json = JSON.stringify(value)
  if (typeof json !== 'string') throw new Error(`${options.label} is not serializable`)
  if (Buffer.byteLength(json, 'utf-8') > options.maxBytes) {
    throw new Error(`${options.label} is too large`)
  }
  if (!isJsonNestingWithinLimit(json)) {
    throw new Error(`${options.label} is too deeply nested`)
  }
  writeValidatedJsonFileAtomic(filePath, json, options)
}

function writeValidatedJsonFileAtomic<T>(
  filePath: string,
  json: string,
  options: JsonFileOptions<T>
): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = temporaryPathFor(filePath)
  const backupPath = backupPathFor(filePath)
  const current = readJsonCandidate(filePath, options)
  let backupIsKnownValid = false

  try {
    writeFileSync(tmpPath, json, 'utf-8')
    if (current.status === 'loaded') {
      copyFileSync(filePath, backupPath)
      backupIsKnownValid = true
    } else if (current.status === 'invalid') {
      preserveCorruptCopy(filePath)
    }

    try {
      renameSync(tmpPath, filePath)
    } catch {
      if (existsSync(filePath)) unlinkSync(filePath)
      renameSync(tmpPath, filePath)
    }

    if (!backupIsKnownValid) {
      const activeBackup = readJsonCandidate(backupPath, options)
      if (activeBackup.status !== 'loaded') {
        copyFileSync(filePath, backupPath)
      }
    }
  } catch (error) {
    const recoveryBackup = readJsonCandidate(backupPath, options)
    if (!existsSync(filePath) && recoveryBackup.status === 'loaded') {
      try {
        copyFileSync(backupPath, filePath)
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Atomic rename removes the temporary file on success.
    }
  }
}

export function clearJsonFileArtifacts(filePath: string): void {
  for (const targetPath of [
    filePath,
    backupPathFor(filePath),
    temporaryPathFor(filePath),
    corruptPathFor(filePath)
  ]) {
    try {
      unlinkSync(targetPath)
    } catch {
      // Missing files are already clear.
    }
  }
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`
}

export function corruptPathFor(filePath: string): string {
  return `${filePath}.corrupt`
}

function temporaryPathFor(filePath: string): string {
  return `${filePath}.tmp`
}

function readJsonCandidate<T>(filePath: string, options: JsonFileOptions<T>): JsonCandidate<T> {
  if (!existsSync(filePath)) return { status: 'missing' }
  try {
    const fileSize = statSync(filePath).size
    if (fileSize <= 0) return { status: 'invalid', error: 'file is empty' }
    if (fileSize > options.maxBytes) return { status: 'invalid', error: 'file is too large' }
    const raw = readFileSync(filePath, 'utf-8')
    if (Buffer.byteLength(raw, 'utf-8') > options.maxBytes) {
      return { status: 'invalid', error: 'file is too large' }
    }
    if (!isJsonNestingWithinLimit(raw)) {
      return { status: 'invalid', error: 'JSON is too deeply nested' }
    }
    const value = JSON.parse(raw) as unknown
    if (!options.validate(value)) {
      return { status: 'invalid', error: 'JSON structure is invalid' }
    }
    return { status: 'loaded', value }
  } catch (error) {
    return { status: 'invalid', error: errorMessage(error) }
  }
}

function preserveCorruptCopy(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const corruptPath = corruptPathFor(filePath)
  try {
    if (existsSync(corruptPath)) unlinkSync(corruptPath)
    copyFileSync(filePath, corruptPath)
    return corruptPath
  } catch {
    return null
  }
}

function candidateError<T>(candidate: JsonCandidate<T>): string {
  return candidate.status === 'invalid' ? candidate.error : 'file is missing'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
