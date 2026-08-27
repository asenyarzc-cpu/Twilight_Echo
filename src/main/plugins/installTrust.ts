import { createHash } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { assertPluginPackageFileSize } from './packageSecurity.ts'
import type {
  TwilightPluginInstallEvidence,
  TwilightPluginManifest,
  TwilightPluginSignatureStatus,
  TwilightPluginVerificationLevel
} from './types.ts'

const signatureStatusLabels: Record<TwilightPluginSignatureStatus, string> = {
  missing: '缺失',
  malformed: '格式错误',
  unsupported: '算法或版本不支持',
  'unknown-key': '未知发布者密钥',
  'revoked-key': '发布者密钥已吊销',
  'key-not-yet-valid': '发布者密钥尚未生效',
  'key-expired': '发布者密钥已过期',
  'invalid-key': '发布者公钥无效',
  invalid: '签名无效',
  valid: '签名有效',
  'trust-store-error': '可信发布者注册表不可用'
}

const verificationLevelLabels: Record<TwilightPluginVerificationLevel, string> = {
  official: '官方验证链完整',
  'publisher-signed': '发布者签名有效（非官方验证）',
  'index-declared': '仅索引声明',
  unverified: '未验证'
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

export async function stageFinalPluginPackage(
  sourcePath: string,
  stagingRoot: string,
  evidence: TwilightPluginInstallEvidence
): Promise<{ packagePath: string; evidence: TwilightPluginInstallEvidence }> {
  await assertPluginPackageFileSize(sourcePath)
  const packageBytes = await readFile(sourcePath)
  const sourcePackageSha256 = createHash('sha256').update(packageBytes).digest('hex')
  const sourceBoundEvidence = bindFinalPluginPackageEvidence(evidence, sourcePackageSha256)
  const packagePath = join(stagingRoot, 'candidate.tep')
  await writeFile(packagePath, packageBytes)
  await assertPluginPackageFileSize(packagePath)
  const stagedPackageSha256 = createHash('sha256')
    .update(await readFile(packagePath))
    .digest('hex')
  return {
    packagePath,
    evidence: bindFinalPluginPackageEvidence(sourceBoundEvidence, stagedPackageSha256)
  }
}

export async function runFinalPluginPackageTrustBoundary<T>(options: {
  sourcePath: string
  stagingRoot: string
  evidence: TwilightPluginInstallEvidence
  inspectStagedPackage: (packagePath: string) => Promise<T>
  requestConfirmation: (inspected: T, evidence: TwilightPluginInstallEvidence) => Promise<boolean>
  now?: () => Date
}): Promise<{ inspected: T; evidence: TwilightPluginInstallEvidence }> {
  const staged = await stageFinalPluginPackage(
    options.sourcePath,
    options.stagingRoot,
    options.evidence
  )
  const inspected = await options.inspectStagedPackage(staged.packagePath)
  const evidence = { ...staged.evidence, manifestVerified: true }
  await confirmPluginInstallWithFreshEvidence(
    evidence,
    () => options.requestConfirmation(inspected, evidence),
    options.now
  )
  return { inspected, evidence }
}

export async function confirmPluginInstallWithFreshEvidence(
  evidence: TwilightPluginInstallEvidence,
  requestConfirmation: () => Promise<boolean>,
  now: () => Date = () => new Date()
): Promise<void> {
  assertPluginInstallEvidenceFresh(evidence, now(), '打开安装确认前')
  if (!(await requestConfirmation())) throw new Error('已取消插件安装')
  assertPluginInstallEvidenceFresh(evidence, now(), '确认安装后')
}

export function assertPluginInstallEvidenceFresh(
  evidence: TwilightPluginInstallEvidence,
  now: Date,
  phase = '安装前'
): void {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error('插件信任证据校验时钟无效')
  if (
    evidence.verification?.official &&
    (evidence.loadedFrom !== 'remote' ||
      evidence.stale ||
      evidence.expired ||
      !evidence.originVerified ||
      !evidence.expiresAt)
  ) {
    throw new Error('插件官方验证证据状态不一致，请重新下载并验证后再安装')
  }
  if (evidence.loadedFrom === 'local') return
  const deadline = pluginInstallEvidenceRevalidationDeadline(evidence)
  if (deadline !== null && nowMs >= deadline) {
    throw new Error(`插件信任证据已过期（${phase}），请重新下载并验证后再安装`)
  }
}

export function pluginInstallEvidenceRevalidationDeadline(
  evidence: TwilightPluginInstallEvidence
): number | null {
  if (evidence.loadedFrom === 'local') return null
  const deadlines: number[] = []
  if (!evidence.expired && evidence.expiresAt) {
    deadlines.push(parseEvidenceDeadline(evidence.expiresAt, '索引 expiresAt'))
  }
  if (evidence.verification?.revalidateAt) {
    deadlines.push(parseEvidenceDeadline(evidence.verification.revalidateAt, '发布者密钥重验时间'))
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null
}

export function bindFinalPluginPackageEvidence(
  evidence: TwilightPluginInstallEvidence,
  actualPackageSha256: string | null
): TwilightPluginInstallEvidence {
  const expected = normalizeSha256(evidence.expectedPackageSha256, '索引期望 SHA-256')
  const actual = normalizeSha256(actualPackageSha256, '实际包 SHA-256')
  if (evidence.loadedFrom !== 'local' && !expected) {
    throw new Error('索引安装证据缺少期望 SHA-256')
  }
  if (expected && !actual) {
    throw new Error('索引安装证据要求 .tep 包 SHA-256，但当前来源不是包文件')
  }
  if (expected && actual !== expected) {
    throw new Error(`插件包 SHA-256 在下载后发生变化：expected ${expected}, actual ${actual}`)
  }
  return {
    ...evidence,
    expectedPackageSha256: expected,
    packageSha256: actual,
    checksumVerified: expected !== null && actual === expected
  }
}

export function buildPluginInstallConfirmationDetail(
  manifest: TwilightPluginManifest,
  evidence: TwilightPluginInstallEvidence
): string {
  const verification = evidence.verification
  const revalidationDeadline = pluginInstallEvidenceRevalidationDeadline(evidence)
  const indexState =
    evidence.loadedFrom === 'local'
      ? '不适用（本地安装）'
      : [
          evidence.stale ? 'stale/回退' : 'fresh',
          evidence.expired ? '已过期' : '未过期',
          evidence.originVerified ? '来源已绑定' : '来源未验证'
        ].join('，')

  return [
    `来源：${evidence.sourceLabel}`,
    `索引来源：${evidence.indexSourceUrl ?? '不适用（本地安装）'}`,
    `配置索引：${evidence.configuredIndexUrl ?? '不适用（本地安装）'}`,
    `索引载入方式：${loadedFromLabel(evidence.loadedFrom)}`,
    `索引获取时间：${evidence.fetchedAt ?? '无持久化记录'}`,
    `索引过期时间：${evidence.expiresAt ?? '无持久化记录'}`,
    `索引状态：${indexState}`,
    `缓存格式：${cacheFormatLabel(evidence.cacheFormat)}`,
    `索引期望 SHA-256：${evidence.expectedPackageSha256 ?? '未提供'}`,
    `实际包 SHA-256：${evidence.packageSha256 ?? '不适用（目录安装）'}`,
    `SHA-256 校验：${evidence.checksumVerified ? '已与索引声明匹配' : '未提供独立期望值'}`,
    `包内 manifest：${evidence.manifestVerified ? '已校验' : '未校验'}`,
    `信任级别：${verification ? verificationLevelLabels[verification.level] : '本地来源，未验证'}`,
    `发布者签名：${
      verification ? signatureStatusLabels[verification.signatureStatus] : '不适用（本地安装）'
    }`,
    `签名发布者：${verification?.publisher ?? '无'}`,
    `签名密钥 ID：${verification?.keyId ?? '无'}`,
    `签名公钥 SHA-256 指纹：${verification?.keyFingerprintSha256 ?? '无'}`,
    `信任重验截止：${
      revalidationDeadline === null ? '无计划边界' : new Date(revalidationDeadline).toISOString()
    }`,
    ...(verification ? [`验证说明：${verification.reason}`] : []),
    `作者：${manifest.author}`,
    `权限：${manifest.permissions.join(', ') || '无'}`,
    '',
    '代码执行风险：插件可执行任意代码，并拥有与 Twilight Echo 应用相同的操作权限；签名和哈希只能验证来源与完整性，不能证明代码安全。'
  ].join('\n')
}

function loadedFromLabel(value: TwilightPluginInstallEvidence['loadedFrom']): string {
  if (value === 'remote') return '远程直连'
  if (value === 'cache') return '缓存回退'
  if (value === 'bundled') return '随应用分发的离线快照'
  return '本地文件或目录'
}

function cacheFormatLabel(value: TwilightPluginInstallEvidence['cacheFormat']): string {
  if (value === 'envelope-v1') return 'envelope-v1（保留来源与有效期）'
  if (value === 'legacy') return 'legacy（无可信来源/有效期）'
  return '不适用'
}

function normalizeSha256(value: string | null, label: string): string | null {
  if (value === null) return null
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} 必须是 64 位十六进制 SHA-256`)
  return value.toLowerCase()
}

function parseEvidenceDeadline(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是有效时间`)
  return parsed
}
