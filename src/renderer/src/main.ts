import './assets/main.css'
import '@phosphor-icons/web/regular'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { bootstrapThemeRuntime } from './stores/useThemeStore'
import { beginStartupSnapshot } from './app/startupSnapshot'
import { installAutoHideScrollbars } from './utils/autoHideScrollbars'
import { injectCachedThemeRuntime } from './app/themeRuntimeCache'
import { activateDeferredFontStyles } from './app/deferredFontStyles'

const query = new URLSearchParams(window.location.search)
const windowKind = query.get('window')
const isMiniPlayer = windowKind === 'mini-player'
const isTrayPlayer = windowKind === 'tray-player'
if (isMiniPlayer || isTrayPlayer) {
  const documentClass = isMiniPlayer ? 'mini-player-document' : 'tray-player-document'
  document.documentElement.classList.add(documentClass)
  document.body.classList.add(documentClass)
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.padding = '0'
}

installAutoHideScrollbars()
if (!isMiniPlayer && !isTrayPlayer) injectCachedThemeRuntime()

// Chromium starts an OS drag for images, links, and arbitrary elements, letting
// users drag app content out of the window onto the desktop. Block every
// dragstart that did not originate on an explicitly draggable app surface.
// The app's intentional HTML5 drag-and-drop (playback queue reorder, DSP rack
// reorder, playlist-detail reorder) marks its rows draggable="true", so those
// keep working while everything else is confined to the window.
document.addEventListener(
  'dragstart',
  (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[draggable="true"]')) {
      event.preventDefault()
    }
  },
  true
)

async function mountApp(): Promise<void> {
  const startupSnapshot = !isMiniPlayer && !isTrayPlayer ? beginStartupSnapshot() : null
  const rootComponent = isMiniPlayer
    ? (await import('./mini-player/MiniPlayerApp.vue')).default
    : isTrayPlayer
      ? (await import('./tray-player/TrayPlayerApp.vue')).default
      : (await import('./App.vue')).default
  if (isMiniPlayer) await bootstrapThemeRuntime()
  createApp(rootComponent).use(createPinia()).mount('#app')
  activateDeferredFontStyles()
  void startupSnapshot
}

void mountApp()
