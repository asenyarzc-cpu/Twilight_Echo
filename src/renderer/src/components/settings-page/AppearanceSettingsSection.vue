<script setup lang="ts">
import { ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import ThemeControlsSettings from './ThemeControlsSettings.vue'
import BackgroundEditorSettings from './BackgroundEditorSettings.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import LiquidGlassSettings from './LiquidGlassSettings.vue'
import CardAppearanceSettings from './CardAppearanceSettings.vue'
import LyricsAppearanceCustomizer from '../LyricsAppearanceCustomizer.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useLyricsAppearanceEditor } from '../../composables/useLyricsAppearanceEditor.ts'
import { LYRICS_RANGES } from '../../../../shared/lyricsAppearance.ts'
import {
  fontFamilyOptions,
  lyricAlignOptions,
  lyricsAppearanceFontFamilyOptions,
  lyricsFocusLineCountOptions,
  uiDensityOptions,
  type BooleanSettingKey
} from './types.ts'
import type { AppSettings, LyricsAppearanceSettings, UiDensity } from '../../types/settings'

const emit = defineEmits<{
  openThemeStudio: []
}>()

const { settings, updateSettings } = useSettingsStore()

const lyricsEditor = useLyricsAppearanceEditor()
const lyricsRanges = LYRICS_RANGES
const lyricsCustomizerOpen = ref(false)

function setFontFamily(event: Event): void {
  void updateSettings({ fontFamily: (event.target as HTMLSelectElement).value })
}

function setUiDensity(density: UiDensity): void {
  if (settings.value.uiDensity === density) return
  void updateSettings({ uiDensity: density })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}

function updateLyricsAppearance<K extends keyof LyricsAppearanceSettings>(
  key: K,
  value: LyricsAppearanceSettings[K]
): void {
  // The shared editor owns the legacy fan-out and the published bounds, so the
  // quick controls here cannot drift from the full editor in the drawer.
  lyricsEditor.setGlobal(key, value)
}
</script>

<template>
  <section id="appearance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-palette"></i>
      <h2>外观 (Appearance)</h2>
    </div>

    <div class="setting-list">
      <ThemeControlsSettings @open-theme-studio="emit('openThemeStudio')" />
      <BackgroundEditorSettings />
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>封面主题色</strong>
          <span>播放页和底栏使用当前专辑封面提取的主题色。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: settings.useCoverTheme, inactive: !settings.useCoverTheme }"
          role="switch"
          :aria-checked="settings.useCoverTheme"
          @click="toggleSetting('useCoverTheme')"
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>全局字体 (Typography)</strong>
          <span>更换界面的主要显示字体。</span>
        </div>
        <select class="preview-select wide" :value="settings.fontFamily" @change="setFontFamily">
          <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>界面排版密度 (UI Density)</strong>
          <span>控制列表项的间距与信息密度。</span>
        </div>
        <div class="segmented-control density">
          <button
            v-for="option in uiDensityOptions"
            :key="option.value"
            type="button"
            :class="{ active: settings.uiDensity === option.value }"
            @click="setUiDensity(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item lyric-style-item">
        <div class="setting-copy">
          <strong>歌词显示样式 (Lyrics Style)</strong>
          <span>控制主播放页的排版、聚焦范围和高亮效果。</span>
        </div>
        <div class="inline-controls">
          <select
            class="preview-select"
            :value="settings.lyricsAppearance.fontFamily"
            @change="
              updateLyricsAppearance(
                'fontFamily',
                ($event.target as HTMLSelectElement).value as LyricsAppearanceSettings['fontFamily']
              )
            "
          >
            <option
              v-for="option in lyricsAppearanceFontFamilyOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <select
            class="preview-select"
            :value="settings.lyricsAppearance.align"
            @change="
              updateLyricsAppearance(
                'align',
                ($event.target as HTMLSelectElement).value as LyricsAppearanceSettings['align']
              )
            "
          >
            <option v-for="option in lyricAlignOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <div class="range-pill">
            <span>字号</span>
            <input
              class="range-input"
              type="range"
              :min="lyricsRanges.fontSize.min"
              :max="lyricsRanges.fontSize.max"
              :value="settings.lyricsAppearance.fontSize"
              @input="
                updateLyricsAppearance(
                  'fontSize',
                  Number(($event.target as HTMLInputElement).value)
                )
              "
            />
            <EditableRangeValue
              :value="settings.lyricsAppearance.fontSize"
              :min="lyricsRanges.fontSize.min"
              :max="lyricsRanges.fontSize.max"
              suffix="px"
              aria-label="编辑歌词字号"
              @change="updateLyricsAppearance('fontSize', $event)"
            />
          </div>
          <div class="range-pill">
            <span>字重</span>
            <input
              class="range-input"
              type="range"
              min="400"
              max="700"
              step="100"
              :value="settings.lyricsAppearance.fontWeight"
              @input="
                updateLyricsAppearance(
                  'fontWeight',
                  Number(($event.target as HTMLInputElement).value)
                )
              "
            />
            <EditableRangeValue
              :value="settings.lyricsAppearance.fontWeight"
              :min="400"
              :max="700"
              :step="100"
              aria-label="编辑歌词字重"
              @change="updateLyricsAppearance('fontWeight', $event)"
            />
          </div>
          <div class="range-pill">
            <span>行距</span>
            <input
              class="range-input"
              type="range"
              :min="lyricsRanges.lineHeight.min"
              :max="lyricsRanges.lineHeight.max"
              :step="lyricsRanges.lineHeight.step"
              :value="settings.lyricsAppearance.lineHeight"
              @input="
                updateLyricsAppearance(
                  'lineHeight',
                  Number(($event.target as HTMLInputElement).value)
                )
              "
            />
            <EditableRangeValue
              :value="settings.lyricsAppearance.lineHeight"
              :min="lyricsRanges.lineHeight.min"
              :max="lyricsRanges.lineHeight.max"
              :step="lyricsRanges.lineHeight.step"
              aria-label="编辑歌词行距"
              @change="updateLyricsAppearance('lineHeight', $event)"
            />
          </div>
          <div class="range-pill">
            <span>未播放暗度</span>
            <input
              class="range-input"
              type="range"
              :min="lyricsRanges.inactiveOpacity.min"
              :max="lyricsRanges.inactiveOpacity.max"
              :step="lyricsRanges.inactiveOpacity.step"
              :value="settings.lyricsAppearance.inactiveOpacity"
              @input="
                updateLyricsAppearance(
                  'inactiveOpacity',
                  Number(($event.target as HTMLInputElement).value)
                )
              "
            />
            <EditableRangeValue
              :value="settings.lyricsAppearance.inactiveOpacity"
              :min="lyricsRanges.inactiveOpacity.min"
              :max="lyricsRanges.inactiveOpacity.max"
              suffix="%"
              aria-label="编辑未播放歌词暗度"
              @change="updateLyricsAppearance('inactiveOpacity', $event)"
            />
          </div>
        </div>
        <div class="inline-controls">
          <div class="segmented-control density" role="group" aria-label="歌词聚焦行数">
            <button
              v-for="option in lyricsFocusLineCountOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.lyricsAppearance.focusLineCount === option.value }"
              @click="updateLyricsAppearance('focusLineCount', option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <div class="setting-copy">
            <strong>逐字高亮</strong>
            <span>按逐字时间戳显示扫光效果。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: settings.lyricsAppearance.karaokeEnabled,
              inactive: !settings.lyricsAppearance.karaokeEnabled
            }"
            role="switch"
            :aria-checked="settings.lyricsAppearance.karaokeEnabled"
            @click="
              updateLyricsAppearance('karaokeEnabled', !settings.lyricsAppearance.karaokeEnabled)
            "
          ></span>
        </div>
        <div class="inline-controls">
          <div class="segmented-control density" role="group" aria-label="歌词颜色来源">
            <button
              type="button"
              :class="{ active: settings.lyricsAppearance.colorMode === 'theme' }"
              @click="updateLyricsAppearance('colorMode', 'theme')"
            >
              跟随主题
            </button>
            <button
              type="button"
              :class="{ active: settings.lyricsAppearance.colorMode === 'custom' }"
              @click="updateLyricsAppearance('colorMode', 'custom')"
            >
              自定义
            </button>
          </div>
          <template v-if="settings.lyricsAppearance.colorMode === 'custom'">
            <label class="range-pill">
              <span>正文</span>
              <input
                type="color"
                class="color-picker"
                :value="settings.lyricsAppearance.textColor"
                @input="
                  updateLyricsAppearance('textColor', ($event.target as HTMLInputElement).value)
                "
              />
            </label>
            <label class="range-pill">
              <span>当前行</span>
              <input
                type="color"
                class="color-picker"
                :value="settings.lyricsAppearance.activeColor"
                @input="
                  updateLyricsAppearance('activeColor', ($event.target as HTMLInputElement).value)
                "
              />
            </label>
            <label class="range-pill">
              <span>逐字高亮</span>
              <input
                type="color"
                class="color-picker"
                :value="settings.lyricsAppearance.karaokeColor"
                @input="
                  updateLyricsAppearance('karaokeColor', ($event.target as HTMLInputElement).value)
                "
              />
            </label>
          </template>
        </div>
        <div class="inline-controls">
          <div class="setting-copy">
            <strong>逐层个性化</strong>
            <span>
              分别设置普通、当前、翻译、罗马音四层的字体与字号，以及封面间距、聚焦范围和动效强度。
            </span>
          </div>
          <button type="button" class="soft-button" @click="lyricsCustomizerOpen = true">
            打开歌词个性化
          </button>
        </div>
      </div>
      <MiniPlayerSettingsSection />
      <hr />
      <PlayerBarSettings />
      <hr />
      <LiquidGlassSettings />
      <hr />
      <CardAppearanceSettings />
    </div>
  </section>
  <Teleport to="body">
    <LyricsAppearanceCustomizer
      :open="lyricsCustomizerOpen"
      @close="lyricsCustomizerOpen = false"
    />
  </Teleport>
</template>
