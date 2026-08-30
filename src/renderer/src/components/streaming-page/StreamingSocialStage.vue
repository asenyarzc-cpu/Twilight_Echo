<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '../../types/music'
import CoverImg from '../CoverImg.vue'
import { useProgressiveList } from './useProgressiveList.ts'

export type SocialStageKind = 'artist' | 'user_list' | 'user_playlists' | string

export type SocialStageTab = {
  key: string
  label: string
  count: number
}

export type SocialPerson = {
  id: string | number
  name: string
  picUrl?: string | null
  picUrlSource?: string | null
}

export type SocialCollection = {
  id: string | number
  name: string
  cover?: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount?: number
  meta?: string
}

const props = withDefaults(
  defineProps<{
    kind: SocialStageKind
    title: string
    cover?: string | null
    coverSource?: string | null
    description?: string
    intro?: string
    icon?: string
    loading?: boolean
    error?: string
    showFollow?: boolean
    followLabel?: string
    followIcon?: string
    followActive?: boolean
    followLoading?: boolean
    followError?: string
    people?: SocialPerson[]
    collections?: SocialCollection[]
    collectionUnit?: string
    collectionEmptyTitle?: string
    collectionEmptyHint?: string
    peopleEmptyTitle?: string
    tabs?: SocialStageTab[]
    activeTab?: string
    tracks?: Track[]
    currentTrackId?: string | null
    trackActivationMode?: 'singleClick' | 'doubleClick'
    isExternal?: boolean
    hasSelection?: boolean
    selectedCount?: number
    selectionAllFavorited?: boolean
    canAddToPlaylist?: boolean
    isSelected?: (id: string) => boolean
    isTrackLiked?: (ncmSongId?: number | null) => boolean
    isLiking?: (ncmSongId?: number | null) => boolean
    formatTime?: (seconds: number) => string
    trackCountLabel?: string
  }>(),
  {
    cover: null,
    coverSource: null,
    description: '',
    intro: '',
    icon: 'pi pi-users',
    loading: false,
    error: '',
    showFollow: false,
    followLabel: '关注',
    followIcon: 'pi pi-user-plus',
    followActive: false,
    followLoading: false,
    followError: '',
    people: () => [],
    collections: () => [],
    collectionUnit: '首',
    collectionEmptyTitle: '暂无内容',
    collectionEmptyHint: '',
    peopleEmptyTitle: '暂无数据',
    tabs: () => [],
    activeTab: '',
    tracks: () => [],
    currentTrackId: null,
    trackActivationMode: 'singleClick',
    isExternal: false,
    hasSelection: false,
    selectedCount: 0,
    selectionAllFavorited: false,
    canAddToPlaylist: false,
    isSelected: () => false,
    isTrackLiked: () => false,
    isLiking: () => false,
    formatTime: (seconds: number) => {
      const total = Math.max(0, Math.floor(Number(seconds) || 0))
      const m = Math.floor(total / 60)
      const s = total % 60
      return `${m}:${String(s).padStart(2, '0')}`
    },
    trackCountLabel: ''
  }
)

const emit = defineEmits<{
  follow: []
  retry: []
  personClick: [person: SocialPerson]
  collectionClick: [item: SocialCollection]
  tabChange: [key: string]
  playAll: []
  shufflePlay: []
  playTrack: [track: Track, index: number, event?: MouseEvent]
  trackClick: [track: Track, index: number, event: MouseEvent]
  likeTrack: [track: Track, event: MouseEvent]
  batchFavorite: []
  batchAddToPlaylist: []
  batchDelete: []
  clearSelection: []
  trackContextMenu: [track: Track, index: number, event: MouseEvent]
}>()

const {
  visibleItems: visibleTracks,
  visibleStart,
  paddingTop,
  totalHeight,
  listRef
} = useProgressiveList(() => props.tracks)

function trackIndex(offset: number): number {
  return visibleStart.value + offset
}

const kindLabel = computed(() => {
  switch (props.kind) {
    case 'artist':
      return '艺人'
    case 'user_list':
      return '社交'
    case 'user_playlists':
      return '歌单集'
    default:
      return '详情'
  }
})

const isPeopleMode = computed(() => props.kind === 'user_list')
const isCollectionOnlyMode = computed(() => props.kind === 'user_playlists')
const isArtistMode = computed(() => props.kind === 'artist')
const showTrackPanel = computed(
  () => isArtistMode.value && (props.activeTab === 'songs' || !props.activeTab)
)
const showCollectionPanel = computed(() => {
  if (isCollectionOnlyMode.value) return true
  if (!isArtistMode.value) return false
  return props.activeTab === 'albums' || props.activeTab === 'playlists'
})

const canPlay = computed(() => !props.loading && props.tracks.length > 0)
const avatarCover = computed(
  () => isPeopleMode.value || isArtistMode.value || isCollectionOnlyMode.value
)

const emptyMessage = computed(() => {
  if (isPeopleMode.value) return props.peopleEmptyTitle
  if (props.activeTab === 'albums') return '这个艺人目前没有可展示的专辑'
  if (props.activeTab === 'playlists') return '目前没有公开创建的歌单'
  if (showTrackPanel.value) return '这个艺人目前没有可展示的歌曲'
  return props.collectionEmptyTitle
})

function onRowActivate(track: Track, index: number, event: MouseEvent): void {
  if (event.detail > 1) return
  emit('trackClick', track, index, event)
}

function onRowDblClick(track: Track, index: number, event: MouseEvent): void {
  event.preventDefault()
  if (props.trackActivationMode !== 'doubleClick') return
  emit('playTrack', track, index, event)
}

function onPlayRow(track: Track, index: number, event: MouseEvent): void {
  event.stopPropagation()
  emit('playTrack', track, index)
}

function onLike(track: Track, event: MouseEvent): void {
  event.stopPropagation()
  emit('likeTrack', track, event)
}

function onContextMenu(track: Track, index: number, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  emit('trackContextMenu', track, index, event)
}
</script>

<template>
  <section class="detail-stage social-stage" :data-kind="kind">
    <header class="stage-hero" :class="{ 'is-avatar': avatarCover }">
      <div class="stage-cover-frame" :class="{ avatar: avatarCover }">
        <CoverImg
          v-if="cover"
          :cover="cover"
          :cover-source="coverSource"
          class="stage-cover"
          :class="{ avatar: avatarCover }"
          alt="cover"
        />
        <div
          v-else
          class="stage-cover stage-cover-fallback"
          :class="{ avatar: avatarCover }"
          aria-hidden="true"
        >
          <i :class="icon"></i>
        </div>
        <span class="stage-cover-ring" :class="{ avatar: avatarCover }" aria-hidden="true"></span>
      </div>

      <div class="stage-copy">
        <div class="stage-kicker">
          <span class="stage-kicker-mark" aria-hidden="true"></span>
          <span class="stage-kicker-text">{{ kindLabel }}</span>
          <span v-if="description" class="stage-kicker-meta">{{ description }}</span>
        </div>

        <h2 class="stage-title">{{ title }}</h2>
        <p v-if="intro" class="stage-intro">{{ intro }}</p>

        <div class="stage-actions">
          <button
            v-if="showFollow"
            type="button"
            class="stage-btn"
            :class="[
              isArtistMode || followActive ? 'stage-btn-ghost' : 'stage-btn-primary',
              { active: followActive && !isArtistMode }
            ]"
            :disabled="followLoading"
            @click="emit('follow')"
          >
            <i :class="followIcon"></i>
            <span>{{ followLabel }}</span>
          </button>

          <template v-if="isArtistMode && showTrackPanel">
            <button
              type="button"
              class="stage-btn stage-btn-primary"
              :disabled="!canPlay"
              @click="emit('playAll')"
            >
              <i class="pi pi-play"></i>
              <span>播放全部</span>
            </button>
            <button
              type="button"
              class="stage-btn stage-btn-ghost"
              :disabled="!canPlay"
              title="随机播放"
              @click="emit('shufflePlay')"
            >
              <i class="pi pi-arrow-right-arrow-left"></i>
              <span>随机</span>
            </button>
          </template>
        </div>

        <p v-if="followError" class="stage-follow-error">{{ followError }}</p>
      </div>
    </header>

    <div v-if="tabs.length > 0" class="stage-tabs" role="tablist" aria-label="内容分区">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="stage-tab"
        :class="{ active: activeTab === tab.key }"
        role="tab"
        :aria-selected="activeTab === tab.key"
        @click="emit('tabChange', tab.key)"
      >
        <span>{{ tab.label }}</span>
        <strong>{{ tab.count }}</strong>
      </button>
    </div>

    <div v-if="error && !loading" class="stage-empty">
      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
      <p>{{ error }}</p>
      <button type="button" class="stage-mini-btn" @click="emit('retry')">
        <i class="pi pi-refresh"></i>
        <span>重试</span>
      </button>
    </div>

    <div v-else-if="loading" class="stage-list stage-list-skeleton" aria-live="polite">
      <div v-if="isPeopleMode" class="stage-people-grid skeleton-grid">
        <div v-for="i in 12" :key="i" class="stage-person-card skeleton-card">
          <span class="sk sk-avatar"></span>
          <span class="sk sk-line mid"></span>
        </div>
      </div>
      <div
        v-else-if="showCollectionPanel || isCollectionOnlyMode"
        class="stage-collection-grid skeleton-grid"
      >
        <div v-for="i in 8" :key="i" class="stage-collection-card skeleton-card">
          <span class="sk sk-square"></span>
          <span class="sk sk-line wide"></span>
          <span class="sk sk-line short"></span>
        </div>
      </div>
      <template v-else>
        <div class="stage-list-head">
          <span class="col-index">#</span>
          <span class="col-title">曲目</span>
          <span v-if="!isExternal" class="col-like"></span>
          <span class="col-album">专辑</span>
          <span class="col-time">时长</span>
        </div>
        <div v-for="i in 8" :key="i" class="stage-row skeleton-row">
          <div class="col-index"><span class="sk sk-num"></span></div>
          <div class="col-title">
            <span class="sk sk-cover"></span>
            <span class="sk-copy">
              <span class="sk sk-line wide"></span>
              <span class="sk sk-line narrow"></span>
            </span>
          </div>
          <div v-if="!isExternal" class="col-like"></div>
          <div class="col-album"><span class="sk sk-line mid"></span></div>
          <div class="col-time"><span class="sk sk-line short"></span></div>
        </div>
      </template>
    </div>

    <!-- People grid (follows / followers) -->
    <div v-else-if="isPeopleMode" class="stage-panel">
      <div v-if="people.length === 0" class="stage-empty">
        <i class="pi pi-users" aria-hidden="true"></i>
        <p>{{ peopleEmptyTitle }}</p>
      </div>
      <div v-else class="stage-people-grid">
        <button
          v-for="person in people"
          :key="person.id"
          type="button"
          class="stage-person-card"
          @click="emit('personClick', person)"
        >
          <CoverImg
            v-if="person.picUrl"
            :cover="person.picUrl"
            :cover-source="person.picUrlSource"
            class="stage-person-avatar"
            alt=""
          />
          <div v-else class="stage-person-avatar stage-person-fallback" aria-hidden="true">
            <i class="pi pi-user"></i>
          </div>
          <span class="stage-person-name" :title="person.name">{{ person.name }}</span>
        </button>
      </div>
    </div>

    <!-- Collections (albums / playlists / user playlists) -->
    <div v-else-if="showCollectionPanel || isCollectionOnlyMode" class="stage-panel">
      <div v-if="collections.length === 0" class="stage-empty">
        <i class="pi pi-clone" aria-hidden="true"></i>
        <p>{{ emptyMessage }}</p>
        <p v-if="collectionEmptyHint" class="stage-empty-hint">{{ collectionEmptyHint }}</p>
      </div>
      <div v-else class="stage-collection-grid">
        <button
          v-for="item in collections"
          :key="item.id"
          type="button"
          class="stage-collection-card"
          @click="emit('collectionClick', item)"
        >
          <CoverImg
            v-if="item.coverSmall || item.cover"
            :cover="item.coverSmall || item.cover"
            :cover-source="item.coverSmallSource || item.coverSource"
            class="stage-collection-cover"
            alt=""
          />
          <div v-else class="stage-collection-cover stage-collection-fallback" aria-hidden="true">
            <i class="pi pi-clone"></i>
          </div>
          <span class="stage-collection-name" :title="item.name">{{ item.name }}</span>
          <span v-if="item.meta || item.trackCount != null" class="stage-collection-meta">
            {{ item.meta || `${item.trackCount} ${collectionUnit}` }}
          </span>
        </button>
      </div>
    </div>

    <!-- Artist songs -->
    <div v-else-if="showTrackPanel" class="stage-panel">
      <div v-if="tracks.length === 0" class="stage-empty">
        <i class="pi pi-wave-pulse" aria-hidden="true"></i>
        <p>{{ emptyMessage }}</p>
      </div>

      <div v-else class="stage-list" :class="{ 'no-like': isExternal }">
        <div v-if="hasSelection" class="stage-selection" role="toolbar" aria-label="批量操作">
          <div class="stage-selection-left">
            <span class="stage-selection-dot" aria-hidden="true"></span>
            <span>已选 {{ selectedCount }} 首</span>
          </div>
          <div class="stage-selection-actions">
            <button type="button" class="stage-mini-btn" @click="emit('batchFavorite')">
              <i :class="selectionAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
              <span>{{ selectionAllFavorited ? '取消收藏' : '加入收藏' }}</span>
            </button>
            <button
              v-if="canAddToPlaylist"
              type="button"
              class="stage-mini-btn"
              @click="emit('batchAddToPlaylist')"
            >
              <i class="pi pi-list"></i>
              <span>添加到歌单</span>
            </button>
            <button type="button" class="stage-mini-btn danger" @click="emit('batchDelete')">
              <i class="pi pi-minus-circle"></i>
              <span>移除</span>
            </button>
            <button type="button" class="stage-mini-btn ghost" @click="emit('clearSelection')">
              <i class="pi pi-times"></i>
              <span>取消</span>
            </button>
          </div>
        </div>

        <div class="stage-list-head" aria-hidden="true">
          <span class="col-index">#</span>
          <span class="col-title">曲目</span>
          <span v-if="!isExternal" class="col-like"></span>
          <span class="col-album">专辑</span>
          <span class="col-time">时长</span>
        </div>

        <ul :ref="listRef" class="stage-rows" role="list" :style="{ height: `${totalHeight}px` }">
          <li
            v-for="(track, index) in visibleTracks"
            :key="track.id"
            class="stage-row"
            data-te-interactive
            :class="{
              playing: currentTrackId === track.id,
              selected: isSelected(track.id)
            }"
            :style="index === 0 ? { marginTop: `${paddingTop}px` } : undefined"
            role="listitem"
            @click="onRowActivate(track, trackIndex(index), $event)"
            @dblclick="onRowDblClick(track, trackIndex(index), $event)"
            @contextmenu="onContextMenu(track, trackIndex(index), $event)"
          >
            <div class="col-index">
              <button
                v-if="currentTrackId === track.id"
                type="button"
                class="row-play-btn playing"
                title="正在播放"
                @click="onPlayRow(track, trackIndex(index), $event)"
              >
                <span class="eq-bars" aria-hidden="true"> <i></i><i></i><i></i> </span>
              </button>
              <button
                v-else
                type="button"
                class="row-play-btn"
                :aria-label="`播放 ${track.title}`"
                @click="onPlayRow(track, trackIndex(index), $event)"
              >
                <span class="row-index-num">{{
                  String(trackIndex(index) + 1).padStart(2, '0')
                }}</span>
                <i class="pi pi-play row-play-icon"></i>
              </button>
            </div>

            <div class="col-title">
              <CoverImg
                v-if="track.cover"
                :cover="track.cover"
                :cover-source="track.coverSource"
                class="row-cover"
                alt=""
              />
              <div v-else class="row-cover row-cover-fallback" aria-hidden="true">
                <i class="pi pi-wave-pulse"></i>
              </div>
              <div class="row-copy">
                <div class="row-title" :title="track.title">{{ track.title }}</div>
                <div class="row-artist" :title="track.artist">{{ track.artist || '未知艺人' }}</div>
              </div>
            </div>

            <div v-if="!isExternal" class="col-like">
              <button
                type="button"
                class="row-like"
                :class="{
                  liked: isTrackLiked(track.ncmSongId),
                  loading: isLiking(track.ncmSongId)
                }"
                :disabled="isLiking(track.ncmSongId)"
                :title="isTrackLiked(track.ncmSongId) ? '取消喜欢' : '喜欢'"
                @click="onLike(track, $event)"
              >
                <i v-if="isLiking(track.ncmSongId)" class="pi pi-spin pi-spinner"></i>
                <i
                  v-else
                  :class="isTrackLiked(track.ncmSongId) ? 'pi pi-heart-fill' : 'pi pi-heart'"
                ></i>
              </button>
            </div>

            <div class="col-album" :title="track.album || ''">
              {{ track.album || '—' }}
            </div>

            <div class="col-time">
              {{ formatTime(track.duration) }}
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped src="./StreamingDetailStage.css"></style>
<style scoped src="./StreamingSocialStage.css"></style>
