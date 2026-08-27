export interface ProviderHealthInput {
  available: boolean
  pluginStatus: string
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  methodStats?: Record<string, ProviderMethodHealthInput | undefined>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface ProviderMethodHealthInput {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

export interface ProviderHealthPresentation {
  state: 'ok' | 'warning' | 'error'
  reason: ProviderHealthReason
  label: string
  detail: string
}

export type ProviderHealthReason =
  | 'missing-diagnostics'
  | 'plugin-disabled'
  | 'plugin-invalid'
  | 'plugin-failed'
  | 'login-expired'
  | 'network-or-api-failed'
  | 'not-logged-in'
  | 'playback-url-degraded'
  | 'api-degraded'
  | 'ok'

export function buildProviderHealthPresentation({
  health,
  loggedIn
}: {
  health?: ProviderHealthInput
  loggedIn: boolean
}): ProviderHealthPresentation {
  if (!health) {
    return {
      state: 'warning',
      reason: 'missing-diagnostics',
      label: '未收到健康状态',
      detail: '等待宿主回传登录、API 和播放 URL 诊断'
    }
  }

  const reason = providerHealthReason(health, loggedIn)
  const state = providerHealthState(reason)
  const label = providerHealthLabel(reason)
  const playbackUrlHealth = health.methodStats?.getPlaybackUrl
  const detail = [
    `登录状态 ${loggedIn ? '已登录' : '未登录'}`,
    `成功率 ${formatProviderSuccessRate(health.successRate)}`,
    playbackUrlHealth
      ? `播放 URL 成功率 ${formatProviderSuccessRate(playbackUrlHealth.successRate)}`
      : '',
    `插件状态 ${health.pluginStatus}`,
    `调用 ${health.successfulCalls}/${health.totalCalls}`,
    playbackUrlHealth
      ? `播放 URL 调用 ${playbackUrlHealth.successfulCalls}/${playbackUrlHealth.totalCalls}`
      : '',
    health.lastError ? `最近错误 ${health.lastError}` : '',
    playbackUrlHealth?.lastError ? `播放 URL 最近错误 ${playbackUrlHealth.lastError}` : '',
    health.lastCheckedAt ? `最后检查 ${formatProviderCheckedAt(health.lastCheckedAt)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return { state, reason, label, detail }
}

function providerHealthReason(
  health: ProviderHealthInput,
  loggedIn: boolean
): ProviderHealthReason {
  if (health.pluginStatus === 'disabled') return 'plugin-disabled'
  if (health.pluginStatus === 'invalid') return 'plugin-invalid'
  if (health.pluginStatus !== 'enabled') return 'plugin-failed'
  if (!loggedIn && isLoginError(health.lastError)) return 'login-expired'
  if (!health.available) return 'network-or-api-failed'
  if (!loggedIn) return 'not-logged-in'
  const playbackUrlHealth = health.methodStats?.getPlaybackUrl
  if (
    playbackUrlHealth &&
    (playbackUrlHealth.failedCalls > 0 || playbackUrlHealth.successRate < 0.95)
  ) {
    return 'playback-url-degraded'
  }
  if (health.failedCalls > 0 || health.successRate < 0.95) {
    return 'api-degraded'
  }
  return 'ok'
}

function providerHealthState(reason: ProviderHealthReason): ProviderHealthPresentation['state'] {
  if (
    reason === 'plugin-disabled' ||
    reason === 'plugin-invalid' ||
    reason === 'plugin-failed' ||
    reason === 'login-expired' ||
    reason === 'network-or-api-failed'
  ) {
    return 'error'
  }
  if (
    reason === 'missing-diagnostics' ||
    reason === 'not-logged-in' ||
    reason === 'playback-url-degraded' ||
    reason === 'api-degraded'
  ) {
    return 'warning'
  }
  return 'ok'
}

function providerHealthLabel(reason: ProviderHealthReason): string {
  switch (reason) {
    case 'missing-diagnostics':
      return '未收到健康状态'
    case 'plugin-disabled':
      return '音源已停用'
    case 'plugin-invalid':
      return '插件无效'
    case 'plugin-failed':
      return '插件运行失败'
    case 'login-expired':
      return '登录已失效'
    case 'network-or-api-failed':
      return '网络或 API 不可用'
    case 'not-logged-in':
      return '未登录'
    case 'playback-url-degraded':
      return '播放 URL 不稳定'
    case 'api-degraded':
      return '部分请求失败'
    case 'ok':
      return '音源可用'
  }
}

function isLoginError(value: string | null): boolean {
  return !!value && /login|登录|cookie|unauthori[sz]ed|auth|账号|过期/i.test(value)
}

function formatProviderSuccessRate(value: number): string {
  if (!Number.isFinite(value)) return '未知'
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function formatProviderCheckedAt(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Date(time).toLocaleString()
}
