<script setup lang="ts">
import { ref } from 'vue'
import { useBackStack } from '../app/useBackStack'
import { useNcmStore } from '../stores/useNcmStore'
import PuzzleIcon from './icons/PuzzleIcon.vue'

withDefaults(
  defineProps<{
    menuOpen: boolean
    glass?: boolean
    liquidMaterial?: boolean
    streaming?: boolean
    hideStart?: boolean
    titleSurface?: 'default' | 'settings' | 'streaming'
  }>(),
  {
    titleSurface: 'default'
  }
)

defineEmits<{
  toggleMenu: []
  collapseMenu: []
  back: []
  login: [providerId?: string | null]
  settings: []
  plugins: []
}>()

const { isLoggedIn, profile } = useNcmStore()
const { canGoBack, backHint } = useBackStack()
const avatarLoadFailed = ref(false)

function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

function minimize(): void {
  window.api.window.minimize()
}

function toggleMaximize(): void {
  window.api.window.toggleMaximize()
}

function close(): void {
  window.api.window.close()
}
</script>

<template>
  <div
    class="title-bar drag-region"
    :class="{
      'title-bar-glass': glass,
      'title-bar-liquid': liquidMaterial,
      'title-bar-settings': titleSurface === 'settings',
      'title-bar-streaming': titleSurface === 'streaming',
      'title-bar-menu-open': menuOpen
    }"
  >
    <div class="title-bar-background" aria-hidden="true"></div>
    <!-- One global back affordance. It lives outside `hideStart`/`glass` so every
         deep surface (playing page, theme studio, login, …) resolves through the
         same fixed position; the wrapper width animates so sibling buttons do
         not jump when it appears. -->
    <div
      class="title-bar-back no-drag"
      :class="{ 'title-bar-back-visible': canGoBack }"
      @pointerdown="setPressOrigin"
    >
      <Transition name="title-back-fade">
        <button
          v-if="canGoBack"
          class="back-btn"
          :title="backHint ?? '返回'"
          aria-label="返回"
          @click="$emit('back')"
        >
          <i class="pi pi-arrow-left" aria-hidden="true"></i>
        </button>
      </Transition>
    </div>
    <div v-if="!glass && !hideStart" class="title-bar-start no-drag" @pointerdown="setPressOrigin">
      <button class="menu-btn" title="菜单" @click="$emit('toggleMenu')">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <button class="settings-btn" title="设置" @click="$emit('settings')">
        <i class="pi pi-cog"></i>
      </button>
      <button class="plugins-btn" title="扩展中心" @click="$emit('plugins')">
        <PuzzleIcon />
      </button>
      <button
        v-if="streaming"
        class="login-btn"
        :title="isLoggedIn ? profile?.nickname || '个人详情' : '网易云登录'"
        @click="$emit('login', 'ncm')"
      >
        <img
          v-if="isLoggedIn && profile?.avatarUrl && !avatarLoadFailed"
          :src="profile.avatarUrl"
          class="user-avatar"
          alt=""
          @error="avatarLoadFailed = true"
        />
        <i v-else class="pi pi-user"></i>
      </button>
    </div>
    <div class="title-bar-controls no-drag" @pointerdown="setPressOrigin">
      <button class="control-btn minimize" title="最小化" @click="minimize">
        <svg width="14" height="14" viewBox="0 0 10 10">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button class="control-btn maximize" title="最大化/还原" @click="toggleMaximize">
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
        </svg>
      </button>
      <button class="control-btn close" title="关闭窗口" aria-label="关闭窗口" @click="close">
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  background: transparent !important;
  user-select: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  overflow: hidden;
  border-bottom: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition:
    border-color 0.3s,
    box-shadow 0.3s;
}

.title-bar-background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  background: transparent !important;
}

.title-bar::before {
  display: none;
}

.title-bar-glass,
.title-bar.title-bar-streaming,
.title-bar.title-bar-menu-open:not(.title-bar-glass):not(.title-bar-settings),
.title-bar.title-bar-streaming.title-bar-menu-open:not(.title-bar-glass):not(.title-bar-settings) {
  background: transparent !important;
  border-bottom-color: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.title-bar.title-bar-settings::before,
.title-bar.title-bar-glass::before {
  display: none;
}

/* The settings title strip stays transparent: the settings overlay below it is
   the single wallpaper painter and spans the full window, so the image reads as
   one continuous surface through the strip. The bar keeps its own higher
   stacking context, so the controls remain clickable. */
.title-bar.title-bar-settings,
.title-bar.title-bar-settings .title-bar-background {
  background: transparent !important;
}

/* Dark tone must not wrap the whole chain in `:global()`: Vue's scoped transform
   rewrites only the last compound, so `:global(html .title-bar…)` compiles to the
   bare ancestor and the declarations land on <html> instead of this component.
   Both compounds here belong to this component; scoping appends the id to the
   subject and leaves the document-level ancestor alone — same contract as the
   playbar glass rules in PlayerBar.css. */
html[data-theme='dark'] .title-bar,
html[data-theme='dark'] .title-bar.title-bar-streaming,
html[data-theme='dark']
  .title-bar.title-bar-streaming.title-bar-menu-open:not(.title-bar-glass):not(.title-bar-settings),
html[data-theme='dark'] .title-bar.title-bar-glass {
  background: transparent !important;
}

.title-bar-start {
  display: flex;
  height: 100%;
  position: relative;
  z-index: 1;
}

.title-bar-back {
  display: flex;
  align-items: center;
  width: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  transition: width 0.2s var(--te-ease-soft, ease);
}

.title-bar-back-visible {
  width: 36px;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  min-width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  font-size: 14px;
}

.back-btn:hover {
  background: var(--te-shell-control-hover);
}

.title-back-fade-enter-active,
.title-back-fade-leave-active {
  transition: opacity 0.18s ease;
}

.title-back-fade-enter-from,
.title-back-fade-leave-to {
  opacity: 0;
}

.title-bar-glass .back-btn {
  color: #fff;
}

.title-bar-glass .back-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.menu-btn:hover {
  background: var(--te-shell-control-hover);
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: 14px;
}

.settings-btn:hover {
  background: var(--te-shell-control-hover);
}

.plugins-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: 17px;
}

.plugins-btn:hover {
  background: var(--te-shell-control-hover);
}

.login-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: 14px;
}

.login-btn:hover {
  background: var(--te-shell-control-hover);
}

.user-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.title-bar-glass .settings-btn {
  color: #fff;
}

.title-bar-glass .settings-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.title-bar-glass .login-btn {
  color: #fff;
}

.title-bar-glass .login-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.title-bar-controls {
  display: flex;
  height: 100%;
  margin-left: auto;
  position: relative;
  z-index: 1;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  font-size: 16px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.3s,
    transform 0.24s var(--te-ease-soft);
}

.control-btn:active {
  transition-duration: 0.1s;
}

.title-bar-glass .control-btn {
  color: #fff;
}

.title-bar-glass .control-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.title-bar-glass .control-btn.maximize:hover {
  background: rgba(255, 255, 255, 0.1);
}

.control-btn:hover {
  background: var(--te-shell-control-hover);
}

.control-btn.maximize:hover {
  background: var(--te-shell-control-hover);
}

.control-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.title-bar-liquid {
  isolation: isolate;
  color: var(--te-lg-context-label);
}

.title-bar-liquid .title-bar-background {
  display: block;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--te-lg-context-rim) 18%, transparent),
      transparent 82%
    ),
    color-mix(in srgb, var(--te-lg-context-surface) 56%, transparent) !important;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--te-lg-context-label) 8%, transparent);
  backdrop-filter: blur(16px) saturate(124%);
  -webkit-backdrop-filter: blur(16px) saturate(124%);
}

:global(html[data-te-liquid-glass-source='solid'] .title-bar-liquid .title-bar-background) {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--te-lg-context-rim) 22%, transparent),
      transparent 82%
    ),
    var(--te-lg-context-material) !important;
}

html[data-te-liquid-glass-scrolled='on'] .title-bar-liquid .title-bar-background {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--te-lg-context-rim) 24%, transparent),
      transparent 66%
    ),
    color-mix(in srgb, var(--te-lg-context-surface) 72%, transparent) !important;
  box-shadow:
    inset 0 -1px 0 color-mix(in srgb, var(--te-lg-context-label) 13%, transparent),
    0 6px 18px color-mix(in srgb, var(--te-lg-context-label) 8%, transparent);
}

.title-bar-liquid :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  position: relative;
  overflow: hidden;
  color: inherit;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn)::after {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 56%, transparent),
    transparent 58%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease-out;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active {
  transform: scale(0.94);
  transition-duration: 90ms;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active::after {
  opacity: 1;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .title-bar-liquid .title-bar-background {
    background: var(--te-lg-context-surface-solid) !important;
    border-bottom: 1px solid var(--te-lg-context-label);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .title-bar-liquid .title-bar-background {
    background: Canvas !important;
    border-bottom: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
