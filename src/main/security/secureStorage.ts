import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { hostname, userInfo } from 'os'
import * as electron from 'electron'
import { tryParseJsonWithNestingLimit } from './jsonSafety.ts'

export interface SecureValueEnvelope {
  __twilightSecure: true
  version: 1
  backend: 'electron-safe-storage' | 'aes-256-gcm-machine'
  ciphertext: string
  iv?: string
  tag?: string
}

interface ElectronSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

const SENSITIVE_KEY_PATTERN =
  /(^|[-_.:])(cookie|csrf|token|access[-_.:]?token|refresh[-_.:]?token|api[-_.:]?key|apikey|bearer|signing[-_.:]?key|client[-_.:]?secret|secret|password|passwd|credential|session|auth)([-_.:]|$)/i

export function isSensitiveStorageKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim())
}

export function isSecureValueEnvelope(value: unknown): value is SecureValueEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.__twilightSecure === true &&
    record.version === 1 &&
    typeof record.ciphertext === 'string'
  )
}

export function protectString(value: string, scope: string): SecureValueEnvelope {
  const safeStorage = loadElectronSafeStorage()
  if (safeStorage?.isEncryptionAvailable()) {
    return {
      __twilightSecure: true,
      version: 1,
      backend: 'electron-safe-storage',
      ciphertext: safeStorage.encryptString(value).toString('base64')
    }
  }

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveFallbackKey(scope), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    __twilightSecure: true,
    version: 1,
    backend: 'aes-256-gcm-machine',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  }
}

export function unprotectString(envelope: SecureValueEnvelope, scope: string): string | null {
  try {
    if (envelope.backend === 'electron-safe-storage') {
      const safeStorage = loadElectronSafeStorage()
      if (!safeStorage?.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))
    }

    if (envelope.backend === 'aes-256-gcm-machine') {
      if (!envelope.iv || !envelope.tag) return null
      const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveFallbackKey(scope),
        Buffer.from(envelope.iv, 'base64')
      )
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf-8')
    }
  } catch {
    return null
  }
  return null
}

export function protectJsonValue(value: unknown, scope: string): SecureValueEnvelope {
  const serialized = JSON.stringify(value)
  return protectString(serialized === undefined ? 'null' : serialized, scope)
}

export function unprotectJsonValue(envelope: SecureValueEnvelope, scope: string): unknown {
  const plainText = unprotectString(envelope, scope)
  if (plainText == null) return undefined
  const parsed = tryParseJsonWithNestingLimit(plainText)
  return parsed.ok ? parsed.value : undefined
}

export function redactSensitiveText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  return text
    .replace(/(MUSIC_U=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(__csrf=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:X-Api-Key|X-Signature)\s*:\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:password|captcha|token|cookie|csrf|secret|api[-_]?key|apikey|signature)=)[^&\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:password|token|cookie|secret|credential|api[-_.:]?key|apikey|bearer|signing[-_.:]?key|client[-_.:]?secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]'
    )
}

function deriveFallbackKey(scope: string): Buffer {
  const user = safeUserFingerprint()
  const material = [
    'twilight-echo-secure-storage-v1',
    process.platform,
    process.arch,
    hostname(),
    user.username,
    user.homedir,
    scope
  ].join('\0')
  return scryptSync(material, 'twilight-echo-local-machine', 32)
}

function safeUserFingerprint(): { username: string; homedir: string } {
  try {
    const info = userInfo()
    return { username: info.username || '', homedir: info.homedir || '' }
  } catch {
    return { username: '', homedir: process.env.HOME || process.env.USERPROFILE || '' }
  }
}

function loadElectronSafeStorage(): ElectronSafeStorage | null {
  const direct = electron as unknown as { safeStorage?: ElectronSafeStorage }
  if (direct.safeStorage) return direct.safeStorage
  const nested = electron as unknown as { default?: { safeStorage?: ElectronSafeStorage } | string }
  return typeof nested.default === 'object' ? (nested.default.safeStorage ?? null) : null
}
