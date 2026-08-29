<script setup lang="ts">
import { computed, ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import type {
  DesktopLyricsLayout,
  DesktopLyricsPresentation,
  DesktopLyricsSettings,
  LyricAlign
} from '../../types/settings'
import {
  BUILTIN_FONT_OPTIONS,
  useLyricsFontPicker,
  type LyricsFontOption
} from '../../composables/useLyricsFontPicker'
import {
  DESKTOP_LYRICS_FOLLOW_FONT,
  DESKTOP_LYRICS_SYSTEM_FONT
} from '../../../../shared/desktopLyricsFont.ts'

const props = defineProps<{
  desktopLyrics: DesktopLyricsSettings
}>()

const emit = defineEmits<{
  toggle: []
  update: [patch: Partial<DesktopLyricsSettings>]
}>()

function update<K extends keyof DesktopLyricsSettings>(
  key: K,
  value: DesktopLyricsSettings[K]
): void {
  emit('update', { [key]: value } as Partial<DesktopLyricsSettings>)
}

type DesktopFontOption = {
  key: string
  label: string
  preview: string
  value: string
}

const fontPicker = useLyricsFontPicker()
const fontMenuOpen = ref(false)
const followFontOption: DesktopFontOption = {
  key: 'desktop:follow',
  label: '跟随 PlayingMusic',
  preview: 'var(--te-font-rounded, var(--te-font-sans, sans-serif))',
  value: DESKTOP_LYRICS_FOLLOW_FONT
}

const query = computed(() => fontPicker.query.value.trim().toLowerCase())
const desktopBuiltinMatches = computed<DesktopFontOption[]>(() => {
  const options = [
    followFontOption,
    ...BUILTIN_FONT_OPTIONS.filter((option) => option.builtin !== 'inherit').map((option) =>
      toDesktopFontOption(option)
    )
  ]
  return options.filter(
    (option) =>
      !query.value || `${option.label} ${option.value}`.toLowerCase().includes(query.value)
  )
})
const installedFontMatches = computed<DesktopFontOption[]>(() =>
  fontPicker.installedMatches.value.map((option) => ({
    key: `desktop:${option.key}`,
    label: option.label,
    preview: option.preview,
    value: option.familyName ?? ''
  }))
)

function toDesktopFontOption(option: LyricsFontOption): DesktopFontOption {
  return {
    key: `desktop:${option.key}`,
    label: option.label,
    preview: option.preview,
    value: option.builtin ?? DESKTOP_LYRICS_SYSTEM_FONT
  }
}

const selectedFontOption = computed(() => {
  const value = props.desktopLyrics.fontFamily || DESKTOP_LYRICS_SYSTEM_FONT
  return [...desktopBuiltinMatches.value, ...installedFontMatches.value].find(
    (option) => option.value === value
  )
})

const selectedFontLabel = computed(
  () =>
    selectedFontOption.value?.label ??
    (props.desktopLyrics.fontFamily || DESKTOP_LYRICS_SYSTEM_FONT)
)
const selectedFontPreview = computed(
  () =>
    selectedFontOption.value?.preview ??
    `${JSON.stringify(props.desktopLyrics.fontFamily || DESKTOP_LYRICS_SYSTEM_FONT)}, sans-serif`
)

function chooseDesktopFont(value: string): void {
  update('fontFamily', value)
  fontMenuOpen.value = false
  fontPicker.query.value = ''
}

async function toggleFontMenu(): Promise<void> {
  fontMenuOpen.value = !fontMenuOpen.value
  if (fontMenuOpen.value) await fontPicker.load()
}
</script>

<template>
  <section id="desktopLyrics" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-window-maximize"></i>
      <h2>桌面歌词 (Desktop Lyrics)</h2>
    </div>

    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>启用桌面歌词</strong>
          <span>在独立窗口中显示桌面歌词，可拖拽移动位置。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.enabled,
            inactive: !props.desktopLyrics.enabled
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.enabled"
          @click="$emit('toggle')"
        ></span>
      </div>
      <hr />
      <div
        class="setting-item top-align desktop-font-setting"
        :class="{ 'font-menu-open': fontMenuOpen }"
      >
        <div class="setting-copy">
          <strong>歌词字体 (Font Family)</strong>
          <span>默认跟随 PlayingMusic，也可以单独选择本机已安装字体。</span>
        </div>
        <div class="desktop-font-field">
          <button
            type="button"
            class="desktop-font-trigger"
            :aria-expanded="fontMenuOpen"
            @click="toggleFontMenu"
          >
            <span :style="{ fontFamily: selectedFontPreview }">{{ selectedFontLabel }}</span>
            <i class="pi pi-chevron-down"></i>
          </button>
          <div v-if="fontMenuOpen" class="desktop-font-menu">
            <input
              v-model="fontPicker.query.value"
              type="text"
              class="desktop-font-search"
              placeholder="搜索字体…"
            />
            <div class="desktop-font-list">
              <p class="desktop-font-group">内置</p>
              <button
                v-for="option in desktopBuiltinMatches"
                :key="option.key"
                type="button"
                class="desktop-font-option"
                :style="{ fontFamily: option.preview }"
                @click="chooseDesktopFont(option.value)"
              >
                {{ option.label }}
              </button>
              <p class="desktop-font-group">
                本机字体
                <small v-if="fontPicker.loading.value">载入中…</small>
                <small v-else-if="!installedFontMatches.length">无匹配</small>
              </p>
              <button
                v-for="option in installedFontMatches"
                :key="option.key"
                type="button"
                class="desktop-font-option"
                :style="{ fontFamily: option.preview }"
                @click="chooseDesktopFont(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>字体大小 (Font Size)</strong>
          <span>调整桌面歌词的字号大小。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="12"
            max="80"
            :value="props.desktopLyrics.fontSize"
            @input="update('fontSize', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.fontSize"
            :min="12"
            :max="80"
            suffix="px"
            aria-label="编辑桌面歌词字号"
            @change="update('fontSize', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>字体粗细 (Font Weight)</strong>
          <span>调整歌词文本的粗细程度。</span>
        </div>
        <select
          class="preview-select wide"
          :value="props.desktopLyrics.fontWeight"
          @change="update('fontWeight', Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="300">细体 (300)</option>
          <option :value="400">常规 (400)</option>
          <option :value="500">中等 (500)</option>
          <option :value="600">半粗 (600)</option>
          <option :value="700">粗体 (700)</option>
          <option :value="800">特粗 (800)</option>
          <option :value="900">黑体 (900)</option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>行间距 (Line Spacing)</strong>
          <span>调整多行歌词之间的间距。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="1"
            max="3"
            step="0.1"
            :value="props.desktopLyrics.lineSpacing"
            @input="update('lineSpacing', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.lineSpacing"
            :min="1"
            :max="3"
            :step="0.1"
            aria-label="编辑桌面歌词行间距"
            @change="update('lineSpacing', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>最大显示行数 (Max Lines)</strong>
          <span>限制桌面歌词最多显示的行数。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="1"
            max="5"
            :value="props.desktopLyrics.maxLines"
            @input="update('maxLines', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.maxLines"
            :min="1"
            :max="5"
            suffix="行"
            aria-label="编辑桌面歌词最大显示行数"
            @change="update('maxLines', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>行水平偏移 (Line Offset)</strong>
          <span>多行时交错左右位置：正值=第1行偏左、第2行偏右；0 为对齐。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="-200"
            max="200"
            step="1"
            :value="props.desktopLyrics.lineOffset ?? 0"
            @input="update('lineOffset', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.lineOffset ?? 0"
            :min="-200"
            :max="200"
            suffix="px"
            aria-label="编辑桌面歌词行水平偏移"
            @change="update('lineOffset', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>默认文字颜色 (Text Color)</strong>
          <span>未播放到该句时的歌词颜色。</span>
        </div>
        <input
          type="color"
          :value="props.desktopLyrics.color"
          @input="update('color', ($event.target as HTMLInputElement).value)"
          class="color-picker"
        />
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>高亮文字颜色 (Highlight Color)</strong>
          <span>当前正在播放的歌词颜色。</span>
        </div>
        <input
          type="color"
          :value="props.desktopLyrics.highlightColor"
          @input="update('highlightColor', ($event.target as HTMLInputElement).value)"
          class="color-picker"
        />
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>背景颜色 (Background Color)</strong>
          <span>桌面歌词窗口的背景色。</span>
        </div>
        <input
          type="color"
          :value="props.desktopLyrics.bgColor"
          @input="update('bgColor', ($event.target as HTMLInputElement).value)"
          class="color-picker"
        />
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>背景透明度 (Background Opacity)</strong>
          <span>调整背景颜色的透明程度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="100"
            :value="props.desktopLyrics.bgOpacity"
            @input="update('bgOpacity', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.bgOpacity"
            :min="0"
            :max="100"
            suffix="%"
            aria-label="编辑桌面歌词背景透明度"
            @change="update('bgOpacity', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>选中时显示亚克力 (Acrylic)</strong>
          <span>点击歌词选中后才显示毛玻璃背景；关闭后选中也只显示歌词和控制条。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.showAcrylic !== false,
            inactive: props.desktopLyrics.showAcrylic === false
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.showAcrylic !== false"
          @click="update('showAcrylic', props.desktopLyrics.showAcrylic === false)"
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>文字阴影 (Text Shadow)</strong>
          <span>为歌词文字添加阴影以提高辨识度。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.shadow,
            inactive: !props.desktopLyrics.shadow
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.shadow"
          @click="update('shadow', !props.desktopLyrics.shadow)"
        ></span>
      </div>
      <hr v-if="props.desktopLyrics.shadow" />
      <div class="setting-item" v-if="props.desktopLyrics.shadow">
        <div class="setting-copy">
          <strong>阴影模糊度 (Shadow Blur)</strong>
          <span>文字阴影的扩散程度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="0"
            max="30"
            :value="props.desktopLyrics.shadowBlur"
            @input="update('shadowBlur', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.shadowBlur"
            :min="0"
            :max="30"
            suffix="px"
            aria-label="编辑桌面歌词阴影模糊度"
            @change="update('shadowBlur', $event)"
          />
        </div>
      </div>
      <hr v-if="props.desktopLyrics.shadow" />
      <div class="setting-item" v-if="props.desktopLyrics.shadow">
        <div class="setting-copy">
          <strong>阴影颜色 (Shadow Color)</strong>
          <span>文字阴影的颜色。</span>
        </div>
        <input
          type="color"
          :value="props.desktopLyrics.shadowColor"
          @input="update('shadowColor', ($event.target as HTMLInputElement).value)"
          class="color-picker"
        />
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>对齐方式 (Alignment)</strong>
          <span>歌词文本的水平对齐方式。</span>
        </div>
        <select
          class="preview-select wide"
          :value="props.desktopLyrics.align"
          @change="update('align', ($event.target as HTMLSelectElement).value as LyricAlign)"
        >
          <option value="center">居中对齐 (Center)</option>
          <option value="left">靠左对齐 (Left)</option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>窗口宽度 (Window Width)</strong>
          <span>调整桌面歌词窗口的宽度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="200"
            max="3000"
            step="10"
            :value="props.desktopLyrics.windowWidth"
            @input="update('windowWidth', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.windowWidth"
            :min="200"
            :max="3000"
            :step="10"
            suffix="px"
            aria-label="编辑桌面歌词窗口宽度"
            @change="update('windowWidth', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>窗口高度 (Window Height)</strong>
          <span>调整桌面歌词窗口的高度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="range"
            class="range-input"
            min="60"
            max="800"
            step="10"
            :value="props.desktopLyrics.windowHeight"
            @input="update('windowHeight', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="props.desktopLyrics.windowHeight"
            :min="60"
            :max="800"
            :step="10"
            suffix="px"
            aria-label="编辑桌面歌词窗口高度"
            @change="update('windowHeight', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>始终置顶 (Always on Top)</strong>
          <span>桌面歌词窗口始终显示在其他窗口之前。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.alwaysOnTop,
            inactive: !props.desktopLyrics.alwaysOnTop
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.alwaysOnTop"
          @click="update('alwaysOnTop', !props.desktopLyrics.alwaysOnTop)"
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>锁定桌面歌词 (Lock)</strong>
          <span>开启后点击穿透桌面；双击或悬浮歌词约 2 秒后在正中显示小锁，点锁即可解锁编辑。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.locked,
            inactive: !props.desktopLyrics.locked
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.locked"
          @click="update('locked', !props.desktopLyrics.locked)"
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>展示风格 (Presentation)</strong>
          <span>网易云：当前句逐字渐变，下一句弱化显示；经典：保留原有布局。</span>
        </div>
        <select
          class="preview-select wide"
          :value="props.desktopLyrics.presentation ?? 'netease'"
          @change="
            update(
              'presentation',
              ($event.target as HTMLSelectElement).value as DesktopLyricsPresentation
            )
          "
        >
          <option value="netease">网易云风格 (NetEase)</option>
          <option value="classic">经典布局 (Classic)</option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>布局模式 (Layout)</strong>
          <span>多行：连续多句歌词；双语：第一行原文、第二行翻译（当前句）。</span>
        </div>
        <select
          class="preview-select wide"
          :value="props.desktopLyrics.layout ?? 'bilingual'"
          @change="
            update('layout', ($event.target as HTMLSelectElement).value as DesktopLyricsLayout)
          "
        >
          <option value="multi">多行歌词 (Multi)</option>
          <option value="bilingual">双语分行 (Original + Translation)</option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>显示翻译 (Show Translation)</strong>
          <span>多行模式下在原文下附带翻译；双语模式下控制是否显示第二行翻译。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.desktopLyrics.showTranslation,
            inactive: !props.desktopLyrics.showTranslation
          }"
          role="switch"
          :aria-checked="props.desktopLyrics.showTranslation"
          @click="update('showTranslation', !props.desktopLyrics.showTranslation)"
        ></span>
      </div>
    </div>
  </section>
</template>
