<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import type { DesktopLyricsSettings } from '../../types/settings'

const props = defineProps<{ desktopLyrics: DesktopLyricsSettings }>()
const emit = defineEmits<{
  toggle: []
  update: [patch: Partial<DesktopLyricsSettings>]
}>()

const draft = reactive<DesktopLyricsSettings>({ ...props.desktopLyrics })
let persistTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.desktopLyrics,
  (value) => Object.assign(draft, value),
  { deep: true }
)

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer)
})

function update<K extends keyof DesktopLyricsSettings>(
  key: K,
  value: DesktopLyricsSettings[K],
  immediate = false
): void {
  draft[key] = value
  if (persistTimer) clearTimeout(persistTimer)
  const commit = (): void => emit('update', { [key]: value } as Partial<DesktopLyricsSettings>)
  if (immediate) commit()
  else persistTimer = setTimeout(commit, 300)
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

const activeColor = computed(() => {
  if (draft.palette === 'twilight') return '#9b8cff'
  if (draft.palette === 'warm') return '#fff1d6'
  if (draft.palette === 'custom') return draft.customActiveColor
  return 'var(--theme-accent, #7aa2ff)'
})

const previewStyle = computed<Record<string, string>>(() => ({
  '--preview-active': activeColor.value,
  '--preview-font':
    draft.fontFamily === 'follow'
      ? 'var(--te-font-rounded, var(--te-font-sans, sans-serif))'
      : draft.fontFamily === 'system'
        ? 'system-ui, sans-serif'
        : `${JSON.stringify(draft.fontFamily)}, sans-serif`,
  '--preview-size': `${Math.min(36, draft.fontSize)}px`,
  '--preview-weight': String(draft.fontWeight),
  '--preview-gap': `${draft.lineGap}px`,
  '--preview-inactive': String(draft.inactiveOpacity / 100),
  '--preview-shadow': String(draft.shadowStrength / 100)
}))

const palettes = [
  { value: 'accent', label: '封面强调色', color: 'var(--theme-accent, #7aa2ff)' },
  { value: 'twilight', label: 'Twilight', color: '#9b8cff' },
  { value: 'warm', label: '暖白', color: '#fff1d6' },
  { value: 'custom', label: '自定义', color: draft.customActiveColor }
] as const
</script>

<template>
  <section class="settings-section" data-settings-section="desktopLyrics">
    <div class="section-heading">
      <div>
        <h2>桌面歌词</h2>
        <p>双行悬浮歌词，设置会实时同步到桌面窗口。</p>
      </div>
      <button
        class="enable-button"
        type="button"
        :class="{ active: draft.enabled }"
        @click="emit('toggle')"
      >
        <i :class="draft.enabled ? 'ph ph-check' : 'ph ph-power'"></i>
        {{ draft.enabled ? '已启用' : '启用' }}
      </button>
    </div>

    <div class="lyrics-preview" :style="previewStyle" aria-label="桌面歌词外观预览">
      <div class="preview-line primary">
        <span>晚风拂过回响</span>
        <small v-if="draft.translationVisible">The evening wind carries the echo</small>
      </div>
      <div class="preview-line secondary">
        <span>下一句落在星光里</span>
        <small v-if="draft.translationVisible">The next line rests in starlight</small>
      </div>
    </div>

    <div class="setting-card">
      <h3>基础设置</h3>
      <label class="field">
        <span>字体</span>
        <select
          :value="draft.fontFamily"
          @change="update('fontFamily', ($event.target as HTMLSelectElement).value, true)"
        >
          <option value="follow">跟随播放器</option>
          <option value="system">系统字体</option>
          <option value="Microsoft YaHei UI">微软雅黑</option>
          <option value="LXGW WenKai">霞鹜文楷</option>
        </select>
      </label>
      <label class="field range-field">
        <span
          >字号 <b>{{ draft.fontSize }} px</b></span
        >
        <input
          type="range"
          min="20"
          max="64"
          :value="draft.fontSize"
          @input="update('fontSize', numberValue($event))"
        />
      </label>
      <div class="field">
        <span>快捷配色</span>
        <div class="palette-grid">
          <button
            v-for="item in palettes"
            :key="item.value"
            type="button"
            :class="{ active: draft.palette === item.value }"
            @click="update('palette', item.value, true)"
          >
            <i :style="{ background: item.color }"></i>{{ item.label }}
          </button>
        </div>
      </div>
      <label v-if="draft.palette === 'custom'" class="field color-field">
        <span>主色</span>
        <input
          type="color"
          :value="draft.customActiveColor"
          @input="update('customActiveColor', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="switch-field">
        <span><b>显示翻译</b><small>没有翻译时自动收起副行</small></span>
        <input
          type="checkbox"
          :checked="draft.translationVisible"
          @change="update('translationVisible', ($event.target as HTMLInputElement).checked, true)"
        />
      </label>
    </div>

    <div class="setting-card">
      <h3>窗口</h3>
      <div class="two-columns">
        <label class="field range-field">
          <span
            >宽度 <b>{{ draft.windowWidth }} px</b></span
          >
          <input
            type="range"
            min="480"
            max="1920"
            step="10"
            :value="draft.windowWidth"
            @input="update('windowWidth', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >高度 <b>{{ draft.windowHeight }} px</b></span
          >
          <input
            type="range"
            min="140"
            max="320"
            step="4"
            :value="draft.windowHeight"
            @input="update('windowHeight', numberValue($event))"
          />
        </label>
      </div>
      <label class="switch-field">
        <span><b>始终置顶</b><small>保持歌词悬浮在其他窗口上方</small></span>
        <input
          type="checkbox"
          :checked="draft.alwaysOnTop"
          @change="update('alwaysOnTop', ($event.target as HTMLInputElement).checked, true)"
        />
      </label>
      <label class="switch-field">
        <span><b>锁定并穿透点击</b><small>使用 Ctrl + Alt + L 或托盘菜单解锁</small></span>
        <input
          type="checkbox"
          :checked="draft.locked"
          @change="update('locked', ($event.target as HTMLInputElement).checked, true)"
        />
      </label>
    </div>

    <details class="setting-card advanced">
      <summary>高级设置</summary>
      <div class="two-columns advanced-grid">
        <label class="field range-field">
          <span
            >字体粗细 <b>{{ draft.fontWeight }}</b></span
          >
          <input
            type="range"
            min="400"
            max="800"
            step="50"
            :value="draft.fontWeight"
            @input="update('fontWeight', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >行距 <b>{{ draft.lineGap }} px</b></span
          >
          <input
            type="range"
            min="0"
            max="24"
            :value="draft.lineGap"
            @input="update('lineGap', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >未唱透明度 <b>{{ draft.inactiveOpacity }}%</b></span
          >
          <input
            type="range"
            min="20"
            max="80"
            :value="draft.inactiveOpacity"
            @input="update('inactiveOpacity', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >背景透明度 <b>{{ draft.backgroundOpacity }}%</b></span
          >
          <input
            type="range"
            min="0"
            max="60"
            :value="draft.backgroundOpacity"
            @input="update('backgroundOpacity', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >阴影强度 <b>{{ draft.shadowStrength }}%</b></span
          >
          <input
            type="range"
            min="0"
            max="100"
            :value="draft.shadowStrength"
            @input="update('shadowStrength', numberValue($event))"
          />
        </label>
        <label class="field range-field">
          <span
            >动效强度 <b>{{ draft.motionIntensity }}%</b></span
          >
          <input
            type="range"
            min="0"
            max="100"
            :value="draft.motionIntensity"
            @input="update('motionIntensity', numberValue($event))"
          />
        </label>
      </div>
      <label class="switch-field">
        <span
          ><b>暂停后隐藏</b><small>暂停 {{ draft.pauseHideDelaySeconds }} 秒后淡出歌词</small></span
        >
        <input
          type="checkbox"
          :checked="draft.hideWhenPaused"
          @change="update('hideWhenPaused', ($event.target as HTMLInputElement).checked, true)"
        />
      </label>
      <label v-if="draft.hideWhenPaused" class="field range-field">
        <span
          >隐藏延迟 <b>{{ draft.pauseHideDelaySeconds }} 秒</b></span
        >
        <input
          type="range"
          min="2"
          max="30"
          :value="draft.pauseHideDelaySeconds"
          @input="update('pauseHideDelaySeconds', numberValue($event))"
        />
      </label>
    </details>
  </section>
</template>

<style scoped>
.settings-section {
  display: grid;
  gap: 18px;
}
.section-heading,
.switch-field,
.field > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.section-heading h2,
.setting-card h3 {
  margin: 0;
}
.section-heading p {
  margin: 6px 0 0;
  color: var(--text-secondary);
}
.enable-button {
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 9px 15px;
  color: var(--text-primary);
  background: var(--surface-card);
}
.enable-button.active {
  border-color: color-mix(in srgb, var(--theme-accent) 55%, transparent);
  color: var(--theme-accent);
}
.lyrics-preview {
  min-height: 150px;
  padding: 25px 30px;
  display: grid;
  align-content: center;
  gap: var(--preview-gap);
  overflow: hidden;
  border-radius: 18px;
  background:
    radial-gradient(
      circle at 20% 15%,
      color-mix(in srgb, var(--preview-active) 24%, transparent),
      transparent 38%
    ),
    linear-gradient(135deg, #20232d, #111218);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 8%);
  font-family: var(--preview-font);
}
.preview-line {
  display: grid;
  min-width: 0;
  text-shadow: 0 2px calc(4px + 12px * var(--preview-shadow)) rgb(0 0 0 / 72%);
}
.preview-line span {
  overflow: hidden;
  white-space: nowrap;
  font-size: var(--preview-size);
  font-weight: var(--preview-weight);
  line-height: 1.1;
  text-overflow: clip;
}
.preview-line small {
  margin-top: 4px;
  color: rgb(255 255 255 / 62%);
}
.preview-line.primary {
  color: var(--preview-active);
  justify-items: start;
}
.preview-line.secondary {
  color: rgb(255 255 255 / var(--preview-inactive));
  justify-items: end;
}
.setting-card {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--surface-card);
}
.field {
  display: grid;
  gap: 9px;
}
.field b {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.field select {
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  color: var(--text-primary);
  background: var(--surface-card);
}
.range-field input {
  width: 100%;
  accent-color: var(--theme-accent);
}
.two-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.switch-field > span {
  display: grid;
  gap: 3px;
}
.switch-field small {
  color: var(--text-secondary);
}
.switch-field input {
  width: 18px;
  height: 18px;
  accent-color: var(--theme-accent);
}
.palette-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.palette-grid button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-secondary);
  background: transparent;
}
.palette-grid button.active {
  border-color: var(--theme-accent);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--theme-accent) 10%, transparent);
}
.palette-grid i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgb(255 255 255 / 24%);
}
.color-field {
  grid-template-columns: 1fr auto;
  align-items: center;
}
.color-field input {
  width: 44px;
  height: 32px;
  padding: 2px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
}
.advanced summary {
  cursor: pointer;
  font-weight: 650;
}
.advanced-grid {
  margin-top: 4px;
}
@media (max-width: 760px) {
  .two-columns,
  .palette-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
