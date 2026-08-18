<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { appBackgroundPageOptions } from './types.ts'
import type {
  AppBackgroundKind,
  AppBackgroundPage,
  AppBackgroundSettings
} from '../../types/settings'

const { settings, updateSettings, importBackgroundImage } = useSettingsStore()
const customBackgroundOpen = ref(false)
const backgroundPageOpen = ref<AppBackgroundPage | null>(null)
const backgroundFileInputRef = ref<HTMLInputElement | null>(null)
const pendingBackgroundTarget = ref<'global' | AppBackgroundPage | null>(null)

function toBackgroundImageStyle(image: string): string {
  return image ? `url("${image.replace(/"/g, '\\"')}")` : 'none'
}

function cloneAppBackground(): AppBackgroundSettings {
  const background = settings.value.appBackground
  return {
    global: { ...background.global },
    pages: {
      local: { ...background.pages.local },
      settings: { ...background.pages.settings },
      streaming: { ...background.pages.streaming },
      player: { ...background.pages.player }
    }
  }
}

function setGlobalBackgroundColor(mode: 'light' | 'dark', color: string): void {
  if (settings.value.appBackground.global[mode] === color) return
  const appBackground = cloneAppBackground()
  appBackground.global[mode] = color
  void updateSettings({
    appBackground
  })
}

function setGlobalBackgroundKind(kind: AppBackgroundKind): void {
  if (settings.value.appBackground.global.kind === kind) return
  const appBackground = cloneAppBackground()
  appBackground.global.kind = kind
  void updateSettings({
    appBackground
  })
}

function openBackgroundFilePicker(target: 'global' | AppBackgroundPage): void {
  pendingBackgroundTarget.value = target
  backgroundFileInputRef.value?.click()
}

async function applyGlobalBackgroundImage(image: string): Promise<void> {
  const appBackground = cloneAppBackground()
  appBackground.global.kind = 'image'
  appBackground.global.image = image
  void updateSettings({
    appBackground
  })
}

async function handleBackgroundFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const target = pendingBackgroundTarget.value
  input.value = ''
  pendingBackgroundTarget.value = null
  if (!file || !target) return
  const image = await importBackgroundImage(file)
  if (!image) return
  if (target === 'global') {
    await applyGlobalBackgroundImage(image)
    return
  }
  await applyPageBackgroundImage(target, image)
}

function clearGlobalBackgroundImage(): void {
  if (
    !settings.value.appBackground.global.image &&
    settings.value.appBackground.global.kind === 'color'
  )
    return
  const appBackground = cloneAppBackground()
  appBackground.global.kind = 'color'
  appBackground.global.image = ''
  void updateSettings({
    appBackground
  })
}

function setPageBackgroundInherited(page: AppBackgroundPage, inherit: boolean): void {
  const current = settings.value.appBackground.pages[page]
  if (current.inherit === inherit) return
  const appBackground = cloneAppBackground()
  appBackground.pages[page].inherit = inherit
  void updateSettings({
    appBackground
  })
}

function setPageBackgroundKind(page: AppBackgroundPage, kind: AppBackgroundKind): void {
  const current = settings.value.appBackground.pages[page]
  if (current.kind === kind) return
  const appBackground = cloneAppBackground()
  appBackground.pages[page].inherit = false
  appBackground.pages[page].kind = kind
  void updateSettings({
    appBackground
  })
}

function setPageBackgroundColor(
  page: AppBackgroundPage,
  mode: 'light' | 'dark',
  color: string
): void {
  const current = settings.value.appBackground.pages[page]
  if (current[mode] === color && !current.inherit) return
  const appBackground = cloneAppBackground()
  appBackground.pages[page].inherit = false
  appBackground.pages[page][mode] = color
  void updateSettings({
    appBackground
  })
}

async function applyPageBackgroundImage(page: AppBackgroundPage, image: string): Promise<void> {
  const appBackground = cloneAppBackground()
  appBackground.pages[page].inherit = false
  appBackground.pages[page].kind = 'image'
  appBackground.pages[page].image = image
  void updateSettings({
    appBackground
  })
}

function clearPageBackgroundImage(page: AppBackgroundPage): void {
  const current = settings.value.appBackground.pages[page]
  if (!current.image && current.kind === 'color') return
  const appBackground = cloneAppBackground()
  appBackground.pages[page].kind = 'color'
  appBackground.pages[page].image = ''
  void updateSettings({
    appBackground
  })
}

function toggleBackgroundPage(page: AppBackgroundPage): void {
  backgroundPageOpen.value = backgroundPageOpen.value === page ? null : page
}
</script>

<template>
  <input
    ref="backgroundFileInputRef"
    class="visually-hidden-file-input"
    type="file"
    accept="image/jpeg,image/png,image/webp"
    @change="handleBackgroundFileSelected"
  />
  <div class="setting-item top-align">
    <div class="setting-copy">
      <strong>自定义背景</strong>
      <span>控制整个 App 的统一主背景，可上传图片，也可给不同页面单独覆盖。</span>
    </div>
    <div class="background-accordion">
      <button
        type="button"
        class="background-accordion-trigger"
        :class="{ active: customBackgroundOpen }"
        @click="customBackgroundOpen = !customBackgroundOpen"
      >
        <span>
          {{
            settings.appBackground.global.kind === 'image' && settings.appBackground.global.image
              ? '图片背景'
              : '纯色背景'
          }}
        </span>
        <i class="pi pi-chevron-down"></i>
      </button>
      <div v-if="customBackgroundOpen" class="background-accordion-panel">
        <section class="background-editor">
          <div class="background-editor-head">
            <div>
              <strong>统一背景</strong>
              <span>深色模式默认 #17181a，图片模式下颜色会作为回退底色。</span>
            </div>
            <div class="background-kind-toggle">
              <button
                type="button"
                :class="{ active: settings.appBackground.global.kind === 'color' }"
                @click="setGlobalBackgroundKind('color')"
              >
                纯色
              </button>
              <button
                type="button"
                :class="{ active: settings.appBackground.global.kind === 'image' }"
                @click="setGlobalBackgroundKind('image')"
              >
                图片
              </button>
            </div>
          </div>
          <div class="background-color-stack">
            <label class="color-field">
              <span>浅色</span>
              <input
                type="color"
                :value="settings.appBackground.global.light"
                @input="
                  setGlobalBackgroundColor('light', ($event.target as HTMLInputElement).value)
                "
              />
              <code>{{ settings.appBackground.global.light }}</code>
            </label>
            <label class="color-field">
              <span>深色</span>
              <input
                type="color"
                :value="settings.appBackground.global.dark"
                @input="setGlobalBackgroundColor('dark', ($event.target as HTMLInputElement).value)"
              />
              <code>{{ settings.appBackground.global.dark }}</code>
            </label>
          </div>
          <div class="background-image-actions">
            <span
              v-if="settings.appBackground.global.image"
              class="background-image-preview"
              :style="{
                backgroundImage: toBackgroundImageStyle(settings.appBackground.global.image)
              }"
            ></span>
            <button type="button" class="pill-action" @click="openBackgroundFilePicker('global')">
              <i class="pi pi-image"></i>
              <span>{{ settings.appBackground.global.image ? '更换图片' : '选择图片' }}</span>
            </button>
            <button
              type="button"
              class="pill-action ghost"
              :disabled="!settings.appBackground.global.image"
              @click="clearGlobalBackgroundImage"
            >
              移除图片
            </button>
            <small>{{
              settings.appBackground.global.image ? '已选择图片' : '支持 JPG / PNG / WebP'
            }}</small>
          </div>
        </section>

        <section class="background-editor">
          <div class="background-editor-head">
            <div>
              <strong>页面背景覆盖</strong>
              <span>默认继承统一背景，展开后可给单个页面单独设置纯色或图片。</span>
            </div>
          </div>
          <div class="page-background-list">
            <div
              v-for="page in appBackgroundPageOptions"
              :key="page.value"
              class="page-background-row"
              :class="{ expanded: backgroundPageOpen === page.value }"
            >
              <button
                type="button"
                class="page-background-header"
                @click="toggleBackgroundPage(page.value)"
              >
                <span class="page-background-copy">
                  <strong>{{ page.label }}</strong>
                  <span>{{ page.desc }}</span>
                </span>
                <span class="page-background-state">
                  {{
                    settings.appBackground.pages[page.value].inherit
                      ? '继承'
                      : settings.appBackground.pages[page.value].kind === 'image'
                        ? '图片'
                        : '纯色'
                  }}
                </span>
                <i class="pi pi-chevron-down"></i>
              </button>
              <div v-if="backgroundPageOpen === page.value" class="page-background-controls">
                <button
                  type="button"
                  class="inherit-toggle"
                  :class="{ active: settings.appBackground.pages[page.value].inherit }"
                  @click="
                    setPageBackgroundInherited(
                      page.value,
                      !settings.appBackground.pages[page.value].inherit
                    )
                  "
                >
                  {{
                    settings.appBackground.pages[page.value].inherit
                      ? '当前继承统一背景'
                      : '当前使用自定义背景'
                  }}
                </button>
                <div
                  class="background-kind-toggle"
                  :class="{ disabled: settings.appBackground.pages[page.value].inherit }"
                >
                  <button
                    type="button"
                    :class="{
                      active: settings.appBackground.pages[page.value].kind === 'color'
                    }"
                    @click="setPageBackgroundKind(page.value, 'color')"
                  >
                    纯色
                  </button>
                  <button
                    type="button"
                    :class="{
                      active: settings.appBackground.pages[page.value].kind === 'image'
                    }"
                    @click="setPageBackgroundKind(page.value, 'image')"
                  >
                    图片
                  </button>
                </div>
                <div
                  class="background-color-stack compact"
                  :class="{ disabled: settings.appBackground.pages[page.value].inherit }"
                >
                  <label class="color-field">
                    <span>浅色</span>
                    <input
                      type="color"
                      :value="settings.appBackground.pages[page.value].light"
                      @input="
                        setPageBackgroundColor(
                          page.value,
                          'light',
                          ($event.target as HTMLInputElement).value
                        )
                      "
                    />
                    <code>{{ settings.appBackground.pages[page.value].light }}</code>
                  </label>
                  <label class="color-field">
                    <span>深色</span>
                    <input
                      type="color"
                      :value="settings.appBackground.pages[page.value].dark"
                      @input="
                        setPageBackgroundColor(
                          page.value,
                          'dark',
                          ($event.target as HTMLInputElement).value
                        )
                      "
                    />
                    <code>{{ settings.appBackground.pages[page.value].dark }}</code>
                  </label>
                </div>
                <div
                  class="background-image-actions"
                  :class="{ disabled: settings.appBackground.pages[page.value].inherit }"
                >
                  <span
                    v-if="settings.appBackground.pages[page.value].image"
                    class="background-image-preview"
                    :style="{
                      backgroundImage: toBackgroundImageStyle(
                        settings.appBackground.pages[page.value].image
                      )
                    }"
                  ></span>
                  <button
                    type="button"
                    class="pill-action"
                    @click="openBackgroundFilePicker(page.value)"
                  >
                    <i class="pi pi-image"></i>
                    <span>{{
                      settings.appBackground.pages[page.value].image ? '更换图片' : '选择图片'
                    }}</span>
                  </button>
                  <button
                    type="button"
                    class="pill-action ghost"
                    :disabled="!settings.appBackground.pages[page.value].image"
                    @click="clearPageBackgroundImage(page.value)"
                  >
                    移除图片
                  </button>
                  <small>{{
                    settings.appBackground.pages[page.value].image ? '已选择图片' : '未设置图片'
                  }}</small>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
