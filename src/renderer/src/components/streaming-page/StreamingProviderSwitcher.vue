<script setup lang="ts">
import { computed } from 'vue'
import type { StreamingProviderOption } from '../../utils/streamingNavigation'

const props = defineProps<{
  modelValue: string
  options: StreamingProviderOption[]
  label?: string
}>()

const emit = defineEmits<{
  change: [providerId: string]
}>()

const activeOption = computed(
  () => props.options.find((option) => option.id === props.modelValue) ?? props.options[0] ?? null
)

function onChange(event: Event): void {
  const providerId = (event.target as HTMLSelectElement).value
  if (providerId && providerId !== props.modelValue) emit('change', providerId)
}
</script>

<template>
  <div v-if="activeOption" class="provider-switcher">
    <span class="provider-switcher-label">{{ label ?? '当前音源' }}</span>
    <label
      v-if="options.length > 1"
      class="provider-switcher-control is-interactive"
      :style="{ '--provider-color': activeOption.color }"
    >
      <i :class="activeOption.icon" aria-hidden="true"></i>
      <span class="provider-switcher-name">{{ activeOption.name }}</span>
      <select :value="activeOption.id" :aria-label="label ?? '切换音源'" @change="onChange">
        <option v-for="option in options" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>
      <i class="pi pi-chevron-down provider-switcher-caret" aria-hidden="true"></i>
    </label>
    <span
      v-else
      class="provider-switcher-control is-static"
      :style="{ '--provider-color': activeOption.color }"
    >
      <i :class="activeOption.icon" aria-hidden="true"></i>
      <span class="provider-switcher-name">{{ activeOption.name }}</span>
    </span>
  </div>
</template>

<style scoped>
.provider-switcher {
  position: relative;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--te-neutral-600);
  font-size: 12px;
  font-weight: 700;
}

.provider-switcher-label {
  white-space: nowrap;
}

.provider-switcher-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding-left: 13px;
  border: 1px solid color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-card-bg) 86%, transparent);
  color: var(--te-neutral-900);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
}

.provider-switcher-control > .pi:first-child {
  color: var(--provider-color, var(--te-primary-500));
  font-size: 13px;
}

.provider-switcher select {
  position: absolute;
  z-index: 2;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  outline: 0;
  opacity: 0;
  cursor: pointer;
}

.provider-switcher-name {
  min-width: 112px;
  padding-right: 34px;
  white-space: nowrap;
}

.provider-switcher-control.is-static .provider-switcher-name {
  padding-right: 13px;
}

.provider-switcher-caret {
  position: absolute;
  right: 13px;
  pointer-events: none;
  color: var(--te-neutral-500);
  font-size: 10px;
}

@media (max-width: 720px) {
  .provider-switcher-label {
    display: none;
  }

  .provider-switcher-name {
    min-width: 98px;
  }
}
</style>
