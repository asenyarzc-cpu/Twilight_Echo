<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { DuplicateDetectionResult } from '../../../shared/duplicateDetection.ts'
import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagPatch
} from '../../../shared/localLibraryTags.ts'
import type { Track } from '../types/music'
import {
  hasTagPatch,
  successfulTagPaths,
  summarizeTagWriteResults,
  tagPatchFromForm,
  toDuplicateReviewGroups,
  validateTagCoverFile,
  type DuplicateReviewGroup
} from '../utils/localLibraryTagManagement.ts'

const props = withDefaults(
  defineProps<{
    tracks: Track[]
    initialView?: 'edit' | 'duplicates'
  }>(),
  { initialView: 'edit' }
)

const emit = defineEmits<{
  close: []
  applied: [filePaths: string[], patch: LocalLibraryTagPatch]
}>()

const activeView = ref<'edit' | 'duplicates'>(props.initialView)
const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
let focusRestoreTarget: HTMLElement | null = null
const busy = ref(false)
const coverError = ref('')
const operationError = ref('')
const operationResults = ref<LocalLibraryTagOperationResult[]>([])
const duplicateResult = ref<DuplicateDetectionResult | null>(null)
const duplicateError = ref('')
const form = ref({
  title: undefined as string | undefined,
  artist: undefined as string | undefined,
  album: undefined as string | undefined,
  albumArtist: undefined as string | undefined,
  track: null as number | null,
  disc: null as number | null,
  year: null as number | null,
  genre: undefined as string | undefined,
  coverData: undefined as Uint8Array | undefined,
  coverName: ''
})

const selectedLocalTracks = computed(() => props.tracks.filter((track) => track.filePath))
const summary = computed(() => summarizeTagWriteResults(operationResults.value))
const reviewGroups = computed<DuplicateReviewGroup[]>(() =>
  duplicateResult.value ? toDuplicateReviewGroups(duplicateResult.value) : []
)
const hasPatch = computed(() => hasTagPatch(toPatch()))
const canWrite = computed(
  () => !busy.value && selectedLocalTracks.value.length > 0 && hasPatch.value && !coverError.value
)

watch(
  () => props.tracks,
  (tracks) => {
    if (tracks.length !== 1) {
      form.value.title = undefined
      form.value.artist = undefined
      form.value.album = undefined
      form.value.albumArtist = undefined
      form.value.genre = undefined
      return
    }
    const [track] = tracks
    form.value.title = track.title
    form.value.artist = track.artist
    form.value.album = track.album
    form.value.albumArtist = track.albumArtist ?? ''
    form.value.genre = track.genre ?? ''
  },
  { immediate: true }
)

function toPatch(): LocalLibraryTagPatch {
  return tagPatchFromForm({
    title: form.value.title,
    artist: form.value.artist,
    album: form.value.album,
    albumArtist: form.value.albumArtist,
    track: form.value.track ?? undefined,
    disc: form.value.disc ?? undefined,
    year: form.value.year ?? undefined,
    genre: form.value.genre,
    coverData: form.value.coverData
  })
}

async function onCoverInput(event: Event): Promise<void> {
  coverError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const validation = validateTagCoverFile(file)
  if (validation) {
    form.value.coverData = undefined
    form.value.coverName = ''
    coverError.value = validation
    input.value = ''
    return
  }
  try {
    form.value.coverData = new Uint8Array(await file.arrayBuffer())
    form.value.coverName = file.name
  } catch {
    form.value.coverData = undefined
    form.value.coverName = ''
    coverError.value = '无法读取封面文件'
  }
}

async function submitTagWrite(): Promise<void> {
  const patch = toPatch()
  if (!hasTagPatch(patch) || selectedLocalTracks.value.length === 0 || busy.value) return
  busy.value = true
  operationError.value = ''
  operationResults.value = []
  try {
    const result = await window.api.library.writeTags({
      items: selectedLocalTracks.value.map((track) => ({ filePath: track.filePath, ...patch }))
    })
    operationResults.value = result.items
    const successful = successfulTagPaths(result.items)
    if (successful.length > 0) emit('applied', successful, patch)
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '标签写入失败'
  } finally {
    busy.value = false
  }
}

async function restoreFromJournal(): Promise<void> {
  if (busy.value) return
  busy.value = true
  operationError.value = ''
  try {
    const result = await window.api.library.restoreTags({ fromJournal: true })
    operationResults.value = result.items
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '无法从恢复日志还原标签'
  } finally {
    busy.value = false
  }
}

async function loadDuplicates(): Promise<void> {
  if (busy.value) return
  busy.value = true
  duplicateError.value = ''
  try {
    duplicateResult.value = await window.api.library.detectDuplicates()
  } catch (error) {
    duplicateError.value = error instanceof Error ? error.message : '重复歌曲检查失败'
  } finally {
    busy.value = false
  }
}

function switchView(view: 'edit' | 'duplicates'): void {
  activeView.value = view
  if (view === 'duplicates' && !duplicateResult.value) void loadDuplicates()
}

function focusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return [
    ...dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ].filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
}

function restoreTriggerFocus(): void {
  const target = focusRestoreTarget
  focusRestoreTarget = null
  if (target?.isConnected) target.focus()
}

function requestClose(): void {
  emit('close')
  void nextTick(restoreTriggerFocus)
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex === -1 || currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1
  event.preventDefault()
  focusable[nextIndex].focus()
}

function onTabKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const nextView = activeView.value === 'edit' ? 'duplicates' : 'edit'
  switchView(nextView)
  void nextTick(() => document.getElementById(`tag-manager-${nextView}-tab`)?.focus())
}

onMounted(() => {
  const activeElement = document.activeElement
  focusRestoreTarget = activeElement instanceof HTMLElement ? activeElement : null
  void nextTick(() => closeButtonRef.value?.focus())
})
</script>

<template>
  <section
    ref="dialogRef"
    class="tag-manager"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tag-manager-title"
    @keydown="onDialogKeydown"
  >
    <header class="tag-manager-header">
      <div>
        <h3 id="tag-manager-title">标签与重复歌曲</h3>
        <p>{{ selectedLocalTracks.length }} 首本地歌曲已选中</p>
      </div>
      <button
        ref="closeButtonRef"
        type="button"
        class="tag-icon-button"
        aria-label="关闭标签管理"
        title="关闭"
        @click="requestClose"
      >
        <i class="pi pi-times"></i>
      </button>
    </header>

    <div class="tag-manager-tabs" role="tablist" aria-label="标签管理视图">
      <button
        type="button"
        id="tag-manager-edit-tab"
        role="tab"
        aria-controls="tag-manager-edit-panel"
        :aria-selected="activeView === 'edit'"
        :tabindex="activeView === 'edit' ? 0 : -1"
        @click="switchView('edit')"
        @keydown="onTabKeydown"
      >
        编辑标签
      </button>
      <button
        type="button"
        id="tag-manager-duplicates-tab"
        role="tab"
        aria-controls="tag-manager-duplicates-panel"
        :aria-selected="activeView === 'duplicates'"
        :tabindex="activeView === 'duplicates' ? 0 : -1"
        @click="switchView('duplicates')"
        @keydown="onTabKeydown"
      >
        重复检查
      </button>
    </div>

    <p class="tag-manager-live" aria-live="polite" aria-atomic="true">
      <template v-if="busy">正在处理，请勿关闭此窗口。</template>
      <template v-else-if="operationError">{{ operationError }}</template>
      <template v-else-if="operationResults.length">
        已成功 {{ summary.successCount }} 项；失败 {{ summary.failedCount }} 项；已回滚
        {{ summary.rolledBackCount }} 项；未执行 {{ summary.notAttemptedCount }} 项。
      </template>
    </p>

    <form
      v-if="activeView === 'edit'"
      id="tag-manager-edit-panel"
      class="tag-editor"
      role="tabpanel"
      aria-labelledby="tag-manager-edit-tab"
      @submit.prevent="submitTagWrite"
    >
      <p class="tag-help">批量写入只会覆盖填写的字段。每次写入都先创建可恢复备份。</p>
      <div class="tag-form-grid">
        <label>标题<input v-model="form.title" maxlength="1024" /></label>
        <label>歌手<input v-model="form.artist" maxlength="1024" /></label>
        <label>专辑<input v-model="form.album" maxlength="1024" /></label>
        <label>专辑歌手<input v-model="form.albumArtist" maxlength="1024" /></label>
        <label>曲目号<input v-model.number="form.track" type="number" min="1" max="9999" /></label>
        <label>碟号<input v-model.number="form.disc" type="number" min="1" max="9999" /></label>
        <label>年份<input v-model.number="form.year" type="number" min="1" max="9999" /></label>
        <label>流派<input v-model="form.genre" maxlength="1024" /></label>
        <label class="tag-cover-input"
          >封面
          <input accept="image/png,image/jpeg" type="file" @change="onCoverInput" />
          <span v-if="form.coverName">{{ form.coverName }}</span>
        </label>
      </div>
      <p v-if="coverError" class="tag-field-error" role="alert">{{ coverError }}</p>
      <div class="tag-actions">
        <button
          type="button"
          class="tag-secondary-button"
          :disabled="busy"
          @click="restoreFromJournal"
        >
          从恢复日志还原
        </button>
        <button type="submit" class="tag-primary-button" :disabled="!canWrite" :aria-busy="busy">
          {{ busy ? '正在写入' : `写入 ${selectedLocalTracks.length} 首` }}
        </button>
      </div>
    </form>

    <section
      v-else
      id="tag-manager-duplicates-panel"
      class="duplicate-review"
      role="tabpanel"
      aria-labelledby="tag-manager-duplicates-tab"
    >
      <div class="tag-actions">
        <p>仅展示建议，不会删除文件、合并条目或修改标签。</p>
        <button type="button" class="tag-secondary-button" :disabled="busy" @click="loadDuplicates">
          重新检查
        </button>
      </div>
      <p v-if="duplicateError" class="tag-field-error" role="alert">{{ duplicateError }}</p>
      <p v-else-if="busy" class="tag-help">正在读取本地音乐库并计算重复项。</p>
      <p v-else-if="duplicateResult && reviewGroups.length === 0" class="tag-help">
        未发现需要复核的重复歌曲。
      </p>
      <div v-else class="duplicate-groups">
        <article v-for="review in reviewGroups" :key="review.group.key" class="duplicate-group">
          <header>
            <strong>{{ review.label }}</strong>
            <span>{{ review.group.items.length }} 个候选</span>
          </header>
          <ul>
            <li v-for="track in review.group.items" :key="track.id">
              <span>{{ track.title || track.filePath }}</span>
              <small :title="track.filePath">{{ track.artist }} · {{ track.filePath }}</small>
            </li>
          </ul>
          <p v-if="review.suggestion" class="duplicate-suggestion">需要人工确认的只读合并建议</p>
        </article>
      </div>
    </section>

    <details v-if="operationResults.length" class="tag-operation-details">
      <summary>查看逐项结果</summary>
      <ul>
        <li
          v-for="result in operationResults"
          :key="`${result.filePath}:${result.status}`"
          :class="`tag-result-${result.status}`"
        >
          <strong>{{ result.status }}</strong
          ><span :title="result.filePath">{{ result.filePath }}</span
          ><small v-if="result.message">{{ result.message }}</small>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.tag-manager {
  width: min(760px, calc(100vw - 32px));
  max-height: min(780px, calc(100vh - 48px));
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--te-glass-border, #dce0e8);
  border-radius: 8px;
  background: var(--te-glass-bg-strong, #fff);
  color: var(--te-neutral-900, #1b1b1b);
  box-shadow: 0 24px 64px rgba(24, 28, 42, 0.28);
}
.tag-manager-header,
.tag-actions,
.duplicate-group header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.tag-manager-header h3 {
  margin: 0;
  font-size: 18px;
}
.tag-manager-header p,
.tag-help,
.tag-manager-live,
.duplicate-group header span {
  color: var(--te-neutral-600, #657084);
  font-size: 12px;
}
.tag-manager-header p {
  margin: 4px 0 0;
}
.tag-icon-button {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.tag-icon-button:hover {
  background: rgba(0, 0, 0, 0.07);
}
.tag-manager-tabs {
  display: flex;
  gap: 4px;
  margin: 18px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.22);
}
.tag-manager-tabs button {
  border: 0;
  padding: 8px 10px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.tag-manager-tabs button[aria-selected='true'] {
  color: var(--te-primary-600, #6345d5);
  border-bottom: 2px solid currentColor;
  font-weight: 700;
}
.tag-manager-live {
  min-height: 18px;
  margin: 8px 0;
}
.tag-editor {
  display: grid;
  gap: 12px;
}
.tag-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.tag-form-grid label {
  display: grid;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
}
.tag-form-grid input {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 4px;
  padding: 6px 8px;
  font: inherit;
}
.tag-cover-input {
  grid-column: 1 / -1;
}
.tag-cover-input span {
  color: var(--te-neutral-600, #657084);
  font-weight: 400;
}
.tag-field-error {
  margin: 0;
  color: #b42318;
  font-size: 12px;
}
.tag-actions {
  margin-top: 8px;
}
.tag-actions p {
  margin: 0;
  color: var(--te-neutral-600, #657084);
  font-size: 12px;
}
.tag-primary-button,
.tag-secondary-button {
  min-height: 36px;
  border-radius: 5px;
  padding: 7px 12px;
  font: inherit;
  cursor: pointer;
}
.tag-primary-button {
  border: 1px solid #6845de;
  background: #6845de;
  color: #fff;
}
.tag-secondary-button {
  border: 1px solid rgba(104, 69, 222, 0.36);
  background: transparent;
  color: #5635bb;
}
.tag-primary-button:disabled,
.tag-secondary-button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.duplicate-groups {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}
.duplicate-group {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6px;
  padding: 12px;
}
.duplicate-group header strong {
  font-size: 13px;
}
.duplicate-group ul,
.tag-operation-details ul {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.duplicate-group li {
  display: grid;
  gap: 2px;
  padding-top: 6px;
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}
.duplicate-group small,
.tag-operation-details small {
  overflow: hidden;
  color: var(--te-neutral-600, #657084);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.duplicate-suggestion {
  margin: 10px 0 0;
  color: #875a00;
  font-size: 12px;
}
.tag-operation-details {
  margin-top: 16px;
}
.tag-operation-details summary {
  cursor: pointer;
  font-weight: 600;
}
.tag-operation-details li {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
}
.tag-operation-details span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-operation-details small {
  grid-column: 2;
}
.tag-result-success strong {
  color: #18794e;
}
.tag-result-failed strong,
.tag-result-rolledBack strong {
  color: #b42318;
}
.tag-result-notAttempted strong {
  color: #875a00;
}
@media (max-width: 560px) {
  .tag-form-grid {
    grid-template-columns: 1fr;
  }
  .tag-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .tag-actions button {
    width: 100%;
  }
}
</style>
