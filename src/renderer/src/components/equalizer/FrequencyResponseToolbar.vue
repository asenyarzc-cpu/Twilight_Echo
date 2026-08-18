<script setup lang="ts">
import type { ImportedFrequencyResponse } from '../../../../shared/frequencyResponse.ts'

type ResponseView = 'dsp' | 'headphone'

const props = defineProps<{
  responseView: ResponseView
  importedFrequencyResponse: ImportedFrequencyResponse | null
  importing: boolean
  error: string
  card?: boolean
}>()

const emit = defineEmits<{
  'update:responseView': [value: ResponseView]
  import: []
  clear: []
}>()
</script>

<template>
  <section v-if="props.card" class="parametric-toolbar-card" aria-label="分析器数据视图">
    <div class="response-view-toolbar">
      <div class="response-view-switch" aria-label="响应视图">
        <button
          type="button"
          :class="{ active: props.responseView === 'dsp' }"
          :aria-pressed="props.responseView === 'dsp'"
          @click="emit('update:responseView', 'dsp')"
        >
          DSP 响应
        </button>
        <button
          type="button"
          :disabled="!props.importedFrequencyResponse"
          :class="{ active: props.responseView === 'headphone' }"
          :aria-pressed="props.responseView === 'headphone'"
          @click="emit('update:responseView', 'headphone')"
        >
          耳机频响
        </button>
      </div>
      <div class="frequency-response-actions">
        <span v-if="props.importedFrequencyResponse" class="frequency-response-source">
          {{ props.importedFrequencyResponse.sourceName }} ·
          {{
            props.importedFrequencyResponse.sourceColumn === 'smoothed'
              ? 'AutoEq smoothed 列'
              : 'AutoEq raw 列'
          }}
        </span>
        <span v-if="props.error" class="frequency-response-error">
          {{ props.error }}
        </span>
        <button
          type="button"
          class="frequency-response-import"
          :disabled="props.importing"
          @click="emit('import')"
        >
          {{ props.importing ? '导入中' : '导入 AutoEq CSV' }}
        </button>
        <button
          v-if="props.importedFrequencyResponse"
          type="button"
          class="frequency-response-clear"
          @click="emit('clear')"
        >
          清除
        </button>
      </div>
    </div>
  </section>
  <div v-else class="response-view-toolbar">
    <div class="response-view-switch" aria-label="响应视图">
      <button
        type="button"
        :class="{ active: props.responseView === 'dsp' }"
        :aria-pressed="props.responseView === 'dsp'"
        @click="emit('update:responseView', 'dsp')"
      >
        DSP 响应
      </button>
      <button
        type="button"
        :disabled="!props.importedFrequencyResponse"
        :class="{ active: props.responseView === 'headphone' }"
        :aria-pressed="props.responseView === 'headphone'"
        @click="emit('update:responseView', 'headphone')"
      >
        耳机频响
      </button>
    </div>
    <div class="frequency-response-actions">
      <span v-if="props.importedFrequencyResponse" class="frequency-response-source">
        {{ props.importedFrequencyResponse.sourceName }} ·
        {{
          props.importedFrequencyResponse.sourceColumn === 'smoothed'
            ? 'AutoEq smoothed 列'
            : 'AutoEq raw 列'
        }}
      </span>
      <span v-if="props.error" class="frequency-response-error">
        {{ props.error }}
      </span>
      <button
        type="button"
        class="frequency-response-import"
        :disabled="props.importing"
        @click="emit('import')"
      >
        {{ props.importing ? '导入中' : '导入 AutoEq CSV' }}
      </button>
      <button
        v-if="props.importedFrequencyResponse"
        type="button"
        class="frequency-response-clear"
        @click="emit('clear')"
      >
        清除
      </button>
    </div>
  </div>
</template>

<style scoped>
.response-view-toolbar {
  margin: -2px 0 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.response-view-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-neutral-100);
}
.response-view-switch button,
.frequency-response-import,
.frequency-response-clear {
  appearance: none;
  border: 0;
  border-radius: 7px;
  padding: 6px 10px;
  background: transparent;
  color: var(--te-neutral-600);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.response-view-switch button.active {
  background: var(--te-card-bg);
  color: var(--te-primary-500);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
}
.response-view-switch button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.frequency-response-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.frequency-response-source {
  color: var(--te-neutral-500);
  font-size: 11px;
}
.frequency-response-error {
  max-width: 360px;
  color: var(--te-danger-soft-fg);
  font-size: 11px;
}
.frequency-response-import {
  background: var(--te-primary-500);
  color: var(--te-neutral-50);
}
.frequency-response-import:disabled {
  cursor: wait;
  opacity: 0.65;
}
.frequency-response-clear {
  color: var(--te-neutral-500);
}

.parametric-toolbar-card {
  min-height: 38px;
  padding: 5px 7px 5px 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--te-card-border) 76%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--te-card-bg) 50%, transparent);
  box-shadow: inset 0 1px color-mix(in srgb, var(--te-neutral-50) 3%, transparent);
}
.parametric-toolbar-card .response-view-toolbar {
  flex: 1;
  min-width: 0;
  margin: 0;
  gap: 6px 12px;
}
.parametric-toolbar-card .response-view-switch {
  padding: 2px;
  border-color: color-mix(in srgb, var(--te-card-border) 76%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--te-neutral-900) 5%, transparent);
}
.parametric-toolbar-card .response-view-switch button,
.parametric-toolbar-card .frequency-response-import,
.parametric-toolbar-card .frequency-response-clear {
  min-height: 25px;
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.parametric-toolbar-card .response-view-switch button.active {
  color: var(--te-neutral-100);
  background: color-mix(in srgb, var(--te-neutral-900) 88%, var(--te-primary-500));
  box-shadow: none;
}
.parametric-toolbar-card .frequency-response-actions {
  gap: 6px;
}
.parametric-toolbar-card .frequency-response-source,
.parametric-toolbar-card .frequency-response-error {
  overflow: hidden;
  max-width: min(30vw, 320px);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parametric-toolbar-card .frequency-response-import {
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 32%, transparent);
  color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500) 7%, transparent);
}
.parametric-toolbar-card .frequency-response-clear {
  border: 1px solid color-mix(in srgb, var(--te-card-border) 68%, transparent);
}

@media (max-width: 900px) {
  .parametric-toolbar-card {
    align-items: flex-start;
  }

  .parametric-toolbar-card .response-view-toolbar {
    align-items: flex-start;
  }

  .parametric-toolbar-card .frequency-response-source,
  .parametric-toolbar-card .frequency-response-error {
    max-width: 220px;
  }
}

@media (max-width: 620px) {
  .parametric-toolbar-card {
    padding: 5px;
  }

  .parametric-toolbar-card .response-view-toolbar,
  .parametric-toolbar-card .frequency-response-actions {
    width: 100%;
  }

  .parametric-toolbar-card .frequency-response-actions {
    justify-content: flex-start;
  }

  .parametric-toolbar-card .frequency-response-source,
  .parametric-toolbar-card .frequency-response-error {
    order: 3;
    width: 100%;
    max-width: none;
  }
}

:global(html[data-te-equalizer-panel] .parametric-toolbar-card) {
  border-color: var(--te-equalizer-panel-border);
  border-radius: var(--te-equalizer-panel-radius);
  background: var(--te-equalizer-panel-bg);
}

:global(html[data-te-equalizer-panel='tinted'] .parametric-toolbar-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 82%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .parametric-toolbar-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

:global(html[data-te-equalizer-panel] .parametric-toolbar-card) {
  border-color: color-mix(in srgb, var(--te-equalizer-panel-border) 76%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 46%, transparent);
}

:global(html[data-te-equalizer-panel='tinted'] .parametric-toolbar-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 72%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .parametric-toolbar-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 42%, transparent);
  backdrop-filter: blur(14px) saturate(120%);
  -webkit-backdrop-filter: blur(14px) saturate(120%);
}

:global(html[data-theme='pureWhite'] .parametric-toolbar-card) {
  border-color: var(--te-card-border);
  background: var(--te-card-bg);
  box-shadow: none;
}
</style>
