<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Track } from '../../types/music'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider'
import AnimatedInput from '../AnimatedInput.vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'

const props = defineProps<{
  showCreate: boolean
  showAdd: boolean
  newName: string
  createBusy: boolean
  createError: string
  addBusy: boolean
  addError: string
  addTracks: Track[]
  ownedUserPlaylists: MediaProviderPlaylistSummary[]
}>()

const emit = defineEmits<{
  'update:newName': [value: string]
  closeCreate: []
  confirmCreate: []
  closeAdd: []
  convertAddToCreate: []
  confirmAdd: [playlist: MediaProviderPlaylistSummary]
}>()

const createDialogRef = ref<HTMLElement | null>(null)
const addDialogRef = ref<HTMLElement | null>(null)

const newName = computed({
  get: () => props.newName,
  set: (value: string) => emit('update:newName', value)
})

function closeCreate(): void {
  if (props.createBusy) return
  emit('closeCreate')
}

function closeAdd(): void {
  if (props.addBusy) return
  emit('closeAdd')
}

useEscapeToClose(() => props.showCreate, closeCreate)
useFocusTrap(createDialogRef, () => props.showCreate)
useEscapeToClose(() => props.showAdd, closeAdd)
useFocusTrap(addDialogRef, () => props.showAdd)
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="showCreate" class="ncm-playlist-dialog-overlay" @click.self="closeCreate">
        <div
          ref="createDialogRef"
          class="ncm-playlist-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="创建歌单"
        >
          <h3>创建网易云歌单</h3>
          <AnimatedInput
            v-model="newName"
            type="text"
            class="ncm-playlist-name-input"
            maxlength="50"
            placeholder="请输入歌单名称"
            :disabled="createBusy"
            autofocus
            @keyup.enter="emit('confirmCreate')"
          />
          <p v-if="createError" class="ncm-playlist-dialog-error">{{ createError }}</p>
          <div class="ncm-playlist-dialog-actions">
            <button type="button" :disabled="createBusy" @click="closeCreate">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="createBusy || !newName.trim()"
              @click="emit('confirmCreate')"
            >
              {{ createBusy ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="showAdd" class="ncm-playlist-dialog-overlay" @click.self="closeAdd">
        <div
          ref="addDialogRef"
          class="ncm-playlist-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="添加到歌单"
        >
          <h3>添加到网易云歌单</h3>
          <p class="ncm-playlist-dialog-hint">已选 {{ addTracks.length }} 首，选择目标歌单</p>
          <div class="ncm-playlist-picker">
            <button
              type="button"
              class="ncm-playlist-picker-item create"
              :disabled="addBusy"
              @click="emit('convertAddToCreate')"
            >
              <i class="pi pi-plus"></i>
              <span>新建歌单并添加</span>
            </button>
            <button
              v-for="playlist in ownedUserPlaylists"
              :key="playlist.id"
              type="button"
              class="ncm-playlist-picker-item"
              :disabled="addBusy"
              @click="emit('confirmAdd', playlist)"
            >
              <img v-if="playlist.cover" :src="playlist.cover" alt="" />
              <i v-else class="pi pi-list"></i>
              <span>
                <strong>{{ playlist.name }}</strong>
                <small>{{ playlist.trackCount ?? 0 }} 首</small>
              </span>
            </button>
            <p v-if="ownedUserPlaylists.length === 0" class="ncm-playlist-dialog-hint">
              暂无自建歌单，可先新建一个
            </p>
          </div>
          <p v-if="addError" class="ncm-playlist-dialog-error">{{ addError }}</p>
          <div class="ncm-playlist-dialog-actions">
            <button type="button" :disabled="addBusy" @click="closeAdd">取消</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ncm-playlist-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  padding: 24px;
}

.ncm-playlist-dialog {
  width: min(420px, 100%);
  max-height: min(78vh, 640px);
  overflow: auto;
  border-radius: 20px;
  background: var(--te-card-bg, #fff);
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.25));
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.22);
  padding: 22px;
}

.ncm-playlist-dialog h3 {
  margin: 0 0 14px;
  font-size: 18px;
  font-weight: 800;
  color: var(--te-neutral-900, #0f172a);
}

.ncm-playlist-dialog .ncm-playlist-name-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.35));
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
  background: var(--te-subtle-bg, #f8fafc);
  color: var(--te-neutral-900, #0f172a);
  --ai-placeholder: var(--te-neutral-500, #64748b);
}

.ncm-playlist-dialog-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--te-neutral-500, #64748b);
}

.ncm-playlist-dialog-error {
  margin: 10px 0 0;
  font-size: 12px;
  color: #e11d48;
}

.ncm-playlist-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.ncm-playlist-dialog-actions button {
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.35));
  background: var(--te-subtle-bg, #f8fafc);
  color: var(--te-neutral-700, #334155);
  border-radius: 999px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.ncm-playlist-dialog-actions button.primary {
  border-color: transparent;
  background: var(--te-primary-500, #6366f1);
  color: #fff;
}

.ncm-playlist-dialog-actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ncm-playlist-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}

.ncm-playlist-picker-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.28));
  background: var(--te-subtle-bg, #f8fafc);
  border-radius: 14px;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  color: var(--te-neutral-800, #1e293b);
}

.ncm-playlist-picker-item.create {
  border-style: dashed;
  color: var(--te-primary-600, #4f46e5);
  font-weight: 700;
}

.ncm-playlist-picker-item img,
.ncm-playlist-picker-item > i {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.1);
}

.ncm-playlist-picker-item span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ncm-playlist-picker-item strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ncm-playlist-picker-item small {
  font-size: 12px;
  color: var(--te-neutral-500, #64748b);
}

.ncm-playlist-picker-item:hover:not(:disabled) {
  border-color: rgba(var(--te-primary-rgb, 99, 102, 241), 0.4);
  background: rgba(var(--te-primary-rgb, 99, 102, 241), 0.08);
}

.ncm-playlist-picker-item:disabled {
  opacity: 0.55;
  cursor: wait;
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
