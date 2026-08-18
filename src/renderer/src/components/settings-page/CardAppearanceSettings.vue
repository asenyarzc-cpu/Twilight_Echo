<script setup lang="ts">
import { ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type {
  CardAppearanceSettings,
  CardAppearanceTheme,
  CardHoverEffect,
  CardShadowStrength
} from '../../types/settings'

const { settings, updateSettings } = useSettingsStore()

const cardAppearanceOpen = ref(false)
const cardAppearanceTab = ref<'light' | 'dark'>('light')

const cardShadowOptions: { value: CardShadowStrength; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'subtle', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'strong', label: '强' }
]

const cardHoverOptions: { value: CardHoverEffect; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'lift', label: '上浮' },
  { value: 'zoom', label: '放大' },
  { value: 'glow', label: '发光' }
]

function cloneCardAppearance(): CardAppearanceSettings {
  const ca = settings.value.cardAppearance
  return {
    enabled: ca.enabled,
    light: { ...ca.light },
    dark: { ...ca.dark },
    background: {
      enabled: ca.background.enabled,
      light: { ...ca.background.light },
      dark: { ...ca.background.dark }
    }
  }
}

function toggleCardAppearance(): void {
  const cardAppearance = cloneCardAppearance()
  cardAppearance.enabled = !cardAppearance.enabled
  void updateSettings({ cardAppearance })
}

function toggleCardBackgroundEffect(): void {
  const cardAppearance = cloneCardAppearance()
  cardAppearance.background.enabled = !cardAppearance.background.enabled
  void updateSettings({ cardAppearance })
}

function setCardField<K extends keyof CardAppearanceTheme>(
  field: K,
  value: CardAppearanceTheme[K]
): void {
  const cardAppearance = cloneCardAppearance()
  const theme = cardAppearanceTab.value
  cardAppearance[theme][field] = value
  void updateSettings({ cardAppearance })
}

function setBgEffectField<K extends keyof typeof settings.value.cardAppearance.background.light>(
  field: K,
  value: number
): void {
  const cardAppearance = cloneCardAppearance()
  const theme = cardAppearanceTab.value
  ;(cardAppearance.background[theme] as any)[field] = value
  void updateSettings({ cardAppearance })
}
</script>

<template>
  <button
    type="button"
    class="settings-accordion-trigger"
    :class="{ open: cardAppearanceOpen }"
    :aria-expanded="cardAppearanceOpen"
    @click="cardAppearanceOpen = !cardAppearanceOpen"
  >
    <span class="setting-copy">
      <strong>卡片与背景自定义</strong>
      <span>自由调节卡片模糊、颜色、圆角、阴影及背景模糊等外观。</span>
    </span>
    <i class="pi pi-chevron-down"></i>
  </button>
  <div v-if="cardAppearanceOpen" class="settings-accordion-body">
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>启用自定义外观</strong>
        <span>开启后应用下方卡片与背景效果。</span>
      </div>
      <span
        class="toggle-switch"
        :class="{ active: settings.cardAppearance.enabled }"
        role="switch"
        :aria-checked="settings.cardAppearance.enabled"
        @click="toggleCardAppearance"
      ></span>
    </div>
    <div v-if="settings.cardAppearance.enabled">
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>编辑主题</strong>
          <span>分别设置浅色与深色模式下的卡片外观。</span>
        </div>
        <div class="theme-segment">
          <button
            type="button"
            :class="{ active: cardAppearanceTab === 'light' }"
            @click="cardAppearanceTab = 'light'"
          >
            <i class="pi pi-sun"></i>
            浅色
          </button>
          <button
            type="button"
            :class="{ active: cardAppearanceTab === 'dark' }"
            @click="cardAppearanceTab = 'dark'"
          >
            <i class="pi pi-moon"></i>
            深色
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片模糊强度</strong>
          <span>控制卡片毛玻璃的模糊半径。</span>
        </div>
        <div class="range-pill">
          <span>模糊</span>
          <input
            class="range-input"
            type="range"
            min="0"
            max="40"
            :value="settings.cardAppearance[cardAppearanceTab].blurRadius"
            @input="setCardField('blurRadius', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.cardAppearance[cardAppearanceTab].blurRadius"
            :min="0"
            :max="40"
            suffix="px"
            aria-label="编辑卡片模糊强度"
            @change="setCardField('blurRadius', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片模糊饱和度</strong>
          <span>增强或减弱毛玻璃的色彩饱和感。</span>
        </div>
        <div class="range-pill">
          <span>饱和度</span>
          <input
            class="range-input"
            type="range"
            min="80"
            max="180"
            :value="settings.cardAppearance[cardAppearanceTab].blurSaturation"
            @input="
              setCardField('blurSaturation', Number(($event.target as HTMLInputElement).value))
            "
          />
          <EditableRangeValue
            :value="settings.cardAppearance[cardAppearanceTab].blurSaturation"
            :min="80"
            :max="180"
            suffix="%"
            aria-label="编辑卡片模糊饱和度"
            @change="setCardField('blurSaturation', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片背景颜色</strong>
          <span>自定义卡片的底色。</span>
        </div>
        <div class="inline-controls">
          <input
            type="color"
            class="color-picker"
            :value="settings.cardAppearance[cardAppearanceTab].backgroundColor"
            @input="setCardField('backgroundColor', ($event.target as HTMLInputElement).value)"
          />
          <div class="range-pill">
            <span>不透明度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              :value="settings.cardAppearance[cardAppearanceTab].backgroundOpacity"
              @input="
                setCardField('backgroundOpacity', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].backgroundOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑卡片背景不透明度"
              @change="setCardField('backgroundOpacity', $event)"
            />
          </div>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片边框</strong>
          <span>自定义边框颜色、透明度与宽度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="color"
            class="color-picker"
            :value="settings.cardAppearance[cardAppearanceTab].borderColor"
            @input="setCardField('borderColor', ($event.target as HTMLInputElement).value)"
          />
          <div class="range-pill">
            <span>透明度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              :value="settings.cardAppearance[cardAppearanceTab].borderOpacity"
              @input="
                setCardField('borderOpacity', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].borderOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑卡片边框透明度"
              @change="setCardField('borderOpacity', $event)"
            />
          </div>
          <div class="range-pill">
            <span>宽度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="3"
              step="0.5"
              :value="settings.cardAppearance[cardAppearanceTab].borderWidth"
              @input="
                setCardField('borderWidth', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].borderWidth"
              :min="0"
              :max="3"
              :step="0.5"
              suffix="px"
              aria-label="编辑卡片边框宽度"
              @change="setCardField('borderWidth', $event)"
            />
          </div>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片圆角半径</strong>
          <span>控制卡片边角的圆滑程度。</span>
        </div>
        <div class="range-pill">
          <span>圆角</span>
          <input
            class="range-input"
            type="range"
            min="0"
            max="24"
            :value="settings.cardAppearance[cardAppearanceTab].borderRadius"
            @input="setCardField('borderRadius', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.cardAppearance[cardAppearanceTab].borderRadius"
            :min="0"
            :max="24"
            suffix="px"
            aria-label="编辑卡片圆角半径"
            @change="setCardField('borderRadius', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片阴影强度</strong>
          <span>控制卡片投影的深浅。</span>
        </div>
        <div class="segmented-control">
          <button
            v-for="option in cardShadowOptions"
            :key="option.value"
            type="button"
            :class="{
              active: settings.cardAppearance[cardAppearanceTab].shadowStrength === option.value
            }"
            @click="setCardField('shadowStrength', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片悬浮效果</strong>
          <span>鼠标悬停时卡片的动效。</span>
        </div>
        <div class="segmented-control">
          <button
            v-for="option in cardHoverOptions"
            :key="option.value"
            type="button"
            :class="{
              active: settings.cardAppearance[cardAppearanceTab].hoverEffect === option.value
            }"
            @click="setCardField('hoverEffect', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>玻璃高光</strong>
          <span>在卡片顶部添加内描边光泽。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: settings.cardAppearance[cardAppearanceTab].glassHighlight }"
          role="switch"
          :aria-checked="settings.cardAppearance[cardAppearanceTab].glassHighlight"
          @click="
            setCardField(
              'glassHighlight',
              !settings.cardAppearance[cardAppearanceTab].glassHighlight
            )
          "
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>背景模糊与暗化</strong>
          <span>对 App 背景图片施加模糊、亮度调节与暗化遮罩。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: settings.cardAppearance.background.enabled }"
          role="switch"
          :aria-checked="settings.cardAppearance.background.enabled"
          @click="toggleCardBackgroundEffect"
        ></span>
      </div>
      <div v-if="settings.cardAppearance.background.enabled">
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>背景模糊</strong>
            <span>模糊背景图片的半径。</span>
          </div>
          <div class="range-pill">
            <span>模糊</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="30"
              :value="settings.cardAppearance.background[cardAppearanceTab].blur"
              @input="setBgEffectField('blur', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.cardAppearance.background[cardAppearanceTab].blur"
              :min="0"
              :max="30"
              suffix="px"
              aria-label="编辑背景模糊度"
              @change="setBgEffectField('blur', $event)"
            />
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>背景亮度</strong>
            <span>调暗或提亮背景图片。</span>
          </div>
          <div class="range-pill">
            <span>亮度</span>
            <input
              class="range-input"
              type="range"
              min="50"
              max="120"
              :value="settings.cardAppearance.background[cardAppearanceTab].brightness"
              @input="
                setBgEffectField('brightness', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance.background[cardAppearanceTab].brightness"
              :min="50"
              :max="120"
              suffix="%"
              aria-label="编辑背景亮度"
              @change="setBgEffectField('brightness', $event)"
            />
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>背景暗化遮罩</strong>
            <span>叠加黑色遮罩使前景更突出。</span>
          </div>
          <div class="range-pill">
            <span>暗化</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="80"
              :value="settings.cardAppearance.background[cardAppearanceTab].dim"
              @input="setBgEffectField('dim', Number(($event.target as HTMLInputElement).value))"
            />
            <EditableRangeValue
              :value="settings.cardAppearance.background[cardAppearanceTab].dim"
              :min="0"
              :max="80"
              suffix="%"
              aria-label="编辑背景暗化遮罩"
              @change="setBgEffectField('dim', $event)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
