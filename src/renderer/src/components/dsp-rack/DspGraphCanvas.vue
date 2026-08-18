<script setup lang="ts">
import { ref } from 'vue'
import type { DspNodeType, DspScene, DspSceneState } from '../../../../shared/dspGraph.ts'
import { nodeCatalog, nodeLabel } from '@renderer/utils/dspNodeParams'

const scene = defineModel<DspScene | null>('scene')
const nodeTypeToAdd = defineModel<DspNodeType>('nodeTypeToAdd')

defineProps<{
  selectedNodeId: string | null
  busy: boolean
  isPinned: boolean
  snapshotA: boolean
  state: DspSceneState | null
  vst3HelpersNotice: string
  soxrFallbackActive: boolean
}>()

const emit = defineEmits<{
  selectNode: [id: string]
  addNode: []
  removeNode: [id: string]
  moveNode: [id: string, destinationId: string]
  apply: []
  save: []
  togglePin: []
  toggleSnapshot: []
  setOutputTarget: [value: string]
  setOutputQuality: [value: string]
  setOutputDither: [value: string]
}>()

const draggedNodeId = ref<string | null>(null)

function onDrop(destinationId: string): void {
  if (draggedNodeId.value) emit('moveNode', draggedNodeId.value, destinationId)
  draggedNodeId.value = null
}
</script>

<template>
  <section class="graph-pane">
    <template v-if="scene">
      <div class="scene-toolbar">
        <label>名称<input v-model="scene.name" maxlength="64" /></label>
        <label>优先级<input v-model.number="scene.priority" type="number" step="1" /></label>
        <label class="switch-field"
          ><input v-model="scene.enabled" type="checkbox" /> 场景启用</label
        >
        <button
          type="button"
          class="icon-text-button"
          :class="{ selected: isPinned }"
          @click="emit('togglePin')"
        >
          <i class="pi pi-thumbtack"></i>{{ isPinned ? '取消 Pin' : 'Pin 场景' }}
        </button>
        <button type="button" class="icon-text-button" @click="emit('toggleSnapshot')">
          <i class="pi pi-clone"></i>{{ snapshotA ? '恢复 A' : '记录 A' }}
        </button>
        <button type="button" class="primary-button" :disabled="busy" @click="emit('apply')">
          <i class="pi pi-play"></i>应用
        </button>
        <button type="button" class="icon-text-button" :disabled="busy" @click="emit('save')">
          <i class="pi pi-save"></i>保存
        </button>
      </div>

      <div v-if="state?.requiresPcmFallback && !state.dsdPcmFallbackApplied" class="dsd-notice">
        <i class="pi pi-info-circle"></i
        ><span>当前 DSD Direct/DoP 保持直通。应用 DSP 需要明确确认 PCM 回退。</span>
      </div>

      <div v-if="vst3HelpersNotice" class="dsd-notice" role="status">
        <i class="pi pi-exclamation-triangle"></i>
        <span>{{ vst3HelpersNotice }}</span>
      </div>

      <div class="graph-heading">
        <div>
          <h2>串行处理图</h2>
          <span>{{ scene.graph.nodes.length }} 个节点</span>
        </div>
        <div class="node-add">
          <select v-model="nodeTypeToAdd">
            <option v-for="item in nodeCatalog" :key="item.type" :value="item.type">
              {{ item.label }}
            </option></select
          ><button type="button" class="icon-button" title="添加节点" @click="emit('addNode')">
            <i class="pi pi-plus"></i>
          </button>
        </div>
      </div>

      <section class="output-stage">
        <label
          >Output rate
          <select
            :value="String(scene.graph.outputStage.targetSampleRate)"
            @change="emit('setOutputTarget', ($event.target as HTMLSelectElement).value)"
          >
            <option value="device">Device</option>
            <option value="44100">44.1 kHz</option>
            <option value="48000">48 kHz</option>
            <option value="88200">88.2 kHz</option>
            <option value="96000">96 kHz</option>
            <option value="176400">176.4 kHz</option>
            <option value="192000">192 kHz</option>
          </select>
        </label>
        <label
          >SRC
          <select
            :value="scene.graph.outputStage.resamplerQuality"
            @change="emit('setOutputQuality', ($event.target as HTMLSelectElement).value)"
          >
            <option value="native">Native</option>
            <option value="high">High</option>
            <option value="ultra">Ultra</option>
            <option value="soxrHq">
              SoX HQ{{ soxrFallbackActive ? '（不可用，回退 Ultra）' : '' }}
            </option>
            <option value="soxrVhq">
              SoX VHQ (最高){{ soxrFallbackActive ? '（不可用，回退 Ultra）' : '' }}
            </option>
          </select>
        </label>
        <label
          >Dither
          <select
            :value="scene.graph.outputStage.dither"
            @change="emit('setOutputDither', ($event.target as HTMLSelectElement).value)"
          >
            <option value="off">Off</option>
            <option value="tpdf">TPDF</option>
            <option value="highpassTpdf">High-pass TPDF</option>
            <option value="noiseShaped">Noise-shaped</option>
          </select>
        </label>
        <label class="switch-field"
          ><input v-model="scene.graph.outputStage.safetyClamp" type="checkbox" /> Safety
          clamp</label
        >
      </section>

      <div class="node-list" aria-label="DSP graph nodes">
        <article
          v-for="node in scene.graph.nodes"
          :key="node.id"
          draggable="true"
          class="graph-node"
          data-te-interactive
          :class="{ selected: node.id === selectedNodeId, bypassed: !node.enabled }"
          @dragstart="draggedNodeId = node.id"
          @dragover.prevent
          @drop="onDrop(node.id)"
          @click="emit('selectNode', node.id)"
        >
          <i class="pi pi-bars drag-handle" aria-hidden="true"></i>
          <i
            :class="nodeCatalog.find((item) => item.type === node.type)?.icon ?? 'pi pi-circle'"
          ></i>
          <div>
            <strong>{{ nodeLabel(node.type) }}</strong
            ><small>{{ node.id }}</small>
          </div>
          <button
            type="button"
            class="icon-button small"
            :title="node.enabled ? '旁路节点' : '启用节点'"
            @click.stop="node.enabled = !node.enabled"
          >
            <i :class="node.enabled ? 'pi pi-eye' : 'pi pi-eye-slash'"></i>
          </button>
          <button
            type="button"
            class="icon-button small danger"
            title="移除节点"
            @click.stop="emit('removeNode', node.id)"
          >
            <i class="pi pi-times"></i>
          </button>
        </article>
      </div>
      <p class="v1-note">
        ABI v1 原生插件固定在图末端、输出安全保护之前；仅 ABI v2 节点可参与此排序。
      </p>
    </template>
  </section>
</template>
