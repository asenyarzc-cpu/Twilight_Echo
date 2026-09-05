<script setup lang="ts">
import { ref } from 'vue'
import AnimatedInput from '../AnimatedInput.vue'
import type { MediaProviderProfile } from '../../providers/mediaProvider'

defineProps<{
  isDetail: boolean
  isSearching: boolean
  showSubtitle: boolean
  title: string
  subtitle: string
  showUnifiedSearch: boolean
  searchQuery: string
  searchLoading: boolean
  loggedIn: boolean
  profile: MediaProviderProfile | null
}>()

const emit = defineEmits<{
  back: []
  'clear-search': []
  'update:searchQuery': [value: string]
  login: []
}>()

const searchInputFocused = ref(false)
const avatarLoadFailed = ref(false)
</script>

<template>
  <header
    class="streaming-content-header"
    :class="{
      'is-detail': isDetail,
      'is-searching': isSearching
    }"
  >
    <div class="streaming-header-left">
      <button
        v-if="isDetail"
        type="button"
        class="detail-back-button"
        data-te-back-button="pill"
        @click="emit('back')"
      >
        <i class="pi pi-arrow-left" aria-hidden="true"></i>
        <span>返回</span>
      </button>
      <div v-else class="streaming-header-copy">
        <div v-if="isSearching" class="streaming-header-kicker" aria-hidden="true">
          <span class="streaming-header-kicker-mark"></span>
          <span class="streaming-header-kicker-text"> 搜索 </span>
        </div>
        <h2 class="streaming-content-title">{{ title }}</h2>
        <p v-if="showSubtitle" class="streaming-content-subtitle">
          {{ subtitle }}
        </p>
      </div>
    </div>
    <div class="streaming-header-right">
      <div
        v-if="showUnifiedSearch"
        class="streaming-search-box"
        :class="{ focused: searchInputFocused }"
      >
        <i class="pi pi-search streaming-search-icon"></i>
        <AnimatedInput
          :model-value="searchQuery"
          type="text"
          class="streaming-search-input"
          placeholder="搜索音乐、歌手、专辑"
          @update:model-value="emit('update:searchQuery', $event)"
          @focus="searchInputFocused = true"
          @blur="searchInputFocused = false"
        />
        <i v-if="searchLoading" class="pi pi-spin pi-spinner streaming-search-spinner"></i>
        <button
          v-else-if="searchQuery"
          type="button"
          class="streaming-search-clear"
          @click="emit('clear-search')"
        >
          <i class="pi pi-times"></i>
        </button>
      </div>
      <button
        v-if="loggedIn"
        type="button"
        class="streaming-avatar-btn"
        title="个人资料"
        @click="emit('login')"
      >
        <img
          v-if="profile?.avatarUrl && !avatarLoadFailed"
          :src="profile.avatarUrl"
          alt=""
          @error="avatarLoadFailed = true"
        />
        <i v-else class="pi pi-user"></i>
      </button>
    </div>
  </header>
</template>

<style scoped src="./StreamingContentHeader.css"></style>
