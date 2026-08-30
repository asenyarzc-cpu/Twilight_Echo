<script setup lang="ts">
import { computed } from 'vue'
import type { NcmCloudSelectedFile } from '../../../shared/ncmCloud.ts'
import type { NcmCloudSong, NcmCloudTransferTask } from '../stores/useNcmStore.ts'

const props = defineProps<{
  songs: NcmCloudSong[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string
  selectedFiles: NcmCloudSelectedFile[]
  transferTasks: Record<string, NcmCloudTransferTask>
  currentTrackId?: string | null
}>()

const emit = defineEmits<{
  refresh: []
  loadMore: []
  chooseFiles: []
  upload: [handle: string]
  removeSelected: [handle: string]
  play: [song: NcmCloudSong]
  playAll: []
  download: [song: NcmCloudSong]
  cancel: [transferId: string]
}>()

const tasks = computed(() => Object.values(props.transferTasks))
const visibleTasks = computed(() =>
  tasks.value
    .filter(
      (task) =>
        task.kind === 'download' || !props.selectedFiles.some((file) => file.handle === task.handle)
    )
    .reverse()
    .slice(0, 8)
)

function isActive(task?: NcmCloudTransferTask): boolean {
  return !!task && !['completed', 'failed', 'cancelled'].includes(task.stage)
}

function preferredTask(
  predicate: (task: NcmCloudTransferTask) => boolean
): NcmCloudTransferTask | undefined {
  const matches = tasks.value.filter(predicate)
  return matches.find(isActive) ?? matches.at(-1)
}

function taskForHandle(handle: string): NcmCloudTransferTask | undefined {
  return preferredTask((task) => task.kind === 'upload' && task.handle === handle)
}

function taskForSong(song: NcmCloudSong): NcmCloudTransferTask | undefined {
  return preferredTask(
    (task) => task.kind === 'download' && String(task.cloudSongId) === String(song.cloudSongId)
  )
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知大小'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${unit}`
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

function formatDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '添加时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(timestamp))
}

function progressLabel(task: NcmCloudTransferTask): string {
  if (task.percent != null) {
    return `${task.message} · ${task.percent}% · ${formatBytes(task.bytesTransferred)} / ${formatBytes(task.bytesTotal)}`
  }
  return `${task.message} · ${formatBytes(task.bytesTransferred)}`
}
</script>

<template>
  <section class="cloud-panel" aria-labelledby="ncm-cloud-title">
    <div class="cloud-header">
      <div>
        <span class="cloud-kicker">网易云音乐</span>
        <h2 id="ncm-cloud-title">我的音乐云盘</h2>
        <p>{{ total }} 首云盘歌曲 · 上传与下载均由主进程安全处理</p>
      </div>
      <div class="cloud-header-actions">
        <button
          type="button"
          class="cloud-button secondary"
          :disabled="loading"
          @click="emit('refresh')"
        >
          <i :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'"></i>
          刷新
        </button>
        <button type="button" class="cloud-button primary" @click="emit('chooseFiles')">
          <i class="pi pi-upload"></i>
          选择音频
        </button>
      </div>
    </div>

    <div v-if="selectedFiles.length > 0" class="upload-queue">
      <div class="queue-heading">
        <div>
          <h3>待上传文件</h3>
          <p>一次最多选择 20 个文件，文件路径不会暴露给页面。</p>
        </div>
      </div>
      <article v-for="file in selectedFiles" :key="file.handle" class="transfer-row">
        <span class="transfer-icon"><i class="pi pi-file"></i></span>
        <div class="transfer-copy">
          <strong>{{ file.name }}</strong>
          <span>{{ (file.format || '音频').toUpperCase() }} · {{ formatBytes(file.size) }}</span>
          <div v-if="taskForHandle(file.handle)" class="progress-copy">
            <div class="progress-track">
              <span
                :style="{
                  transform: `scaleX(${(taskForHandle(file.handle)?.percent ?? 12) / 100})`
                }"
              ></span>
            </div>
            <small>{{ progressLabel(taskForHandle(file.handle)!) }}</small>
            <small v-if="taskForHandle(file.handle)?.error" class="task-error">
              {{ taskForHandle(file.handle)?.error }}
            </small>
          </div>
        </div>
        <div class="transfer-actions">
          <button
            v-if="isActive(taskForHandle(file.handle))"
            type="button"
            class="icon-button danger"
            title="取消上传"
            @click="emit('cancel', taskForHandle(file.handle)!.transferId)"
          >
            <i class="pi pi-times"></i>
          </button>
          <template v-else>
            <button
              type="button"
              class="icon-button"
              title="移除"
              @click="emit('removeSelected', file.handle)"
            >
              <i class="pi pi-trash"></i>
            </button>
            <button
              type="button"
              class="cloud-button compact primary"
              @click="emit('upload', file.handle)"
            >
              上传
            </button>
          </template>
        </div>
      </article>
    </div>

    <div v-if="error && songs.length === 0" class="cloud-state error-state">
      <i class="pi pi-exclamation-triangle"></i>
      <strong>云盘加载失败</strong>
      <p>{{ error }}</p>
      <button type="button" class="cloud-button primary" @click="emit('refresh')">重试</button>
    </div>

    <div v-else-if="loading && songs.length === 0" class="cloud-state">
      <i class="pi pi-spin pi-spinner"></i>
      <strong>正在加载云盘歌曲</strong>
      <p>正在从网易云音乐读取当前账号的云盘数据。</p>
    </div>

    <div v-else-if="songs.length === 0" class="cloud-state">
      <i class="pi pi-cloud"></i>
      <strong>云盘暂时为空</strong>
      <p>选择本地音频上传后，歌曲会出现在这里并复用现有播放器。</p>
      <button type="button" class="cloud-button primary" @click="emit('chooseFiles')">
        选择音频
      </button>
    </div>

    <template v-else>
      <div class="song-toolbar">
        <div>
          <strong>云盘歌曲</strong>
          <span>已加载 {{ songs.length }} / {{ total }}</span>
        </div>
        <button type="button" class="cloud-button primary" @click="emit('playAll')">
          <i class="pi pi-play"></i>
          播放全部
        </button>
      </div>

      <div class="cloud-song-list">
        <article
          v-for="song in songs"
          :key="String(song.cloudSongId)"
          class="cloud-song"
          :class="{ playing: song.track.id === currentTrackId }"
          tabindex="0"
          role="button"
          @click="emit('play', song)"
          @keydown.enter.prevent="emit('play', song)"
          @keydown.space.prevent="emit('play', song)"
        >
          <span class="song-cover">
            <img v-if="song.track.cover" :src="song.track.cover" alt="" />
            <i v-else class="pi pi-music"></i>
            <span class="cover-play"><i class="pi pi-play"></i></span>
          </span>
          <span class="song-main">
            <strong>{{ song.track.title }}</strong>
            <small
              >{{ song.track.artist || '未知艺术家' }} · {{ song.track.album || '未知专辑' }}</small
            >
            <small class="song-file">{{ song.fileName }}</small>
          </span>
          <span class="song-meta">
            <small>{{ (song.track.format || 'audio').toUpperCase() }}</small>
            <small>{{ formatBytes(song.track.size) }}</small>
          </span>
          <span class="song-meta secondary-meta">
            <small>{{ formatDuration(song.track.duration) }}</small>
            <small>{{ formatDate(song.addTime) }}</small>
          </span>
          <span class="song-actions">
            <button
              v-if="isActive(taskForSong(song))"
              type="button"
              class="icon-button danger"
              title="取消下载"
              @click.stop="emit('cancel', taskForSong(song)!.transferId)"
            >
              <i class="pi pi-times"></i>
            </button>
            <button
              v-else
              type="button"
              class="icon-button"
              title="下载"
              @click.stop="emit('download', song)"
            >
              <i class="pi pi-download"></i>
            </button>
          </span>
          <span v-if="taskForSong(song)" class="song-progress">
            <span
              :style="{ transform: `scaleX(${(taskForSong(song)?.percent ?? 12) / 100})` }"
            ></span>
          </span>
        </article>
      </div>

      <button
        v-if="hasMore"
        type="button"
        class="load-more"
        :disabled="loadingMore"
        @click="emit('loadMore')"
      >
        <i v-if="loadingMore" class="pi pi-spin pi-spinner"></i>
        {{ loadingMore ? '正在加载' : '加载更多' }}
      </button>
    </template>

    <div v-if="visibleTasks.length > 0" class="recent-transfers">
      <h3>最近传输</h3>
      <article v-for="task in visibleTasks" :key="task.transferId" class="recent-transfer">
        <i :class="task.kind === 'upload' ? 'pi pi-upload' : 'pi pi-download'"></i>
        <div>
          <strong>{{ task.fileName }}</strong>
          <small :class="{ 'task-error': task.stage === 'failed' }">
            {{ task.error || progressLabel(task) }}
          </small>
        </div>
        <button
          v-if="isActive(task)"
          type="button"
          class="icon-button danger"
          title="取消传输"
          @click="emit('cancel', task.transferId)"
        >
          <i class="pi pi-times"></i>
        </button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.cloud-panel {
  padding: 28px;
  border: 1px solid var(--te-card-border, rgba(255, 255, 255, 0.08));
  border-radius: 24px;
  background: var(--te-glass-bg-strong);
  box-shadow: var(--te-glass-shadow);
}
.cloud-header,
.song-toolbar,
.queue-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.cloud-kicker {
  color: var(--te-primary-500);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.cloud-header h2 {
  margin: 4px 0 5px;
  color: var(--te-neutral-900);
  font-size: 24px;
}
.cloud-header p,
.queue-heading p {
  margin: 0;
  color: var(--te-neutral-500);
  font-size: 13px;
}
.cloud-header-actions,
.transfer-actions,
.song-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cloud-button,
.icon-button,
.load-more {
  border: 0;
  cursor: pointer;
  transition: 0.2s ease;
}
.cloud-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 750;
}
.cloud-button.primary {
  color: #111;
  background: var(--te-primary-500);
}
.cloud-button.secondary {
  color: var(--te-neutral-700);
  background: var(--te-subtle-bg);
  border: 1px solid var(--te-card-border);
}
.cloud-button.compact {
  min-height: 34px;
  padding: 0 14px;
}
.cloud-button:hover:not(:disabled),
.load-more:hover:not(:disabled),
.icon-button:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.04);
}
.cloud-button:disabled,
.load-more:disabled {
  cursor: wait;
  opacity: 0.6;
}
.upload-queue,
.recent-transfers {
  margin-top: 24px;
  padding: 18px;
  border: 1px solid var(--te-card-border);
  border-radius: 18px;
  background: var(--te-subtle-bg);
}
.queue-heading h3,
.recent-transfers h3 {
  margin: 0 0 4px;
  color: var(--te-neutral-900);
  font-size: 16px;
}
.transfer-row,
.recent-transfer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 0;
  border-top: 1px solid var(--te-card-border);
}
.queue-heading + .transfer-row {
  margin-top: 12px;
}
.transfer-icon {
  display: grid;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 12px;
  color: var(--te-primary-500);
  background: rgba(var(--te-primary-rgb), 0.12);
}
.transfer-copy,
.recent-transfer > div {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.transfer-copy strong,
.recent-transfer strong {
  overflow: hidden;
  color: var(--te-neutral-900);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transfer-copy > span,
.recent-transfer small,
.progress-copy small {
  color: var(--te-neutral-500);
  font-size: 11px;
}
.progress-track {
  width: min(420px, 100%);
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.18);
}
.progress-track span,
.song-progress span {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--te-primary-500);
  transform: scaleX(0);
  transform-origin: 0 50%;
  transition: transform 0.2s linear;
}
.icon-button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 10px;
  color: var(--te-neutral-700);
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
}
.icon-button.danger,
.task-error {
  color: #fb7185 !important;
}
.cloud-state {
  display: flex;
  min-height: 220px;
  margin-top: 24px;
  padding: 32px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
  border: 1px dashed var(--te-card-border);
  border-radius: 18px;
  color: var(--te-neutral-500);
}
.cloud-state > i {
  margin-bottom: 14px;
  color: var(--te-primary-500);
  font-size: 34px;
}
.cloud-state strong {
  color: var(--te-neutral-900);
}
.cloud-state p {
  max-width: 520px;
  margin: 8px 0 18px;
  font-size: 13px;
}
.error-state > i {
  color: #fb7185;
}
.song-toolbar {
  margin: 28px 0 14px;
}
.song-toolbar > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.song-toolbar strong {
  color: var(--te-neutral-900);
  font-size: 17px;
}
.song-toolbar span {
  color: var(--te-neutral-500);
  font-size: 12px;
}
.cloud-song-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cloud-song {
  position: relative;
  display: grid;
  grid-template-columns: 48px minmax(180px, 1fr) 120px 130px 42px;
  align-items: center;
  gap: 14px;
  min-height: 68px;
  padding: 9px 12px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 14px;
  background: var(--te-subtle-bg);
  cursor: pointer;
  transition: 0.2s ease;
}
.cloud-song:hover,
.cloud-song:focus-visible,
.cloud-song.playing {
  border-color: rgba(var(--te-primary-rgb), 0.3);
  background: rgba(var(--te-primary-rgb), 0.09);
  outline: 0;
}
.song-cover {
  position: relative;
  display: grid;
  width: 48px;
  height: 48px;
  overflow: hidden;
  place-items: center;
  border-radius: 10px;
  color: var(--te-primary-500);
  background: var(--te-card-bg);
}
.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: white;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.2s;
}
.cloud-song:hover .cover-play,
.cloud-song.playing .cover-play {
  opacity: 1;
}
.song-main,
.song-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.song-main strong,
.song-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-main strong {
  color: var(--te-neutral-900);
  font-size: 14px;
}
.song-main small,
.song-meta small {
  color: var(--te-neutral-500);
  font-size: 11px;
}
.song-file {
  opacity: 0.72;
}
.song-progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.12);
}
.load-more {
  display: flex;
  width: 100%;
  min-height: 42px;
  margin-top: 14px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 12px;
  color: var(--te-neutral-700);
  background: var(--te-subtle-bg);
  border: 1px solid var(--te-card-border);
  font-weight: 700;
}
.recent-transfer > i {
  color: var(--te-primary-500);
}
@media (max-width: 900px) {
  .cloud-song {
    grid-template-columns: 48px minmax(160px, 1fr) 100px 42px;
  }
  .secondary-meta {
    display: none;
  }
}
@media (max-width: 680px) {
  .cloud-panel {
    padding: 18px;
  }
  .cloud-header,
  .song-toolbar,
  .queue-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .cloud-header-actions {
    width: 100%;
  }
  .cloud-header-actions .cloud-button {
    flex: 1;
  }
  .transfer-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .transfer-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .cloud-song {
    grid-template-columns: 48px minmax(0, 1fr) 38px;
  }
  .song-meta {
    display: none;
  }
}
</style>
