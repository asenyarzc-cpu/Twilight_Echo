<script setup lang="ts">
import { computed, ref } from 'vue'
import ImportDialog from './ImportDialog.vue'
import ThemeIcon from './ThemeIcon.vue'
import type { UiContribution } from '../extensions/registry'
import type { ThemeIconSlot } from '../../../shared/theme.ts'
import { useMusicStore } from '../stores/useMusicStore'

const props = defineProps<{
  open: boolean
  liquidMaterial?: boolean
  activeKey: string
  pluginPages?: UiContribution[]
  localItems?: UiContribution[]
}>()

const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  selectPluginPage: [page: UiContribution]
  enterStreaming: []
  enterRadioPodcast: []
  enterNetworkSources: []
}>()

interface MenuItem {
  key: string
  label: string
  icon: ThemeIconSlot
}

const menuItems: MenuItem[] = [
  { key: 'dashboard', label: '首页', icon: 'navigation.home' },
  { key: 'allSongs', label: '所有歌曲', icon: 'navigation.songs' },
  { key: 'artists', label: '艺术家', icon: 'navigation.artists' },
  { key: 'albums', label: '专辑', icon: 'navigation.albums' },
  { key: 'genres', label: '流派', icon: 'navigation.genres' },
  { key: 'playlists', label: '歌单', icon: 'navigation.playlists' },
  { key: 'folders', label: '文件夹', icon: 'navigation.folders' },
  { key: 'recent', label: '最近播放', icon: 'navigation.recent' }
]

const { libraryScanStatus, libraryScanProgress } = useMusicStore()
const scanning = computed(
  () => libraryScanStatus.value.state === 'running' || libraryScanStatus.value.state === 'paused'
)
const scanningLabel = computed(() => {
  const status = libraryScanStatus.value
  if (status.state === 'paused') return '扫描已暂停'
  const current = Math.max(0, status.current || 0)
  const total = Math.max(0, status.total || 0)
  const phase = libraryScanProgress.value?.phase === 'parsing' ? '解析' : '扫描'
  if (total > 0) return `${phase}中 ${current}/${total}`
  return '正在扫描…'
})
const showImportDialog = ref(false)

function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

function selectItem(key: string): void {
  emit('selectView', key, null)
}

function selectPluginPage(page: UiContribution): void {
  emit('selectPluginPage', page)
}

function handleImportClick(): void {
  showImportDialog.value = true
}
</script>

<template>
  <div
    class="side-menu"
    :class="{ open, 'side-menu-liquid': props.liquidMaterial }"
    @pointerdown="setPressOrigin"
  >
    <div class="navigation-brand" aria-hidden="true">
      <img src="/icon.png" alt="" />
      <span>Twilight Echo</span>
    </div>
    <nav class="menu-items">
      <div class="menu-nav">
        <button
          v-for="item in menuItems"
          :key="item.key"
          type="button"
          class="menu-item"
          :class="{ active: props.activeKey === item.key }"
          :aria-current="props.activeKey === item.key ? 'page' : undefined"
          :title="item.label"
          @click="selectItem(item.key)"
        >
          <ThemeIcon class="item-icon" :icon-slot="item.icon" />
          <span class="item-label">{{ item.label }}</span>
        </button>
      </div>
      <div class="menu-bottom">
        <div v-if="(props.localItems?.length ?? 0) > 0" class="menu-separator"></div>
        <button
          v-for="item in props.localItems ?? []"
          :key="`local:${item.pluginId}:${item.id}`"
          type="button"
          class="menu-item menu-item-plugin"
          :class="{ active: props.activeKey === `plugin:${item.pluginId}:${item.id}` }"
          :aria-current="
            props.activeKey === `plugin:${item.pluginId}:${item.id}` ? 'page' : undefined
          "
          :title="item.title"
          @click="selectPluginPage(item)"
        >
          <i v-if="item.icon" class="item-icon" :class="item.icon"></i>
          <ThemeIcon v-else class="item-icon" icon-slot="navigation.plugin" />
          <span class="item-label">{{ item.title }}</span>
        </button>
        <div class="menu-separator"></div>
        <button
          v-for="page in props.pluginPages ?? []"
          :key="`${page.pluginId}:${page.id}`"
          type="button"
          class="menu-item menu-item-plugin"
          :class="{ active: props.activeKey === `plugin:${page.pluginId}:${page.id}` }"
          :aria-current="
            props.activeKey === `plugin:${page.pluginId}:${page.id}` ? 'page' : undefined
          "
          :title="page.title"
          @click="selectPluginPage(page)"
        >
          <i v-if="page.icon" class="item-icon" :class="page.icon"></i>
          <ThemeIcon v-else class="item-icon" icon-slot="navigation.plugin" />
          <span class="item-label">{{ page.title }}</span>
        </button>
        <div v-if="(props.pluginPages?.length ?? 0) > 0" class="menu-separator"></div>
        <button
          type="button"
          class="menu-item menu-item-streaming"
          title="流媒体"
          @click="emit('enterStreaming')"
        >
          <ThemeIcon class="item-icon" icon-slot="navigation.streaming" />
          <span class="item-label">流媒体</span>
        </button>
        <button
          type="button"
          class="menu-item menu-item-radio"
          title="电台 / 播客"
          @click="emit('enterRadioPodcast')"
        >
          <ThemeIcon class="item-icon" icon-slot="navigation.radio" />
          <span class="item-label">电台 / 播客</span>
        </button>
        <button
          type="button"
          class="menu-item menu-item-network"
          title="网络源"
          @click="emit('enterNetworkSources')"
        >
          <i class="item-icon pi pi-server"></i>
          <span class="item-label">网络源</span>
        </button>
        <button
          type="button"
          class="menu-item menu-item-import"
          title="导入歌曲"
          @click="handleImportClick()"
        >
          <ThemeIcon class="item-icon" icon-slot="navigation.import" />
          <span class="item-label">导入歌曲</span>
        </button>
        <span v-if="scanning" class="scanning-text" aria-live="polite">{{ scanningLabel }}</span>
      </div>
    </nav>
    <ImportDialog :show="showImportDialog" @close="showImportDialog = false" />
  </div>
</template>

<style scoped>
.side-menu {
  position: fixed;
  display: flex;
  flex-direction: column;
  top: 32px;
  left: 0;
  bottom: 0;
  width: var(--te-menu-width);
  /* Frosted surface: the bottom-most global background shows through. */
  background: transparent;
  border-right: 1px solid var(--te-navigation-border);
  border-radius: 0 var(--te-navigation-radius) var(--te-navigation-radius) 0;
  z-index: 1000;
  overflow: hidden;
  box-shadow: var(--te-navigation-shadow);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transform: translate3d(-100%, 0, 0);
  transform-origin: left center;
  will-change: transform;
  transition:
    transform 0.32s var(--te-ease-soft),
    box-shadow 0.32s;
  font-family: var(--te-font-sans);
}

.side-menu.open {
  transform: translate3d(0, 0, 0);
}

:global(html[data-theme='dark'] .side-menu) {
  border-right-color: var(--te-navigation-border);
  background: transparent;
}

:global(html[data-te-navigation-style='expanded']) {
  --te-menu-width: clamp(180px, 18vw, 216px);
}

:global(html[data-te-navigation-style='compact']) {
  --te-menu-width: 164px;
}

:global(html[data-te-navigation-style='rail']) {
  --te-menu-width: 72px;
}

.navigation-brand {
  display: none;
  height: 56px;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--te-navigation-border);
  color: var(--te-navigation-text);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.navigation-brand img {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}

:global(html[data-te-navigation-logo='show'] .navigation-brand) {
  display: flex;
}

.side-menu .menu-items {
  transform: none;
  opacity: 1;
}

.menu-items {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  height: auto;
  width: 100%;
  min-width: 132px;
  max-width: 216px;
  padding: 16px 12px 16px 4px;
}

.menu-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.menu-bottom {
  flex-shrink: 0;
  margin-top: auto;
  padding-top: 8px;
}

.menu-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 40px;
  width: calc(100% - 8px);
  padding: 0 12px 0 16px;
  margin-left: 8px;
  border: 0;
  cursor: pointer;
  border-radius: var(--te-radius-global);
  gap: 14px;
  white-space: nowrap;
  color: var(--te-chrome-text, var(--te-navigation-text));
  background: transparent;
  font: inherit;
  text-align: left;
  transition:
    background var(--te-motion-hover) var(--te-ease-enter),
    color var(--te-motion-hover) var(--te-ease-enter),
    transform var(--te-motion-hover) var(--te-ease-enter);
}

.menu-item:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: -2px;
}

.menu-item:hover {
  background: var(--te-navigation-hover);
  color: var(--te-navigation-hover-text);
  transform: translateX(3px);
}

.menu-item.active {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
  font-weight: 600;
}

.menu-item.active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 10px;
  bottom: 10px;
  width: 4px;
  border-radius: 0 4px 4px 0;
  background: var(--te-navigation-indicator);
  opacity: 0.8;
  box-shadow: 0 0 8px color-mix(in srgb, var(--te-navigation-indicator) 50%, transparent);
}

:global(html[data-te-motion='full'] .menu-item.active::before) {
  animation: side-menu-indicator-in var(--te-motion-press) var(--te-ease-spring) both;
}

@keyframes side-menu-indicator-in {
  from {
    opacity: 0;
    scale: 1 0.45;
  }
}

.item-icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--te-navigation-icon);
  font-size: 17px;
  transition:
    color 0.2s,
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

:global(html[data-te-navigation-icon-scale='sm'] .item-icon) {
  font-size: 14px;
}

:global(html[data-te-navigation-icon-scale='lg'] .item-icon) {
  font-size: 20px;
}

.menu-item:hover .item-icon {
  transform: translateX(1px) scale(1.12) rotate(-4deg);
  color: var(--te-navigation-hover-text);
}

.menu-item.active .item-icon,
.menu-item-streaming .item-icon,
.menu-item-import .item-icon {
  color: inherit;
}

.item-label {
  font-size: 14px;
  font-weight: 500;
  color: currentColor;
  opacity: 0;
  letter-spacing: 0.3px;
  transition: opacity 0.2s ease;
}

.open .item-label {
  opacity: 1;
}

:global(html[data-te-navigation-style='compact'] .menu-items) {
  padding-right: 8px;
}

:global(html[data-te-navigation-style='compact'] .menu-item) {
  gap: 10px;
  padding-inline: 12px;
}

:global(html[data-te-navigation-style='compact'] .item-label) {
  font-size: 12px;
}

:global(html[data-te-navigation-style='rail'] .menu-items) {
  min-width: 0;
  max-width: 100%;
  padding: 12px 8px;
}

:global(html[data-te-navigation-style='rail'] .menu-nav) {
  gap: 5px;
}

:global(html[data-te-navigation-style='rail'] .menu-item) {
  width: 44px;
  margin-left: 6px;
  padding: 0;
  justify-content: center;
}

:global(html[data-te-navigation-style='rail'] .menu-item:hover) {
  transform: none;
}

:global(html[data-te-navigation-style='rail'] .menu-item.active::before) {
  left: -6px;
}

:global(html[data-te-navigation-style='rail'] .item-label),
:global(html[data-te-navigation-style='rail'] .navigation-brand span) {
  display: none;
}

:global(html[data-te-navigation-style='rail'] .navigation-brand) {
  justify-content: center;
  padding-inline: 8px;
}

:global(html[data-te-navigation-style='rail'] .menu-separator) {
  margin-inline: 8px;
}

.menu-separator {
  height: 1px;
  margin: 12px 10px 12px 16px;
  background: linear-gradient(to right, var(--te-navigation-border), transparent);
}

.menu-item-streaming,
.menu-item-import {
  color: var(--te-chrome-text, var(--te-navigation-text));
}

.menu-item-streaming:hover,
.menu-item-import:hover {
  background: var(--te-navigation-hover);
}

.scanning-text {
  display: block;
  padding: 8px 16px;
  color: var(--te-navigation-icon);
  font-size: 12px;
  font-weight: 500;
}

.side-menu-liquid {
  isolation: isolate;
  border-right-color: color-mix(in srgb, var(--te-lg-context-label) 13%, transparent);
  box-shadow: 5px 0 22px var(--te-lg-context-shadow);
}

.side-menu-liquid::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background:
    linear-gradient(
      112deg,
      color-mix(in srgb, var(--te-lg-context-rim) 18%, transparent),
      transparent 56%
    ),
    color-mix(in srgb, var(--te-lg-context-surface) 68%, transparent);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--te-lg-context-rim) 32%, transparent);
  content: '';
  pointer-events: none;
  backdrop-filter: blur(20px) saturate(128%);
  -webkit-backdrop-filter: blur(20px) saturate(128%);
}

:global(html[data-te-liquid-glass-source='solid'] .side-menu-liquid::before) {
  background:
    linear-gradient(
      112deg,
      color-mix(in srgb, var(--te-lg-context-rim) 22%, transparent),
      transparent 56%
    ),
    var(--te-lg-context-material);
}

.side-menu-liquid :is(.navigation-brand, .menu-item, .scanning-text) {
  color: var(--te-lg-context-label);
}

.side-menu-liquid .menu-item:hover {
  background: color-mix(in srgb, var(--te-lg-context-rim) 28%, transparent);
}

.side-menu-liquid .menu-item.active {
  background: color-mix(in srgb, var(--te-lg-context-rim) 40%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--te-lg-context-rim) 30%, transparent);
}

.side-menu-liquid .menu-item {
  overflow: hidden;
}

.side-menu-liquid .menu-item::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 58%, transparent),
    transparent 62%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease-out;
}

.side-menu-liquid .menu-item:active {
  transform: scale(0.97);
  transition-duration: 90ms;
}

.side-menu-liquid .menu-item:active::after {
  opacity: 1;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .side-menu-liquid::before {
    background: var(--te-lg-context-surface-solid);
    border-right: 1px solid var(--te-lg-context-label);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .side-menu-liquid::before {
    background: Canvas;
    border-right: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.scanning-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--te-navigation-border);
  border-top-color: var(--te-primary-500);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
</style>
