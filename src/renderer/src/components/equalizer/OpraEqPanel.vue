<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { OpraCatalogStatus, OpraProfile } from '../../../../preload/types'
import type { HeadphoneCompensationSettings } from '../../types/settings'
import {
  formatActiveCompensationTitle,
  formatOpraStatus,
  opraApplyButtonLabel
} from '../../utils/equalizerPageLogic'

const props = defineProps<{
  compensation: HeadphoneCompensationSettings
  status: OpraCatalogStatus | null
  searching: boolean
  refreshing: boolean
  applyingEqId: string
  results: OpraProfile[]
  error: string
  query: string
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  search: [query: string]
  select: [profile: OpraProfile]
  clear: []
  refresh: []
}>()

const drawerOpen = ref(true)
const query = ref(props.query)
let searchTimer: number | null = null

watch(query, (value) => {
  emit('update:query', value)
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    emit('search', value.trim())
  }, 250)
})

onBeforeUnmount(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
})
</script>

<template>
  <section class="opra-panel">
    <div class="opra-header">
      <div class="opra-info">
        <h3>
          {{ formatActiveCompensationTitle(props.compensation) }}
          <span v-if="props.compensation.enabled" class="badge">已启用补偿</span>
        </h3>
        <p>OPRA (AutoEQ) 自动耳机频响校正曲线。独立处理，不干扰您的手动 EQ 设置。</p>
      </div>
      <button
        class="opra-action-btn"
        :class="{ active: drawerOpen }"
        @click="drawerOpen = !drawerOpen"
      >
        <span>{{ drawerOpen ? '收起设备搜索' : '展开设备搜索' }}</span>
        <i class="pi pi-chevron-down"></i>
      </button>
    </div>

    <div class="opra-drawer-wrapper" :class="{ collapsed: !drawerOpen }">
      <div class="opra-drawer">
        <div class="opra-drawer-inner">
          <div class="opra-search">
            <div class="opra-search-input-wrap">
              <i class="pi pi-search search-icon"></i>
              <input
                type="text"
                v-model="query"
                placeholder="搜索耳机型号或厂商，例如 HD 600、Sony、Moondrop"
              />
            </div>
            <button class="opra-refresh" :disabled="props.refreshing" @click="emit('refresh')">
              {{ props.refreshing ? '刷新中' : '刷新缓存' }}
            </button>
          </div>

          <div
            style="
              font-size: 12px;
              font-weight: 700;
              color: var(--te-neutral-500);
              display: flex;
              justify-content: space-between;
            "
          >
            <span
              >{{ formatOpraStatus(props.status) }}
              <span v-if="props.searching">搜索中...</span></span
            >
            <span v-if="props.error" style="color: #ec4899">{{ props.error }}</span>
            <button
              v-if="props.compensation.enabled"
              @click="emit('clear')"
              style="
                background: none;
                border: none;
                color: #ec4899;
                cursor: pointer;
                font-weight: 700;
              "
            >
              停用补偿
            </button>
          </div>

          <div class="opra-results" v-if="props.results.length > 0">
            <div v-for="profile in props.results" :key="profile.eqId" class="opra-result-item">
              <div class="result-info">
                <span class="result-brand">{{ profile.vendorName }}</span>
                <span class="result-model">{{ profile.productName }}</span>
                <span class="result-author">Profile by {{ profile.author }}</span>
                <span class="result-author" v-if="!profile.applicable" style="color: #ec4899"
                  >不支持: {{ profile.unsupportedBandTypes.join(', ') }}</span
                >
              </div>
              <button
                class="result-apply"
                :style="
                  props.compensation.eqId === profile.eqId
                    ? 'background: var(--te-primary-500); color: #fff;'
                    : ''
                "
                :disabled="!profile.applicable || props.applyingEqId === profile.eqId"
                @click="emit('select', profile)"
              >
                {{
                  opraApplyButtonLabel(props.compensation.eqId, profile.eqId, props.applyingEqId)
                }}
              </button>
            </div>
          </div>

          <p class="opra-attribution">
            Data sourced from
            <a href="https://github.com/opra-project/OPRA" target="_blank">OPRA</a>. Profile authors
            are credited in each result.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.opra-panel {
  background: var(--te-card-bg);
  border-radius: 20px;
  border: 1px solid var(--te-card-border);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.03);
  overflow: hidden;
}
.opra-header {
  padding: 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--te-card-bg);
  z-index: 2;
  position: relative;
}
.opra-info h3 {
  font-size: 16px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 8px;
}
.opra-info h3 span.badge {
  background: var(--te-success-soft-bg);
  color: var(--te-success-soft-fg);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
.opra-info p {
  font-size: 13px;
  color: var(--te-neutral-500);
  margin-top: 6px;
  font-weight: 500;
}
.opra-action-btn {
  background: rgba(15, 23, 42, 0.04);
  border: none;
  padding: 10px 20px;
  border-radius: 10px;
  font-weight: 700;
  color: var(--te-neutral-900);
  cursor: pointer;
  transition: var(--transition);
  display: flex;
  align-items: center;
  gap: 8px;
}
.opra-action-btn i {
  font-size: 10px;
  transition: transform 0.4s var(--te-ease-soft);
}
.opra-action-btn:hover {
  background: var(--te-subtle-bg);
  transform: translateY(-2px);
}
.opra-action-btn.active {
  background: var(--te-info-soft-bg);
  color: var(--te-info-soft-fg);
  transform: translateY(0);
}
.opra-action-btn.active i {
  transform: rotate(180deg);
}

.opra-drawer-wrapper {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.4s var(--te-ease-soft);
}
.opra-drawer-wrapper.collapsed {
  grid-template-rows: 0fr;
}
.opra-drawer {
  overflow: hidden;
}
.opra-drawer-inner {
  border-top: 1px solid var(--te-card-border);
  background: var(--te-subtle-bg);
  padding: 20px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.opra-search {
  display: flex;
  gap: 12px;
  align-items: center;
}
.opra-search-input-wrap {
  flex: 1;
  position: relative;
}
.opra-search-input-wrap .search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--te-neutral-500);
}
.opra-search-input-wrap input {
  width: 100%;
  padding: 12px 16px 12px 40px;
  border-radius: 12px;
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg);
  font-family: inherit;
  font-size: 14px;
  color: var(--te-neutral-900);
  outline: none;
  transition: var(--transition);
  font-weight: 500;
}
.opra-search-input-wrap input:focus {
  border-color: var(--te-primary-500);
  box-shadow: 0 0 0 3px rgba(var(--te-primary-rgb), 0.1);
}
.opra-refresh {
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  padding: 11px 20px;
  border-radius: 12px;
  font-weight: 700;
  color: var(--te-neutral-900);
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(15, 23, 42, 0.02);
  transition: var(--transition);
}
.opra-refresh:hover {
  background: var(--te-hover-bg);
  border-color: var(--te-active-bg);
}

.opra-results {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  max-height: 200px;
  overflow-y: auto;
  padding-right: 4px;
}
.opra-results::-webkit-scrollbar {
  width: 6px;
}
.opra-results::-webkit-scrollbar-track {
  background: transparent;
}
.opra-results::-webkit-scrollbar-thumb {
  background: rgba(15, 23, 42, 0.1);
  border-radius: 999px;
}

.opra-result-item {
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  padding: 16px;
  border-radius: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: var(--transition);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.02);
}
.opra-result-item:hover {
  border-color: rgba(99, 102, 241, 0.3);
  box-shadow: 0 8px 16px rgba(99, 102, 241, 0.08);
  transform: translateY(-2px);
}
.result-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.result-brand {
  font-size: 11px;
  font-weight: 800;
  color: var(--te-neutral-500);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.result-model {
  font-size: 15px;
  font-weight: 800;
  color: var(--te-neutral-900);
}
.result-author {
  font-size: 12px;
  font-weight: 500;
  color: rgba(15, 23, 42, 0.4);
  margin-top: 4px;
}
.result-apply {
  background: rgba(99, 102, 241, 0.1);
  color: var(--te-primary-500);
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
  transition: var(--transition);
}
.result-apply:hover {
  background: var(--te-primary-500);
  color: #fff;
}

.opra-attribution {
  font-size: 12px;
  font-weight: 500;
  color: var(--te-neutral-500);
  margin-top: 4px;
}
.opra-attribution a {
  color: var(--te-primary-500);
  text-decoration: none;
  font-weight: 700;
}
.opra-attribution a:hover {
  text-decoration: underline;
}

:global(html[data-te-equalizer-panel] .opra-panel) {
  border-color: var(--te-equalizer-panel-border);
  border-radius: var(--te-equalizer-panel-radius);
  background: var(--te-equalizer-panel-bg);
}

:global(html[data-te-equalizer-panel='tinted'] .opra-panel) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 82%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .opra-panel) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

:global(html[data-te-equalizer-button] .opra-action-btn),
:global(html[data-te-equalizer-button] .result-apply) {
  border-radius: var(--te-equalizer-button-radius);
}
</style>
