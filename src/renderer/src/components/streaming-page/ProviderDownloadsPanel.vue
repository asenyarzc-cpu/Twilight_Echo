<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../../shared/providerDownloads.ts'
import { downloadStatusLabel, filterActiveDownloadTasks } from './streamingDownloads.ts'

const props = defineProps<{
  show: boolean
  tasks: ProviderDownloadTaskSnapshot[]
}>()

const emit = defineEmits<{
  close: []
  open: []
  retry: [taskId: string]
  cancel: [taskId: string]
}>()

const activeDownloadTasks = computed(() => filterActiveDownloadTasks(props.tasks))
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="show" class="provider-download-panel-overlay" @click.self="emit('close')">
        <div class="provider-download-panel" role="dialog" aria-modal="true" aria-label="下载管理">
          <div class="provider-download-panel-header">
            <h3>下载管理</h3>
            <button type="button" class="soft-button" @click="emit('close')">
              <i class="pi pi-times"></i>
            </button>
          </div>
          <div v-if="tasks.length === 0" class="provider-download-empty">
            暂无下载任务。在流媒体曲目上右键选择「下载到本地」即可开始。
          </div>
          <div v-else class="provider-download-list">
            <div
              v-for="task in tasks"
              :key="task.id"
              class="provider-download-item"
              :class="{
                completed: task.status === 'completed',
                failed: task.status === 'failed'
              }"
            >
              <div class="provider-download-item-info">
                <strong>{{ task.track.title }}</strong>
                <span>{{ task.track.artist }}</span>
                <small :class="{ error: task.status === 'failed' }">
                  {{ downloadStatusLabel(task) }}
                  <template v-if="task.actualQuality"> · {{ task.actualQuality }}</template>
                  <template v-if="task.fileSize">
                    · {{ (task.fileSize / 1048576).toFixed(1) }} MB</template
                  >
                </small>
                <small v-if="task.error" class="error">{{ task.error }}</small>
                <small v-if="task.targetPath && task.status === 'completed'" class="path">
                  {{ task.targetPath }}
                </small>
              </div>
              <div class="provider-download-item-actions">
                <button
                  v-if="task.status === 'failed' || task.status === 'cancelled'"
                  type="button"
                  class="soft-button"
                  @click="emit('retry', task.id)"
                >
                  重试
                </button>
                <button
                  v-if="task.status !== 'completed' && task.status !== 'cancelled'"
                  type="button"
                  class="muted-button"
                  @click="emit('cancel', task.id)"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <button
    v-if="activeDownloadTasks.length > 0 && !show"
    type="button"
    class="provider-download-fab"
    @click="emit('open')"
  >
    <i class="pi pi-download"></i>
    <span class="fab-badge">{{ activeDownloadTasks.length }}</span>
  </button>
</template>

<style scoped>
.provider-download-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.provider-download-panel {
  width: min(560px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--te-panel-bg, #1e1e2e);
  border-radius: 16px;
  overflow: hidden;
}

.provider-download-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--te-border, rgba(255, 255, 255, 0.08));
}

.provider-download-panel-header h3 {
  margin: 0;
  font-size: 16px;
}

.provider-download-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--te-muted, rgba(255, 255, 255, 0.5));
  font-size: 13px;
}

.provider-download-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.provider-download-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--te-border, rgba(255, 255, 255, 0.04));
}

.provider-download-item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.provider-download-item-info strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-download-item-info span {
  font-size: 12px;
  color: var(--te-muted, rgba(255, 255, 255, 0.5));
}

.provider-download-item-info small {
  font-size: 11px;
  color: var(--te-muted, rgba(255, 255, 255, 0.4));
}

.provider-download-item-info small.error {
  color: var(--te-danger, #ef4444);
}

.provider-download-item-info small.path {
  word-break: break-all;
  font-family: monospace;
}

.provider-download-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.provider-download-fab {
  position: fixed;
  bottom: 80px;
  right: 24px;
  z-index: 900;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: var(--te-accent, #7c3aed);
  color: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s;
}

.provider-download-fab:hover {
  transform: scale(1.05);
}

.fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--te-danger, #ef4444);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.18s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}
</style>
