export const OFFICIAL_PLUGIN_INDEX_URL =
  'https://raw.githubusercontent.com/asenyarzc-cpu/Twilight-Echo-plugins/main/plugins.json'

export interface PluginVerificationLike {
  level: 'official' | 'publisher-signed' | 'index-declared' | 'unverified'
  official: boolean
  officialSource: boolean
  indexClaimed: boolean
  signatureStatus: string
  keyId: string | null
  keyFingerprintSha256: string | null
  revalidateAt: string | null
  reason: string
}

export interface PluginIndexEntryTrustLike {
  verification: PluginVerificationLike
}

export interface PluginIndexStatusLike {
  sourceUrl: string
  configuredSourceUrl: string
  loadedFrom: 'remote' | 'cache' | 'bundled'
  lastFetchedAt: string | null
  expiresAt: string | null
  stale: boolean
  expired: boolean
  originVerified: boolean
  officialSource: boolean
  trustStoreError: string | null
}

export interface PluginTrustPresentation {
  label: '官方验证' | '发布者签名有效' | '索引声明' | '未验证'
  icon: string
  tone: 'official' | 'signed' | 'declared' | 'unverified'
  official: boolean
  detail: string
}

export function presentPluginTrust(
  entry: PluginIndexEntryTrustLike,
  status: PluginIndexStatusLike | null,
  now: number | Date = Date.now()
): PluginTrustPresentation {
  const verification = entry.verification
  const nowMs = now instanceof Date ? now.getTime() : now
  const signatureCurrentlyValid =
    verification.signatureStatus === 'valid' &&
    isBeforeOptionalDeadline(verification.revalidateAt, nowMs)
  const official = isFreshOfficialVerification(verification, status, nowMs, signatureCurrentlyValid)
  if (official) {
    return {
      label: '官方验证',
      icon: 'pi pi-verified',
      tone: 'official',
      official: true,
      detail: trustDetail(verification)
    }
  }
  if (signatureCurrentlyValid) {
    return {
      label: '发布者签名有效',
      icon: 'pi pi-shield',
      tone: 'signed',
      official: false,
      detail: trustDetail(verification)
    }
  }
  if (verification.indexClaimed || verification.level === 'index-declared') {
    return {
      label: '索引声明',
      icon: 'pi pi-info-circle',
      tone: 'declared',
      official: false,
      detail: trustDetail(verification)
    }
  }
  return {
    label: '未验证',
    icon: 'pi pi-exclamation-circle',
    tone: 'unverified',
    official: false,
    detail: trustDetail(verification)
  }
}

export function pluginIndexSourceLabel(status: PluginIndexStatusLike | null): string {
  if (!status) return '索引未加载'
  if (status.loadedFrom === 'bundled') return '随应用分发的离线发现快照'
  if (status.sourceUrl === OFFICIAL_PLUGIN_INDEX_URL) {
    if (status.loadedFrom === 'cache') {
      return status.originVerified ? '官方索引缓存（降级）' : '官方 URL 缓存（来源未验证）'
    }
    return status.originVerified ? '固定官方索引' : '官方 URL 响应（来源未验证）'
  }
  return status.loadedFrom === 'cache' ? '自定义索引缓存' : '自定义远程索引'
}

export function pluginIndexLoadedFromLabel(
  loadedFrom: PluginIndexStatusLike['loadedFrom'] | undefined
): string {
  if (loadedFrom === 'remote') return '远程直连'
  if (loadedFrom === 'cache') return '缓存回退'
  if (loadedFrom === 'bundled') return '离线快照'
  return '未知'
}

function isFreshOfficialVerification(
  verification: PluginVerificationLike,
  status: PluginIndexStatusLike | null,
  nowMs: number,
  signatureCurrentlyValid: boolean
): boolean {
  return Boolean(
    Number.isFinite(nowMs) &&
    status &&
    verification.level === 'official' &&
    verification.official &&
    verification.officialSource &&
    verification.indexClaimed &&
    signatureCurrentlyValid &&
    status.sourceUrl === OFFICIAL_PLUGIN_INDEX_URL &&
    status.configuredSourceUrl === OFFICIAL_PLUGIN_INDEX_URL &&
    status.loadedFrom === 'remote' &&
    status.lastFetchedAt &&
    status.expiresAt &&
    isBeforeRequiredDeadline(status.expiresAt, nowMs) &&
    !status.stale &&
    !status.expired &&
    status.originVerified &&
    status.officialSource &&
    !status.trustStoreError
  )
}

function isBeforeOptionalDeadline(value: string | null, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false
  if (!value) return true
  return isBeforeRequiredDeadline(value, nowMs)
}

function isBeforeRequiredDeadline(value: string, nowMs: number): boolean {
  const deadline = Date.parse(value)
  return Number.isFinite(deadline) && nowMs < deadline
}

function trustDetail(verification: PluginVerificationLike): string {
  return [
    verification.reason,
    `签名状态：${verification.signatureStatus}`,
    `密钥 ID：${verification.keyId ?? '无'}`,
    `公钥 SHA-256：${verification.keyFingerprintSha256 ?? '无'}`
  ].join('\n')
}
