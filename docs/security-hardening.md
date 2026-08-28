# Twilight Echo Security Hardening

This document tracks app-side security controls that should stay in place as the
project grows.

## Sensitive Local Storage

- Plugin private settings automatically encrypt sensitive keys before writing
  `settings.json`.
- Plugin settings keys, per-value JSON size, and total settings file size are
  bounded before write so a plugin cannot accidentally create unbounded settings
  files through the host API.
- Sensitive keys are detected by name, including `cookie`, `csrf`, `token`,
  `refreshToken`, `secret`, `password`, `credential`, `session`, and `auth`.
- Existing plaintext sensitive plugin settings are migrated on the next read.
- The legacy `ncm-cookie.json` IPC path writes the same encrypted envelope and
  migrates older plaintext `{ "cookie": "..." }` files on load.
- In Electron, encryption uses `safeStorage` when available. In non-Electron
  test or fallback environments, values use AES-256-GCM with a local
  machine/user-derived key so secrets are not stored as plain JSON.

## Electron Surface

- The main window and desktop lyrics window use `contextIsolation`,
  `nodeIntegration: false`, `sandbox`, `webSecurity`, and
  `allowRunningInsecureContent: false`.
- The preload exposes only `window.api`; it does not expose the generic
  `window.electron.ipcRenderer` bridge.
- The desktop lyrics document receives only the satellite subset of
  `window.api.desktopLyrics`; the main document receives only the publisher subset.
  Main-process handlers verify the exact sending `webContents`, validate structured
  session/clock payloads, and cap each normalized lyrics session at 1 MiB.
- Main-frame navigation is limited to the app renderer. External URLs are opened
  through the OS browser only for `http` and `https`.
- The NetEase official login window allows in-window navigation only on
  `music.163.com` and rejects non-web external protocols.
- The renderer no longer loads Google Fonts or Unpkg scripts from the app HTML.
  Fonts/icons are bundled local assets.
- `installElectronSecurity()` applies a document CSP through response headers,
  strips existing CSP headers before replacing them, adds `nosniff`,
  `no-referrer`, and a restrictive `Permissions-Policy`, and denies Chromium
  permission requests/checks by default.
- The shared renderer CSP disallows remote and inline scripts for the main and
  satellite windows, including desktop lyrics.

## IPC And Network Boundaries

- High-impact IPC handlers validate the sender URL before doing work. Desktop lyrics
  additionally separates host publication from satellite window controls by exact
  sender identity; untrusted `ipcMain.handle` callers are rejected, and untrusted
  fire-and-forget `ipcMain.on` callers are ignored without throwing in the main process.
- Renderer audio file reads are limited to paths accepted by
  `resolvePlayableAudioFile`.
- Renderer-controlled JSON persisted by `data:*` IPC has size limits before
  writing to disk.
- Shell IPC rejects URL-like paths for local open/show operations.
- Music scanning, audio file URL creation, lazy lyrics reads, and embedded lyric
  parsing normalize local paths before filesystem access.
- IPC numeric controls for audio playback clamp invalid, infinite, or out of
  range values before reaching the native audio engine.
- Plugin IPC validates plugin IDs, provider IDs, provider method names, UI
  commands, DSP parameter names/values, argument array lengths, and argument
  payload size before dispatching to the plugin manager or plugin host.
- The plugin API gateway enforces runtime permissions for player observation,
  player control, provider registration, library provider capabilities, UI
  injection, and private settings access. Provider IDs are single-owner, and
  built-in prefixes such as `ncm` and `local` cannot be taken over by third-party
  plugins.
- Plugin event subscriptions are restricted to supported event namespaces:
  `player:*` and compatibility `audioEngine:*` events require `player:observe`,
  `library:*` events require `library:read`, and public app lifecycle events are
  allowed without sensitive data payloads.
- Theme stylesheet reads compare registered real paths before reading from disk.
- NetEase API IPC accepts only bounded local API paths beginning with `/`, caps
  cookie size, validates song IDs, and caps cache URL/file-name inputs.
- Streaming audio cache downloads reject localhost, loopback, link-local, and
  private IPv4 literal hosts.
- Settings import/update, Discord activity, OPRA search/profile lookup,
  background image import, and BPM analysis IPC now enforce size/string/path
  limits before expensive parsing, disk reads, or native analysis.
- Background image imports reject files over 20 MiB before reading or writing
  them into the app data directory.
- Plugin logs redact common login secrets such as `MUSIC_U`, `__csrf`,
  `password`, `token`, `cookie`, `secret`, and `credential`.
- Plugin installation rejects symbolic links in package contents, and runtime
  plugin entry/theme/binary paths are checked against real paths to prevent
  link-based escapes from the plugin directory.
- Local `.tep` installs and index-downloaded `.tep` manifest validation share
  `packageSecurity.ts`: zip entries are inspected before extraction, rejecting
  absolute paths, parent traversal, backslash paths, symlinks, excessive file
  counts, oversized single entries, oversized archives, and zip-bomb style
  expanded size. Extracted trees are scanned again by real path before install.
- Desktop lyrics IPC normalizes settings, ignores invalid playback times, and
  clamps window move requests to the current display work area.

## Tooling Gate

- `pnpm run lint` now ignores generated/build artifacts and CJS helper outputs
  that are not authored TypeScript/Vue app code.
- Formatting remains owned by `pnpm run format`; ESLint is kept focused on
  correctness/security checks and Vue SFC TypeScript enforcement.

## Remaining Work

- Add signing or stronger trust metadata for third-party `.tep` packages.
- Consider permission prompts for high-impact plugin capabilities beyond the
  current trust-based install warning.
- Add a focused security test script once more controls are added outside the
  plugin test gate.
