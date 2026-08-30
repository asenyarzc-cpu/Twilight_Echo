import { createHash, createPublicKey, verify, type KeyObject } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { canonicalizePluginManifestPaths } from './manifest.ts'
import type {
  TwilightPluginIndexLoadedFrom,
  TwilightPluginPublisherSignature,
  TwilightPluginSignatureStatus,
  TwilightPluginVerification
} from './types.ts'

export const OFFICIAL_PLUGIN_INDEX_URL =
  'https://raw.githubusercontent.com/asenyarzc-cpu/Twilight-Echo-plugins/main/plugins.json'

const TRUST_REGISTRY_SCHEMA_VERSION = 1
const MAX_TRUSTED_PUBLISHER_REGISTRY_BYTES = 512 * 1024
const SIGNATURE_SCHEMA_VERSION = 1
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface TrustedPluginPublisherKey {
  keyId: string
  publisher: string
  algorithm: 'ed25519'
  publicKeyPem: string
  status?: 'active' | 'revoked'
  notBefore?: string
  notAfter?: string
}

export interface TrustedPluginPublisherRegistryFile {
  schemaVersion: 1
  keys: TrustedPluginPublisherKey[]
  revokedKeyIds?: string[]
}

export interface NormalizedTrustedPublisherKey extends TrustedPluginPublisherKey {
  status: 'active' | 'revoked'
  keyObject: KeyObject
  fingerprintSha256: string
  notBeforeMs: number | null
  notAfterMs: number | null
}

export interface TrustedPluginPublisherRegistry {
  keys: ReadonlyMap<string, NormalizedTrustedPublisherKey>
  revokedKeyIds: ReadonlySet<string>
  error: string | null
}

export interface PluginIndexTrustContext {
  indexOrigin: string
  loadedFrom: TwilightPluginIndexLoadedFrom
  stale: boolean
  expired: boolean
  originVerified: boolean
}

export function loadTrustedPluginPublisherRegistry(
  registryPath: string
): TrustedPluginPublisherRegistry {
  if (!existsSync(registryPath)) {
    return failedRegistry(`Trusted publisher registry is missing: ${registryPath}`)
  }
  try {
    const contents = readFileSync(registryPath)
    if (contents.byteLength > MAX_TRUSTED_PUBLISHER_REGISTRY_BYTES) {
      throw new Error('Trusted publisher registry is too large')
    }
    const parsed = tryParseJsonWithNestingLimit(contents.toString('utf-8'))
    if (!parsed.ok) {
      throw new Error(
        parsed.reason === 'too-deep'
          ? 'Trusted publisher registry is too deeply nested'
          : 'Trusted publisher registry contains invalid JSON'
      )
    }
    return createTrustedPluginPublisherRegistry(parsed.value)
  } catch (error) {
    return failedRegistry(error instanceof Error ? error.message : String(error))
  }
}

export function createTrustedPluginPublisherRegistry(raw: unknown): TrustedPluginPublisherRegistry {
  try {
    if (!isRecord(raw) || raw.schemaVersion !== TRUST_REGISTRY_SCHEMA_VERSION) {
      throw new Error('Trusted publisher registry schemaVersion must be 1')
    }
    if (!Array.isArray(raw.keys))
      throw new Error('Trusted publisher registry keys must be an array')
    if (raw.revokedKeyIds !== undefined && !Array.isArray(raw.revokedKeyIds)) {
      throw new Error('Trusted publisher registry revokedKeyIds must be an array')
    }
    const revokedKeyIds = new Set(
      Array.isArray(raw.revokedKeyIds)
        ? raw.revokedKeyIds.map((value) => requireKeyId(value, 'revoked key id'))
        : []
    )
    const keys = new Map<string, NormalizedTrustedPublisherKey>()
    for (const candidate of raw.keys) {
      const key = normalizeTrustedKey(candidate)
      if (keys.has(key.keyId)) throw new Error(`Duplicate trusted publisher key id: ${key.keyId}`)
      keys.set(key.keyId, key)
      if (key.status === 'revoked') revokedKeyIds.add(key.keyId)
    }
    return { keys, revokedKeyIds, error: null }
  } catch (error) {
    return failedRegistry(error instanceof Error ? error.message : String(error))
  }
}

export function createPluginIndexSignaturePayload(
  entry: Record<string, unknown>,
  indexOrigin: string
): Buffer {
  const canonicalEntry = canonicalPluginIndexEntry(entry, false)
  return Buffer.from(
    canonicalJson({
      schemaVersion: SIGNATURE_SCHEMA_VERSION,
      indexOrigin,
      entry: canonicalEntry
    }),
    'utf-8'
  )
}

export function createPluginIndexEntryFingerprint(
  entry: Record<string, unknown>,
  indexOrigin: string
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: SIGNATURE_SCHEMA_VERSION,
        indexOrigin,
        entry: canonicalPluginIndexEntry(entry, true)
      }),
      'utf-8'
    )
    .digest('hex')
}

export function verifyPluginIndexEntry(
  entry: Record<string, unknown>,
  context: PluginIndexTrustContext,
  registry: TrustedPluginPublisherRegistry,
  now: Date
): { signature?: TwilightPluginPublisherSignature; verification: TwilightPluginVerification } {
  const indexClaimed = entry.verified === true
  const officialSource = context.indexOrigin === OFFICIAL_PLUGIN_INDEX_URL
  const signatureResult = verifyPublisherSignature(entry, context.indexOrigin, registry, now)
  const official =
    indexClaimed &&
    officialSource &&
    context.loadedFrom === 'remote' &&
    context.originVerified &&
    !context.stale &&
    !context.expired &&
    signatureResult.status === 'valid'

  const level = official
    ? 'official'
    : signatureResult.status === 'valid'
      ? 'publisher-signed'
      : indexClaimed
        ? 'index-declared'
        : 'unverified'

  return {
    signature: signatureResult.signature,
    verification: {
      level,
      official,
      officialSource,
      indexClaimed,
      signatureStatus: signatureResult.status,
      keyId: signatureResult.keyId,
      publisher: signatureResult.publisher,
      keyFingerprintSha256: signatureResult.fingerprintSha256,
      revalidateAt: signatureResult.revalidateAt,
      reason: verificationReason({
        official,
        officialSource,
        indexClaimed,
        context,
        signatureStatus: signatureResult.status,
        registryError: registry.error
      })
    }
  }
}

function verifyPublisherSignature(
  entry: Record<string, unknown>,
  indexOrigin: string,
  registry: TrustedPluginPublisherRegistry,
  now: Date
): {
  status: TwilightPluginSignatureStatus
  signature?: TwilightPluginPublisherSignature
  keyId: string | null
  publisher: string | null
  fingerprintSha256: string | null
  revalidateAt: string | null
} {
  if (entry.publisherSignature == null) return signatureResult('missing')
  const parsed = parsePublisherSignature(entry.publisherSignature)
  if (!parsed.signature) return signatureResult(parsed.status, parsed.keyId)
  if (registry.error) return signatureResult('trust-store-error', parsed.signature.keyId)

  const key = registry.keys.get(parsed.signature.keyId)
  if (!key) return signatureResult('unknown-key', parsed.signature.keyId, parsed.signature)
  const common = {
    keyId: key.keyId,
    publisher: key.publisher,
    fingerprintSha256: key.fingerprintSha256,
    signature: parsed.signature,
    revalidateAt: null as string | null
  }
  if (registry.revokedKeyIds.has(key.keyId) || key.status === 'revoked') {
    return { status: 'revoked-key', ...common }
  }

  const nowMs = now.getTime()
  if (key.notBeforeMs !== null && nowMs < key.notBeforeMs) {
    return {
      status: 'key-not-yet-valid',
      ...common,
      revalidateAt: new Date(key.notBeforeMs).toISOString()
    }
  }
  if (key.notAfterMs !== null && nowMs >= key.notAfterMs) {
    return { status: 'key-expired', ...common }
  }
  const activeCommon = {
    ...common,
    revalidateAt: key.notAfterMs === null ? null : new Date(key.notAfterMs).toISOString()
  }

  try {
    const valid = verify(
      null,
      createPluginIndexSignaturePayload(entry, indexOrigin),
      key.keyObject,
      Buffer.from(parsed.signature.value, 'base64')
    )
    return { status: valid ? 'valid' : 'invalid', ...activeCommon }
  } catch {
    return { status: 'invalid-key', ...activeCommon }
  }
}

function parsePublisherSignature(raw: unknown): {
  status: TwilightPluginSignatureStatus
  signature?: TwilightPluginPublisherSignature
  keyId: string | null
} {
  if (!isRecord(raw)) return { status: 'malformed', keyId: null }
  const keyId = typeof raw.keyId === 'string' && KEY_ID_PATTERN.test(raw.keyId) ? raw.keyId : null
  if (raw.schemaVersion !== SIGNATURE_SCHEMA_VERSION || raw.algorithm !== 'ed25519') {
    return { status: 'unsupported', keyId }
  }
  if (!keyId || typeof raw.value !== 'string' || !isCanonicalSignatureBase64(raw.value)) {
    return { status: 'malformed', keyId }
  }
  return {
    status: 'valid',
    keyId,
    signature: {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId,
      value: raw.value
    }
  }
}

function signatureResult(
  status: TwilightPluginSignatureStatus,
  keyId: string | null = null,
  signature?: TwilightPluginPublisherSignature
): {
  status: TwilightPluginSignatureStatus
  signature?: TwilightPluginPublisherSignature
  keyId: string | null
  publisher: string | null
  fingerprintSha256: string | null
  revalidateAt: string | null
} {
  return {
    status,
    signature,
    keyId,
    publisher: null,
    fingerprintSha256: null,
    revalidateAt: null
  }
}

function normalizeTrustedKey(raw: unknown): NormalizedTrustedPublisherKey {
  if (!isRecord(raw)) throw new Error('Trusted publisher key must be an object')
  const keyId = requireKeyId(raw.keyId, 'trusted publisher key id')
  const publisher = requireNonEmptyString(raw.publisher, `publisher for ${keyId}`)
  if (raw.algorithm !== 'ed25519') throw new Error(`Unsupported key algorithm for ${keyId}`)
  const publicKeyPem = requireNonEmptyString(raw.publicKeyPem, `public key for ${keyId}`)
  let status: 'active' | 'revoked'
  if (raw.status === undefined || raw.status === 'active') {
    status = 'active'
  } else if (raw.status === 'revoked') {
    status = 'revoked'
  } else {
    throw new Error(`Trusted publisher key ${keyId} has an invalid status`)
  }
  const keyObject = createPublicKey(publicKeyPem)
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Trusted publisher key ${keyId} is not Ed25519`)
  }
  const notBefore = optionalTimestamp(raw.notBefore, `notBefore for ${keyId}`)
  const notAfter = optionalTimestamp(raw.notAfter, `notAfter for ${keyId}`)
  if (notBefore.ms !== null && notAfter.ms !== null && notAfter.ms <= notBefore.ms) {
    throw new Error(`Trusted publisher key ${keyId} has an invalid validity window`)
  }
  const der = keyObject.export({ type: 'spki', format: 'der' })
  return {
    keyId,
    publisher,
    algorithm: 'ed25519',
    publicKeyPem,
    status,
    notBefore: notBefore.iso ?? undefined,
    notAfter: notAfter.iso ?? undefined,
    notBeforeMs: notBefore.ms,
    notAfterMs: notAfter.ms,
    keyObject,
    fingerprintSha256: createHash('sha256').update(der).digest('hex')
  }
}

function optionalTimestamp(
  value: unknown,
  label: string
): { iso: string | null; ms: number | null } {
  if (value === undefined) return { iso: null, ms: null }
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`${label} must be an ISO timestamp`)
  return { iso: new Date(ms).toISOString(), ms }
}

function verificationReason(input: {
  official: boolean
  officialSource: boolean
  indexClaimed: boolean
  context: PluginIndexTrustContext
  signatureStatus: TwilightPluginSignatureStatus
  registryError: string | null
}): string {
  if (input.official) return '固定官方索引、有效期、发布者签名和索引审核声明均已验证'
  if (input.signatureStatus === 'trust-store-error') {
    return `可信发布者注册表不可用：${input.registryError ?? '未知错误'}`
  }
  if (input.signatureStatus === 'valid') {
    if (!input.officialSource) return '发布者签名有效，但索引不是固定官方来源'
    if (input.context.loadedFrom !== 'remote') return '发布者签名有效，但当前条目来自缓存或离线索引'
    if (!input.context.originVerified) return '发布者签名有效，但缓存来源未经持久化验证'
    if (input.context.expired) return '发布者签名有效，但索引记录已过期'
    if (input.context.stale) return '发布者签名有效，但索引记录已标记为 stale'
    if (!input.indexClaimed) return '发布者签名有效，但索引未声明完成审核'
  }
  if (input.indexClaimed) {
    return `索引声明已审核，但发布者签名状态为 ${input.signatureStatus}`
  }
  return `未形成官方验证链；发布者签名状态为 ${input.signatureStatus}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Signature payload contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isRecord(value)) {
    const properties = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${properties.join(',')}}`
  }
  throw new Error('Signature payload contains a non-JSON value')
}

function canonicalPluginIndexEntry(
  entry: Record<string, unknown>,
  includePublisherSignature: boolean
): Record<string, unknown> {
  const canonicalEntry = { ...entry }
  if (!includePublisherSignature) delete canonicalEntry.publisherSignature
  delete canonicalEntry.verification
  delete canonicalEntry.installState
  delete canonicalEntry.installedVersion
  return canonicalizePluginManifestPaths(canonicalEntry)
}

function requireKeyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`)
  return value.trim()
}

function isCanonicalSignatureBase64(value: string): boolean {
  if (!BASE64_PATTERN.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength === 64 && decoded.toString('base64') === value
}

function failedRegistry(error: string): TrustedPluginPublisherRegistry {
  return { keys: new Map(), revokedKeyIds: new Set(), error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
