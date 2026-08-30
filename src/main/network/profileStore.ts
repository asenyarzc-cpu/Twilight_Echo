import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeRemotePath, redactProfile } from './networkPath.ts'
import { NetworkSourceFailure } from './errors.ts'
import { hasControlCharacters } from './textValidation.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import type { NetworkAuth } from './adapters/types.ts'
import type {
  NetworkProtocol,
  NetworkSourceProfileInput,
  NetworkSourceProfile,
  NetworkSourceProfileSummary
} from '../../shared/networkSources.ts'

export type { NetworkSourceProfileInput } from '../../shared/networkSources.ts'

/** 凭据加密接缝：生产用 secureStorage，测试注入假 codec。 */
export interface CredentialCodec {
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}

export interface NetworkProfileStore {
  listProfiles(): Promise<NetworkSourceProfileSummary[]>
  getProfile(id: string): Promise<NetworkSourceProfile>
  createProfile(input: NetworkSourceProfileInput): Promise<NetworkSourceProfileSummary>
  updateProfile(
    id: string,
    patch: Partial<NetworkSourceProfileInput>
  ): Promise<NetworkSourceProfileSummary>
  deleteProfile(id: string): Promise<void>
  resolveAuth(id: string): Promise<NetworkAuth>
}

const SUPPORTED_PROTOCOLS: ReadonlySet<NetworkProtocol> = new Set([
  'webdav',
  'ftp',
  'ftps',
  'sftp',
  'scp',
  'smb',
  'nfs',
  'dlna'
])

const MAX_BOOKMARKS = 50
const MAX_NETWORK_PROFILES = 256
const MAX_NETWORK_PROFILES_FILE_BYTES = 1024 * 1024
const MAX_ENCRYPTED_CREDENTIAL_BYTES = 16 * 1024

function normalizeName(value: unknown): string {
  if (typeof value !== 'string')
    throw new NetworkSourceFailure('invalidProfile', '名称必须是字符串')
  const name = value.trim()
  if (!name || name.length > 64)
    throw new NetworkSourceFailure('invalidProfile', '名称长度需在 1–64 之间')
  if (hasControlCharacters(name)) {
    throw new NetworkSourceFailure('invalidProfile', '名称包含非法字符')
  }
  return name
}

function normalizeHost(value: unknown): string {
  if (typeof value !== 'string')
    throw new NetworkSourceFailure('invalidProfile', '地址必须是字符串')
  const host = value.trim().replace(/^https?:\/\//i, '')
  if (!host || host.length > 253 || hasControlCharacters(host)) {
    throw new NetworkSourceFailure('invalidProfile', '地址不合法')
  }
  return host
}

function normalizeWebDavScheme(
  protocol: NetworkProtocol,
  host: unknown,
  explicit: unknown
): 'http' | 'https' | undefined {
  if (protocol !== 'webdav') return undefined
  if (typeof host === 'string' && /^https:\/\//i.test(host.trim())) return 'https'
  if (typeof host === 'string' && /^http:\/\//i.test(host.trim())) return 'http'
  if (explicit === 'http' || explicit === 'https') return explicit
  return 'http'
}

function normalizePort(value: unknown): number | null {
  if (value == null || value === '') return null
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NetworkSourceFailure('invalidProfile', '端口需在 1–65535 之间')
  }
  return port
}

function normalizeUsername(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 128 || hasControlCharacters(value)) {
    throw new NetworkSourceFailure('invalidProfile', '用户名不合法')
  }
  return value.trim()
}

function validateAuth(auth: NetworkSourceProfileInput['auth']): void {
  if (auth.kind === 'anonymous') return
  if (auth.kind === 'password') {
    if (typeof auth.password !== 'string' || auth.password.length > 512) {
      throw new NetworkSourceFailure('invalidProfile', '密码不合法')
    }
    return
  }
  if (auth.kind === 'privateKey') {
    const keyPath = typeof auth.keyPath === 'string' ? auth.keyPath.trim() : ''
    if (!keyPath || keyPath.length > 512 || hasControlCharacters(keyPath)) {
      throw new NetworkSourceFailure('invalidProfile', '私钥路径不合法')
    }
    if (
      auth.passphrase != null &&
      (typeof auth.passphrase !== 'string' || auth.passphrase.length > 512)
    ) {
      throw new NetworkSourceFailure('invalidProfile', '私钥口令不合法')
    }
    return
  }
  throw new NetworkSourceFailure('invalidProfile', '暂不支持该认证方式')
}

function normalizeBookmarks(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new NetworkSourceFailure('invalidProfile', '书签格式不合法')
  const bookmarks = value.slice(0, MAX_BOOKMARKS).map((item) => normalizeRemotePath(String(item)))
  return [...new Set(bookmarks)]
}

export function validateProfileInput(input: NetworkSourceProfileInput): void {
  if (!SUPPORTED_PROTOCOLS.has(input.protocol)) {
    throw new NetworkSourceFailure('invalidProfile', '不支持的协议')
  }
  normalizeName(input.name)
  normalizeHost(input.host)
  if (
    input.webdavScheme !== undefined &&
    (input.protocol !== 'webdav' || !['http', 'https'].includes(input.webdavScheme))
  ) {
    throw new NetworkSourceFailure('invalidProfile', 'WebDAV 传输协议配置不合法')
  }
  normalizePort(input.port)
  normalizeRemotePath(input.rootPath)
  normalizeUsername(input.username)
  validateAuth(input.auth)
  normalizeBookmarks(input.bookmarks)
}

interface PersistedFile {
  profiles: NetworkSourceProfile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPersistedProfile(value: unknown): value is NetworkSourceProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128) {
    return false
  }
  if (
    typeof value.protocol !== 'string' ||
    !SUPPORTED_PROTOCOLS.has(value.protocol as NetworkProtocol)
  ) {
    return false
  }
  if (!isRecord(value.credential) || typeof value.credential.kind !== 'string') return false
  if (
    !['anonymous', 'password', 'privateKey'].includes(value.credential.kind) ||
    typeof value.credential.encryptedId !== 'string' ||
    value.credential.encryptedId.length > MAX_ENCRYPTED_CREDENTIAL_BYTES
  ) {
    return false
  }
  if (value.credential.kind === 'anonymous' && value.credential.encryptedId !== '') return false
  if (!isRecord(value.options)) return false
  if (
    typeof value.options.readOnly !== 'boolean' ||
    !isBoundedPositiveInteger(value.options.connectTimeoutMs, 10 * 60 * 1000) ||
    !isBoundedPositiveInteger(value.options.transferTimeoutMs, 60 * 60 * 1000) ||
    !isBoundedPositiveInteger(value.options.maxConcurrentTransfers, 128) ||
    !Array.isArray(value.bookmarks) ||
    !isBoundedPositiveInteger(value.createdAt, Number.MAX_SAFE_INTEGER) ||
    (value.lastConnectedAt !== null &&
      !isBoundedPositiveInteger(value.lastConnectedAt, Number.MAX_SAFE_INTEGER)) ||
    typeof value.rootPath !== 'string'
  ) {
    return false
  }

  try {
    const protocol = value.protocol as NetworkProtocol
    normalizeName(value.name)
    normalizeHost(value.host)
    normalizePort(value.port)
    normalizeRemotePath(value.rootPath)
    normalizeUsername(value.username)
    normalizeBookmarks(value.bookmarks)
    if (
      value.webdavScheme !== undefined &&
      value.webdavScheme !== 'http' &&
      value.webdavScheme !== 'https'
    ) {
      return false
    }
    if (protocol !== 'webdav' && value.webdavScheme !== undefined) return false
    if (value.keyPath !== undefined) {
      if (
        typeof value.keyPath !== 'string' ||
        !value.keyPath.trim() ||
        value.keyPath.length > 512 ||
        hasControlCharacters(value.keyPath)
      ) {
        return false
      }
    }
    if (value.credential.kind === 'privateKey' && value.keyPath === undefined) return false
  } catch {
    return false
  }

  return true
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function isPersistedFile(value: unknown): value is PersistedFile {
  return (
    isRecord(value) &&
    Array.isArray(value.profiles) &&
    value.profiles.length <= MAX_NETWORK_PROFILES &&
    value.profiles.every(isPersistedProfile)
  )
}

export function createNetworkProfileStore(deps: {
  filePath: string
  codec: CredentialCodec
}): NetworkProfileStore {
  const { filePath, codec } = deps

  async function load(): Promise<NetworkSourceProfile[]> {
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size > MAX_NETWORK_PROFILES_FILE_BYTES) {
        throw new Error('profile store file is invalid or too large')
      }
      const raw = await readFile(filePath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_NETWORK_PROFILES_FILE_BYTES) {
        throw new Error('profile store file is too large')
      }
      const parsed = tryParseJsonWithNestingLimit(raw)
      if (!parsed.ok || !isPersistedFile(parsed.value)) {
        throw new Error('profile store JSON is invalid')
      }
      return parsed.value.profiles
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new NetworkSourceFailure('network', '?????????')
    }
  }

  async function save(profiles: NetworkSourceProfile[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify({ profiles }, null, 2), 'utf8')
  }

  async function findProfile(id: string): Promise<NetworkSourceProfile> {
    const profile = (await load()).find((item) => item.id === id)
    if (!profile) throw new NetworkSourceFailure('notFound', '网络源不存在')
    return profile
  }

  function toCredential(
    auth: NetworkSourceProfileInput['auth']
  ): NetworkSourceProfile['credential'] {
    if (auth.kind === 'anonymous') return { kind: 'anonymous', encryptedId: '' }
    if (auth.kind === 'password')
      return { kind: 'password', encryptedId: codec.encrypt(auth.password) }
    return {
      kind: 'privateKey',
      encryptedId: auth.passphrase ? codec.encrypt(auth.passphrase) : ''
    }
  }

  return {
    async listProfiles(): Promise<NetworkSourceProfileSummary[]> {
      return (await load()).map(redactProfile)
    },
    async getProfile(id: string): Promise<NetworkSourceProfile> {
      return findProfile(id)
    },
    async createProfile(input: NetworkSourceProfileInput): Promise<NetworkSourceProfileSummary> {
      validateProfileInput(input)
      const profiles = await load()
      const profile: NetworkSourceProfile = {
        id: randomUUID(),
        protocol: input.protocol,
        name: normalizeName(input.name),
        host: normalizeHost(input.host),
        port: normalizePort(input.port),
        rootPath: normalizeRemotePath(input.rootPath),
        webdavScheme: normalizeWebDavScheme(input.protocol, input.host, input.webdavScheme),
        username: normalizeUsername(input.username),
        keyPath:
          input.auth.kind === 'privateKey' ? input.auth.keyPath.trim() : input.keyPath?.trim(),
        credential: toCredential(input.auth),
        options: {
          readOnly: input.readOnly !== false,
          connectTimeoutMs: 10_000,
          transferTimeoutMs: 60_000,
          maxConcurrentTransfers: 2
        },
        bookmarks: normalizeBookmarks(input.bookmarks),
        createdAt: Date.now(),
        lastConnectedAt: null
      }
      profiles.push(profile)
      await save(profiles)
      return redactProfile(profile)
    },
    async updateProfile(
      id: string,
      patch: Partial<NetworkSourceProfileInput>
    ): Promise<NetworkSourceProfileSummary> {
      const profiles = await load()
      const index = profiles.findIndex((item) => item.id === id)
      if (index < 0) throw new NetworkSourceFailure('notFound', '网络源不存在')
      const profile = profiles[index]
      const merged: NetworkSourceProfileInput = {
        protocol: patch.protocol ?? profile.protocol,
        name: patch.name ?? profile.name,
        host: patch.host ?? profile.host,
        port: patch.port ?? profile.port,
        rootPath: patch.rootPath ?? profile.rootPath,
        webdavScheme: patch.webdavScheme ?? profile.webdavScheme,
        username: patch.username === undefined ? profile.username : patch.username,
        keyPath: patch.keyPath ?? profile.keyPath,
        auth:
          patch.auth ??
          (profile.credential.kind === 'anonymous'
            ? { kind: 'anonymous' }
            : profile.credential.kind === 'privateKey'
              ? { kind: 'privateKey', keyPath: profile.keyPath ?? '' }
              : { kind: 'password', password: '' }),
        readOnly: patch.readOnly ?? profile.options.readOnly,
        bookmarks: patch.bookmarks ?? profile.bookmarks
      }
      validateProfileInput(merged)
      const updated: NetworkSourceProfile = {
        ...profile,
        protocol: merged.protocol,
        name: normalizeName(merged.name),
        host: normalizeHost(merged.host),
        port: normalizePort(merged.port),
        rootPath: normalizeRemotePath(merged.rootPath),
        webdavScheme: normalizeWebDavScheme(merged.protocol, merged.host, merged.webdavScheme),
        username: normalizeUsername(merged.username),
        keyPath:
          merged.auth.kind === 'privateKey' ? merged.auth.keyPath.trim() : merged.keyPath?.trim(),
        credential: patch.auth ? toCredential(merged.auth) : profile.credential,
        options: { ...profile.options, readOnly: merged.readOnly !== false },
        bookmarks: normalizeBookmarks(merged.bookmarks)
      }
      profiles[index] = updated
      await save(profiles)
      return redactProfile(updated)
    },
    async deleteProfile(id: string): Promise<void> {
      const profiles = await load()
      const next = profiles.filter((item) => item.id !== id)
      if (next.length === profiles.length)
        throw new NetworkSourceFailure('notFound', '网络源不存在')
      await save(next)
    },
    async resolveAuth(id: string): Promise<NetworkAuth> {
      const profile = await findProfile(id)
      if (profile.credential.kind === 'anonymous') return { kind: 'anonymous' }
      if (profile.credential.kind === 'privateKey') {
        return {
          kind: 'privateKey',
          username: profile.username,
          keyPath: profile.keyPath ?? '',
          passphrase: profile.credential.encryptedId
            ? codec.decrypt(profile.credential.encryptedId)
            : undefined
        }
      }
      return {
        kind: 'password',
        username: profile.username,
        password: codec.decrypt(profile.credential.encryptedId)
      }
    }
  }
}
