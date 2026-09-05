import { app, shell } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join, normalize } from 'path'

export const WINDOWS_APP_USER_MODEL_ID = 'com.TwilightEcho.music'
export const WINDOWS_APP_DISPLAY_NAME = 'TwilightEcho'

export interface WindowsShellIdentityResult {
  ok: boolean
  shortcutPath: string | null
  createdOrUpdated: boolean
  error: string | null
}

function normalizeWindowsPath(value: string): string {
  return normalize(value).toLowerCase()
}

function samePath(left: string | undefined, right: string): boolean {
  return Boolean(left) && normalizeWindowsPath(left as string) === normalizeWindowsPath(right)
}

function quoteShortcutArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

export function buildWindowsIdentityShortcutDetails(options: {
  appPath: string
  execPath: string
  packaged: boolean
  iconPath?: string
}): Electron.ShortcutDetails {
  return {
    target: options.execPath,
    cwd: options.packaged ? dirname(options.execPath) : options.appPath,
    args: options.packaged ? '' : quoteShortcutArgument(options.appPath),
    description: 'Twilight Echo music player',
    icon: options.iconPath || options.execPath,
    iconIndex: 0,
    appUserModelId: WINDOWS_APP_USER_MODEL_ID
  }
}

export function getWindowsIdentityShortcutPaths(appDataPath: string): {
  preferred: string
  developmentFallback: string
} {
  const programs = join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  return {
    preferred: join(programs, `${WINDOWS_APP_DISPLAY_NAME}.lnk`),
    // Never overwrite an unrelated/installed shortcut that happens to use the
    // preferred filename. Keeping the fallback link filename as TwilightEcho
    // still gives the Shell the desired display name for this AUMID.
    developmentFallback: join(
      programs,
      'TwilightEcho Development',
      `${WINDOWS_APP_DISPLAY_NAME}.lnk`
    )
  }
}

/**
 * Register a Shell-visible identity for unpackaged/dev launches.
 *
 * electron-builder/NSIS already creates the production Start Menu shortcut.
 * Direct `electron.exe .` and win-unpacked launches do not have one, and the
 * Windows media UI cannot resolve the explicit AUMID to a display name without
 * a matching Shell identity. This helper is intentionally idempotent and will
 * not replace a valid production shortcut.
 */
export function ensureWindowsShellIdentity(): WindowsShellIdentityResult {
  if (process.platform !== 'win32') {
    return { ok: true, shortcutPath: null, createdOrUpdated: false, error: null }
  }

  try {
    const appPath = app.getAppPath()
    const paths = getWindowsIdentityShortcutPaths(app.getPath('appData'))
    const preferredExists = existsSync(paths.preferred)

    let shortcutPath = paths.preferred
    if (preferredExists) {
      try {
        const current = shell.readShortcutLink(paths.preferred)
        if (
          current.appUserModelId === WINDOWS_APP_USER_MODEL_ID &&
          samePath(current.target, process.execPath)
        ) {
          return {
            ok: true,
            shortcutPath: paths.preferred,
            createdOrUpdated: false,
            error: null
          }
        }
        if (
          current.appUserModelId === WINDOWS_APP_USER_MODEL_ID &&
          !samePath(current.target, process.execPath)
        ) {
          // An installed and a development copy may legitimately share the
          // same AUMID. Preserve the installed shortcut when a dev copy runs;
          // an installed copy may replace a stale dev registration for itself.
          shortcutPath = app.isPackaged ? paths.preferred : paths.developmentFallback
        }
        if (!samePath(current.target, process.execPath)) {
          shortcutPath = app.isPackaged ? shortcutPath : paths.developmentFallback
        }
      } catch {
        // If the preferred entry is unreadable, preserve it and create a
        // dedicated development registration instead of overwriting it.
        shortcutPath = paths.developmentFallback
      }
    }

    if (existsSync(shortcutPath)) {
      try {
        const current = shell.readShortcutLink(shortcutPath)
        if (
          current.appUserModelId === WINDOWS_APP_USER_MODEL_ID &&
          samePath(current.target, process.execPath)
        ) {
          return { ok: true, shortcutPath, createdOrUpdated: false, error: null }
        }
      } catch {
        // Replace our dedicated identity shortcut below.
      }
    }

    mkdirSync(dirname(shortcutPath), { recursive: true })
    const devIcon = join(appPath, 'build', 'icon.ico')
    const details = buildWindowsIdentityShortcutDetails({
      appPath,
      execPath: process.execPath,
      packaged: app.isPackaged,
      iconPath: existsSync(devIcon) ? devIcon : process.execPath
    })
    const operation = existsSync(shortcutPath) ? 'replace' : 'create'
    const written = shell.writeShortcutLink(shortcutPath, operation, details)
    return written
      ? { ok: true, shortcutPath, createdOrUpdated: true, error: null }
      : {
          ok: false,
          shortcutPath,
          createdOrUpdated: false,
          error: 'shell.writeShortcutLink returned false'
        }
  } catch (error) {
    return {
      ok: false,
      shortcutPath: null,
      createdOrUpdated: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
