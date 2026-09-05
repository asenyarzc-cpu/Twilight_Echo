<script setup lang="ts">
defineProps<{
  name: 'volume' | 'muted' | 'queue' | 'hifi' | 'equalizer' | 'miniPlayer' | 'favorite'
  filled?: boolean
}>()
</script>

<template>
  <svg
    class="player-control-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'volume' || name === 'muted'">
      <path d="M11 5 6 9H3v6h3l5 4Z" />
      <path v-if="name === 'volume'" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
      <path v-else d="m16 9 6 6m0-6-6 6" />
    </template>
    <path v-else-if="name === 'queue'" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    <template v-else-if="name === 'hifi' || name === 'equalizer'">
      <path d="M5 3v5m0 4v9M12 3v10m0 4v4M19 3v3m0 4v11" />
      <path d="M2 8h6v4H2Zm7 5h6v4H9Zm7-7h6v4h-6Z" />
    </template>
    <template v-else-if="name === 'miniPlayer'">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="12" y="11" width="7" height="6" rx="1" />
    </template>
    <path
      v-else
      d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"
      :fill="filled ? 'currentColor' : 'none'"
    />
  </svg>
</template>

<style scoped>
.player-control-icon {
  width: 1em;
  height: 1em;
  display: block;
  flex-shrink: 0;
}
</style>
