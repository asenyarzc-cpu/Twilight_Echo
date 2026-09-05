import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import { getWindowBackgroundColor } from '../audio/state'
import {
  isWindowsAcrylicBackdropAvailable,
  isWindowsAcrylicBuild,
  supportsNativeWindowTransparency
} from '../core/settings'
import { installAudioDeviceHotplugWatcher } from '../audio/deviceHotplug'
import { destroyDesktopLyrics } from '../integrations/desktopLyrics'
import { showMiniPlayer } from '../integrations/miniPlayer.ts'
import {
  createTaskbarThumbarButtons,
  destroyTaskbarThumbarButtons
} from '../integrations/taskbarThumbar.ts'
import { destroyWindowsSmtc, initializeWindowsSmtc } from '../integrations/windowsSmtc.ts'
import { ClosePersistenceAttemptGate } from './closePersistence.ts'
import { isSafeExternalUrl } from '../security/externalUrl.ts'
import type { RendererClosePersistenceOutcome } from '../../shared/closePersistence.ts'

const PLAYBACK_SESSION_SAVE_TIMEOUT_MS = 1800
const closePersistenceAttemptGate = new ClosePersistenceAttemptGate()
const pendingPlaybackSessionSaves = new Map<
  string,
  (outcome: RendererClosePersistenceOutcome) => void
>()

export function resolvePlaybackSessionSave(
  requestId: string,
  outcome: RendererClosePersistenceOutcome
): void {
  const resolvePending = pendingPlaybackSessionSaves.get(requestId)
  if (!resolvePending) return
  pendingPlaybackSessionSaves.delete(requestId)
  resolvePending(outcome)
}

async function requestRendererPlaybackSessionSave(): Promise<void> {
  const win = runtime.mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return

  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPlaybackSessionSaves.delete(requestId)
      reject(new Error('Timed out waiting for renderer persistence'))
    }, PLAYBACK_SESSION_SAVE_TIMEOUT_MS)

    pendingPlaybackSessionSaves.set(requestId, (outcome) => {
      clearTimeout(timer)
      if (outcome.status === 'saved') {
        resolve()
        return
      }
      reject(new Error(outcome.error || 'Renderer persistence failed'))
    })

    win.webContents.send('app:save-playback-session', requestId)
  })
}

async function closeMainWindowAfterPlaybackSessionSave(win: BrowserWindow): Promise<void> {
  runtime.savingPlaybackSessionBeforeClose = true
  try {
    await closePersistenceAttemptGate.run({
      requestPersistence: requestRendererPlaybackSessionSave,
      close: () => closeMainWindowAfterSuccessfulPersistence(win),
      showFailure: async (error) => await showClosePersistenceFailure(win, error)
    })
  } finally {
    runtime.savingPlaybackSessionBeforeClose = false
  }
}

function closeMainWindowAfterSuccessfulPersistence(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  destroyDesktopLyrics()
  const shouldQuitAfterClose = runtime.forceQuit
  if (shouldQuitAfterClose) {
    win.once('closed', () => {
      setTimeout(() => app.quit(), 0)
    })
  }
  runtime.closingAfterPlaybackSessionSave = true
  win.close()
  runtime.closingAfterPlaybackSessionSave = false
}

async function showClosePersistenceFailure(
  win: BrowserWindow,
  error: Error
): Promise<'retry' | 'cancel' | 'force'> {
  console.error('[persistence] Window close cancelled because renderer persistence failed:', error)
  try {
    const response = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Twilight Echo could not save your changes',
      message: 'The window remains open so your playlist changes are not silently lost.',
      detail: error.message,
      buttons: ['Retry close', 'Keep window open', 'Quit without saving'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    // I3: 提供“仍然退出”逃生出口，避免保存持续失败时对话框循环卡住。
    if (response.response === 0) return 'retry'
    if (response.response === 2) return 'force'
    return 'cancel'
  } catch (dialogError) {
    console.error('[persistence] Failed to present the cancelled-close dialog:', dialogError)
    return 'cancel'
  }
}

export function getAppIconPath(): string {
  if (process.platform === 'win32') {
    return is.dev
      ? join(app.getAppPath(), 'build', 'icon.ico')
      : join(process.resourcesPath, 'icon.ico')
  }
  return is.dev
    ? join(app.getAppPath(), 'build', 'icon.png')
    : join(process.resourcesPath, 'icon.png')
}

// Win11 22H2 (build 22621) 及以上支持原生亚克力背板（DWM systembackdrop）
export function supportsWindowsAcrylic(): boolean {
  return isWindowsAcrylicBuild()
}

export function createWindow(): void {
  const requestedTransparency = runtime.appSettings.windowTransparency === true
  // Linux Wayland 上 Electron 透明窗口不受支持（alpha 被忽略、内容可能整窗不渲染），
  // 此时强制回退为不透明窗口，保证应用始终可见。
  const transparencySupported = supportsNativeWindowTransparency()
  const transparent = requestedTransparency && transparencySupported
  if (requestedTransparency && !transparencySupported) {
    console.warn(
      '[window] 当前系统不支持窗口透明（Linux Wayland，或 Windows 未开启系统透明效果），' +
        '已回退为不透明窗口。如需要透明效果请切换 X11 会话或开启系统透明效果。'
    )
  }
  // Windows 上用原生亚克力模糊：backgroundMaterial 与 transparent 互斥，
  // 需保持 transparent: false 并用全透明 backgroundColor 露出背板
  const acrylic = transparent && supportsWindowsAcrylic() && isWindowsAcrylicBackdropAvailable()
  if (transparent && supportsWindowsAcrylic() && !isWindowsAcrylicBackdropAvailable()) {
    console.warn(
      '[window] 系统"透明效果"已关闭，DWM 无法提供亚克力背板，' +
        '已回退为逐像素透明窗口（无模糊）。如需要亚克力效果，请开启系统透明效果。'
    )
  }

  runtime.mainWindow = new BrowserWindow({
    width: 1495,
    height: 883,
    // Keep the responsive playback layout usable when the frameless window is resized.
    // These bounds were dropped by the 1.1.4 merge and allow the content columns
    // to collapse into an unusable state on the next manual resize.
    minWidth: 1298,
    minHeight: 692,
    show: false,
    frame: false,
    transparent: transparent && !acrylic,
    backgroundColor: transparent ? '#00000000' : getWindowBackgroundColor(runtime.appSettings),
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  runtime.mainWindow.on('ready-to-show', () => {
    runtime.mainWindow?.show()
  })

  runtime.mainWindow.on('close', (event) => {
    const closeBehavior = runtime.appSettings.closeWindowBehavior ?? 'quit'
    if (!runtime.forceQuit && (closeBehavior === 'tray' || closeBehavior === 'miniPlayer')) {
      event.preventDefault()
      if (closeBehavior === 'miniPlayer') {
        showMiniPlayer()
      } else {
        runtime.mainWindow?.hide()
      }
      return
    }

    if (!runtime.closingAfterPlaybackSessionSave) {
      event.preventDefault()
      if (!runtime.savingPlaybackSessionBeforeClose && runtime.mainWindow) {
        void closeMainWindowAfterPlaybackSessionSave(runtime.mainWindow)
      }
    }
  })

  runtime.mainWindow.on('closed', () => {
    destroyTaskbarThumbarButtons()
    destroyWindowsSmtc()
    runtime.mainWindow = null
  })

  installAudioDeviceHotplugWatcher(runtime.mainWindow)

  if (process.platform === 'win32') {
    try {
      createTaskbarThumbarButtons()
    } catch (error) {
      console.warn('[thumbar] unable to initialize taskbar buttons:', error)
    }
    try {
      initializeWindowsSmtc()
    } catch (error) {
      console.warn('[smtc] unable to initialize Windows media session:', error)
    }
  }

  runtime.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  runtime.mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    runtime.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    runtime.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// S4：外部跳转默认仅放行 https:（共享实现见 security/externalUrl.ts）

function isAllowedAppNavigation(url: string): boolean {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    try {
      const target = new URL(url)
      const devServer = new URL(process.env['ELECTRON_RENDERER_URL'])
      return target.origin === devServer.origin
    } catch {
      return false
    }
  }

  const rendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  return url === rendererUrl || url.startsWith(`${rendererUrl}#`)
}
