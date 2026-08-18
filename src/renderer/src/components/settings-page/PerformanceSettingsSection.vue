<script setup lang="ts">
import { computed } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { WindowTransparencyEffectSettings } from '../../types/settings'
import type { BooleanSettingKey } from './types.ts'

defineProps<{
  toggleSetting: (key: BooleanSettingKey) => void
}>()

const { settings, updateSettings, windowTransparencySupported } = useSettingsStore()

const transparencyUnsupported = computed(
  () => settings.value.windowTransparency === true && windowTransparencySupported.value === false
)
const transparencySupported = computed(() => windowTransparencySupported.value === true)

function updateTp<K extends keyof WindowTransparencyEffectSettings>(
  key: K,
  value: WindowTransparencyEffectSettings[K]
): void {
  void updateSettings({
    windowTransparencyEffect: { ...settings.value.windowTransparencyEffect, [key]: value }
  })
}
</script>

<template>
  <section id="performance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-bolt"></i>
      <h2>性能 (Performance)</h2>
    </div>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>硬件加速</strong>
          <span>使用 GPU 加速界面渲染、动画与模糊效果。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: settings.hardwareAcceleration,
            inactive: !settings.hardwareAcceleration
          }"
          role="switch"
          :aria-checked="settings.hardwareAcceleration"
          @click="toggleSetting('hardwareAcceleration')"
        ></span>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>窗口透明</strong>
          <span
            >让窗口底层透明，显示系统模糊效果（Windows 11 22H2+ 使用原生亚克力模糊；Linux X11
            需合成器支持，如 KWin / picom；Linux Wayland、以及 Windows
            未开启系统透明效果时暂不支持）。更改后需重启。</span
          >
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: settings.windowTransparency,
            inactive: !settings.windowTransparency,
            disabled: !transparencySupported
          }"
          role="switch"
          :aria-checked="settings.windowTransparency"
          :aria-disabled="!transparencySupported"
          @click="toggleSetting('windowTransparency')"
        ></span>
      </div>
      <div v-if="transparencyUnsupported" class="settings-inline-warning" role="status">
        当前系统不支持透明窗口（Linux Wayland，或 Windows
        未开启系统透明效果），已自动回退为不透明窗口，应用仍可正常使用。
      </div>
      <template v-if="settings.windowTransparency && transparencySupported">
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>表面不透明度 (Surface Opacity)</strong>
            <span>页面背景表面的不透明程度，越低越通透。</span>
          </div>
          <div class="inline-controls">
            <input
              type="range"
              class="range-input"
              min="0"
              max="100"
              :value="settings.windowTransparencyEffect.surfaceOpacity"
              @input="updateTp('surfaceOpacity', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.windowTransparencyEffect.surfaceOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑表面不透明度"
              @change="updateTp('surfaceOpacity', $event)"
            />
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-copy">
            <strong>表面模糊度 (Surface Blur)</strong>
            <span>页面背景表面的应用内模糊强度。</span>
          </div>
          <div class="inline-controls">
            <input
              type="range"
              class="range-input"
              min="0"
              max="60"
              :value="settings.windowTransparencyEffect.surfaceBlur"
              @input="updateTp('surfaceBlur', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.windowTransparencyEffect.surfaceBlur"
              :min="0"
              :max="60"
              suffix="px"
              aria-label="编辑表面模糊度"
              @change="updateTp('surfaceBlur', $event)"
            />
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>卡片不透明度 (Card Opacity)</strong>
            <span>卡片表面的不透明程度，越低越通透。</span>
          </div>
          <div class="inline-controls">
            <input
              type="range"
              class="range-input"
              min="0"
              max="100"
              :value="settings.windowTransparencyEffect.cardOpacity"
              @input="updateTp('cardOpacity', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.windowTransparencyEffect.cardOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑卡片不透明度"
              @change="updateTp('cardOpacity', $event)"
            />
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-copy">
            <strong>卡片模糊度 (Card Blur)</strong>
            <span>卡片表面的应用内模糊强度。</span>
          </div>
          <div class="inline-controls">
            <input
              type="range"
              class="range-input"
              min="0"
              max="60"
              :value="settings.windowTransparencyEffect.cardBlur"
              @input="updateTp('cardBlur', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.windowTransparencyEffect.cardBlur"
              :min="0"
              :max="60"
              suffix="px"
              aria-label="编辑卡片模糊度"
              @change="updateTp('cardBlur', $event)"
            />
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
