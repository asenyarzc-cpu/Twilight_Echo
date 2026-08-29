<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE,
  resolveDesktopLyricsPaletteColors,
  type DesktopLyricsPalette
} from '../../../../shared/desktopLyrics.ts'
import type { DesktopLyricsSettings } from '../../types/settings'

const props = defineProps<{ desktopLyrics: DesktopLyricsSettings }>()
const emit = defineEmits<{
  toggle: []
  update: [patch: Partial<DesktopLyricsSettings>]
}>()

const draft = reactive<DesktopLyricsSettings>({ ...props.desktopLyrics })
let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingPatch: Partial<DesktopLyricsSettings> = {}

watch(
  () => props.desktopLyrics,
  (value) => Object.assign(draft, value),
  { deep: true }
)

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer)
  flushPendingPatch()
})

function flushPendingPatch(): void {
  const patch = pendingPatch
  pendingPatch = {}
  if (Object.keys(patch).length > 0) emit('update', patch)
}

function updatePatch(patch: Partial<DesktopLyricsSettings>, immediate = false): void {
  Object.assign(draft, patch)
  Object.assign(pendingPatch, patch)
  if (persistTimer) clearTimeout(persistTimer)
  if (immediate) {
    persistTimer = null
    flushPendingPatch()
    return
  }
  persistTimer = setTimeout(() => {
    persistTimer = null
    flushPendingPatch()
  }, 300)
}

function update<K extends keyof DesktopLyricsSettings>(
  key: K,
  value: DesktopLyricsSettings[K],
  immediate = false
): void {
  updatePatch({ [key]: value } as Partial<DesktopLyricsSettings>, immediate)
}

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function updateWritingMode(writingMode: DesktopLyricsSettings['writingMode']): void {
  const size =
    writingMode === 'vertical'
      ? DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE
      : {
          width: DEFAULT_DESKTOP_LYRICS_SETTINGS.windowWidth,
          height: DEFAULT_DESKTOP_LYRICS_SETTINGS.windowHeight
        }
  updatePatch({ writingMode, windowWidth: size.width, windowHeight: size.height }, true)
}

const paletteColors = computed(() => resolveDesktopLyricsPaletteColors(draft))
const windowRange = computed(() =>
  draft.writingMode === 'vertical'
    ? { width: { min: 160, max: 480, step: 4 }, height: { min: 360, max: 960, step: 10 } }
    : { width: { min: 480, max: 1920, step: 10 }, height: { min: 140, max: 320, step: 4 } }
)
const previewStyle = computed<Record<string, string>>(() => ({
  '--preview-active': paletteColors.value.active,
  '--preview-inactive-color': paletteColors.value.inactive,
  '--preview-font':
    draft.fontFamily === 'follow'
      ? 'var(--te-font-rounded, var(--te-font-sans, sans-serif))'
      : draft.fontFamily === 'system'
        ? 'system-ui, sans-serif'
        : `${JSON.stringify(draft.fontFamily)}, sans-serif`,
  '--preview-size': `${Math.min(36, draft.fontSize)}px`,
  '--preview-weight': String(draft.fontWeight),
  '--preview-gap': `${draft.lineGap}px`,
  '--preview-inactive': `${draft.inactiveOpacity}%`,
  '--preview-outline-width': draft.textOutline ? '1px' : '0px',
  '--preview-align': draft.textAlign,
  '--preview-justify':
    draft.textAlign === 'left' ? 'start' : draft.textAlign === 'right' ? 'end' : 'center',
  '--preview-shadow': String(draft.shadowStrength / 100)
}))

const fontOptions = [
  { value: 'MiSans', label: 'MiSans Light' },
  { value: 'follow', label: '跟随播放器' },
  { value: 'system', label: '系统字体' },
  { value: 'Microsoft YaHei UI', label: '微软雅黑' },
  { value: 'lxgw', label: '霞鹜文楷' },
  { value: 'sarasa', label: '更纱黑体' }
]
const fontSizes = Array.from({ length: 45 }, (_, index) => 20 + index)
const fontWeightLabels: Record<number, string> = {
  400: '标准',
  500: '中等',
  600: '半粗',
  700: '加粗',
  800: '特粗'
}
const fontWeightOptions = Array.from({ length: 9 }, (_, index) => {
  const value = 400 + index * 50
  return { value, label: fontWeightLabels[value] ?? String(value) }
})
const paletteOptions: Array<{ value: DesktopLyricsPalette; label: string }> = [
  { value: 'sunset', label: '落日晖' },
  { value: 'accent', label: '封面强调色' },
  { value: 'twilight', label: 'Twilight' },
  { value: 'warm', label: '暖白' },
  { value: 'custom', label: '自定义' }
]

function updatePaletteColor(key: 'customActiveColor' | 'customInactiveColor', event: Event): void {
  const value = (event.target as HTMLInputElement).value
  updatePatch(
    {
      palette: 'custom',
      customActiveColor: key === 'customActiveColor' ? value : paletteColors.value.active,
      customInactiveColor: key === 'customInactiveColor' ? value : paletteColors.value.inactive
    },
    true
  )
}
</script>

<template>
  <section id="desktopLyrics" class="glass-card preview-section settings-section">
    <div class="section-heading desktop-lyrics-heading">
      <h2>桌面歌词</h2>
      <div class="quick-control-row">
        <label class="check-field">
          <input :checked="draft.enabled" type="checkbox" @change="emit('toggle')" />
          <span>启用桌面歌词</span>
        </label>
        <label class="check-field">
          <input
            :checked="draft.alwaysOnTop"
            type="checkbox"
            @change="update('alwaysOnTop', ($event.target as HTMLInputElement).checked, true)"
          />
          <span>启用歌词总在最前</span>
        </label>
        <label class="check-field">
          <input
            :checked="draft.translationVisible"
            type="checkbox"
            @change="
              update('translationVisible', ($event.target as HTMLInputElement).checked, true)
            "
          />
          <span>外文歌词显示翻译</span>
        </label>
        <label class="check-field">
          <input
            :checked="draft.romanizationVisible"
            type="checkbox"
            @change="
              update('romanizationVisible', ($event.target as HTMLInputElement).checked, true)
            "
          />
          <span>外文歌词显示音译</span>
        </label>
      </div>
    </div>

    <div class="setting-card desktop-lyrics-style-card">
      <div class="style-control-grid">
        <label class="field">
          <span>字体</span>
          <select
            :value="draft.fontFamily"
            @change="update('fontFamily', ($event.target as HTMLSelectElement).value, true)"
          >
            <option v-for="option in fontOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>字号</span>
          <select :value="draft.fontSize" @change="update('fontSize', numberValue($event), true)">
            <option v-for="size in fontSizes" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
        <label class="field">
          <span>字粗</span>
          <select
            :value="draft.fontWeight"
            @change="update('fontWeight', numberValue($event), true)"
          >
            <option v-for="option in fontWeightOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>描边</span>
          <select
            :value="draft.textOutline ? 'on' : 'off'"
            @change="
              update('textOutline', ($event.target as HTMLSelectElement).value === 'on', true)
            "
          >
            <option value="on">有描边</option>
            <option value="off">无描边</option>
          </select>
        </label>
      </div>

      <div class="control-group">
        <h3>调整排版样式</h3>
        <div class="layout-control-grid">
          <label class="field">
            <select
              :value="draft.displayMode"
              aria-label="显示行数"
              @change="
                update(
                  'displayMode',
                  ($event.target as HTMLSelectElement)
                    .value as DesktopLyricsSettings['displayMode'],
                  true
                )
              "
            >
              <option value="double">双行显示</option>
              <option value="single">单行显示</option>
            </select>
          </label>
          <label class="field">
            <select
              :value="draft.writingMode"
              aria-label="文字排列方向"
              @change="
                updateWritingMode(
                  ($event.target as HTMLSelectElement).value as DesktopLyricsSettings['writingMode']
                )
              "
            >
              <option value="horizontal">横排显示</option>
              <option value="vertical">竖排显示</option>
            </select>
          </label>
          <label class="field">
            <select
              :value="draft.textAlign"
              aria-label="歌词对齐方式"
              @change="
                update(
                  'textAlign',
                  ($event.target as HTMLSelectElement).value as DesktopLyricsSettings['textAlign'],
                  true
                )
              "
            >
              <option value="left">居左</option>
              <option value="center">居中</option>
              <option value="right">居右</option>
            </select>
          </label>
        </div>
      </div>

      <div class="control-group">
        <h3>更改配色方案</h3>
        <div class="palette-control-grid">
          <label class="field">
            <select
              :value="draft.palette"
              aria-label="歌词配色方案"
              @change="
                update(
                  'palette',
                  ($event.target as HTMLSelectElement).value as DesktopLyricsPalette,
                  true
                )
              "
            >
              <option v-for="option in paletteOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="palette-color-button">
            <input
              :value="paletteColors.active"
              type="color"
              aria-label="已播放歌词颜色"
              @input="updatePaletteColor('customActiveColor', $event)"
            />
            <i :style="{ background: paletteColors.active }"></i>
            <span>已播放</span>
          </label>
          <label class="palette-color-button">
            <input
              :value="paletteColors.inactive"
              type="color"
              aria-label="未播放歌词颜色"
              @input="updatePaletteColor('customInactiveColor', $event)"
            />
            <i :style="{ background: paletteColors.inactive }"></i>
            <span>未播放</span>
          </label>
        </div>
      </div>
    </div>

    <div class="preview-group">
      <h3>预览</h3>
      <div
        class="lyrics-preview"
        :class="[`is-${draft.displayMode}`, `is-${draft.writingMode}`]"
        :style="previewStyle"
        aria-label="桌面歌词外观预览"
      >
        <div class="preview-line primary">
          <span>晚风拂过回响</span>
          <small v-if="draft.translationVisible">The evening wind carries the echo</small>
          <small v-if="draft.romanizationVisible" class="romanization"
            >Wǎnfēng fúguò huíxiǎng</small
          >
        </div>
        <div v-if="draft.displayMode === 'double'" class="preview-line secondary">
          <span>下一句落在星光里</span>
          <small v-if="draft.translationVisible">The next line rests in starlight</small>
          <small v-if="draft.romanizationVisible" class="romanization"
            >Xià yījù luò zài xīngguāng lǐ</small
          >
        </div>
      </div>
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
            :min="windowRange.width.min"
            :max="windowRange.width.max"
            :step="windowRange.width.step"
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
            :min="windowRange.height.min"
            :max="windowRange.height.max"
            :step="windowRange.height.step"
            :value="draft.windowHeight"
            @input="update('windowHeight', numberValue($event))"
          />
        </label>
      </div>
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
            >未播放透明度 <b>{{ draft.inactiveOpacity }}%</b></span
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
.quick-control-row,
.switch-field,
.field > span {
  display: flex;
  align-items: center;
  gap: 16px;
}

.desktop-lyrics-heading {
  justify-content: space-between;
}

.section-heading h2,
.setting-card h3,
.preview-group h3 {
  margin: 0;
}

.quick-control-row {
  flex: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.check-field {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-primary);
  font-size: 13px;
  white-space: nowrap;
}

.check-field input,
.switch-field input {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--theme-accent);
}

.setting-card {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--surface-card);
}

.desktop-lyrics-style-card {
  gap: 22px;
}

.style-control-grid,
.layout-control-grid,
.palette-control-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
}

.layout-control-grid,
.palette-control-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.control-group {
  display: grid;
  gap: 12px;
}

.control-group h3,
.preview-group h3 {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
}

.field {
  display: grid;
  gap: 9px;
}

.field > span {
  justify-content: space-between;
}

.field b {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.field select {
  width: 100%;
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-primary);
  background: var(--surface-card);
}

.range-field input {
  width: 100%;
  accent-color: var(--theme-accent);
}

.palette-color-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 38px;
  gap: 7px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-primary);
  background: var(--surface-card);
  cursor: pointer;
}

.palette-color-button input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.palette-color-button i {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
}

.preview-group {
  display: grid;
  gap: 12px;
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

.lyrics-preview.is-single {
  grid-template-rows: minmax(0, 1fr);
}

.lyrics-preview.is-vertical {
  width: fit-content;
  max-width: 100%;
  min-height: 0;
  padding: 14px 12px;
  grid-template-columns: repeat(2, max-content);
  grid-template-rows: max-content;
  justify-content: end;
  align-content: end;
  gap: min(var(--preview-gap), 10px);
  margin-inline: auto;
}

.lyrics-preview.is-vertical .preview-line.primary {
  grid-column: 2;
}

.lyrics-preview.is-vertical .preview-line.secondary {
  grid-column: 1;
}

.lyrics-preview.is-single.is-vertical {
  grid-template-columns: max-content;
}

.lyrics-preview.is-single.is-vertical .preview-line.primary {
  grid-column: 1;
}

.preview-line {
  display: grid;
  min-width: 0;
  justify-items: var(--preview-justify);
  text-align: var(--preview-align);
  text-shadow: 0 2px calc(4px + 12px * var(--preview-shadow)) rgb(0 0 0 / 72%);
}

.preview-line span {
  overflow: hidden;
  max-width: 100%;
  white-space: nowrap;
  font-size: var(--preview-size);
  font-weight: var(--preview-weight);
  line-height: 1.1;
  text-overflow: clip;
  paint-order: stroke fill;
  -webkit-text-stroke: var(--preview-outline-width) rgb(0 0 0 / 72%);
}

.lyrics-preview.is-vertical .preview-line {
  writing-mode: vertical-rl;
  text-orientation: mixed;
}

.lyrics-preview.is-vertical .preview-line span {
  max-inline-size: 360px;
}

.preview-line small {
  margin-top: 4px;
  color: rgb(255 255 255 / 62%);
  -webkit-text-stroke-width: 0;
}

.lyrics-preview.is-vertical .preview-line small {
  margin-top: 0;
  margin-inline-start: 4px;
}

.preview-line .romanization {
  color: rgb(255 255 255 / 48%);
}

.preview-line.primary {
  color: var(--preview-active);
}

.preview-line.secondary {
  color: color-mix(in srgb, var(--preview-inactive-color) var(--preview-inactive), transparent);
}

.two-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.switch-field {
  justify-content: space-between;
}

.switch-field > span {
  display: grid;
  gap: 3px;
}

.switch-field small {
  color: var(--text-secondary);
}

.advanced summary {
  cursor: pointer;
  font-weight: 650;
}

.advanced-grid {
  margin-top: 4px;
}

@media (max-width: 980px) {
  .desktop-lyrics-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .quick-control-row {
    justify-content: flex-start;
  }

  .style-control-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .style-control-grid,
  .layout-control-grid,
  .palette-control-grid,
  .two-columns {
    grid-template-columns: 1fr;
  }

  .lyrics-preview.is-vertical {
    min-height: 220px;
  }
}
</style>
