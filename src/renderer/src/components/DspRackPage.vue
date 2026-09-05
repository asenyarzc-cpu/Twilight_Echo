<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createDspFactoryScene, type DspFactorySceneTemplateId } from '../../../shared/dspGraph.ts'
import type {
  DspAsset,
  DspAssetKind,
  DspCorrectionProfile,
  DspGraphNode,
  DspGraphStatus,
  DspNodeType,
  DspResamplerQuality,
  DspScene,
  DspSceneState,
  Vst3CatalogState
} from '../../../shared/dspGraph.ts'
import DspGraphCanvas from './dsp-rack/DspGraphCanvas.vue'
import DspNodeEditor from './dsp-rack/DspNodeEditor.vue'
import DspScenePane from './dsp-rack/DspScenePane.vue'
import {
  nodeCatalog,
  normalizeNodeEditorParams,
  singletonNodeTypes
} from '@renderer/utils/dspNodeParams'
import { cloneDspScene as cloneScene, submitDspSceneDraft } from '@renderer/utils/dspSceneDraft'

const state = ref<DspSceneState | null>(null)
const status = ref<DspGraphStatus | null>(null)
const selectedSceneId = ref<string | null>(null)
const selectedNodeId = ref<string | null>(null)
const nodeTypeToAdd = ref<DspNodeType>('compressor')
const factoryTemplateToAdd = ref<DspFactorySceneTemplateId>('transparent')
const snapshotA = ref<DspScene[] | null>(null)
const busy = ref(false)
const message = ref('')
const assets = ref<DspAsset[]>([])
const vst3Catalog = ref<Vst3CatalogState | null>(null)

const scenes = computed(() => state.value?.scenes ?? [])
const selectedScene = computed(
  () => scenes.value.find((scene) => scene.id === selectedSceneId.value) ?? scenes.value[0] ?? null
)
const selectedNode = computed(
  () => selectedScene.value?.graph.nodes.find((node) => node.id === selectedNodeId.value) ?? null
)
const selectedStatus = computed(
  () => status.value?.nodes.find((node) => node.id === selectedNodeId.value) ?? null
)
const vst3Helpers = computed(() => vst3Catalog.value?.helpers ?? null)
const vst3HelpersReady = computed(() => {
  if (typeof navigator !== 'undefined' && !/win/i.test(navigator.platform)) return false
  if (!vst3Helpers.value) return true
  return (
    vst3Helpers.value.platformSupported &&
    vst3Helpers.value.scannerPresent &&
    vst3Helpers.value.hostPresent
  )
})
const vst3HelpersNotice = computed(() => {
  if (typeof navigator !== 'undefined' && !/win/i.test(navigator.platform)) {
    return 'VST3 仅在 Windows x64 构建中提供。'
  }
  if (!vst3Helpers.value) return ''
  if (!vst3Helpers.value.platformSupported) return 'VST3 仅在 Windows x64 构建中提供。'
  if (!vst3Helpers.value.scannerPresent || !vst3Helpers.value.hostPresent) {
    return '本构建未包含 VST3 扫描/宿主组件。开发环境请执行 pnpm run stage:vst3-msvc，或安装完整 Windows 签名包。'
  }
  return ''
})
const activeSceneId = computed(() => state.value?.activeSceneId ?? null)
const isPinned = computed(() => state.value?.pinnedSceneId === selectedScene.value?.id)
const activeGraphLatency = computed(() => status.value?.totalLatencyFrames ?? 0)
const activeGraphTail = computed(() => status.value?.totalTailFrames ?? 0)
const graphApplyState = computed(() => status.value?.applyState ?? 'idle')
const graphApplyLabel = computed(() => {
  if (graphApplyState.value === 'pending') return 'Pending'
  if (graphApplyState.value === 'applied') return 'Applied'
  if (graphApplyState.value === 'failed') return 'Failed'
  return 'Idle'
})
const soxrFallbackActive = computed(() => status.value?.outputStage?.resamplerFallback === true)
let diagnosticsPoll: number | null = null

function selectScene(id: string): void {
  selectedSceneId.value = id
  selectedScene.value?.graph.nodes.forEach(normalizeNodeEditorParams)
  selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
}

function selectNode(id: string): void {
  selectedNodeId.value = id
  if (selectedNode.value) normalizeNodeEditorParams(selectedNode.value)
}

function addScene(): void {
  const base = selectedScene.value ?? scenes.value[0]
  if (!base || !state.value) return
  const suffix = state.value.scenes.length + 1
  const next = cloneScene(base, `scene-${Date.now()}`, `New DSP Scene ${suffix}`)
  next.rules = {}
  state.value.scenes.push(next)
  selectScene(next.id)
  message.value = '新场景已加入，保存后生效。'
}

function addFactoryScene(): void {
  if (!state.value) return
  const template = createDspFactoryScene(
    factoryTemplateToAdd.value,
    `factory-${factoryTemplateToAdd.value}-${Date.now()}`
  )
  state.value.scenes.push(template)
  selectScene(template.id)
  message.value = `${template.name} 模板已加入；填写资料或校准值后保存并应用。`
}

function duplicateScene(): void {
  if (!selectedScene.value || !state.value) return
  const next = cloneScene(
    selectedScene.value,
    `${selectedScene.value.id}-copy-${Date.now()}`,
    `${selectedScene.value.name} Copy`
  )
  state.value.scenes.push(next)
  selectScene(next.id)
  message.value = '场景副本已创建。'
}

function removeScene(): void {
  if (!state.value || !selectedScene.value || state.value.scenes.length <= 1) return
  const index = state.value.scenes.findIndex((scene) => scene.id === selectedScene.value?.id)
  state.value.scenes.splice(index, 1)
  if (state.value.pinnedSceneId === selectedScene.value.id) state.value.pinnedSceneId = null
  selectScene(state.value.scenes[Math.max(0, index - 1)].id)
}

function addNode(): void {
  const scene = selectedScene.value
  const item = nodeCatalog.find((entry) => entry.type === nodeTypeToAdd.value)
  if (!scene || !item) return
  const existing = singletonNodeTypes.has(item.type)
    ? scene.graph.nodes.find((node) => node.type === item.type)
    : undefined
  if (existing) {
    selectedNodeId.value = existing.id
    message.value = `当前串行图已包含 ${item.label} 节点。`
    return
  }
  const node: DspGraphNode = {
    id: `${item.type}-${Date.now()}`,
    type: item.type,
    enabled: item.type === 'meter',
    params: { ...item.params }
  }
  scene.graph.nodes.push(node)
  normalizeNodeEditorParams(node)
  selectedNodeId.value = node.id
}

function removeNode(id: string): void {
  const scene = selectedScene.value
  if (!scene) return
  const index = scene.graph.nodes.findIndex((node) => node.id === id)
  if (index < 0) return
  scene.graph.nodes.splice(index, 1)
  selectedNodeId.value = scene.graph.nodes[Math.max(0, index - 1)]?.id ?? null
}

function moveNode(id: string, destinationId: string): void {
  const nodes = selectedScene.value?.graph.nodes
  if (!nodes || id === destinationId) return
  const from = nodes.findIndex((node) => node.id === id)
  const to = nodes.findIndex((node) => node.id === destinationId)
  if (from < 0 || to < 0) return
  const [node] = nodes.splice(from, 1)
  nodes.splice(to, 0, node)
}

async function refreshDiagnostics(): Promise<void> {
  status.value = await window.api.audioEngine.getDspGraphStatus()
}

async function saveScenes(): Promise<void> {
  if (!state.value) return
  busy.value = true
  try {
    state.value.scenes.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
    state.value = await submitDspSceneDraft(
      window.api.audioEngine,
      state.value.scenes,
      state.value.pinnedSceneId
    )
    selectedSceneId.value = state.value.activeSceneId ?? selectedSceneId.value
    message.value = 'DSP 场景已保存并提交给音频引擎。'
    await refreshDiagnostics()
  } catch (error) {
    await refreshDiagnostics().catch(() => undefined)
    message.value =
      status.value?.applyError || (error instanceof Error ? error.message : '无法保存 DSP 场景')
  } finally {
    busy.value = false
  }
}

async function applySelectedScene(): Promise<void> {
  if (!selectedScene.value || !state.value) return
  const sceneId = selectedScene.value.id
  busy.value = true
  try {
    state.value.scenes.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
    let next = await submitDspSceneDraft(
      window.api.audioEngine,
      state.value.scenes,
      state.value.pinnedSceneId,
      sceneId
    )
    if (next.requiresPcmFallback && !next.dsdPcmFallbackApplied) {
      const confirmed = window.confirm(
        '此场景需要 DSP 处理。切换到 PCM 并应用会停止 Native DSD/DoP 直通，是否继续？'
      )
      if (confirmed) next = await window.api.audioEngine.applyDspScene(sceneId, true)
    }
    state.value = next
    message.value =
      next.requiresPcmFallback && !next.dsdPcmFallbackApplied
        ? '保留 DSD Direct/DoP 直通，DSP 图未应用。'
        : '活动场景已应用。'
    await refreshDiagnostics()
  } catch (error) {
    await refreshDiagnostics().catch(() => undefined)
    message.value =
      status.value?.applyError || (error instanceof Error ? error.message : '无法应用 DSP 场景')
  } finally {
    busy.value = false
  }
}

function togglePin(): void {
  if (!state.value || !selectedScene.value) return
  state.value.pinnedSceneId = isPinned.value ? null : selectedScene.value.id
  message.value = state.value.pinnedSceneId
    ? '手动 pin 将覆盖自动规则。请保存以生效。'
    : '已恢复自动规则。请保存以生效。'
}

function toggleSnapshot(): void {
  if (!state.value) return
  if (!snapshotA.value) {
    snapshotA.value = state.value.scenes.map((scene) => cloneScene(scene))
    message.value = 'A 快照已记录。修改后可一键回到 A。'
    return
  }
  state.value.scenes = snapshotA.value.map((scene) => cloneScene(scene))
  selectScene(selectedSceneId.value ?? state.value.scenes[0]?.id ?? '')
  message.value = '已恢复 A 快照。保存后重新编译。'
}

async function refreshLibrary(): Promise<void> {
  const [nextAssets, nextCatalog] = await Promise.all([
    window.api.audioEngine.getDspAssets(),
    window.api.audioEngine.getVst3Catalog()
  ])
  assets.value = nextAssets
  vst3Catalog.value = nextCatalog
}

async function importAsset(kind: DspAssetKind): Promise<void> {
  const asset = await window.api.audioEngine.importDspAsset(kind)
  if (!asset) return
  assets.value = await window.api.audioEngine.getDspAssets()
  if (selectedNode.value?.type === 'convolver' && kind === 'impulseResponse') {
    selectedNode.value.params.impulseResponseAssetId = asset.id
    selectedNode.value.params.impulseResponsePath = ''
  }
  if (
    selectedNode.value?.type === 'vst3Plugin' &&
    selectedNode.value.vst3 &&
    (kind === 'vst3Preset' || kind === 'vst3State')
  ) {
    selectedNode.value.vst3 = { ...selectedNode.value.vst3, stateAssetId: asset.id }
  }
}

function applyCorrectionProfile(assetId: string, profile: DspCorrectionProfile): void {
  if (!selectedNode.value || selectedNode.value.type !== 'equalizer') return
  selectedNode.value.enabled = true
  selectedNode.value.params = {
    ...selectedNode.value.params,
    mode: 'parametric',
    preampDb: profile.preampDb,
    bands: profile.bands.map((band) => ({ ...band })),
    correctionAssetId: assetId,
    correctionFormat: profile.format
  }
}

async function importCorrectionProfile(): Promise<void> {
  if (!selectedNode.value || selectedNode.value.type !== 'equalizer') return
  busy.value = true
  try {
    const imported = await window.api.audioEngine.importDspCorrectionProfile()
    if (!imported) return
    applyCorrectionProfile(imported.asset.id, imported.profile)
    assets.value = await window.api.audioEngine.getDspAssets()
    message.value = `已导入 ${imported.profile.bands.length} 段 ${imported.profile.format} 校正，并写入当前参数 EQ。`
  } catch (error) {
    message.value = error instanceof Error ? error.message : '无法导入参数 EQ 校正文件'
  } finally {
    busy.value = false
  }
}

async function selectCorrectionAsset(assetId: string): Promise<void> {
  if (!selectedNode.value || selectedNode.value.type !== 'equalizer') return
  if (!assetId) {
    delete selectedNode.value.params.correctionAssetId
    delete selectedNode.value.params.correctionFormat
    return
  }
  busy.value = true
  try {
    applyCorrectionProfile(assetId, await window.api.audioEngine.getDspCorrectionProfile(assetId))
  } catch (error) {
    message.value = error instanceof Error ? error.message : '无法读取校正资料'
  } finally {
    busy.value = false
  }
}

async function exportProfile(): Promise<void> {
  await window.api.audioEngine.exportDspProfile(selectedScene.value?.name)
}

async function importProfile(): Promise<void> {
  const imported = await window.api.audioEngine.importDspProfile()
  if (!imported) return
  state.value = imported.state
  state.value.scenes.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
  selectedSceneId.value = imported.state.activeSceneId ?? imported.state.scenes[0]?.id ?? null
  selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
  await refreshLibrary()
  await refreshDiagnostics()
}

async function scanVst3(): Promise<void> {
  busy.value = true
  try {
    vst3Catalog.value = await window.api.audioEngine.scanVst3Plugins()
  } finally {
    busy.value = false
  }
}

async function recoverVst3Module(catalogId: string): Promise<void> {
  busy.value = true
  try {
    vst3Catalog.value = await window.api.audioEngine.clearVst3Quarantine(catalogId)
    await refreshDiagnostics()
    const entry = vst3Catalog.value.entries.find((candidate) => candidate.id === catalogId)
    message.value =
      entry?.status === 'available'
        ? `${entry.name} was re-scanned and is ready for manual re-enable.`
        : entry?.error || 'The VST3 module remains unavailable after its isolated scan.'
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Unable to recover the VST3 module.'
  } finally {
    busy.value = false
  }
}

function setOutputTarget(value: string): void {
  const scene = selectedScene.value
  if (!scene) return
  scene.graph.outputStage.targetSampleRate = value === 'device' ? 'device' : Number(value)
}

function setOutputQuality(value: string): void {
  const scene = selectedScene.value
  if (!scene || !['native', 'high', 'ultra', 'soxrHq', 'soxrVhq'].includes(value)) return
  scene.graph.outputStage.resamplerQuality = value as DspResamplerQuality
}

function setOutputDither(value: string): void {
  const scene = selectedScene.value
  if (!scene || !['off', 'tpdf', 'highpassTpdf', 'noiseShaped'].includes(value)) return
  scene.graph.outputStage.dither = value as 'off' | 'tpdf' | 'highpassTpdf' | 'noiseShaped'
}

onMounted(async () => {
  try {
    state.value = await window.api.audioEngine.getDspSceneState()
    state.value.scenes.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
    selectedSceneId.value = state.value.activeSceneId ?? state.value.scenes[0]?.id ?? null
    selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
    await Promise.all([refreshDiagnostics(), refreshLibrary()])
  } catch (error) {
    message.value = error instanceof Error ? error.message : '无法读取 DSP Rack 状态'
  }
})
onMounted(() => {
  diagnosticsPoll = window.setInterval(() => {
    if (busy.value || document.visibilityState === 'hidden') return
    void refreshDiagnostics().catch(() => undefined)
  }, 1000)
})

onBeforeUnmount(() => {
  if (diagnosticsPoll !== null) window.clearInterval(diagnosticsPoll)
})
</script>

<template>
  <main class="dsp-rack-page">
    <header class="rack-header">
      <div>
        <p class="eyebrow">DSP WORKSTATION</p>
        <h1>DSP Rack</h1>
      </div>
      <div class="rack-header-actions">
        <button
          type="button"
          class="icon-button"
          title="刷新诊断"
          :disabled="busy"
          @click="refreshDiagnostics"
        >
          <i class="pi pi-refresh"></i>
        </button>
        <button
          type="button"
          class="icon-button"
          title="导入配置包"
          :disabled="busy"
          @click="importProfile"
        >
          <i class="pi pi-upload"></i>
        </button>
        <button
          type="button"
          class="icon-button"
          title="导出配置包"
          :disabled="busy"
          @click="exportProfile"
        >
          <i class="pi pi-download"></i>
        </button>
      </div>
    </header>

    <p
      v-if="message"
      class="rack-message"
      :class="{ error: graphApplyState === 'failed' }"
      :role="graphApplyState === 'failed' ? 'alert' : 'status'"
    >
      {{ message }}
    </p>

    <div class="rack-layout">
      <DspScenePane
        :scenes="scenes"
        :selected-scene-id="selectedSceneId"
        :active-scene-id="activeSceneId"
        v-model:factory-template="factoryTemplateToAdd"
        @select="selectScene"
        @add="addScene"
        @duplicate="duplicateScene"
        @remove="removeScene"
        @add-factory="addFactoryScene"
      />
      <DspGraphCanvas
        :scene="selectedScene"
        :selected-node-id="selectedNodeId"
        :busy="busy"
        :is-pinned="isPinned"
        :snapshot-a="snapshotA !== null"
        :state="state"
        :vst3-helpers-notice="vst3HelpersNotice"
        :soxr-fallback-active="soxrFallbackActive"
        v-model:node-type-to-add="nodeTypeToAdd"
        @select-node="selectNode"
        @add-node="addNode"
        @remove-node="removeNode"
        @move-node="moveNode"
        @apply="applySelectedScene"
        @save="saveScenes"
        @toggle-pin="togglePin"
        @toggle-snapshot="toggleSnapshot"
        @set-output-target="setOutputTarget"
        @set-output-quality="setOutputQuality"
        @set-output-dither="setOutputDither"
      />
      <DspNodeEditor
        :scene="selectedScene"
        :node="selectedNode"
        :status="status"
        :selected-status="selectedStatus"
        :busy="busy"
        :assets="assets"
        :vst3-catalog="vst3Catalog"
        :vst3-helpers-ready="vst3HelpersReady"
        @import-asset="importAsset"
        @import-correction-profile="importCorrectionProfile"
        @select-correction-asset="selectCorrectionAsset"
        @scan-vst3="scanVst3"
        @recover-vst3="recoverVst3Module"
      />
    </div>

    <footer class="rack-footer">
      <span>图延迟 {{ activeGraphLatency }} frames</span
      ><span>尾音 {{ activeGraphTail }} frames</span
      ><span>图 revision {{ status?.revision ?? 0 }}</span
      ><span :class="['apply-state', graphApplyState]">
        {{ graphApplyLabel }} {{ status?.appliedRevision ?? 0 }}/{{
          status?.requestedRevision ?? 0
        }}
      </span>
    </footer>
  </main>
</template>

<style scoped>
.dsp-rack-page {
  height: 100vh;
  min-height: 0;
  min-width: 0;
  padding: calc(28px + 28px) 32px 24px;
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  color: var(--te-settings-text, #1a1a1a);
  font-family: var(--te-font-sans);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  -webkit-font-smoothing: antialiased;
}
:deep(.rack-header),
:deep(.pane-heading),
:deep(.graph-heading),
:deep(.scene-toolbar),
:deep(.rack-footer),
:deep(.rack-header-actions),
:deep(.node-add),
:deep(.scene-actions) {
  display: flex;
  align-items: center;
}
:deep(.rack-header) {
  position: relative;
  justify-content: space-between;
  max-width: 1540px;
  margin: 0 auto 18px;
}
:deep(.rack-header h1) {
  margin: 4px 0 0;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--te-settings-text, #1a1a1a);
}
:deep(.eyebrow) {
  margin: 0;
  font-size: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
  font-weight: 600;
  letter-spacing: 0.04em;
}
:deep(.rack-header-actions) {
  gap: 8px;
}
:deep(.rack-message) {
  max-width: 1540px;
  margin: 0 auto 14px;
  padding: 10px 14px;
  background: var(--te-success-soft-bg, #f0fdf4);
  border: 1px solid color-mix(in srgb, var(--te-success-soft-fg, #16a34a) 28%, transparent);
  border-radius: 12px;
  color: var(--te-success-soft-fg, #16a34a);
  font-size: 13px;
}
:deep(.rack-message.error) {
  background: var(--te-danger-soft-bg, #fef2f2);
  border-color: color-mix(in srgb, var(--te-danger-soft-fg, #b91c1c) 28%, transparent);
  color: var(--te-danger-soft-fg, #b91c1c);
}
:deep(.rack-layout) {
  max-width: 1540px;
  min-height: 640px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 230px minmax(420px, 1fr) 320px;
  gap: 14px;
  border: none;
  border-radius: 0;
  background: transparent;
  overflow: visible;
}
:deep(.scene-pane),
:deep(.graph-pane),
:deep(.detail-pane) {
  border: 1px solid var(--te-settings-panel-border, transparent);
  border-radius: var(--te-equalizer-panel-radius, 20px);
  background: var(--te-settings-control-bg, var(--te-card-bg, #ffffff));
  box-shadow: var(--te-settings-shadow, 0 2px 16px rgba(15, 23, 42, 0.04));
  padding: 16px;
  min-width: 0;
}
:deep(.scene-pane),
:deep(.detail-pane) {
  background: var(--te-settings-control-bg, #ffffff);
}
:deep(.pane-heading) {
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
:deep(h2),
:deep(h3) {
  margin: 0;
  letter-spacing: 0;
  color: var(--te-settings-text, #1a1a1a);
}
:deep(h2) {
  font-size: 15px;
  font-weight: 600;
}
:deep(h3) {
  font-size: 13px;
  font-weight: 500;
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.scene-row) {
  width: 100%;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 10px 10px;
  color: var(--te-settings-nav-text, #5c6370);
  background: transparent;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
}
:deep(.scene-row:hover) {
  background: var(--te-settings-nav-hover, rgba(15, 23, 42, 0.04));
  color: var(--te-settings-text, #1a1a1a);
}
:deep(.scene-row.selected) {
  background: var(--te-settings-nav-active, #ffffff);
  color: var(--te-settings-text, #1a1a1a);
  box-shadow: var(--te-settings-shadow-soft, 0 1px 4px rgba(15, 23, 42, 0.04));
}
:deep(.scene-row.active strong),
:deep(.scene-row.active i) {
  color: var(--te-primary-500);
}
:deep(.scene-row span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.scene-row small) {
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.scene-actions) {
  gap: 6px;
  margin-top: 12px;
}
:deep(.factory-template-picker) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  gap: 6px;
  margin-top: 10px;
}
:deep(.factory-template-picker select) {
  min-width: 0;
}
:deep(.graph-pane) {
  min-width: 0;
}
:deep(.scene-toolbar) {
  flex-wrap: wrap;
  gap: 9px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.06));
}
:deep(.scene-toolbar label),
:deep(.switch-field) {
  font-size: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
:deep(.scene-toolbar input) {
  width: 86px;
}
:deep(input),
:deep(select),
:deep(textarea) {
  font: inherit;
  color: var(--te-settings-text, #1a1a1a);
  border: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.06));
  border-radius: 12px;
  background: var(--te-settings-control-bg, #ffffff);
  padding: 8px 10px;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
:deep(input:focus),
:deep(select:focus),
:deep(textarea:focus) {
  outline: none;
  border-color: var(--te-primary-500);
  box-shadow: 0 0 0 3px rgba(var(--te-primary-rgb), 0.14);
}
:deep(button) {
  font: inherit;
}
:deep(.icon-button),
:deep(.text-button),
:deep(.icon-text-button),
:deep(.primary-button) {
  border: none;
  background: var(--te-settings-search-bg, #eef0f3);
  color: var(--te-settings-text, #1a1a1a);
  cursor: pointer;
  min-height: 34px;
  border-radius: 999px;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    box-shadow 0.16s ease;
}
:deep(.icon-button:hover),
:deep(.text-button:hover),
:deep(.icon-text-button:hover) {
  background: rgba(15, 23, 42, 0.08);
  color: var(--te-primary-500);
}
:deep(.icon-button) {
  width: 34px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.icon-button.small) {
  width: 28px;
  min-height: 28px;
}
:deep(.text-button),
:deep(.icon-text-button),
:deep(.primary-button) {
  padding: 7px 14px;
}
:deep(.icon-text-button i),
:deep(.primary-button i) {
  margin-right: 6px;
}
:deep(.primary-button) {
  background: rgba(var(--te-primary-rgb), 0.12);
  color: var(--te-primary-500);
  font-weight: 600;
}
:deep(.primary-button:hover) {
  background: rgba(var(--te-primary-rgb), 0.18);
}
:deep(.icon-text-button.selected) {
  background: rgba(var(--te-primary-rgb), 0.12);
  color: var(--te-primary-500);
}
:deep(.danger) {
  color: var(--te-danger-soft-fg, #b91c1c);
}
:deep(button:disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}
:deep(.dsd-notice) {
  display: flex;
  gap: 8px;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--te-warning-soft-fg, #d97706) 28%, transparent);
  background: var(--te-warning-soft-bg, #fff7ed);
  color: var(--te-warning-soft-fg, #d97706);
  border-radius: 12px;
  font-size: 12px;
}
:deep(.graph-heading) {
  justify-content: space-between;
  margin: 15px 0 10px;
}
:deep(.graph-heading div:first-child) {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
:deep(.graph-heading span) {
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 12px;
}
:deep(.node-add) {
  gap: 6px;
}
:deep(.node-add select) {
  min-width: 150px;
}
:deep(.output-stage) {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 12px;
  padding: 12px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}
:deep(.output-stage label),
:deep(.node-controls > label) {
  display: grid;
  gap: 5px;
  min-width: 0;
  font-size: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.output-stage .switch-field) {
  display: inline-flex;
  align-items: end;
  padding-bottom: 7px;
}
:deep(.node-list) {
  display: grid;
  gap: 8px;
}
:deep(.graph-node) {
  display: grid;
  grid-template-columns: 18px 18px minmax(0, 1fr) 28px 28px;
  align-items: center;
  gap: 8px;
  min-height: 54px;
  padding: 8px 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-card-bg, #ffffff);
  box-shadow: var(--te-settings-shadow-soft, 0 1px 4px rgba(15, 23, 42, 0.04));
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}
:deep(.graph-node:hover),
:deep(.graph-node.selected) {
  border-color: color-mix(in srgb, var(--te-primary-500) 35%, transparent);
  background: rgba(var(--te-primary-rgb), 0.04);
}
:deep(.graph-node.bypassed) {
  opacity: 0.58;
}
:deep(.graph-node strong),
:deep(.graph-node small) {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
:deep(.graph-node strong) {
  font-size: 13px;
  color: var(--te-settings-text, #1a1a1a);
}
:deep(.graph-node small) {
  font-size: 11px;
  color: var(--te-settings-text-muted, #8a8f98);
  margin-top: 2px;
}
:deep(.drag-handle) {
  color: var(--te-settings-text-muted, #8a8f98);
  cursor: grab;
}
:deep(.v1-note) {
  margin: 13px 0 0;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 11px;
  line-height: 1.55;
}
:deep(.node-controls) {
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
}
:deep(.node-controls .switch-field) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
:deep(.node-controls .muted) {
  opacity: 0.55;
}
:deep(.control-heading) {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
:deep(.matrix-grid) {
  display: grid;
  gap: 4px;
  align-items: center;
  overflow-x: auto;
  padding: 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}
:deep(.matrix-grid input) {
  min-width: 42px;
  padding: 5px 4px;
  text-align: center;
  font-size: 11px;
}
:deep(.matrix-axis),
:deep(.matrix-corner) {
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}
:deep(.matrix-corner) {
  text-align: left;
}
:deep(.channel-strip-row) {
  display: grid;
  grid-template-columns: 30px repeat(2, minmax(0, 1fr));
  gap: 7px;
  align-items: end;
  padding: 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}
:deep(.channel-strip-row strong) {
  align-self: center;
  color: var(--te-primary-500);
  font-size: 12px;
}
:deep(.channel-strip-row label),
:deep(.crossover-grid label) {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 11px;
}
:deep(.channel-strip-row .switch-field) {
  padding-bottom: 7px;
}
:deep(.crossover-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
:deep(.band-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}
:deep(.band-grid.compact) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
:deep(.band-grid label) {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 11px;
}
:deep(.band-grid .switch-field) {
  display: inline-flex;
  align-items: end;
  padding-bottom: 7px;
}
:deep(.vst3-parameter-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}
:deep(.vst3-catalog-status) {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--te-warning-soft-fg, #d97706) 28%, transparent);
  border-radius: 12px;
  background: var(--te-warning-soft-bg, #fff7ed);
}
:deep(.vst3-catalog-entry) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  gap: 8px;
  align-items: center;
  color: var(--te-warning-soft-fg, #d97706);
}
:deep(.vst3-catalog-entry strong),
:deep(.vst3-catalog-entry small) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.vst3-catalog-entry strong) {
  font-size: 11px;
}
:deep(.vst3-catalog-entry small) {
  margin-top: 2px;
  font-size: 10px;
  opacity: 0.85;
}
:deep(.vst3-parameter-field) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px;
  gap: 5px 8px;
  align-items: center;
  min-width: 0;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 11px;
}
:deep(.vst3-parameter-field span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.vst3-parameter-field small) {
  margin-left: 4px;
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.vst3-parameter-field input) {
  min-width: 0;
  padding: 0;
}
:deep(.vst3-parameter-field output) {
  color: var(--te-settings-text-muted, #8a8f98);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
:deep(.raw-config) {
  border-top: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.06));
  padding-top: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 12px;
}
:deep(.raw-config pre) {
  max-height: 150px;
  margin: 8px 0 0;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--te-card-border, rgba(15, 23, 42, 0.08));
  border-radius: 12px;
  background: var(--te-subtle-bg, #f8fafc);
  color: var(--te-settings-text, #1a1a1a);
  font:
    11px/1.45 Consolas,
    monospace;
  white-space: pre-wrap;
}
:deep(.full-field),
:deep(.rule-editor > label) {
  display: grid;
  gap: 5px;
  font-size: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
  margin-bottom: 10px;
}
:deep(.full-field input),
:deep(.full-field textarea),
:deep(.rule-editor input) {
  width: 100%;
  box-sizing: border-box;
}
:deep(.full-field textarea) {
  height: 155px;
  resize: vertical;
  font-family: Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
}
:deep(.apply-params) {
  width: 100%;
  margin-bottom: 16px;
}
:deep(.rule-editor) {
  border-top: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.06));
  padding-top: 14px;
}
:deep(.rule-editor h3),
:deep(.diagnostic-panel h3) {
  margin-bottom: 11px;
}
:deep(.diagnostic-panel h3:not(:first-child)) {
  margin-top: 16px;
}
:deep(.rate-fields) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
:deep(.rate-fields label) {
  display: grid;
  gap: 5px;
  font-size: 12px;
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.diagnostic-panel) {
  border-top: 1px solid var(--te-settings-control-border, rgba(15, 23, 42, 0.06));
  margin-top: 15px;
  padding-top: 14px;
}
:deep(.diagnostic-panel dl) {
  margin: 0;
  display: grid;
  gap: 7px;
}
:deep(.diagnostic-panel dl div) {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
:deep(.diagnostic-panel dt) {
  color: var(--te-settings-text-muted, #8a8f98);
}
:deep(.diagnostic-panel dd) {
  margin: 0;
  text-align: right;
  color: var(--te-settings-text, #1a1a1a);
  overflow-wrap: anywhere;
}
:deep(.apply-state.pending) {
  color: var(--te-warning-soft-fg, #d97706);
}
:deep(.apply-state.applied) {
  color: var(--te-success-soft-fg, #16a34a);
}
:deep(.apply-state.failed),
:deep(.apply-error) {
  color: var(--te-danger-soft-fg, #b91c1c);
}
:deep(.empty-detail) {
  padding-top: 36px;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 13px;
  text-align: center;
}
:deep(.rack-footer) {
  max-width: 1540px;
  gap: 18px;
  margin: 12px auto 0;
  color: var(--te-settings-text-muted, #8a8f98);
  font-size: 12px;
}
@media (max-width: 1080px) {
  .dsp-rack-page {
    padding: 20px;
  }
  :deep(.rack-layout) {
    grid-template-columns: 200px minmax(380px, 1fr);
  }
  :deep(.detail-pane) {
    grid-column: 1 / -1;
  }
  :deep(.detail-pane textarea) {
    max-height: 140px;
  }
}
@media (max-width: 720px) {
  .dsp-rack-page {
    padding: 16px;
  }
  :deep(.rack-layout) {
    display: flex;
    flex-direction: column;
  }
  :deep(.scene-pane),
  :deep(.graph-pane),
  :deep(.detail-pane) {
    width: 100%;
  }
  :deep(.graph-pane) {
    padding: 14px;
  }
  :deep(.rack-header) {
    align-items: flex-start;
  }
  :deep(.scene-toolbar) {
    align-items: stretch;
  }
  :deep(.rack-footer) {
    flex-wrap: wrap;
  }
  :deep(.rack-header h1) {
    font-size: 22px;
  }
  :deep(.output-stage) {
    grid-template-columns: 1fr 1fr;
  }
  :deep(.band-grid) {
    grid-template-columns: 1fr 1fr;
  }
  :deep(.vst3-parameter-grid) {
    grid-template-columns: 1fr;
  }
}
:global(html[data-te-equalizer-panel] .dsp-rack-page .scene-pane),
:global(html[data-te-equalizer-panel] .dsp-rack-page .graph-pane),
:global(html[data-te-equalizer-panel] .dsp-rack-page .detail-pane),
:global(html[data-te-equalizer-panel] .dsp-rack-page .output-stage),
:global(html[data-te-equalizer-panel] .dsp-rack-page .graph-node) {
  border-color: var(--te-equalizer-panel-border);
  background: var(--te-equalizer-panel-bg);
  border-radius: var(--te-equalizer-panel-radius);
}

:global(html[data-te-equalizer-panel='tinted'] .dsp-rack-page .scene-pane),
:global(html[data-te-equalizer-panel='tinted'] .dsp-rack-page .graph-pane),
:global(html[data-te-equalizer-panel='tinted'] .dsp-rack-page .detail-pane) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 84%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .dsp-rack-page .scene-pane),
:global(html[data-te-equalizer-panel='glass'] .dsp-rack-page .graph-pane),
:global(html[data-te-equalizer-panel='glass'] .dsp-rack-page .detail-pane) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

:global(html[data-te-equalizer-button] .dsp-rack-page .icon-button),
:global(html[data-te-equalizer-button] .dsp-rack-page .text-button),
:global(html[data-te-equalizer-button] .dsp-rack-page .icon-text-button),
:global(html[data-te-equalizer-button] .dsp-rack-page .primary-button) {
  border-radius: var(--te-equalizer-button-radius);
}

:global(html[data-te-equalizer-button='soft'] .dsp-rack-page .icon-button),
:global(html[data-te-equalizer-button='soft'] .dsp-rack-page .text-button),
:global(html[data-te-equalizer-button='soft'] .dsp-rack-page .icon-text-button) {
  border-color: transparent;
  background: var(--te-equalizer-button-bg);
}

:global(html[data-te-equalizer-button='outline'] .dsp-rack-page .icon-button),
:global(html[data-te-equalizer-button='outline'] .dsp-rack-page .text-button),
:global(html[data-te-equalizer-button='outline'] .dsp-rack-page .icon-text-button) {
  border: 1px solid var(--te-equalizer-panel-border);
  background: transparent;
}

:global(html[data-te-equalizer-button='solid'] .dsp-rack-page .icon-button),
:global(html[data-te-equalizer-button='solid'] .dsp-rack-page .text-button),
:global(html[data-te-equalizer-button='solid'] .dsp-rack-page .icon-text-button),
:global(html[data-te-equalizer-button='solid'] .dsp-rack-page .primary-button) {
  border-color: var(--te-primary-500);
  background: var(--te-primary-500);
  color: var(--te-neutral-50);
}

:global(html[data-te-equalizer-slider] .dsp-rack-page input[type='range']) {
  accent-color: var(--te-primary-500);
}

:global(
  html[data-te-equalizer-slider] .dsp-rack-page input[type='range']::-webkit-slider-runnable-track
) {
  border-radius: 999px;
  background: var(--te-equalizer-slider-track);
}

:global(html[data-te-equalizer-slider] .dsp-rack-page input[type='range']::-webkit-slider-thumb) {
  width: var(--te-equalizer-slider-thumb-size);
  height: var(--te-equalizer-slider-thumb-size);
  border: 2px solid var(--te-primary-500);
  border-radius: 50%;
  background: var(--te-equalizer-slider-thumb);
}

:global(
  html[data-te-equalizer-slider='solid'] .dsp-rack-page input[type='range']::-webkit-slider-thumb
) {
  border: 0;
  background: var(--te-primary-500);
}
</style>
