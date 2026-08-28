<script setup lang="ts">
import { computed, ref } from 'vue'
import type { GlobalShortcutSettings, PlayerShortcutStatus } from '../../types/settings'

type BindingKey = keyof GlobalShortcutSettings
type StatusTone = 'idle' | 'ok' | 'failed'

const props = defineProps<{
  globalShortcuts: boolean
  shortcutStatuses: PlayerShortcutStatus[]
  shortcutBindings: GlobalShortcutSettings
}>()

const emit = defineEmits<{
  'update:globalShortcuts': [value: boolean]
  'update:shortcutBindings': [patch: Partial<GlobalShortcutSettings>]
}>()

/** 与 src/main/core/settings.ts 的 DEFAULT_GLOBAL_SHORTCUT_BINDINGS 保持一致。 */
const DEFAULT_BINDINGS: GlobalShortcutSettings = {
  previous: 'CommandOrControl+Alt+Left',
  next: 'CommandOrControl+Alt+Right',
  playPause: 'CommandOrControl+Alt+Space',
  toggleDesktopLyrics: 'CommandOrControl+Alt+D',
  toggleDesktopLyricsLock: 'CommandOrControl+Alt+L'
}

const EDITABLE_BINDINGS: { key: BindingKey; label: string }[] = [
  { key: 'previous', label: '上一首' },
  { key: 'next', label: '下一首' },
  { key: 'playPause', label: '播放 / 暂停' },
  { key: 'toggleDesktopLyrics', label: '桌面歌词' },
  { key: 'toggleDesktopLyricsLock', label: '锁定 / 解锁桌面歌词' }
]

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)

const KEY_LABELS: Record<string, string> = {
  CommandOrControl: IS_MAC ? '⌘' : 'Ctrl',
  Command: '⌘',
  Cmd: '⌘',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: IS_MAC ? '⌥' : 'Alt',
  Option: '⌥',
  Shift: IS_MAC ? '⇧' : 'Shift',
  Meta: IS_MAC ? '⌘' : 'Win',
  Super: IS_MAC ? '⌘' : 'Win',
  Space: '空格',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓'
}

const recordingKey = ref<BindingKey | null>(null)
const conflictBinding = ref<BindingKey | null>(null)
const conflictWith = ref<BindingKey | null>(null)

const bindingValues = computed<Record<BindingKey, string>>(() => ({
  previous: props.shortcutBindings.previous,
  next: props.shortcutBindings.next,
  playPause: props.shortcutBindings.playPause,
  toggleDesktopLyrics: props.shortcutBindings.toggleDesktopLyrics,
  toggleDesktopLyricsLock: props.shortcutBindings.toggleDesktopLyricsLock
}))

/** 自定义组合键与媒体键共用 action，靠 Media 前缀区分两组状态。 */
const customStatuses = computed(() =>
  props.shortcutStatuses.filter((status) => !status.accelerator.startsWith('Media'))
)

const mediaStatuses = computed(() =>
  props.shortcutStatuses.filter((status) => status.accelerator.startsWith('Media'))
)

const modifiedKeys = computed(() =>
  EDITABLE_BINDINGS.filter(
    (item) => bindingValues.value[item.key] !== DEFAULT_BINDINGS[item.key]
  ).map((item) => item.key)
)

const failedStatuses = computed(() =>
  props.globalShortcuts ? props.shortcutStatuses.filter((status) => !status.registered) : []
)

const statusSummary = computed<{ tone: StatusTone; text: string }>(() => {
  if (!props.globalShortcuts) {
    return { tone: 'idle', text: '快捷键状态：已关闭，上方组合键当前不会向系统注册。' }
  }
  if (props.shortcutStatuses.length === 0) {
    return { tone: 'idle', text: '快捷键状态：读取中…' }
  }
  if (failedStatuses.value.length > 0) {
    const detail = failedStatuses.value
      .map((status) => `${status.label}（${status.error || '注册失败'}）`)
      .join('；')
    return {
      tone: 'failed',
      text: `快捷键状态：${failedStatuses.value.length} 项注册失败 — ${detail}`
    }
  }
  return { tone: 'ok', text: `快捷键状态：${props.shortcutStatuses.length} 项已全部注册。` }
})

const conflictTip = computed(() => {
  if (!conflictBinding.value) return ''
  const other = EDITABLE_BINDINGS.find((item) => item.key === conflictWith.value)
  return other ? `与「${other.label}」的组合键重复，已保留原值` : '与其他快捷键冲突，已保留原值'
})

function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+').map((part) => KEY_LABELS[part] ?? part)
  return IS_MAC ? parts.join('') : parts.join('+')
}

function statusToneOf(status: PlayerShortcutStatus | undefined): StatusTone {
  if (!props.globalShortcuts || !status) return 'idle'
  return status.registered ? 'ok' : 'failed'
}

function statusTitleOf(status: PlayerShortcutStatus | undefined): string {
  if (!props.globalShortcuts) return '全局快捷键已关闭'
  if (!status) return '状态读取中'
  return status.registered ? '已注册' : status.error || '注册失败'
}

function customStatusOf(key: BindingKey): PlayerShortcutStatus | undefined {
  return customStatuses.value.find((status) => status.action === key)
}

function mediaLabelOf(label: string): string {
  return label.replace('（媒体键）', '')
}

function onToggle(): void {
  emit('update:globalShortcuts', !props.globalShortcuts)
}

function findConflict(key: BindingKey, accelerator: string): BindingKey | null {
  for (const [otherKey, value] of Object.entries(bindingValues.value) as [BindingKey, string][]) {
    if (otherKey === key) continue
    if (value === accelerator) return otherKey
  }
  return null
}

function handleShortcutKeydown(key: BindingKey, event: KeyboardEvent): void {
  // Tab 留给焦点移动，Esc 退出录制，其余按键都进入组合键捕获。
  if (event.key === 'Tab') return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    recordingKey.value = null
    const target = event.currentTarget as HTMLElement | null
    target?.blur()
    return
  }

  const parts: string[] = []
  if (event.ctrlKey) parts.push('CommandOrControl')
  if (event.metaKey && !event.ctrlKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const keyName = event.key
  if (
    keyName === 'Control' ||
    keyName === 'Meta' ||
    keyName === 'Alt' ||
    keyName === 'Shift' ||
    keyName === 'CapsLock'
  ) {
    return
  }

  let mainKey: string
  if (keyName === ' ') {
    mainKey = 'Space'
  } else if (keyName === 'ArrowLeft') {
    mainKey = 'Left'
  } else if (keyName === 'ArrowRight') {
    mainKey = 'Right'
  } else if (keyName === 'ArrowUp') {
    mainKey = 'Up'
  } else if (keyName === 'ArrowDown') {
    mainKey = 'Down'
  } else if (keyName.startsWith('F') && /^F\d{1,2}$/.test(keyName)) {
    mainKey = keyName
  } else if (keyName.length === 1) {
    mainKey = keyName.toUpperCase()
  } else {
    mainKey = keyName
  }

  const isFunctionKey = /^F\d{1,2}$/.test(mainKey)
  if (
    !/^[A-Za-z0-9]$/.test(mainKey) &&
    !isFunctionKey &&
    !/^(Left|Right|Up|Down|Space)$/.test(mainKey)
  ) {
    // Unsupported key; skip silently
    return
  }
  // 录制按钮本身要用空格/回车激活，且裸键不该被全局占用：F1-F24 之外必须带修饰键。
  if (parts.length === 0 && !isFunctionKey) return

  applyBinding(key, [...parts, mainKey].join('+'))
}

function applyBinding(key: BindingKey, accelerator: string): void {
  const trimmed = accelerator.trim()
  if (!trimmed) return
  const conflict = findConflict(key, trimmed)
  conflictBinding.value = conflict ? key : null
  conflictWith.value = conflict
  if (conflict) return
  if (bindingValues.value[key] === trimmed) return
  emit('update:shortcutBindings', { [key]: trimmed })
}

function resetBinding(key: BindingKey): void {
  const conflict = findConflict(key, DEFAULT_BINDINGS[key])
  conflictBinding.value = conflict ? key : null
  conflictWith.value = conflict
  if (conflict) return
  emit('update:shortcutBindings', { [key]: DEFAULT_BINDINGS[key] })
}

function resetAllBindings(): void {
  conflictBinding.value = null
  conflictWith.value = null
  emit('update:shortcutBindings', { ...DEFAULT_BINDINGS })
}

function onRecorderFocus(key: BindingKey): void {
  recordingKey.value = key
  conflictBinding.value = null
  conflictWith.value = null
}

function onRecorderBlur(key: BindingKey): void {
  if (recordingKey.value === key) recordingKey.value = null
}
</script>

<template>
  <section id="shortcuts" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-key"></i>
      <h2>快捷键</h2>
    </div>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>全局快捷键 (Global Shortcuts)</strong>
          <span>应用位于后台时，依然响应下方组合键与系统媒体键。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: globalShortcuts, inactive: !globalShortcuts }"
          role="switch"
          :aria-checked="globalShortcuts"
          @click="onToggle"
        ></span>
      </div>
    </div>

    <div class="shortcut-panel">
      <div class="shortcut-panel-head">
        <h3>自定义组合键</h3>
        <span class="shortcut-panel-hint">点击右侧按钮后直接按下组合键，Esc 取消</span>
        <button
          v-if="modifiedKeys.length > 0"
          type="button"
          class="shortcut-ghost-button"
          @click="resetAllBindings"
        >
          全部恢复默认
        </button>
      </div>
      <ul class="shortcut-rows">
        <li
          v-for="item in EDITABLE_BINDINGS"
          :key="item.key"
          class="shortcut-row"
          :class="{ conflict: conflictBinding === item.key }"
        >
          <span
            class="shortcut-state"
            :class="statusToneOf(customStatusOf(item.key))"
            :title="statusTitleOf(customStatusOf(item.key))"
          ></span>
          <span class="shortcut-label">{{ item.label }}</span>
          <button
            v-if="modifiedKeys.includes(item.key)"
            type="button"
            class="shortcut-revert"
            :title="`恢复默认 ${formatAccelerator(DEFAULT_BINDINGS[item.key])}`"
            :aria-label="`${item.label}：恢复默认组合键`"
            @click="resetBinding(item.key)"
          >
            <i class="pi pi-undo"></i>
          </button>
          <button
            type="button"
            class="shortcut-key"
            :class="{ recording: recordingKey === item.key }"
            :aria-label="`自定义全局快捷键：${item.label}`"
            :aria-pressed="recordingKey === item.key"
            :title="bindingValues[item.key]"
            @focus="onRecorderFocus(item.key)"
            @blur="onRecorderBlur(item.key)"
            @keydown="handleShortcutKeydown(item.key, $event)"
          >
            {{
              recordingKey === item.key ? '按下组合键…' : formatAccelerator(bindingValues[item.key])
            }}
          </button>
        </li>
      </ul>
      <p v-if="conflictBinding" class="shortcut-note failed">{{ conflictTip }}</p>
    </div>

    <div v-if="mediaStatuses.length > 0" class="shortcut-panel">
      <div class="shortcut-panel-head">
        <h3>系统媒体键</h3>
        <span class="shortcut-panel-hint">键盘与耳机上的播放控制键，固定绑定</span>
      </div>
      <ul class="shortcut-rows">
        <li v-for="status in mediaStatuses" :key="status.accelerator" class="shortcut-row">
          <span
            class="shortcut-state"
            :class="statusToneOf(status)"
            :title="statusTitleOf(status)"
          ></span>
          <span class="shortcut-label">{{ mediaLabelOf(status.label) }}</span>
          <kbd class="shortcut-key static">{{ status.accelerator }}</kbd>
        </li>
      </ul>
    </div>

    <p class="shortcut-note" :class="statusSummary.tone">{{ statusSummary.text }}</p>
  </section>
</template>

<style scoped>
.shortcut-panel {
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-subtle-bg);
}

.shortcut-panel-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 6px;
}

.shortcut-panel-head h3 {
  margin: 0;
  color: var(--te-settings-text);
  font-size: 13px;
  font-weight: 600;
}

.shortcut-panel-hint {
  flex: 1 1 auto;
  color: var(--te-settings-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.shortcut-ghost-button {
  flex: 0 0 auto;
  padding: 3px 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 999px;
  background: var(--te-card-bg);
  color: var(--te-settings-text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
}

.shortcut-ghost-button:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}

.shortcut-rows {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(276px, 1fr));
  gap: 2px 20px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 34px;
  padding: 0 4px;
  border-radius: 8px;
}

.shortcut-row.conflict {
  background: var(--te-danger-soft-bg);
}

.shortcut-state {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-settings-text-muted) 45%, transparent);
}

.shortcut-state.ok {
  background: var(--te-success-soft-fg);
}

.shortcut-state.failed {
  background: var(--te-danger-soft-fg);
}

.shortcut-label {
  flex: 1 1 auto;
  overflow: hidden;
  min-width: 0;
  color: var(--te-settings-text);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shortcut-revert {
  display: inline-flex;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
  font-size: 11px;
}

.shortcut-revert:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}

.shortcut-key {
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 128px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  font-weight: 650;
}

.shortcut-key:hover,
.shortcut-key:focus-visible {
  border-color: rgba(var(--te-primary-rgb), 0.55);
  outline: none;
}

.shortcut-key.recording {
  border-color: rgba(var(--te-primary-rgb), 0.7);
  background: rgba(var(--te-primary-rgb), 0.08);
  color: var(--te-settings-text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
}

.shortcut-row.conflict .shortcut-key {
  border-color: var(--te-danger-soft-fg);
}

.shortcut-key.static {
  color: var(--te-settings-text-muted);
  cursor: default;
  font-size: 11px;
}

.shortcut-note {
  margin: 10px 0 0;
  color: var(--te-settings-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.shortcut-note.failed {
  color: var(--te-danger-soft-fg);
}

.shortcut-note.ok {
  color: var(--te-success-soft-fg);
}

@media (max-width: 760px) {
  .shortcut-key {
    min-width: 108px;
  }
}
</style>
