<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useThemeStore } from '@renderer/stores/useThemeStore'

const LocalDashboard = defineAsyncComponent(() => import('@renderer/components/LocalDashboard.vue'))
const ArchiveDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/ArchiveDashboard.vue')
)
const NightHarborDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/NightHarborDashboard.vue')
)
const { presetLayout } = useThemeStore()

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()
</script>

<template>
  <component
    :is="
      presetLayout === 'aurora-reference'
        ? ArchiveDashboard
        : presetLayout === 'obsidian-glass'
          ? NightHarborDashboard
          : LocalDashboard
    "
    @select-view="
      (category: string, filter: string | null) => emit('select-view', category, filter)
    "
    @open-library-settings="emit('open-library-settings')"
  />
</template>
