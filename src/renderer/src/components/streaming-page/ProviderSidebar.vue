<script setup lang="ts">
import type { StreamingSidebarItem } from '../../utils/streamingNavigation'

defineProps<{
  menuOpen: boolean
  items: StreamingSidebarItem[]
  isActive: (item: StreamingSidebarItem) => boolean
}>()

const emit = defineEmits<{
  select: [item: StreamingSidebarItem]
  backToLocal: []
}>()
</script>

<template>
  <div class="streaming-sidebar" :class="{ open: menuOpen }">
    <div class="streaming-sidebar-inner">
      <div class="streaming-sidebar-header">
        <span class="streaming-sidebar-title">流媒体</span>
      </div>
      <nav class="streaming-nav">
        <div
          v-for="item in items"
          :key="item.key"
          class="streaming-menu-item"
          role="button"
          tabindex="0"
          data-te-interactive
          :class="{ active: isActive(item) }"
          @click="emit('select', item)"
          @keydown.enter.prevent="emit('select', item)"
          @keydown.space.prevent="emit('select', item)"
        >
          <i class="streaming-menu-icon" :class="item.icon"></i>
          <span class="streaming-menu-label">{{ item.label }}</span>
        </div>
      </nav>
      <div class="streaming-sidebar-bottom">
        <div class="streaming-menu-separator"></div>
        <div
          class="streaming-menu-item streaming-local-btn"
          role="button"
          tabindex="0"
          data-te-interactive
          @click="emit('backToLocal')"
          @keydown.enter.prevent="emit('backToLocal')"
          @keydown.space.prevent="emit('backToLocal')"
        >
          <i class="streaming-menu-icon pi pi-desktop"></i>
          <span class="streaming-menu-label">本地模式</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.streaming-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--te-menu-width);
  box-sizing: border-box;
  /* Only the bottom-most global background renders; no separate surface. */
  background: transparent;
  border-right: 1px solid var(--te-card-border);
  z-index: 1000;
  overflow: hidden;
  box-shadow: 8px 0 24px rgba(15, 23, 42, 0.04);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  transform: translate3d(-100%, 0, 0);
  will-change: transform;
  transition:
    transform 0.32s var(--te-ease-soft),
    box-shadow 0.32s;
}

.streaming-sidebar.open {
  transform: translate3d(0, 0, 0);
}

.streaming-sidebar-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: calc(32px + 14px) 9px 14px 1px;
  width: var(--te-menu-width);
  min-width: 132px;
  max-width: 216px;
  box-sizing: border-box;
}

.streaming-sidebar-header {
  padding: 2px 12px 12px 18px;
  flex-shrink: 0;
}

.streaming-sidebar-title {
  font-size: 13px;
  font-weight: 800;
  color: #6b7280;
  text-transform: none;
  letter-spacing: 0;
}

.streaming-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.streaming-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 12px 0 18px;
  cursor: pointer;
  border-radius: 11px;
  color: #111827;
  transition:
    background 0.18s,
    color 0.18s;
  gap: 12px;
  white-space: nowrap;
}

.streaming-menu-item:hover {
  background: var(--te-hover-bg);
}

.streaming-menu-item.active {
  background: var(--te-active-bg);
  color: #0f172a;
  box-shadow: none;
}

.streaming-menu-item.active::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 4px;
  border-radius: 0 999px 999px 0;
  background: #020617;
}

.streaming-menu-item.active .streaming-menu-icon {
  color: #111827;
}

.streaming-menu-icon {
  font-size: 16px;
  width: 17px;
  height: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #4b5563;
  transition: color 0.15s;
}

.streaming-menu-label {
  font-size: 14px;
  font-weight: 700;
  color: currentColor;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.streaming-sidebar-bottom {
  flex-shrink: 0;
  margin-top: auto;
}

.streaming-menu-separator {
  height: 1px;
  background: var(--te-card-border);
  margin: 10px 10px 8px 14px;
}

.streaming-local-btn {
  color: #111827;
}

.streaming-local-btn:hover {
  background: var(--te-hover-bg);
}
</style>

<style>
.streaming-sidebar.open + .streaming-content {
  width: calc(100% - var(--te-menu-width));
  flex-basis: calc(100% - var(--te-menu-width));
  transform: translate3d(var(--te-menu-width), 0, 0);
}

.streaming-sidebar .streaming-menu-label {
  opacity: 0;
  transition: opacity 0.2s ease;
}

.streaming-sidebar.open .streaming-menu-label {
  opacity: 1;
}

:global(html[data-theme='dark'] .streaming-page .streaming-sidebar) {
  border-right-color: transparent;
  background: transparent;
  box-shadow: none;
}

:global(html[data-window-transparent='on'] .streaming-page .streaming-sidebar) {
  /* The sidebar stays frosted transparent over the global background. */
  background: transparent !important;
  background-image: none !important;
}

@media (max-width: 900px) {
  .streaming-sidebar.open {
    transform: translate3d(0, 0, 0);
  }

  .streaming-sidebar-inner {
    width: var(--te-menu-width);
    min-width: 132px;
    max-width: 216px;
    padding: calc(32px + 14px) 9px 14px 1px;
    box-sizing: border-box;
  }

  .streaming-sidebar.open + .streaming-content {
    transform: translate3d(var(--te-menu-width), 0, 0);
    width: calc(100% - var(--te-menu-width));
    flex-basis: calc(100% - var(--te-menu-width));
  }

  .streaming-menu-item {
    height: 42px;
    padding: 0 12px 0 18px;
    border-radius: 11px;
  }

  .streaming-menu-icon {
    width: 17px;
    height: 17px;
    font-size: 16px;
  }

  .streaming-menu-label {
    font-size: 14px;
  }
}
</style>
