import {
  STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION,
  STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION,
  findInvalidThemeShellLayoutFields,
  findUnsupportedThemeModeIds,
  normalizeStructuredPluginTheme
} from '../../shared/theme.ts'
import type {
  TwilightPluginPermission,
  TwilightPluginType,
  TwilightThemeContribution,
  TwilightUiContribution
} from './types.ts'

interface NormalizeThemeContributionOptions {
  pluginApiVersion: number
  pluginTypes: readonly TwilightPluginType[]
  raw: unknown
  source: string
  resolveStylesheet: (stylesheet: string) => string
}

export function normalizeThemeContribution(
  options: NormalizeThemeContributionOptions
): TwilightThemeContribution {
  if (!options.pluginTypes.includes('theme')) {
    throw new Error('只有 theme 类型插件可以注册主题')
  }
  if (!isRecord(options.raw)) throw new Error(`${options.source} 注册信息必须是对象`)
  const record = options.raw
  const id = normalizeContributionId(record.id)
  const name = normalizeText(record.name, '主题名称必填')
  const variables = isRecord(record.variables) ? normalizeCssVariables(record.variables) : undefined
  const stylesheet =
    typeof record.stylesheet === 'string' && record.stylesheet.trim()
      ? options.resolveStylesheet(record.stylesheet.trim())
      : undefined
  const structuredRecord = isRecord(record.structured) ? record.structured : undefined
  if (
    structuredRecord?.schemaVersion === STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION &&
    options.pluginApiVersion < 2
  ) {
    throw new Error('structured schemaVersion 2 需要 plugin.json apiVersion 2')
  }
  if (
    structuredRecord?.schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION &&
    options.pluginApiVersion < STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION
  ) {
    throw new Error('structured schemaVersion 3 requires plugin.json apiVersion 3')
  }
  const structured = normalizeStructuredPluginTheme(record.structured)
  const compatibilityNotes = collectCompatibilityNotes(structuredRecord)
  if (!variables && !stylesheet && !structured) {
    throw new Error('主题必须声明 variables、stylesheet 或 structured')
  }
  return {
    id,
    name,
    description: typeof record.description === 'string' ? record.description.trim() : undefined,
    variables,
    stylesheet,
    structured,
    ...(compatibilityNotes.length > 0 ? { compatibilityNotes } : {})
  }
}

function collectCompatibilityNotes(structured: Record<string, unknown> | undefined): string[] {
  if (!structured) return []
  if (structured.schemaVersion === 1) {
    return isRecord(structured.modes)
      ? ['structured schemaVersion 1 不支持 modes，已忽略该字段']
      : []
  }
  if (
    structured.schemaVersion !== STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION &&
    structured.schemaVersion !== STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION
  ) {
    return [`不支持 structured schemaVersion ${String(structured.schemaVersion)}，已忽略`]
  }
  const modeNotes = findUnsupportedThemeModeIds(structured.modes).map(
    (id) => `主题 mode ${id} 不受当前宿主支持，已忽略`
  )
  const layoutNotes =
    structured.schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION &&
    structured.layout !== undefined
      ? findInvalidThemeShellLayoutFields(structured.layout).map(
          (field) => `Theme layout ${field} is not supported by this host and was ignored`
        )
      : []
  return [...modeNotes, ...layoutNotes]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeContributionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || !/^[a-z][a-z0-9-_.]*$/.test(id)) {
    throw new Error('扩展 id 必须是小写标识符')
  }
  return id
}

export function normalizeText(value: unknown, message: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(message)
  return text.slice(0, 120)
}

export function normalizeUiContribution(
  pluginTypes: readonly TwilightPluginType[],
  permissions: readonly TwilightPluginPermission[],
  raw: unknown
): TwilightUiContribution {
  if (!pluginTypes.includes('ui') && !pluginTypes.includes('tool')) {
    throw new Error('只有 ui 或 tool 类型插件可以注册 UI 扩展点')
  }
  if (!permissions.includes('ui:inject')) {
    throw new Error('UI 扩展插件必须声明 ui:inject 权限')
  }
  if (!raw || typeof raw !== 'object') throw new Error('UI 扩展注册信息必须是对象')
  const record = raw as Record<string, unknown>
  const id = normalizeContributionId(record.id)
  const kind = typeof record.kind === 'string' ? record.kind : ''
  if (
    ![
      'sidebarPage',
      'playerBarButton',
      'settingsPanel',
      'localSidebarItem',
      'streamingHome'
    ].includes(kind)
  ) {
    throw new Error('未知 UI 扩展点')
  }
  const title = normalizeText(record.title, 'UI 扩展标题必填')
  const command = typeof record.command === 'string' ? record.command.trim() : undefined
  if (
    (kind === 'playerBarButton' || kind === 'sidebarPage' || kind === 'localSidebarItem') &&
    !command
  ) {
    throw new Error(`${kind} 扩展必须声明 command`)
  }
  // Legacy renderMode values are accepted as input for API v1 compatibility, but the
  // normalized renderer contract is command-only. Plugin-provided HTML is never executed.
  const renderMode = 'command'
  const autoLoad = typeof record.autoLoad === 'boolean' ? record.autoLoad : false
  return {
    id,
    kind: kind as TwilightUiContribution['kind'],
    title,
    description: typeof record.description === 'string' ? record.description.trim() : undefined,
    icon: typeof record.icon === 'string' ? record.icon.trim() : undefined,
    command,
    renderMode,
    autoLoad
  }
}

function normalizeCssVariables(raw: Record<string, unknown>): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^--te-[a-z0-9-_]+$/.test(key)) continue
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (!normalized || /url\s*\(|@import|expression\s*\(/i.test(normalized)) continue
    variables[key] = normalized.slice(0, 240)
  }
  return variables
}
