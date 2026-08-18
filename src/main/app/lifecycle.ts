import { app, BrowserWindow, dialog, protocol, net } from 'electron'
import { join, extname } from 'path'
import { cpus } from 'os'
import { pathToFileURL } from 'url'
import { fetch as undiciFetch } from 'undici'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import { ensureMusicCacheDirectories } from '../cache/ncmCache'
import { readCachedProtocolFile } from '../cache/protocolAssetCache'
import { kwinHasInputMethodConfigured } from '../imeBackend'
import {
  getCoverCacheContentType,
  isCoverCacheFileName,
  readCoverCacheFileBytes,
  resolveBackgroundImageFile
} from '../library/coverCache'
import { decodeAudioFileUrlPath } from '../library/scan'
import { initializeLocalPathGrants, resolveAuthorizedAudioFile } from '../security/localPaths'
import {
  unregisterPlayerShortcuts,
  destroyTray,
  applyRuntimeSettings
} from '../integrations/shortcutsTray'
import {
  destroyDesktopLyrics,
  showDesktopLyrics,
  setupDesktopLyricsIpc
} from '../integrations/desktopLyrics'
import { restoreMainWindowFromMiniPlayer, setupMiniPlayerIpc } from '../integrations/miniPlayer'
import { setupTrayPlayerIpc } from '../integrations/trayPlayer'
import { setupNcmIpc } from '../ncm/api'
import { ensureAudioEngineRuntime, setupAudioEngineIpc } from '../audio/engineIpc'
import { AudioAnalysisServiceClient } from '../audioAnalysisServiceClient.ts'
import { LocalLibraryScanServiceClient } from '../library/libraryScanServiceClient.ts'
import { setupBpmAnalysisIpc } from '../bpm/bpmIpc'
import { setupLoudnessAnalysisIpc } from '../audio/loudnessIpc'
import { setupOpraIpc } from '../ipc/opra'
import { setupPluginIpc } from '../ipc/plugins'
import { setupDataIpc } from '../ipc/data'
import { ensureActiveLibraryExclusionsLoaded } from '../ipc/libraryIpc.ts'
import { setupThemeIpc } from '../ipc/themes'
import { resolveThemeAssetFile } from '../themes/themeArchive.ts'
import { setupRadioMediaIpc, destroyRadioMediaIpc } from '../radio/radioMediaIpc.ts'
import { setupRemoteIpc, destroyRemoteIpc } from '../remote/remoteIpc.ts'
import { setupNetworkSourceIpc } from '../network/networkIpc.ts'
import { installElectronSecurity } from '../security/electronSecurity.ts'
import { createRemoteMediaRequestHandler } from '../security/remoteMediaGrants.ts'
import { createWindow } from './window'
import { consumeAppSettingsLoadIssue, supportsNativeWindowTransparency } from '../core/settings'
import type { SettingsFileLoadIssue } from '../persistence/settingsFile.ts'

export function startApp(): void {
  app.setName('TwilightEcho')
  electronApp.setAppUserModelId('com.TwilightEcho.music')
  runtime.launchSettings = { ...runtime.appSettings }

  if (!runtime.appSettings.hardwareAcceleration) {
    app.disableHardwareAcceleration()
  }

  if (runtime.appSettings.musicCachePath) {
    try {
      ensureMusicCacheDirectories(runtime.appSettings.musicCachePath)
      app.commandLine.appendSwitch(
        'disk-cache-dir',
        join(runtime.appSettings.musicCachePath, 'renderer-cache')
      )
    } catch (err) {
      console.warn('无法使用自定义缓存目录：', err)
    }
  }

  // Streaming provider URLs are resolved asynchronously after user commands.
  // Desktop playback must not be blocked by Chromium's web-page autoplay policy.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  // Linux Wayland 下的输入法（fcitx5/ibus）集成：
  // - KWin 只有在系统设置里配置了「虚拟键盘/输入法」时才会暴露
  //   zwp_input_method 协议（text-input 通道的前提）。未配置时，
  //   Wayland 原生客户端的 text-input 完全不可用，导致 fcitx5 无法输入。
  //   此时回退到 X11（XWayland）后端，让 fcitx5 通过 GTK_IM_MODULE /
  //   XIM 的前端工作（与 VS Code 等 Electron 应用一致）。
  // - KWin 已配置输入法时，遵循 fcitx-im 官方建议使用 text-input-v1；
  //   KWin 对 zwp_text_input_v3 的实现与 Chromium 存在协议理解差异。
  // - GNOME/Sway 等仅支持 text-input-v3 的 compositor 保持 v3。
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    const desktop = (
      process.env.XDG_CURRENT_DESKTOP ||
      process.env.XDG_SESSION_DESKTOP ||
      ''
    ).toLowerCase()
    const isKWin = desktop.includes('kde') || desktop.includes('plasma')

    if (isKWin && !kwinHasInputMethodConfigured()) {
      app.commandLine.appendSwitch('ozone-platform', 'x11')
    } else {
      app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform')
      app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
      app.commandLine.appendSwitch('enable-wayland-ime')
      app.commandLine.appendSwitch('wayland-text-input-version', isKWin ? '1' : '3')
    }
  }

  // Linux 上透明窗口需要显式启用透明视觉，否则整窗不渲染（纯透明）。
  // Wayland 会话不受支持，且该开关可能进一步破坏内容呈现，因此仅在支持时启用。
  if (
    process.platform === 'linux' &&
    runtime.appSettings.windowTransparency === true &&
    supportsNativeWindowTransparency()
  ) {
    app.commandLine.appendSwitch('enable-transparent-visuals')
  }

  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    app.quit()
  } else {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'twilight-audio',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true
        }
      },
      {
        scheme: 'twilight-media',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
          // Playbar dominant-color sampling loads covers with crossOrigin=anonymous.
          // Without corsEnabled, Chromium taints/fails those requests and can leave
          // the same twilight-media:// URL blank in the player-bar <img> as well.
          corsEnabled: true
        }
      },
      {
        // Local library art (`cover://<hash>.jpg`). Theme sampling also hits these
        // URLs with crossOrigin=anonymous — same corsEnabled requirement as above.
        scheme: 'cover',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      },
      {
        scheme: 'background',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      },
      {
        scheme: 'theme-asset',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true
        }
      }
    ])

    // Focus-only: no OS protocol client / argv deep links (see AGENTS.md).
    app.on('second-instance', () => {
      if (runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()) {
        restoreMainWindowFromMiniPlayer()
        return
      }
      const win = runtime.mainWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })

    app.whenReady().then(async () => {
      installElectronSecurity()
      await initializeLocalPathGrants(runtime.launchSettings)

      // Register cover:// protocol — Chromium reads cached image assets directly from disk,
      // no IPC, no base64, browser manages decode cache natively.
      protocol.handle('cover', async (request) => {
        const url = new URL(request.url)
        const fileName = url.hostname + url.pathname
        // Sanitize: only allow alphanumeric/hash filenames
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '')
        if (!isCoverCacheFileName(safeName)) {
          return new Response('Forbidden', { status: 403 })
        }
        const data = await readCoverCacheFileBytes(safeName)
        if (!data) {
          return new Response('Not Found', { status: 404 })
        }
        return new Response(data, {
          headers: {
            'Content-Type': getCoverCacheContentType(safeName),
            // Cover filenames are content hashes, so each distinct art has a
            // distinct immutable URL. CoverImg remounts per track identity, which
            // is the real guard against the cold-start sticky-decode issue that
            // once required no-store here.
            'Cache-Control': 'public, max-age=31536000, immutable',
            // Permit crossOrigin=anonymous canvas sampling without tainting
            // concurrent plain <img> loads of the same cover:// URL.
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD'
          }
        })
      })

      protocol.handle('background', async (request) => {
        const url = new URL(request.url)
        const fileName = (url.hostname + url.pathname).replace(/^\/+/, '')
        const filePath = resolveBackgroundImageFile(fileName)
        if (!filePath) {
          return new Response('Not Found', { status: 404 })
        }
        const ext = extname(filePath).toLowerCase()
        const contentType =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        const data = await readCachedProtocolFile(filePath)
        if (!data) {
          return new Response('Not Found', { status: 404 })
        }
        return new Response(data, {
          headers: {
            'Content-Type': contentType,
            // Background filenames are sha256 slices of the stored bytes.
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD'
          }
        })
      })

      protocol.handle('theme-asset', async (request) => {
        try {
          const url = new URL(request.url)
          if (url.hostname !== 'asset') return new Response('Forbidden', { status: 403 })
          const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
          const profileId = segments.shift() ?? ''
          const filePath = resolveThemeAssetFile(profileId, segments.join('/'))
          if (!filePath) return new Response('Not Found', { status: 404 })
          const extension = extname(filePath).toLowerCase()
          const contentType =
            extension === '.png'
              ? 'image/png'
              : extension === '.webp'
                ? 'image/webp'
                : extension === '.woff2'
                  ? 'font/woff2'
                  : 'image/jpeg'
          const data = await readCachedProtocolFile(filePath)
          if (!data) return new Response('Not Found', { status: 404 })
          return new Response(data, {
            headers: {
              'Content-Type': contentType,
              // Theme archive assets can change under a stable profile path.
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD'
            }
          })
        } catch {
          return new Response('Not Found', { status: 404 })
        }
      })

      protocol.handle('twilight-audio', async (request) => {
        try {
          const url = new URL(request.url)
          const encodedPath = url.pathname.replace(/^\/+/, '')
          if (!encodedPath) return new Response('Bad Request', { status: 400 })
          const filePath = await resolveAuthorizedAudioFile(decodeAudioFileUrlPath(encodedPath))
          return net.fetch(pathToFileURL(filePath).toString(), {
            headers: request.headers,
            bypassCustomProtocolHandlers: true
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : '无法读取音频文件'
          return new Response(message, { status: 404 })
        }
      })

      // Provider CDN art/audio (especially NetEase) is unreliable through Electron's
      // Chromium net.fetch in the main process — headers/redirects get mangled and
      // covers come back as 403 HTML. undici speaks plain HTTP with the UA/Referer
      // we set in remoteMediaGrants and is already a production dependency.
      protocol.handle(
        'twilight-media',
        createRemoteMediaRequestHandler({
          fetch: async (source, init) => {
            const upstream = await undiciFetch(source, {
              method: init.method,
              headers: init.headers as Record<string, string> | undefined,
              // Manual so remoteMediaGrants can re-apply NetEase Referer on each hop.
              redirect: 'manual'
            })
            // Convert undici Response → web Response for protocol.handle consumers.
            const headers = new Headers()
            upstream.headers.forEach((value, key) => {
              headers.set(key, value)
            })
            return new Response(upstream.body as ReadableStream<Uint8Array> | null, {
              status: upstream.status,
              statusText: upstream.statusText,
              headers
            })
          }
        })
      )

      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      runtime.localLibraryScanService = new LocalLibraryScanServiceClient({
        serviceEntry: join(__dirname, 'libraryScanService.js')
      })
      setupDataIpc()
      setupThemeIpc()
      setupDesktopLyricsIpc()
      setupMiniPlayerIpc()
      setupTrayPlayerIpc()

      setupAudioEngineIpc()
      runtime.audioAnalysisService = new AudioAnalysisServiceClient({
        serviceEntry: join(__dirname, 'audioAnalysisService.js'),
        maxConcurrency: Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))
      })
      setupBpmAnalysisIpc()
      setupLoudnessAnalysisIpc()
      setupNcmIpc()
      setupRadioMediaIpc()
      setupRemoteIpc()
      setupNetworkSourceIpc()
      setupOpraIpc()
      setupPluginIpc()

      // Linux 上透明窗口必须等合成器视觉就绪后再建窗，否则内容不渲染
      if (
        process.platform === 'linux' &&
        runtime.appSettings.windowTransparency === true &&
        supportsNativeWindowTransparency()
      ) {
        setTimeout(() => {
          createMainWindowAndScheduleDeferredStartup()
        }, 360)
      } else {
        createMainWindowAndScheduleDeferredStartup()
      }

      app.on('activate', function () {
        if (runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()) {
          restoreMainWindowFromMiniPlayer()
        } else if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin' && !runtime.appSettings.closeToTray) {
        app.quit()
      }
    })

    app.on('before-quit', () => {
      runtime.forceQuit = true
      destroyDesktopLyrics()
      void runtime.pluginManager?.broadcastEvent('app:before-quit', null)
    })

    app.on('will-quit', () => {
      destroyDesktopLyrics()
      unregisterPlayerShortcuts()
      destroyTray()
      void runtime.pluginManager?.destroy()
      runtime.bpmAnalysisManager?.cancel()
      runtime.loudnessAnalysisManager?.cancel()
      runtime.audioAnalysisService?.destroy()
      runtime.audioAnalysisService = null
      runtime.localLibraryIndexCoordinator?.destroy()
      runtime.localLibraryIndexCoordinator = null
      runtime.localLibraryScanService?.destroy()
      runtime.localLibraryScanService = null
      runtime.audioEngineManager?.destroy()
      runtime.audioEngineManager = null
      runtime.bpmAnalysisManager = null
      runtime.loudnessAnalysisManager = null
      runtime.pluginManager = null
      destroyRadioMediaIpc()
      void destroyRemoteIpc()
      if (runtime.ncmServer) {
        runtime.ncmServer.close()
        runtime.ncmServer = null
      }
      runtime.ncmServerPromise = null
    })
  }
}

function createMainWindowAndScheduleDeferredStartup(): void {
  createWindow()
  showAppSettingsLoadIssue(consumeAppSettingsLoadIssue())
  const mainWindow = runtime.mainWindow
  if (!mainWindow) return
  mainWindow.once('ready-to-show', () => {
    if (runtime.mainWindow !== mainWindow || mainWindow.isDestroyed() || runtime.forceQuit) return
    if (runtime.appSettings.desktopLyrics.enabled) showDesktopLyrics()
    void ensureAudioEngineRuntime().catch((error) => {
      console.error('[音频引擎] 初始化失败：', error instanceof Error ? error.message : error)
    })
    setTimeout(() => {
      void ensureActiveLibraryExclusionsLoaded()
        .catch((error) => {
          console.error(
            '[library] failed to initialize exclusions before starting watchers:',
            error instanceof Error ? error.message : error
          )
        })
        .then(() => {
          if (runtime.mainWindow !== mainWindow || mainWindow.isDestroyed() || runtime.forceQuit)
            return
          applyRuntimeSettings()
        })
    }, 0)
  })
}

function showAppSettingsLoadIssue(issue: SettingsFileLoadIssue | null): void {
  if (!issue) return

  const options: Electron.MessageBoxOptions =
    issue.kind === 'recovered'
      ? {
          type: 'warning',
          title: 'Twilight Echo 数据恢复',
          message: '设置已从备份恢复',
          detail: issue.restoreError
            ? `已读取有效备份，但恢复主文件失败：${issue.restoreError}`
            : issue.corruptCopyPath
              ? `主文件已由最后一个有效备份恢复。损坏副本保留在：${issue.corruptCopyPath}`
              : '主文件缺失，已由最后一个有效备份恢复。',
          buttons: ['确定'],
          defaultId: 0
        }
      : {
          type: 'error',
          title: 'Twilight Echo 数据恢复',
          message: '设置主文件和备份均已损坏',
          detail: buildCorruptSettingsDetail(issue),
          buttons: ['使用默认设置继续'],
          defaultId: 0
        }
  const win = runtime.mainWindow
  const prompt =
    win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  void prompt.catch((error) => {
    console.error('[persistence] failed to show settings recovery notice:', error)
  })
}

function buildCorruptSettingsDetail(
  issue: Extract<SettingsFileLoadIssue, { kind: 'corrupt' }>
): string {
  const preservedPaths = [issue.corruptCopyPath, issue.corruptBackupCopyPath].filter(Boolean)
  const preservedDetail =
    preservedPaths.length > 0
      ? `\n\n损坏副本已保留：\n${preservedPaths.join('\n')}`
      : '\n\n无法创建额外副本；请先备份原设置文件。'
  return `应用本次使用默认设置，未把损坏内容当作有效配置。\n主文件：${issue.primaryError}\n备份：${issue.backupError}${preservedDetail}`
}
