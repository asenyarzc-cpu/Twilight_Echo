/**
 * 网络音乐源（Network Music Sources）共享类型。
 * 详见 docs/network-music-sources.md。
 */

export type NetworkProtocol = 'webdav' | 'ftp' | 'ftps' | 'sftp' | 'scp' | 'smb' | 'nfs' | 'dlna'

export type NetworkCredentialKind = 'anonymous' | 'password' | 'privateKey'

/** 凭据引用：明文只存在于主进程内存；落盘为 secureStorage 密文（encryptedId）。 */
export interface NetworkCredentialRef {
  kind: NetworkCredentialKind
  encryptedId: string
}

export interface NetworkSourceProfile {
  id: string
  protocol: NetworkProtocol
  name: string
  host: string
  port: number | null
  rootPath: string
  /** WebDAV transport selected from the entered URL; defaults to http. */
  webdavScheme?: 'http' | 'https'
  username?: string
  /** SFTP 密钥认证时的私钥文件路径（非敏感，明文存储）。 */
  keyPath?: string
  credential: NetworkCredentialRef
  options: {
    readOnly: boolean
    connectTimeoutMs: number
    transferTimeoutMs: number
    maxConcurrentTransfers: number
  }
  bookmarks: string[]
  createdAt: number
  lastConnectedAt: number | null
}

/** 创建/更新 profile 的输入（凭据为明文，仅 IPC 入参；落盘前加密）。 */
export interface NetworkSourceProfileInput {
  protocol: NetworkProtocol
  name: string
  host: string
  port?: number | null
  rootPath: string
  /** Optional WebDAV transport override. URL schemes are inferred when omitted. */
  webdavScheme?: 'http' | 'https'
  username?: string
  keyPath?: string
  auth:
    | { kind: 'anonymous' }
    | { kind: 'password'; password: string }
    | { kind: 'privateKey'; keyPath: string; passphrase?: string }
  readOnly?: boolean
  bookmarks?: string[]
}

/** 渲染层可见的 profile 摘要：绝不包含凭据密文与口令。 */
export interface NetworkSourceProfileSummary {
  id: string
  protocol: NetworkProtocol
  name: string
  host: string
  port: number | null
  rootPath: string
  webdavScheme?: 'http' | 'https'
  username?: string
  keyPath?: string
  credentialKind: NetworkCredentialKind
  options: NetworkSourceProfile['options']
  bookmarks: string[]
  createdAt: number
  lastConnectedAt: number | null
}

export interface NetworkEntry {
  id: string
  profileId: string
  name: string
  kind: 'directory' | 'file' | 'audio' | 'playlist'
  path: string
  sizeBytes?: number
  mtimeMs?: number
  mimeType?: string
  /** 解析后的标签元数据（仅媒体库条目，浏览列表为空）。 */
  metadata?: NetworkEntryMetadata
  /** 封面文件在 cover-cache 中的绝对路径（解析后可选）。 */
  coverPath?: string
}

export interface NetworkEntryMetadata {
  title?: string
  artist?: string
  album?: string
  duration?: number
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
}

export interface NetworkPlaybackPlan {
  kind: 'local-cache' | 'direct-url'
  url?: string
  cacheFilePath?: string
  displayName: string
}

export type NetworkSourceErrorCode =
  | 'auth'
  | 'timeout'
  | 'network'
  | 'notFound'
  | 'denied'
  | 'invalidProfile'
  | 'unsupportedProtocol'

export interface NetworkSourceError {
  code: NetworkSourceErrorCode
  message: string
}

export type NetworkSourceEvent =
  | { type: 'profiles-changed' }
  | {
      type: 'connection-state'
      profileId: string
      state: 'connecting' | 'connected' | 'failed'
      error?: NetworkSourceError
    }
