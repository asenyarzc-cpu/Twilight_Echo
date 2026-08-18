<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SearchSource, SearchSourceOption, SearchType } from './useStreamingSearch'

const props = defineProps<{
  searchType: SearchType
  availableSearchTypes: SearchType[]
  searchSources: SearchSourceOption[]
  searchSource: SearchSource
}>()

const emit = defineEmits<{
  'update:searchType': [value: SearchType]
  'select-source': [value: SearchSource]
}>()

const sourceMenuOpen = ref(false)
const activeSourceOption = computed(
  () =>
    props.searchSources.find((source) => source.id === props.searchSource) ??
    props.searchSources[0] ??
    null
)

function selectSearchSource(sourceId: SearchSource): void {
  const source = props.searchSources.find((candidate) => candidate.id === sourceId)
  if (!source || !source.available) return
  emit('select-source', sourceId)
  sourceMenuOpen.value = false
}

function onSourceMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  const container = event.currentTarget as HTMLElement | null
  if (!next || !container?.contains(next)) sourceMenuOpen.value = false
}
</script>

<template>
  <div class="streaming-search-tabs">
    <div class="search-type-group">
      <div
        class="search-tab-pill"
        data-te-interactive
        role="button"
        :tabindex="availableSearchTypes.includes('songs') ? 0 : -1"
        :aria-pressed="searchType === 'songs'"
        :aria-disabled="!availableSearchTypes.includes('songs')"
        :class="{
          active: searchType === 'songs',
          disabled: !availableSearchTypes.includes('songs')
        }"
        @click="availableSearchTypes.includes('songs') && emit('update:searchType', 'songs')"
        @keydown.enter.prevent="
          availableSearchTypes.includes('songs') && emit('update:searchType', 'songs')
        "
        @keydown.space.prevent="
          availableSearchTypes.includes('songs') && emit('update:searchType', 'songs')
        "
      >
        单曲
      </div>
      <div
        class="search-tab-pill"
        data-te-interactive
        role="button"
        :tabindex="availableSearchTypes.includes('playlists') ? 0 : -1"
        :aria-pressed="searchType === 'playlists'"
        :aria-disabled="!availableSearchTypes.includes('playlists')"
        :class="{
          active: searchType === 'playlists',
          disabled: !availableSearchTypes.includes('playlists')
        }"
        @click="
          availableSearchTypes.includes('playlists') && emit('update:searchType', 'playlists')
        "
        @keydown.enter.prevent="
          availableSearchTypes.includes('playlists') && emit('update:searchType', 'playlists')
        "
        @keydown.space.prevent="
          availableSearchTypes.includes('playlists') && emit('update:searchType', 'playlists')
        "
      >
        歌单
      </div>
      <div
        class="search-tab-pill"
        data-te-interactive
        role="button"
        :tabindex="availableSearchTypes.includes('artists') ? 0 : -1"
        :aria-pressed="searchType === 'artists'"
        :aria-disabled="!availableSearchTypes.includes('artists')"
        :class="{
          active: searchType === 'artists',
          disabled: !availableSearchTypes.includes('artists')
        }"
        @click="availableSearchTypes.includes('artists') && emit('update:searchType', 'artists')"
        @keydown.enter.prevent="
          availableSearchTypes.includes('artists') && emit('update:searchType', 'artists')
        "
        @keydown.space.prevent="
          availableSearchTypes.includes('artists') && emit('update:searchType', 'artists')
        "
      >
        歌手
      </div>
    </div>
    <div
      class="search-source-dropdown"
      :class="{ open: sourceMenuOpen }"
      @focusout="onSourceMenuFocusOut"
      @keydown.esc.prevent="sourceMenuOpen = false"
    >
      <button
        class="search-source-trigger"
        aria-haspopup="listbox"
        :aria-expanded="sourceMenuOpen"
        @click="sourceMenuOpen = !sourceMenuOpen"
      >
        <i
          v-if="activeSourceOption?.icon"
          class="pi"
          :class="activeSourceOption.icon"
          style="font-size: 13px"
        ></i>
        <span>{{ activeSourceOption?.label ?? '音源' }}</span>
        <i class="pi pi-chevron-down" style="font-size: 10px"></i>
      </button>
      <div v-if="sourceMenuOpen" class="search-source-menu" role="listbox" aria-label="音源">
        <div
          v-for="source in searchSources"
          :key="source.id"
          class="search-source-option"
          role="option"
          :tabindex="source.available ? 0 : -1"
          :aria-selected="searchSource === source.id"
          :aria-disabled="!source.available"
          :class="{ active: searchSource === source.id, disabled: !source.available }"
          @mousedown.prevent="selectSearchSource(source.id)"
          @keydown.enter.prevent="selectSearchSource(source.id)"
          @keydown.space.prevent="selectSearchSource(source.id)"
        >
          <i v-if="source.icon" class="pi" :class="source.icon" style="font-size: 13px"></i>
          <span>{{ source.label }}</span>
          <i
            v-if="searchSource === source.id"
            class="pi pi-check"
            style="font-size: 12px; margin-left: auto"
          ></i>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./StreamingSearchControls.css"></style>
