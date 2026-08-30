<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '../../types/music'
import CoverImg from '../CoverImg.vue'
import { useProgressiveList } from './useProgressiveList.ts'

export type DetailStageKind =
  | 'liked'
  | 'playlist'
  | 'album'
  | 'rec'
  | 'artist'
  | 'user_list'
  | 'user_playlists'
  | 'recent'
  | 'ranking'
  | string

const props = withDefaults(
  defineProps<{
    kind: DetailStageKind
    title: string
    cover?: string | null
    coverSource?: string | null
    description?: string
    intro?: string
    icon?: string
    trackCountLabel: string
    tracks: Track[]
    currentTrackId?: string | null
    trackActivationMode?: 'singleClick' | 'doubleClick'
    isExternal?: boolean
    loading?: boolean
    showFollow?: boolean
    followLabel?: string
    followIcon?: string
    followActive?: boolean
    followLoading?: boolean
    followError?: string
    showPlayActions?: boolean
    hasSelection?: boolean
    selectedCount?: number
    selectionAllFavorited?: boolean
    canAddToPlaylist?: boolean
    canRemoveFromPlaylist?: boolean
    isSelected: (id: string) => boolean
    isTrackLiked: (ncmSongId?: number | null) => boolean
    isLiking: (ncmSongId?: number | null) => boolean
    formatTime: (seconds: number) => string
    likedFooter?: {
      loadingMore?: boolean
      hasMore?: boolean
      loadMoreError?: string
      total?: number | null
      loaded?: number
    } | null
  }>(),
  {
    cover: null,
    coverSource: null,
    description: '',
    intro: '',
    icon: 'pi pi-list',
    trackActivationMode: 'singleClick',
    isExternal: false,
    loading: false,
    showFollow: false,
    followLabel: '关注',
    followIcon: 'pi pi-user-plus',
    followActive: false,
    followLoading: false,
    followError: '',
    showPlayActions: true,
    hasSelection: false,
    selectedCount: 0,
    selectionAllFavorited: false,
    canAddToPlaylist: false,
    canRemoveFromPlaylist: false,
    likedFooter: null
  }
)

const emit = defineEmits<{
  playAll: []
  shufflePlay: []
  playTrack: [track: Track, index: number, event?: MouseEvent]
  trackClick: [track: Track, index: number, event: MouseEvent]
  likeTrack: [track: Track, event: MouseEvent]
  follow: []
  batchFavorite: []
  batchAddToPlaylist: []
  batchDelete: []
  clearSelection: []
  loadMoreLiked: []
  trackContextMenu: [track: Track, index: number, event: MouseEvent]
}>()

const kindLabel = computed(() => {
  switch (props.kind) {
    case 'liked':
      return '收藏'
    case 'playlist':
      return '歌单'
    case 'album':
      return '专辑'
    case 'rec':
      return '推荐'
    case 'artist':
      return '艺人'
    case 'recent':
      return '最近'
    case 'ranking':
      return '排行'
    case 'user_list':
      return '社交'
    case 'user_playlists':
      return '歌单集'
    default:
      return '列表'
  }
})

const totalDurationLabel = computed(() => {
  const total = props.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0)
  if (!total) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `约 ${hours} 小时 ${minutes} 分`
  return `约 ${minutes} 分钟`
})

const canPlay = computed(() => !props.loading && props.tracks.length > 0)

const emptyMessage = computed(() => {
  switch (props.kind) {
    case 'recent':
      return '还没有播放记录'
    case 'ranking':
      return '还没有听歌排行'
    case 'liked':
      return '收藏夹还是空的'
    case 'rec':
      return '暂时没有推荐曲目'
    default:
      return '这里还没有可播放的曲目'
  }
})

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

function shuffleAndPlay(): void {
  if (!canPlay.value) return
  emit('shufflePlay')
}
</script>

<template>
  <section class="detail-stage" :data-kind="kind">
    <header class="stage-hero">
      <div class="stage-cover-frame">
        <CoverImg
          v-if="cover"
          :cover="cover"
          :cover-source="coverSource"
          class="stage-cover"
          alt="cover"
        />
        <div v-else class="stage-cover stage-cover-fallback" aria-hidden="true">
          <i :class="icon"></i>
        </div>
        <span class="stage-cover-ring" aria-hidden="true"></span>
      </div>

      <div class="stage-copy">
        <div class="stage-kicker">
          <span class="stage-kicker-mark" aria-hidden="true"></span>
          <span class="stage-kicker-text">{{ kindLabel }}</span>
          <span v-if="trackCountLabel" class="stage-kicker-meta">{{ trackCountLabel }}</span>
        </div>

        <h2 class="stage-title">{{ title }}</h2>

        <p v-if="description" class="stage-desc">{{ description }}</p>
        <p v-if="intro" class="stage-intro">{{ intro }}</p>

        <div class="stage-meta-row">
          <span v-if="totalDurationLabel" class="stage-chip">{{ totalDurationLabel }}</span>
          <span v-if="tracks.length" class="stage-chip muted">{{ tracks.length }} 首在列</span>
        </div>

        <div class="stage-actions">
          <button
            v-if="showFollow"
            type="button"
            class="stage-btn stage-btn-primary"
            :class="{ active: followActive }"
            :disabled="followLoading"
            @click="emit('follow')"
          >
            <i :class="followIcon"></i>
            <span>{{ followLabel }}</span>
          </button>

          <template v-else-if="showPlayActions">
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
              @click="shuffleAndPlay"
            >
              <i class="pi pi-arrow-right-arrow-left"></i>
              <span>随机</span>
            </button>
          </template>
        </div>

        <p v-if="followError" class="stage-follow-error">{{ followError }}</p>
      </div>
    </header>

    <div
      v-if="!loading && tracks.length === 0 && showPlayActions && !showFollow"
      class="stage-empty"
    >
      <i class="pi pi-wave-pulse" aria-hidden="true"></i>
      <p>{{ emptyMessage }}</p>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="loading && tracks.length === 0"
      class="stage-list stage-list-skeleton"
      :class="{ 'no-like': isExternal }"
      aria-live="polite"
    >
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
    </div>

    <!-- Track list -->
    <div v-else-if="tracks.length > 0" class="stage-list" :class="{ 'no-like': isExternal }">
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
            <span>{{ canRemoveFromPlaylist ? '从歌单移除' : '移除' }}</span>
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

      <div v-if="likedFooter" class="stage-footer">
        <span v-if="likedFooter.loadingMore" class="stage-footer-msg">
          <i class="pi pi-spin pi-spinner"></i>
          正在加载更多
        </span>
        <button
          v-else-if="likedFooter.loadMoreError"
          type="button"
          class="stage-mini-btn"
          @click="emit('loadMoreLiked')"
        >
          <i class="pi pi-refresh"></i>
          <span>继续加载</span>
        </button>
        <span v-else-if="likedFooter.hasMore" class="stage-footer-msg"> 继续向下滚动加载更多 </span>
        <span
          v-else-if="likedFooter.total != null && (likedFooter.loaded ?? 0) > 0"
          class="stage-footer-msg"
        >
          已加载全部
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped src="./StreamingDetailStage.css"></style>
