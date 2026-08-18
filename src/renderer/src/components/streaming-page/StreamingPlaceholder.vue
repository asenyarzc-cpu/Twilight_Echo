<script setup lang="ts">
defineProps<{
  title: string
  hint: string
  icon: string
  actionLabel?: string
  actionIcon?: string
  danger?: boolean
  detail?: boolean
}>()

const emit = defineEmits<{
  action: []
}>()
</script>

<template>
  <div class="streaming-placeholder" :class="{ 'detail-placeholder': detail }">
    <i
      :class="icon"
      :style="danger ? 'font-size: 40px; color: #e74c3c' : 'font-size: 48px; color: #ccc'"
    ></i>
    <p class="placeholder-title">{{ title }}</p>
    <p class="placeholder-hint">{{ hint }}</p>
    <button v-if="actionLabel" type="button" class="stream-action-btn" @click="emit('action')">
      <i v-if="actionIcon" :class="actionIcon"></i>
      <span>{{ actionLabel }}</span>
    </button>
  </div>
</template>

<style scoped src="./StreamingPlaceholder.css"></style>
