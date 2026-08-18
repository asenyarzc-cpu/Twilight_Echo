import { posix, win32 } from 'path'
import {
  TWILIGHT_PLUGIN_API_VERSION,
  type TwilightPluginDescriptor,
  type TwilightPluginManifest,
  type TwilightPluginPermission,
  type TwilightPluginType
} from './types.ts'
const PLUGIN_TYPES = ['provider', 'tool', 'ui', 'theme', 'dsp'] as const
const PLUGIN_PERMISSIONS = [
  'network',
  'filesystem:read',
  'filesystem:write',
  'player:control',
  'player:observe',
  'library:read',
  'library:write',
  'settings',
  'clipboard',
  'ui:inject',
  'dsp:native'
] as const

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`plugin.json 缺少必填字符串字段：${key}`)
  }
  return value.trim()
}

function normalizeRelativePath(value: unknown, key: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`plugin.json 字段 ${key} 必须是相对路径字符串`)
  }
  const source = value.trim()
  if (source.includes('\0')) {
    throw new Error(`plugin.json 字段 ${key} 包含非法空字符`)
  }
  const slashPath = source.replace(/\\/g, '/')
  if (
    posix.isAbsolute(slashPath) ||
    win32.isAbsolute(source) ||
    win32.isAbsolute(slashPath) ||
    /^[A-Za-z]:/.test(source)
  ) {
    throw new Error(`plugin.json 字段 ${key} 不能指向插件目录外`)
  }
  const normalized = posix.normalize(slashPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`plugin.json 字段 ${key} 不能指向插件目录外`)
  }
  if (normalized === '.' || normalized.endsWith('/')) {
    throw new Error(`plugin.json 字段 ${key} 必须指向插件内文件`)
  }
  return normalized
}

function normalizeTypes(value: unknown): TwilightPluginType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('plugin.json 字段 type 必须是非空数组')
  }
  const types = value.map((item) => {
    if (typeof item !== 'string' || !PLUGIN_TYPES.includes(item as TwilightPluginType)) {
      throw new Error(`plugin.json 含有未知插件类型：${String(item)}`)
    }
    return item as TwilightPluginType
  })
  return [...new Set(types)]
}

function normalizePermissions(value: unknown): TwilightPluginPermission[] {
  if (!Array.isArray(value)) {
    throw new Error('plugin.json 字段 permissions 必须是数组')
  }
  const permissions = value.map((item) => {
    if (
      typeof item !== 'string' ||
      !PLUGIN_PERMISSIONS.includes(item as TwilightPluginPermission)
    ) {
      throw new Error(`plugin.json 含有未知权限声明：${String(item)}`)
    }
    return item as TwilightPluginPermission
  })
  return [...new Set(permissions)]
}

function normalizeBinary(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined
  if (!isRecord(value)) throw new Error('plugin.json 字段 binary 必须是对象')
  const binary: Record<string, string> = {}
  for (const [platform, path] of Object.entries(value)) {
    const normalized = normalizeRelativePath(path, `binary.${platform}`)
    if (normalized) binary[platform] = normalized
  }
  return Object.keys(binary).length > 0 ? binary : undefined
}

export function canonicalizePluginManifestPaths(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const canonical = { ...raw }
  setCanonicalPath(canonical, 'main', normalizeRelativePath(raw.main, 'main'))
  setCanonicalPath(canonical, 'icon', normalizeRelativePath(raw.icon, 'icon'))
  const binary = normalizeBinary(raw.binary)
  if (binary) canonical.binary = binary
  else delete canonical.binary
  return canonical
}

function setCanonicalPath(
  target: Record<string, unknown>,
  key: 'main' | 'icon',
  value: string | undefined
): void {
  if (value) target[key] = value
  else delete target[key]
}

function hasDeclarativeThemeContribution(
  raw: Record<string, unknown>,
  type: TwilightPluginType[]
): boolean {
  if (!type.includes('theme')) return false
  const contributes = raw.contributes
  if (!isRecord(contributes)) return false
  return Array.isArray(contributes.themes) && contributes.themes.length > 0
}

function validateThemeSchemaVersion(raw: Record<string, unknown>, apiVersion: number): void {
  if (!isRecord(raw.contributes) || !Array.isArray(raw.contributes.themes)) return
  for (const contribution of raw.contributes.themes) {
    if (!isRecord(contribution) || !isRecord(contribution.structured)) continue
    const schemaVersion = contribution.structured.schemaVersion
    if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
      throw new Error('theme contribution structured schemaVersion must be 1, 2, or 3')
    }
    if (schemaVersion === 2 && apiVersion < 2) {
      throw new Error('structured schemaVersion 2 需要 plugin.json apiVersion 2')
    }
    if (schemaVersion === 3 && apiVersion < 3) {
      throw new Error('structured schemaVersion 3 需要 plugin.json apiVersion 3')
    }
    if (contribution.structured.layout != null && schemaVersion !== 3) {
      throw new Error('theme contribution layout requires structured schemaVersion 3')
    }
    if (contribution.structured.layout != null && !isRecord(contribution.structured.layout)) {
      throw new Error('theme contribution layout must be an object')
    }
  }
}

function normalizeDependencies(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined
  if (!isRecord(value)) throw new Error('plugin.json 字段 dependencies 必须是对象')
  const dependencies: Record<string, string> = {}
  for (const [id, range] of Object.entries(value)) {
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new Error(`plugin.json dependencies 含有非法插件 ID：${id}`)
    }
    if (typeof range !== 'string' || !isSupportedSemverRange(range.trim())) {
      throw new Error(`plugin.json dependencies.${id} 必须是受支持的 semver range`)
    }
    dependencies[id] = range.trim()
  }
  return Object.keys(dependencies).length > 0 ? dependencies : undefined
}

export function validatePluginManifest(raw: unknown): TwilightPluginManifest {
  if (!isRecord(raw)) throw new Error('plugin.json 必须是 JSON 对象')

  const id = requireString(raw, 'id')
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error('plugin.json 字段 id 必须是反域名风格，例如 com.example.plugin')
  }

  const version = requireString(raw, 'version')
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('plugin.json 字段 version 必须遵循 semver，例如 1.0.0')
  }

  const engines = raw.engines
  if (!isRecord(engines) || typeof engines.twilightEcho !== 'string' || !engines.twilightEcho) {
    throw new Error('plugin.json 缺少 engines.twilightEcho 兼容范围')
  }

  const apiVersion = raw.apiVersion
  if (!Number.isInteger(apiVersion)) {
    throw new Error('plugin.json 字段 apiVersion 必须是正整数')
  }
  const normalizedApiVersion = apiVersion as number
  if (normalizedApiVersion < 1) {
    throw new Error('plugin.json 字段 apiVersion 必须是正整数')
  }
  if (normalizedApiVersion > TWILIGHT_PLUGIN_API_VERSION) {
    throw new Error(
      `插件 API 版本 ${normalizedApiVersion} 高于宿主支持版本 ${TWILIGHT_PLUGIN_API_VERSION}`
    )
  }
  validateThemeSchemaVersion(raw, normalizedApiVersion)

  const type = normalizeTypes(raw.type)
  const canonicalPaths = canonicalizePluginManifestPaths(raw)
  const main = canonicalPaths.main as string | undefined
  const binary = canonicalPaths.binary as Record<string, string> | undefined
  const dependencies = normalizeDependencies(raw.dependencies)
  if (type.length === 1 && type[0] === 'theme' && (main || binary)) {
    throw new Error('纯 theme 插件只能通过 contributes.themes 声明，不能包含 main 或 binary')
  }
  if (!main && !binary && !hasDeclarativeThemeContribution(raw, type)) {
    throw new Error('plugin.json 必须声明 main 或 binary，或为 theme 声明 contributes.themes')
  }
  if (type.includes('dsp') && !binary) throw new Error('type 包含 dsp 时必须声明 binary')
  const permissions = normalizePermissions(raw.permissions)
  if (type.includes('dsp') && !permissions.includes('dsp:native')) {
    throw new Error('type 包含 dsp 时必须声明 dsp:native 权限')
  }

  return {
    id,
    name: requireString(raw, 'name'),
    version,
    description: requireString(raw, 'description'),
    author: requireString(raw, 'author'),
    license: requireString(raw, 'license'),
    type,
    main,
    binary,
    dependencies,
    engines: {
      twilightEcho: engines.twilightEcho.trim()
    },
    apiVersion: normalizedApiVersion,
    permissions,
    contributes: raw.contributes,
    homepage: typeof raw.homepage === 'string' ? raw.homepage.trim() : undefined,
    repository: typeof raw.repository === 'string' ? raw.repository.trim() : undefined,
    icon: canonicalPaths.icon as string | undefined,
    signature: raw.signature
  }
}

export function toManifest(descriptor: TwilightPluginDescriptor): TwilightPluginManifest {
  return {
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    description: descriptor.description,
    author: descriptor.author,
    license: descriptor.license,
    type: descriptor.type,
    main: descriptor.main,
    binary: descriptor.binary,
    dependencies: descriptor.dependencies,
    engines: descriptor.engines,
    apiVersion: descriptor.apiVersion,
    permissions: descriptor.permissions,
    contributes: descriptor.contributes,
    homepage: descriptor.homepage,
    repository: descriptor.repository,
    icon: descriptor.icon,
    signature: descriptor.signature
  }
}

export function isCompatibleTwilightRange(range: string, appVersion: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === '') return true
  if (trimmed.startsWith('^')) return appVersion.split('.')[0] === trimmed.slice(1).split('.')[0]
  if (trimmed.startsWith('~')) {
    const [major, minor] = appVersion.split('.')
    const [requiredMajor, requiredMinor] = trimmed.slice(1).split('.')
    return major === requiredMajor && minor === requiredMinor
  }
  if (trimmed.startsWith('>=')) {
    return compareSemver(appVersion, trimmed.slice(2).trim()) >= 0
  }
  return trimmed === appVersion
}

export function isSupportedSemverRange(range: string): boolean {
  if (range === '*') return true
  if (SEMVER_PATTERN.test(range)) return true
  if (range.startsWith('^') || range.startsWith('~')) {
    return SEMVER_PATTERN.test(range.slice(1).trim())
  }
  if (range.startsWith('>=')) {
    return SEMVER_PATTERN.test(range.slice(2).trim())
  }
  return false
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}
