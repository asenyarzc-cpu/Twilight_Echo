const path = require('node:path')

const PLUGIN_TYPES = new Set(['provider', 'tool', 'ui', 'theme', 'dsp'])
const PLUGIN_PERMISSIONS = new Set([
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
])

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const TWILIGHT_PLUGIN_API_VERSION = 3

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(source, key) {
  const value = source[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`plugin.json missing required string field: ${key}`)
  }
  return value.trim()
}

function normalizeRelativePath(value, key) {
  if (value == null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`plugin.json field ${key} must be a relative path string`)
  }
  const source = value.trim()
  if (source.includes('\0')) throw new Error(`plugin.json field ${key} contains a null byte`)
  const slashPath = source.replace(/\\/g, '/')
  if (
    path.posix.isAbsolute(slashPath) ||
    path.win32.isAbsolute(source) ||
    path.win32.isAbsolute(slashPath) ||
    /^[A-Za-z]:/.test(source)
  ) {
    throw new Error(`plugin.json field ${key} cannot point outside the plugin root`)
  }
  const normalized = path.posix.normalize(slashPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`plugin.json field ${key} cannot point outside the plugin root`)
  }
  if (normalized === '.' || normalized.endsWith('/')) {
    throw new Error(`plugin.json field ${key} must point to a file inside the plugin root`)
  }
  return normalized
}

function hasDeclarativeThemeContribution(raw, type) {
  if (!type.includes('theme')) return false
  if (!isRecord(raw.contributes)) return false
  return Array.isArray(raw.contributes.themes) && raw.contributes.themes.length > 0
}

function validateThemeContributions(raw, type, apiVersion) {
  if (!type.includes('theme')) return
  if (!isRecord(raw.contributes) || !Array.isArray(raw.contributes.themes)) return
  for (const contribution of raw.contributes.themes) {
    if (!isRecord(contribution)) throw new Error('theme contribution must be an object')
    requireString(contribution, 'id')
    requireString(contribution, 'name')
    const hasVariables = isRecord(contribution.variables)
    if (contribution.variables != null && !hasVariables) {
      throw new Error('theme contribution variables must be an object')
    }
    const hasStylesheet =
      typeof contribution.stylesheet === 'string' && contribution.stylesheet.trim()
    if (contribution.stylesheet != null) {
      normalizeRelativePath(contribution.stylesheet, 'contributes.themes.stylesheet')
    }
    const structured = contribution.structured
    let hasStructured = false
    if (structured != null) {
      if (!isRecord(structured)) throw new Error('theme contribution structured must be an object')
      if (
        structured.schemaVersion !== 1 &&
        structured.schemaVersion !== 2 &&
        structured.schemaVersion !== 3
      ) {
        throw new Error('theme contribution structured schemaVersion must be 1, 2, or 3')
      }
      if (structured.schemaVersion === 2 && apiVersion < 2) {
        throw new Error('structured schemaVersion 2 requires plugin apiVersion 2')
      }
      if (structured.schemaVersion === 3 && apiVersion < 3) {
        throw new Error('structured schemaVersion 3 requires plugin apiVersion 3')
      }
      if (structured.variants != null && !isRecord(structured.variants)) {
        throw new Error('theme contribution structured variants must be an object')
      }
      if (structured.modes != null) {
        if (structured.schemaVersion !== 2 && structured.schemaVersion !== 3) {
          throw new Error('theme contribution modes require structured schemaVersion 2 or 3')
        }
        if (!isRecord(structured.modes)) {
          throw new Error('theme contribution modes must be an object')
        }
      }
      if (structured.layout != null) {
        if (structured.schemaVersion !== 3) {
          throw new Error('theme contribution layout requires structured schemaVersion 3')
        }
        if (!isRecord(structured.layout)) {
          throw new Error('theme contribution layout must be an object')
        }
      }
      if (structured.windowDefaults != null && !isRecord(structured.windowDefaults)) {
        throw new Error('theme contribution windowDefaults must be an object')
      }
      hasStructured = true
    }
    if (!hasVariables && !hasStylesheet && !hasStructured) {
      throw new Error('theme contribution must declare variables, stylesheet, or structured')
    }
  }
}

function isSupportedSemverRange(range) {
  if (range === '*') return true
  if (SEMVER_PATTERN.test(range)) return true
  if (range.startsWith('^') || range.startsWith('~'))
    return SEMVER_PATTERN.test(range.slice(1).trim())
  if (range.startsWith('>=')) return SEMVER_PATTERN.test(range.slice(2).trim())
  return false
}

function validatePluginManifest(raw) {
  if (!isRecord(raw)) throw new Error('plugin.json must be an object')

  const id = requireString(raw, 'id')
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error('plugin.json id must be reverse-domain style, for example com.example.plugin')
  }

  const version = requireString(raw, 'version')
  if (!SEMVER_PATTERN.test(version))
    throw new Error('plugin.json version must follow semver, for example 1.0.0')

  if (
    !isRecord(raw.engines) ||
    typeof raw.engines.twilightEcho !== 'string' ||
    !raw.engines.twilightEcho.trim()
  ) {
    throw new Error('plugin.json missing engines.twilightEcho')
  }

  if (!Number.isInteger(raw.apiVersion) || raw.apiVersion < 1) {
    throw new Error('plugin.json apiVersion must be a positive integer')
  }
  if (raw.apiVersion > TWILIGHT_PLUGIN_API_VERSION) {
    throw new Error(
      `plugin.json apiVersion exceeds supported version ${TWILIGHT_PLUGIN_API_VERSION}`
    )
  }

  const type = raw.type
  if (!Array.isArray(type) || type.length === 0)
    throw new Error('plugin.json type must be a non-empty array')
  for (const item of type) {
    if (typeof item !== 'string' || !PLUGIN_TYPES.has(item))
      throw new Error(`plugin.json contains unknown type: ${String(item)}`)
  }
  validateThemeContributions(raw, type, raw.apiVersion)

  const main = normalizeRelativePath(raw.main, 'main')
  const rawBinary = raw.binary
  if (rawBinary != null && !isRecord(rawBinary))
    throw new Error('plugin.json binary must be an object')
  let binary
  if (rawBinary) {
    const normalizedBinary = {}
    for (const [platform, binaryPath] of Object.entries(rawBinary)) {
      const normalized = normalizeRelativePath(binaryPath, `binary.${platform}`)
      if (normalized) normalizedBinary[platform] = normalized
    }
    binary = Object.keys(normalizedBinary).length > 0 ? normalizedBinary : undefined
  }
  if (!main && !binary && !hasDeclarativeThemeContribution(raw, type)) {
    throw new Error(
      'plugin.json must declare main or binary, or contributes.themes for theme plugins'
    )
  }
  if (type.includes('dsp') && !binary) throw new Error('plugin.json type dsp requires binary')

  if (!Array.isArray(raw.permissions)) throw new Error('plugin.json permissions must be an array')
  for (const permission of raw.permissions) {
    if (typeof permission !== 'string' || !PLUGIN_PERMISSIONS.has(permission)) {
      throw new Error(`plugin.json contains unknown permission: ${String(permission)}`)
    }
  }
  if (type.includes('dsp') && !raw.permissions.includes('dsp:native')) {
    throw new Error('plugin.json type dsp requires dsp:native permission')
  }

  if (raw.dependencies != null) {
    if (!isRecord(raw.dependencies)) throw new Error('plugin.json dependencies must be an object')
    for (const [dependencyId, range] of Object.entries(raw.dependencies)) {
      if (!PLUGIN_ID_PATTERN.test(dependencyId))
        throw new Error(`plugin.json dependency id is invalid: ${dependencyId}`)
      if (typeof range !== 'string' || !isSupportedSemverRange(range.trim())) {
        throw new Error(`plugin.json dependency range is invalid: ${dependencyId}`)
      }
    }
  }

  return {
    id,
    name: requireString(raw, 'name'),
    version,
    description: requireString(raw, 'description'),
    author: requireString(raw, 'author'),
    license: requireString(raw, 'license'),
    type: [...new Set(type)],
    main,
    binary,
    dependencies: raw.dependencies,
    engines: { twilightEcho: raw.engines.twilightEcho.trim() },
    apiVersion: raw.apiVersion,
    permissions: [...new Set(raw.permissions)],
    contributes: raw.contributes,
    icon: normalizeRelativePath(raw.icon, 'icon')
  }
}

module.exports = { validatePluginManifest }
