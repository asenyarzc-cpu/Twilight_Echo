<script setup lang="ts">
import { computed } from 'vue'
import type {
  DspAsset,
  DspAssetKind,
  DspGraphNode,
  DspGraphNodeStatus,
  DspGraphStatus,
  DspScene,
  Vst3CatalogState
} from '../../../../shared/dspGraph.ts'
import { channelMatrixPresetsForLayout } from '@renderer/utils/channelMatrixPresets'
import {
  addDynamicEqBand,
  addMultibandBand,
  applyMatrixPreset,
  bandBoolean,
  bandNumber,
  bandString,
  bandsFor,
  booleanParam,
  channelLabelsForNode,
  channelLayouts,
  channelStripRows,
  convolverRoutingMode,
  convolverRoutingValue,
  isReadOnlyVst3Parameter,
  layoutForNode,
  matrixChannelCount,
  matrixValue,
  nodeLabel,
  normalizeMultibandCrossovers,
  numberParam,
  removeBand,
  removeMultibandBand,
  resetConvolverRouting,
  resetMatrix,
  setBandBoolean,
  setBandNumber,
  setBandString,
  setBooleanParam,
  setConvolverRoutingLayout,
  setConvolverRoutingMode,
  setConvolverRoutingValue,
  setMatrixValue,
  setMultibandCrossover,
  setNodeLayout,
  setNumberParam,
  setStringParam,
  setVst3Parameter,
  stringParam,
  vst3ParameterStep,
  vst3ParameterValue
} from '@renderer/utils/dspNodeParams'

const scene = defineModel<DspScene | null>('scene')
const node = defineModel<DspGraphNode | null>('node')

const props = defineProps<{
  status: DspGraphStatus | null
  selectedStatus: DspGraphNodeStatus | null
  busy: boolean
  assets: DspAsset[]
  vst3Catalog: Vst3CatalogState | null
  vst3HelpersReady: boolean
}>()

const emit = defineEmits<{
  importAsset: [kind: DspAssetKind]
  importCorrectionProfile: []
  selectCorrectionAsset: [assetId: string]
  scanVst3: []
  recoverVst3: [catalogId: string]
}>()

const selectedVst3Entry = computed(() => {
  const catalogId = node.value?.vst3?.catalogId
  return catalogId
    ? (props.vst3Catalog?.entries.find((entry) => entry.id === catalogId) ?? null)
    : null
})
const visibleVst3Parameters = computed(() =>
  (selectedVst3Entry.value?.parameters ?? []).filter((parameter) => (parameter.flags & 16) === 0)
)
const vst3StateAssets = computed(() =>
  props.assets.filter((asset) => asset.kind === 'vst3Preset' || asset.kind === 'vst3State')
)
const graphApplyState = computed(() => props.status?.applyState ?? 'idle')
const graphApplyLabel = computed(() => {
  if (graphApplyState.value === 'pending') return 'Pending'
  if (graphApplyState.value === 'applied') return 'Applied'
  if (graphApplyState.value === 'failed') return 'Failed'
  return 'Idle'
})
const graphOverrunCount = computed(
  () =>
    props.status?.nodes.reduce((total, statusNode) => total + (statusNode.overrunCount ?? 0), 0) ??
    0
)
const soxrFallbackActive = computed(() => props.status?.outputStage?.resamplerFallback === true)

function formatMetric(value: number | null | undefined, digits = 1, unit = ''): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(digits)}${unit}`
    : '-'
}

function selectImpulseAsset(assetId: string): void {
  if (!node.value) return
  node.value.params.impulseResponseAssetId = assetId
  node.value.params.impulseResponsePath = ''
}

function selectCorrectionAsset(assetId: string): void {
  emit('selectCorrectionAsset', assetId)
}

function updateRuleList(
  key: 'deviceIds' | 'backends' | 'channelLayouts' | 'sourceKinds',
  value: string
): void {
  const selectedScene = scene.value
  if (!selectedScene) return
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (entries.length === 0) {
    delete selectedScene.rules[key]
    return
  }
  selectedScene.rules[key] = entries as never
}

function selectVst3(catalogId: string): void {
  const entry = props.vst3Catalog?.entries.find((candidate) => candidate.id === catalogId)
  if (!node.value || !entry) return
  node.value.vst3 = { catalogId: entry.id, classId: entry.classId }
  node.value.params.catalogId = entry.id
  node.value.params.classId = entry.classId
  node.value.params.parameters = Object.fromEntries(
    entry.parameters.map((parameter) => [String(parameter.id), parameter.defaultNormalizedValue])
  )
}

function selectVst3State(assetId: string): void {
  const selectedNode = node.value
  if (!selectedNode?.vst3) return
  if (!assetId) {
    selectedNode.vst3 = {
      catalogId: selectedNode.vst3.catalogId,
      classId: selectedNode.vst3.classId
    }
    return
  }
  const asset = vst3StateAssets.value.find((candidate) => candidate.id === assetId)
  if (asset) selectedNode.vst3 = { ...selectedNode.vst3, stateAssetId: asset.id }
}
</script>

<template>
  <aside class="detail-pane">
    <template v-if="scene && node">
      <div class="pane-heading">
        <h2>{{ nodeLabel(node.type) }}</h2>
        <label class="switch-field"><input v-model="node.enabled" type="checkbox" /> 启用</label>
      </div>
      <label class="full-field">节点 ID<input v-model="node.id" maxlength="96" /></label>
      <label v-if="node.type === 'nativePlugin'" class="full-field"
        >插件 ID<input v-model="node.pluginId" placeholder="com.example.dsp"
      /></label>
      <section class="node-controls">
        <template v-if="node.type === 'replayGain'">
          <label
            >Mode<select
              :value="stringParam(node, 'mode', 'track')"
              @change="setStringParam(node, 'mode', ($event.target as HTMLSelectElement).value)"
            >
              <option value="off">Off</option>
              <option value="track">Track</option>
              <option value="album">Album</option>
            </select></label
          >
          <label
            >Preamp dB<input
              :value="numberParam(node, 'preampDb', 0)"
              type="number"
              min="-24"
              max="24"
              step="0.1"
              @input="setNumberParam(node, 'preampDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'clip', true)"
              type="checkbox"
              @change="setBooleanParam(node, 'clip', ($event.target as HTMLInputElement).checked)"
            />
            Clip guard</label
          >
        </template>

        <template v-else-if="node.type === 'equalizer'">
          <label
            >Mode<select
              :value="stringParam(node, 'mode', 'parametric')"
              @change="setStringParam(node, 'mode', ($event.target as HTMLSelectElement).value)"
            >
              <option value="parametric">Parametric</option>
              <option value="graphic">Graphic</option>
            </select></label
          >
          <label
            >Preamp dB<input
              :value="numberParam(node, 'preampDb', 0)"
              type="number"
              min="-24"
              max="24"
              step="0.1"
              @input="setNumberParam(node, 'preampDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <div class="control-heading">
            <h3>Correction profile</h3>
            <button
              type="button"
              class="icon-button small"
              title="Import REW, Equalizer APO, or AutoEq profile"
              :disabled="busy"
              @click="emit('importCorrectionProfile')"
            >
              <i class="pi pi-upload"></i>
            </button>
          </div>
          <label
            >Managed profile<select
              :value="stringParam(node, 'correctionAssetId')"
              :disabled="busy"
              @change="selectCorrectionAsset(($event.target as HTMLSelectElement).value)"
            >
              <option value="">None</option>
              <option
                v-for="asset in assets.filter((asset) => asset.kind === 'correctionProfile')"
                :key="asset.id"
                :value="asset.id"
              >
                {{ asset.name }}
              </option>
            </select></label
          >
        </template>

        <template v-else-if="node.type === 'crossfeed'">
          <label
            >Algorithm<select
              :value="stringParam(node, 'algorithm', 'custom')"
              @change="
                setStringParam(node, 'algorithm', ($event.target as HTMLSelectElement).value)
              "
            >
              <option value="custom">Custom</option>
              <option value="bauer">Bauer</option>
              <option value="bs2b">BS2B</option>
              <option value="meier">Meier</option>
            </select></label
          >
          <label
            >Strength<input
              :value="numberParam(node, 'strength', 0.35)"
              type="number"
              min="0"
              max="1"
              step="0.01"
              @input="setNumberParam(node, 'strength', ($event.target as HTMLInputElement).value)"
          /></label>
          <label :class="{ muted: stringParam(node, 'algorithm', 'custom') !== 'custom' }"
            >Delay ms<input
              :value="numberParam(node, 'delayMs', 0.35)"
              type="number"
              min="0.05"
              max="2"
              step="0.01"
              :disabled="stringParam(node, 'algorithm', 'custom') !== 'custom'"
              @input="setNumberParam(node, 'delayMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label :class="{ muted: stringParam(node, 'algorithm', 'custom') !== 'custom' }"
            >Cutoff Hz<input
              :value="numberParam(node, 'cutoffHz', 700)"
              type="number"
              min="80"
              max="4000"
              step="1"
              :disabled="stringParam(node, 'algorithm', 'custom') !== 'custom'"
              @input="setNumberParam(node, 'cutoffHz', ($event.target as HTMLInputElement).value)"
          /></label>
        </template>

        <template v-else-if="node.type === 'channelMatrix'">
          <label
            >Layout<select
              :value="layoutForNode(node)"
              @change="setNodeLayout(node, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="layout in channelLayouts" :key="layout" :value="layout">
                {{ layout }}
              </option>
            </select></label
          >
          <div class="control-heading">
            <h3>Routing matrix</h3>
            <button
              type="button"
              class="icon-button small"
              title="Reset to identity"
              @click="resetMatrix(node)"
            >
              <i class="pi pi-refresh"></i>
            </button>
          </div>
          <label
            >Preset<select
              value=""
              aria-label="Apply matrix preset"
              @change="applyMatrixPreset(node, $event)"
            >
              <option value="" disabled>Apply preset…</option>
              <option
                v-for="preset in channelMatrixPresetsForLayout(layoutForNode(node))"
                :key="preset.id"
                :value="preset.id"
              >
                {{ preset.label }}
              </option>
            </select></label
          >
          <div
            class="matrix-grid"
            :style="{
              gridTemplateColumns: `44px repeat(${matrixChannelCount(node)}, minmax(42px, 1fr))`
            }"
          >
            <span class="matrix-corner">Out/In</span>
            <span
              v-for="label in channelLabelsForNode(node)"
              :key="`input-${label}`"
              class="matrix-axis"
              >{{ label }}</span
            >
            <template
              v-for="(outputLabel, output) in channelLabelsForNode(node)"
              :key="`output-${outputLabel}`"
            >
              <strong class="matrix-axis">{{ outputLabel }}</strong>
              <input
                v-for="(_, input) in channelLabelsForNode(node)"
                :key="`${output}-${input}`"
                :aria-label="`${outputLabel} from ${channelLabelsForNode(node)[input]}`"
                :value="matrixValue(node, output, input)"
                type="number"
                min="-4"
                max="4"
                step="0.01"
                @input="
                  setMatrixValue(node, output, input, ($event.target as HTMLInputElement).value)
                "
              />
            </template>
          </div>
        </template>

        <template v-else-if="node.type === 'channelStrip'">
          <label
            >Layout<select
              :value="layoutForNode(node)"
              @change="setNodeLayout(node, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="layout in channelLayouts" :key="layout" :value="layout">
                {{ layout }}
              </option>
            </select></label
          >
          <div
            v-for="(channel, index) in channelStripRows(node)"
            :key="index"
            class="channel-strip-row"
          >
            <strong>{{ channelLabelsForNode(node)[index] }}</strong>
            <label
              >Gain dB<input
                :value="bandNumber(channel, 'gainDb', 0)"
                type="number"
                min="-60"
                max="24"
                step="0.1"
                @input="
                  setBandNumber(channel, 'gainDb', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Delay ms<input
                :value="bandNumber(channel, 'delayMs', 0)"
                type="number"
                min="0"
                max="250"
                step="0.01"
                @input="
                  setBandNumber(channel, 'delayMs', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label class="switch-field"
              ><input
                :checked="bandBoolean(channel, 'polarityInverted', false)"
                type="checkbox"
                @change="
                  setBandBoolean(
                    channel,
                    'polarityInverted',
                    ($event.target as HTMLInputElement).checked
                  )
                "
              />
              Invert</label
            >
            <label class="switch-field"
              ><input
                :checked="bandBoolean(channel, 'muted', false)"
                type="checkbox"
                @change="
                  setBandBoolean(channel, 'muted', ($event.target as HTMLInputElement).checked)
                "
              />
              Mute</label
            >
          </div>
        </template>

        <template v-else-if="node.type === 'bassManagement'">
          <label
            >Crossover Hz<input
              :value="numberParam(node, 'crossoverHz', 80)"
              type="number"
              min="20"
              max="500"
              step="1"
              @input="
                setNumberParam(node, 'crossoverHz', ($event.target as HTMLInputElement).value)
              "
          /></label>
          <label
            >LFE gain dB<input
              :value="numberParam(node, 'lfeGainDb', 0)"
              type="number"
              min="-24"
              max="12"
              step="0.1"
              @input="setNumberParam(node, 'lfeGainDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'redirectLfe', true)"
              type="checkbox"
              @change="
                setBooleanParam(node, 'redirectLfe', ($event.target as HTMLInputElement).checked)
              "
            />
            Redirect bass to LFE</label
          >
        </template>

        <template v-else-if="node.type === 'dynamicEqualizer'">
          <div class="control-heading">
            <h3>Bands</h3>
            <button
              type="button"
              class="icon-button small"
              title="Add band"
              @click="addDynamicEqBand(node)"
            >
              <i class="pi pi-plus"></i>
            </button>
          </div>
          <div v-for="(band, index) in bandsFor(node)" :key="index" class="band-grid">
            <label
              >Hz<input
                :value="bandNumber(band, 'frequency', 1000)"
                type="number"
                min="10"
                max="96000"
                @input="
                  setBandNumber(band, 'frequency', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Q<input
                :value="bandNumber(band, 'q', 1)"
                type="number"
                min="0.1"
                max="20"
                step="0.1"
                @input="setBandNumber(band, 'q', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Static dB<input
                :value="bandNumber(band, 'gainDb', 0)"
                type="number"
                min="-24"
                max="24"
                step="0.1"
                @input="setBandNumber(band, 'gainDb', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Threshold<input
                :value="bandNumber(band, 'thresholdDb', -24)"
                type="number"
                min="-100"
                max="0"
                step="0.1"
                @input="
                  setBandNumber(band, 'thresholdDb', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Range<input
                :value="bandNumber(band, 'rangeDb', -6)"
                type="number"
                min="-24"
                max="24"
                step="0.1"
                @input="setBandNumber(band, 'rangeDb', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Ratio<input
                :value="bandNumber(band, 'ratio', 2)"
                type="number"
                min="1"
                max="20"
                step="0.1"
                @input="setBandNumber(band, 'ratio', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Attack ms<input
                :value="bandNumber(band, 'attackMs', 15)"
                type="number"
                min="0.1"
                max="1000"
                step="0.1"
                @input="setBandNumber(band, 'attackMs', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Release ms<input
                :value="bandNumber(band, 'releaseMs', 180)"
                type="number"
                min="1"
                max="5000"
                step="1"
                @input="
                  setBandNumber(band, 'releaseMs', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Channel mask<input
                :value="bandNumber(band, 'channelMask', 255)"
                type="number"
                min="0"
                max="255"
                step="1"
                @input="
                  setBandNumber(band, 'channelMask', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Filter<select
                :value="bandString(band, 'filterType', 'peak')"
                @change="
                  setBandString(band, 'filterType', ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="peak">Peak</option>
                <option value="lowShelf">Low shelf</option>
                <option value="highShelf">High shelf</option>
                <option value="bandPass">Band pass</option>
                <option value="notch">Notch</option>
              </select></label
            >
            <label class="switch-field"
              ><input
                :checked="bandBoolean(band, 'enabled', true)"
                type="checkbox"
                @change="
                  setBandBoolean(band, 'enabled', ($event.target as HTMLInputElement).checked)
                "
              />
              On</label
            >
            <button
              type="button"
              class="icon-button small danger"
              title="Remove band"
              @click="removeBand(node, index)"
            >
              <i class="pi pi-trash"></i>
            </button>
          </div>
        </template>

        <template v-else-if="node.type === 'convolver'">
          <label
            >Impulse response<select
              :value="stringParam(node, 'impulseResponseAssetId')"
              @change="selectImpulseAsset(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Select asset</option>
              <option
                v-for="asset in assets.filter((asset) => asset.kind === 'impulseResponse')"
                :key="asset.id"
                :value="asset.id"
              >
                {{ asset.name }}
              </option>
            </select></label
          >
          <button
            type="button"
            class="icon-text-button"
            @click="emit('importAsset', 'impulseResponse')"
          >
            <i class="pi pi-upload"></i>Import IR
          </button>
          <label
            >Wet<input
              :value="numberParam(node, 'wet', 1)"
              type="number"
              min="0"
              max="1"
              step="0.01"
              @input="setNumberParam(node, 'wet', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Dry<input
              :value="numberParam(node, 'dry', 0)"
              type="number"
              min="0"
              max="1"
              step="0.01"
              @input="setNumberParam(node, 'dry', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Wet gain dB<input
              :value="numberParam(node, 'gainDb', 0)"
              type="number"
              min="-60"
              max="24"
              step="0.1"
              @input="setNumberParam(node, 'gainDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Wet delay ms<input
              :value="numberParam(node, 'delayMs', 0)"
              type="number"
              min="0"
              max="250"
              step="0.01"
              @input="setNumberParam(node, 'delayMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'polarityInverted', false)"
              type="checkbox"
              @change="
                setBooleanParam(
                  node,
                  'polarityInverted',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
            Invert wet</label
          >
          <label
            >Partition<input
              :value="numberParam(node, 'partitionSize', 0)"
              type="number"
              min="0"
              max="8192"
              step="64"
              @input="
                setNumberParam(node, 'partitionSize', ($event.target as HTMLInputElement).value)
              "
          /></label>
          <label
            >Routing<select
              :value="convolverRoutingMode(node)"
              @change="setConvolverRoutingMode(node, ($event.target as HTMLSelectElement).value)"
            >
              <option value="diagonal">Diagonal</option>
              <option value="monoToMany">1 x N</option>
              <option value="matrix">N x N</option>
            </select></label
          >
          <template v-if="convolverRoutingMode(node) !== 'diagonal'">
            <label
              >Routing layout<select
                :value="layoutForNode(node)"
                @change="
                  setConvolverRoutingLayout(node, ($event.target as HTMLSelectElement).value)
                "
              >
                <option v-for="layout in channelLayouts" :key="layout" :value="layout">
                  {{ layout }}
                </option>
              </select></label
            >
            <div class="control-heading">
              <h3>IR routing</h3>
              <button
                type="button"
                class="icon-button small"
                title="Reset routing"
                @click="resetConvolverRouting(node)"
              >
                <i class="pi pi-refresh"></i>
              </button>
            </div>
            <div
              v-if="convolverRoutingMode(node) === 'monoToMany'"
              class="matrix-grid"
              :style="{ gridTemplateColumns: '44px minmax(42px, 1fr)' }"
            >
              <span class="matrix-corner">Out</span><span class="matrix-axis">Mono</span>
              <template
                v-for="(outputLabel, output) in channelLabelsForNode(node)"
                :key="`ir-output-${outputLabel}`"
              >
                <strong class="matrix-axis">{{ outputLabel }}</strong>
                <input
                  :aria-label="`${outputLabel} from mono`"
                  :value="convolverRoutingValue(node, output)"
                  type="number"
                  min="-4"
                  max="4"
                  step="0.01"
                  @input="
                    setConvolverRoutingValue(
                      node,
                      output,
                      0,
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
              </template>
            </div>
            <div
              v-else
              class="matrix-grid"
              :style="{
                gridTemplateColumns: `44px repeat(${matrixChannelCount(node)}, minmax(42px, 1fr))`
              }"
            >
              <span class="matrix-corner">Out/In</span>
              <span
                v-for="label in channelLabelsForNode(node)"
                :key="`ir-input-${label}`"
                class="matrix-axis"
                >{{ label }}</span
              >
              <template
                v-for="(outputLabel, output) in channelLabelsForNode(node)"
                :key="`ir-output-${outputLabel}`"
              >
                <strong class="matrix-axis">{{ outputLabel }}</strong>
                <input
                  v-for="(_, input) in channelLabelsForNode(node)"
                  :key="`${output}-${input}`"
                  :aria-label="`${outputLabel} from ${channelLabelsForNode(node)[input]}`"
                  :value="convolverRoutingValue(node, output, input)"
                  type="number"
                  min="-4"
                  max="4"
                  step="0.01"
                  @input="
                    setConvolverRoutingValue(
                      node,
                      output,
                      input,
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
              </template>
            </div>
          </template>
        </template>

        <template v-else-if="node.type === 'gate' || node.type === 'compressor'">
          <label
            >Threshold dB<input
              :value="numberParam(node, 'thresholdDb', node.type === 'gate' ? -60 : -18)"
              type="number"
              min="-100"
              max="0"
              step="0.1"
              @input="
                setNumberParam(node, 'thresholdDb', ($event.target as HTMLInputElement).value)
              "
          /></label>
          <label v-if="node.type === 'compressor'"
            >Ratio<input
              :value="numberParam(node, 'ratio', 2)"
              type="number"
              min="1"
              max="20"
              step="0.1"
              @input="setNumberParam(node, 'ratio', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Attack ms<input
              :value="numberParam(node, 'attackMs', 15)"
              type="number"
              min="0.1"
              max="1000"
              step="0.1"
              @input="setNumberParam(node, 'attackMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Release ms<input
              :value="numberParam(node, 'releaseMs', 180)"
              type="number"
              min="1"
              max="5000"
              step="1"
              @input="setNumberParam(node, 'releaseMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label v-if="node.type === 'compressor'"
            >Makeup dB<input
              :value="numberParam(node, 'makeupDb', 0)"
              type="number"
              min="-24"
              max="24"
              step="0.1"
              @input="setNumberParam(node, 'makeupDb', ($event.target as HTMLInputElement).value)"
          /></label>
        </template>

        <template v-else-if="node.type === 'multibandCompressor'">
          <div class="control-heading">
            <h3>Bands</h3>
            <button
              type="button"
              class="icon-button small"
              title="Add band"
              @click="addMultibandBand(node)"
            >
              <i class="pi pi-plus"></i>
            </button>
          </div>
          <div v-if="bandsFor(node).length >= 2" class="crossover-grid">
            <label v-for="(crossover, index) in normalizeMultibandCrossovers(node)" :key="index"
              >Crossover {{ index + 1 }} Hz<input
                :value="crossover"
                type="number"
                min="20"
                max="24000"
                step="1"
                @input="
                  setMultibandCrossover(node, index, ($event.target as HTMLInputElement).value)
                "
            /></label>
          </div>
          <div v-for="(band, index) in bandsFor(node)" :key="index" class="band-grid compact">
            <label
              >Threshold<input
                :value="bandNumber(band, 'thresholdDb', -18)"
                type="number"
                min="-80"
                max="0"
                @input="
                  setBandNumber(band, 'thresholdDb', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Ratio<input
                :value="bandNumber(band, 'ratio', 2)"
                type="number"
                min="1"
                max="20"
                step="0.1"
                @input="setBandNumber(band, 'ratio', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Attack ms<input
                :value="bandNumber(band, 'attackMs', 15)"
                type="number"
                min="0.1"
                max="1000"
                step="0.1"
                @input="setBandNumber(band, 'attackMs', ($event.target as HTMLInputElement).value)"
            /></label>
            <label
              >Release ms<input
                :value="bandNumber(band, 'releaseMs', 180)"
                type="number"
                min="1"
                max="5000"
                step="1"
                @input="
                  setBandNumber(band, 'releaseMs', ($event.target as HTMLInputElement).value)
                "
            /></label>
            <label
              >Makeup<input
                :value="bandNumber(band, 'makeupDb', 0)"
                type="number"
                min="-24"
                max="24"
                step="0.1"
                @input="setBandNumber(band, 'makeupDb', ($event.target as HTMLInputElement).value)"
            /></label>
            <label class="switch-field"
              ><input
                :checked="bandBoolean(band, 'enabled', true)"
                type="checkbox"
                @change="
                  setBandBoolean(band, 'enabled', ($event.target as HTMLInputElement).checked)
                "
              />
              On</label
            >
            <button
              type="button"
              class="icon-button small danger"
              title="Remove band"
              :disabled="bandsFor(node).length <= 2"
              @click="removeMultibandBand(node, index)"
            >
              <i class="pi pi-trash"></i>
            </button>
          </div>
        </template>

        <template v-else-if="node.type === 'stereoField'">
          <label
            >Width<input
              :value="numberParam(node, 'width', 1)"
              type="number"
              min="0"
              max="2"
              step="0.01"
              @input="setNumberParam(node, 'width', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Balance<input
              :value="numberParam(node, 'balance', 0)"
              type="number"
              min="-1"
              max="1"
              step="0.01"
              @input="setNumberParam(node, 'balance', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Mid dB<input
              :value="numberParam(node, 'midGainDb', 0)"
              type="number"
              min="-24"
              max="24"
              step="0.1"
              @input="setNumberParam(node, 'midGainDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Side dB<input
              :value="numberParam(node, 'sideGainDb', 0)"
              type="number"
              min="-24"
              max="24"
              step="0.1"
              @input="
                setNumberParam(node, 'sideGainDb', ($event.target as HTMLInputElement).value)
              "
          /></label>
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'swap')"
              type="checkbox"
              @change="setBooleanParam(node, 'swap', ($event.target as HTMLInputElement).checked)"
            />
            Swap L/R</label
          >
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'mono')"
              type="checkbox"
              @change="setBooleanParam(node, 'mono', ($event.target as HTMLInputElement).checked)"
            />
            Mono sum</label
          >
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'invertLeft')"
              type="checkbox"
              @change="
                setBooleanParam(node, 'invertLeft', ($event.target as HTMLInputElement).checked)
              "
            />
            Invert L</label
          >
          <label class="switch-field"
            ><input
              :checked="booleanParam(node, 'invertRight')"
              type="checkbox"
              @change="
                setBooleanParam(node, 'invertRight', ($event.target as HTMLInputElement).checked)
              "
            />
            Invert R</label
          >
        </template>

        <template v-else-if="node.type === 'loudnessContour'">
          <label
            >Amount<input
              :value="numberParam(node, 'amount', 0)"
              type="number"
              min="0"
              max="1"
              step="0.01"
              @input="setNumberParam(node, 'amount', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Reference volume<input
              :value="numberParam(node, 'referenceVolume', 0.75)"
              type="number"
              min="0"
              max="1"
              step="0.01"
              @input="
                setNumberParam(node, 'referenceVolume', ($event.target as HTMLInputElement).value)
              "
          /></label>
        </template>

        <template v-else-if="node.type === 'truePeakLimiter'">
          <label
            >Ceiling dB<input
              :value="numberParam(node, 'ceilingDb', -0.1)"
              type="number"
              min="-12"
              max="0"
              step="0.1"
              @input="setNumberParam(node, 'ceilingDb', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Attack ms<input
              :value="numberParam(node, 'attackMs', 0.2)"
              type="number"
              min="0.1"
              max="1000"
              step="0.1"
              @input="setNumberParam(node, 'attackMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Release ms<input
              :value="numberParam(node, 'releaseMs', 80)"
              type="number"
              min="1"
              max="5000"
              @input="setNumberParam(node, 'releaseMs', ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Lookahead ms<input
              :value="numberParam(node, 'lookaheadMs', 1)"
              type="number"
              min="0.1"
              max="20"
              step="0.1"
              @input="
                setNumberParam(node, 'lookaheadMs', ($event.target as HTMLInputElement).value)
              "
          /></label>
        </template>

        <template v-else-if="node.type === 'vst3Plugin'">
          <label
            >VST3 module<select
              :value="node.vst3?.catalogId ?? ''"
              @change="selectVst3(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Select module</option>
              <option
                v-for="entry in vst3Catalog?.entries.filter(
                  (entry) => entry.status === 'available'
                ) ?? []"
                :key="entry.id"
                :value="entry.id"
              >
                {{ entry.vendor }} - {{ entry.name }}
              </option>
            </select></label
          >
          <label
            >Managed state<select
              :value="node.vst3?.stateAssetId ?? ''"
              :disabled="!node.vst3"
              @change="selectVst3State(($event.target as HTMLSelectElement).value)"
            >
              <option value="">No preset or component state</option>
              <option v-for="asset in vst3StateAssets" :key="asset.id" :value="asset.id">
                {{ asset.kind === 'vst3Preset' ? 'Preset' : 'Component state' }} -
                {{ asset.name }}
              </option>
            </select></label
          >
          <button
            type="button"
            class="icon-text-button"
            :disabled="!node.vst3"
            @click="emit('importAsset', 'vst3Preset')"
          >
            <i class="pi pi-upload"></i>Import preset
          </button>
          <button
            type="button"
            class="icon-text-button"
            :disabled="!node.vst3"
            @click="emit('importAsset', 'vst3State')"
          >
            <i class="pi pi-upload"></i>Import state
          </button>
          <button
            type="button"
            class="icon-text-button"
            :disabled="busy || !vst3HelpersReady"
            @click="emit('scanVst3')"
          >
            <i class="pi pi-search"></i>Scan VST3
          </button>
          <div
            v-if="vst3Catalog?.entries.some((entry) => entry.status !== 'available')"
            class="vst3-catalog-status"
          >
            <div
              v-for="entry in vst3Catalog?.entries.filter(
                (entry) => entry.status !== 'available'
              ) ?? []"
              :key="entry.id"
              class="vst3-catalog-entry"
            >
              <div>
                <strong>{{ entry.vendor || 'Unknown vendor' }} - {{ entry.name }}</strong>
                <small>{{ entry.status }}{{ entry.error ? `: ${entry.error}` : '' }}</small>
              </div>
              <button
                type="button"
                class="icon-button small"
                :disabled="busy"
                :title="`Re-scan and manually re-enable ${entry.name}`"
                :aria-label="`Re-scan and manually re-enable ${entry.name}`"
                @click="emit('recoverVst3', entry.id)"
              >
                <i class="pi pi-refresh"></i>
              </button>
            </div>
          </div>
          <div v-if="selectedVst3Entry" class="vst3-parameter-grid">
            <template v-for="parameter in visibleVst3Parameters" :key="parameter.id">
              <label v-if="parameter.stepCount === 1" class="switch-field">
                <input
                  type="checkbox"
                  :checked="
                    vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue) >= 0.5
                  "
                  :disabled="isReadOnlyVst3Parameter(parameter.flags)"
                  @change="
                    setVst3Parameter(
                      node,
                      parameter.id,
                      ($event.target as HTMLInputElement).checked ? 1 : 0
                    )
                  "
                />
                {{ parameter.title }}
              </label>
              <label v-else class="vst3-parameter-field">
                <span
                  >{{ parameter.title
                  }}<small v-if="parameter.unit">{{ parameter.unit }}</small></span
                >
                <input
                  type="range"
                  min="0"
                  max="1"
                  :step="vst3ParameterStep(parameter.stepCount)"
                  :value="vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue)"
                  :disabled="isReadOnlyVst3Parameter(parameter.flags)"
                  @input="
                    setVst3Parameter(node, parameter.id, ($event.target as HTMLInputElement).value)
                  "
                />
                <output>{{
                  formatMetric(
                    vst3ParameterValue(node, parameter.id, parameter.defaultNormalizedValue),
                    3
                  )
                }}</output>
              </label>
            </template>
          </div>
        </template>

        <template v-else-if="node.type === 'nativePlugin'">
          <label
            >Module path<input
              :value="stringParam(node, 'path')"
              @input="setStringParam(node, 'path', ($event.target as HTMLInputElement).value)"
          /></label>
        </template>
      </section>
      <details class="raw-config">
        <summary>Raw configuration</summary>
        <pre>{{ JSON.stringify(node.params, null, 2) }}</pre>
      </details>

      <section class="rule-editor">
        <h3>自动规则</h3>
        <label
          >设备<input
            :value="scene.rules.deviceIds?.join(', ') ?? ''"
            placeholder="device-id, device-id"
            @change="updateRuleList('deviceIds', ($event.target as HTMLInputElement).value)"
        /></label>
        <label
          >后端<input
            :value="scene.rules.backends?.join(', ') ?? ''"
            placeholder="wasapi, asio"
            @change="updateRuleList('backends', ($event.target as HTMLInputElement).value)"
        /></label>
        <label
          >布局<input
            :value="scene.rules.channelLayouts?.join(', ') ?? ''"
            placeholder="stereo, 5.1, 7.1"
            @change="updateRuleList('channelLayouts', ($event.target as HTMLInputElement).value)"
        /></label>
        <label
          >格式<input
            :value="scene.rules.sourceKinds?.join(', ') ?? ''"
            placeholder="pcm, dsd"
            @change="updateRuleList('sourceKinds', ($event.target as HTMLInputElement).value)"
        /></label>
        <div class="rate-fields">
          <label
            >最低 Hz<input
              v-model.number="scene.rules.minSampleRate"
              type="number"
              min="0" /></label
          ><label
            >最高 Hz<input v-model.number="scene.rules.maxSampleRate" type="number" min="0"
          /></label>
        </div>
      </section>

      <section class="diagnostic-panel">
        <h3>节点诊断</h3>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>
              {{
                selectedStatus?.bypassed
                  ? selectedStatus.bypassReason || '旁路'
                  : selectedStatus?.active
                    ? '运行中'
                    : '待命'
              }}
            </dd>
          </div>
          <div>
            <dt>延迟</dt>
            <dd>{{ selectedStatus?.latencyFrames ?? 0 }} frames</dd>
          </div>
          <div>
            <dt>Tail</dt>
            <dd>{{ selectedStatus?.tailFrames ?? 0 }} frames</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{{ (selectedStatus?.lastProcessMs ?? 0).toFixed(3) }} ms</dd>
          </div>
          <div>
            <dt>CPU average</dt>
            <dd>{{ formatMetric(selectedStatus?.averageProcessMs, 3, ' ms') }}</dd>
          </div>
          <div>
            <dt>CPU peak</dt>
            <dd>{{ formatMetric(selectedStatus?.maxProcessMs, 3, ' ms') }}</dd>
          </div>
          <div>
            <dt>Overruns</dt>
            <dd>{{ selectedStatus?.overrunCount ?? 0 }}</dd>
          </div>
          <div>
            <dt>Clips</dt>
            <dd>{{ selectedStatus?.clipCount ?? 0 }}</dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>{{ selectedStatus?.format || '-' }}</dd>
          </div>
        </dl>
        <h3>Graph diagnostics</h3>
        <dl>
          <div>
            <dt>Compile</dt>
            <dd>{{ status?.compileState ?? '-' }}</dd>
          </div>
          <div>
            <dt>Apply</dt>
            <dd :class="['apply-state', graphApplyState]">{{ graphApplyLabel }}</dd>
          </div>
          <div>
            <dt>Requested / applied</dt>
            <dd>{{ status?.requestedRevision ?? 0 }} / {{ status?.appliedRevision ?? 0 }}</dd>
          </div>
          <div v-if="status?.applyError">
            <dt>Apply error</dt>
            <dd class="apply-error">{{ status.applyError }}</dd>
          </div>
          <div v-if="status?.compileError">
            <dt>Compile error</dt>
            <dd>{{ status.compileError }}</dd>
          </div>
          <div>
            <dt>Output rate</dt>
            <dd>{{ status?.outputStage?.actualSampleRate ?? '-' }} Hz</dd>
          </div>
          <div>
            <dt>SRC / dither</dt>
            <dd>
              {{ status?.outputStage?.resamplerQuality ?? '-' }}
              <template v-if="status?.outputStage?.resamplerEngine"
                >({{ status.outputStage.resamplerEngine
                }}{{ soxrFallbackActive ? ' 回退' : '' }})</template
              >
              /
              {{ status?.outputStage?.dither ?? '-' }}
            </dd>
          </div>
          <div>
            <dt>Graph overruns</dt>
            <dd>{{ graphOverrunCount }}</dd>
          </div>
          <div>
            <dt>Post-DSP clips</dt>
            <dd>{{ status?.meter?.clipCount ?? 0 }}</dd>
          </div>
          <div>
            <dt>Momentary</dt>
            <dd>{{ formatMetric(status?.meter?.momentaryLufs, 1, ' LUFS') }}</dd>
          </div>
          <div>
            <dt>Short-term</dt>
            <dd>{{ formatMetric(status?.meter?.shortTermLufs, 1, ' LUFS') }}</dd>
          </div>
          <div>
            <dt>Integrated</dt>
            <dd>{{ formatMetric(status?.meter?.integratedLufs, 1, ' LUFS') }}</dd>
          </div>
          <div>
            <dt>LRA</dt>
            <dd>{{ formatMetric(status?.meter?.loudnessRangeLu, 1, ' LU') }}</dd>
          </div>
          <div>
            <dt>True peak</dt>
            <dd>{{ formatMetric(status?.meter?.truePeakDb, 2, ' dBTP') }}</dd>
          </div>
          <div>
            <dt>Correlation</dt>
            <dd>{{ formatMetric(status?.meter?.correlation, 3) }}</dd>
          </div>
        </dl>
      </section>
    </template>
    <div v-else class="empty-detail">选择一个节点来编辑参数。</div>
  </aside>
</template>
