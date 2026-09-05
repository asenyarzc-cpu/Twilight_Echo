<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AnimatedInput from '../AnimatedInput.vue'
import CoverImg from '../CoverImg.vue'
import ThemeIcon from '../ThemeIcon.vue'
import { formatDuration } from '../song-list/formatDuration'
import { useSongListVirtualScroll } from '../song-list/useSongListVirtualScroll'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'
import { useBackHandler } from '../../app/useBackStack.ts'
import { useMusicStore } from '../../stores/useMusicStore'
import { usePlayerStore } from '../../stores/usePlayerStore'
import { useProviderStore } from '../../stores/useProviderStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  buildAggregateRows,
  collectAggregateSources,
  resolveAggregateQueue,
  toggleHiddenSource,
  type AggregateRow
} from '../../utils/aggregatePlaylistView.ts'
import type { Track } from '../../types/music'

const props = withDefaults(
  defineProps<{
    hasPlayer: boolean
    /** 本地视图和流媒体页各挂一个实例，只用于外壳留白的细微差别。 */
    surface?: 'local' | 'streaming'
    /**
     * 流媒体页内嵌的实例在流媒体页切去后台（v-show）时依然存活；此时不
     * 应向全局返回栈注册，让位给真正可见的页面。本地实例总是 v-if 挂载，
     * 不需要关心。
     */
    active?: boolean
  }>(),
  { surface: 'local', active: true }
)

const {
  aggregatePlaylists,
  createAggregatePlaylist,
  deletePlaylist,
  setPlaylistPinned,
  setPlaylistHiddenSources,
  setPlaylistVariantPreference,
  getPlaylistTracksById,
  removeTracksFromPlaylistById
} = useMusicStore()
const { currentTrack, playTrack } = usePlayerStore()
const settingsStore = useSettingsStore()
const providerStore = useProviderStore()

// ─── 视图状态：网格 ↔ 详情，组件自管，两个实例互不干扰 ────────────────────
const activePlaylistId = ref<string | null>(null)
const searchQuery = ref('')
const openVariantMenuFor = ref<string | null>(null)
const pendingDeleteId = ref<string | null>(null)
const showCreateDialog = ref(false)
const newPlaylistName = ref('')
const createError = ref('')
const actionError = ref('')
const createDialogRef = ref<HTMLElement | null>(null)

const activePlaylist = computed(
  () => aggregatePlaylists.value.find((playlist) => playlist.id === activePlaylistId.value) ?? null
)

// 歌单被别处删掉时不要卡在一个空详情页里。
watch(activePlaylist, (playlist) => {
  if (activePlaylistId.value && !playlist) activePlaylistId.value = null
})

const activeTracks = computed<Track[]>(() =>
  activePlaylist.value ? getPlaylistTracksById(activePlaylist.value.id) : []
)

const rows = computed<AggregateRow[]>(() => {
  const playlist = activePlaylist.value
  if (!playlist) return []
  return buildAggregateRows({
    tracks: activeTracks.value,
    hiddenSources: playlist.hiddenSources,
    variantPreferences: playlist.variantPreferences
  })
})

const searchedRows = computed<AggregateRow[]>(() => {
  const keyword = searchQuery.value.trim().toLowerCase()
  if (!keyword) return rows.value
  return rows.value.filter((row) =>
    `${row.title} ${row.artist} ${row.album}`.toLowerCase().includes(keyword)
  )
})

/** 虚拟滚动跑在"每行当前选定音源"上，行数据再按 trackId 映射回来。 */
const displayTracks = computed<Track[]>(() => resolveAggregateQueue(searchedRows.value))
const rowByTrackId = computed(() => {
  const map = new Map<string, AggregateRow>()
  for (const row of searchedRows.value) map.set(row.selectedVariant.track.id, row)
  return map
})

const sourceFilters = computed(() =>
  activePlaylist.value
    ? collectAggregateSources(activeTracks.value, activePlaylist.value.hiddenSources ?? [])
    : []
)

const detailStatsText = computed(() => {
  const visible = rows.value.length
  const total = activeTracks.value.length
  const sourceCount = sourceFilters.value.filter((item) => !item.hidden).length
  const parts = [`${visible} 首`]
  if (total !== visible) parts.push(`已隐藏 ${total - visible} 首`)
  parts.push(`${sourceCount} 个音源`)
  return parts.join(' · ')
})

const {
  containerRef,
  tbodyRef,
  rowHeight,
  visibleRange,
  visibleTracks,
  totalHeight,
  paddingTop,
  onScroll
} = useSongListVirtualScroll({
  displayTracks,
  resetSources: [activePlaylistId, searchQuery],
  shouldResetOnSearch: computed(() => !!activePlaylist.value),
  debouncedSearchQuery: searchQuery
})
// 这两个只在模板里以 ref="…" 字符串出现，vue-tsc 不把那当使用（SongList 同样处理）。
void containerRef.value
void tbodyRef.value

// ─── 音源展示 ──────────────────────────────────────────────────────────────
function sourceLabel(source: string): string {
  if (source === 'local') return '本地音乐'
  if (source === 'radio') return '电台'
  if (source === 'network') return '网络源'
  return providerStore.providers.value.find((provider) => provider.id === source)?.name ?? source
}

function sourceIcon(source: string): string {
  if (source === 'local') return 'pi pi-desktop'
  if (source === 'radio') return 'pi pi-wifi'
  if (source === 'network') return 'pi pi-server'
  return (
    providerStore.providers.value.find((provider) => provider.id === source)?.ui?.icon ||
    'pi pi-cloud'
  )
}

function playlistSourceSummary(playlistId: string): string {
  const sources = collectAggregateSources(getPlaylistTracksById(playlistId))
  if (sources.length === 0) return ''
  return sources.map((item) => `${sourceLabel(item.source)} ${item.count}`).join(' · ')
}

// ─── 网格操作 ──────────────────────────────────────────────────────────────
function openPlaylist(playlistId: string): void {
  activePlaylistId.value = playlistId
  searchQuery.value = ''
  pendingDeleteId.value = null
}

function backToGrid(): void {
  activePlaylistId.value = null
  openVariantMenuFor.value = null
}

// 歌单详情 → 标题栏返回按钮回到网格；取代了原来详情头部的页内返回按钮。
useBackHandler(
  computed(() => props.active && activePlaylistId.value !== null),
  backToGrid,
  '返回聚合歌单列表'
)

function togglePinned(playlistId: string, pinned: boolean, event: Event): void {
  event.stopPropagation()
  setPlaylistPinned(playlistId, !pinned)
}

/** 删除很难撤销，所以要点两次：第一下把按钮切成确认态。 */
function requestDelete(playlistId: string, event: Event): void {
  event.stopPropagation()
  if (pendingDeleteId.value !== playlistId) {
    pendingDeleteId.value = playlistId
    return
  }
  pendingDeleteId.value = null
  if (activePlaylistId.value === playlistId) activePlaylistId.value = null
  deletePlaylist(playlistId)
}

function openCreateDialog(): void {
  newPlaylistName.value = ''
  createError.value = ''
  showCreateDialog.value = true
}

function closeCreateDialog(): void {
  showCreateDialog.value = false
  newPlaylistName.value = ''
  createError.value = ''
}

function confirmCreate(): void {
  const name = newPlaylistName.value.trim()
  if (!name) {
    createError.value = '请输入聚合歌单名称'
    return
  }
  try {
    const playlistId = createAggregatePlaylist(name)
    closeCreateDialog()
    openPlaylist(playlistId)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '创建聚合歌单失败'
  }
}

useEscapeToClose(showCreateDialog, closeCreateDialog)
useFocusTrap(createDialogRef, showCreateDialog)

// ─── 详情操作 ──────────────────────────────────────────────────────────────
function toggleSourceVisibility(source: string): void {
  const playlist = activePlaylist.value
  if (!playlist) return
  const next = toggleHiddenSource(playlist.hiddenSources ?? [], source)
  // 全部音源都隐藏等于一个空歌单，拦下来并说明原因。
  if (next.length >= sourceFilters.value.length) {
    actionError.value = '至少要保留一个显示的音源'
    return
  }
  actionError.value = ''
  setPlaylistHiddenSources(playlist.id, next)
}

function rowFor(track: Track): AggregateRow | undefined {
  return rowByTrackId.value.get(track.id)
}

function toggleVariantMenu(anchorTrackId: string, event: Event): void {
  event.stopPropagation()
  openVariantMenuFor.value = openVariantMenuFor.value === anchorTrackId ? null : anchorTrackId
}

function chooseVariant(row: AggregateRow, source: string, event: Event): void {
  event.stopPropagation()
  const playlist = activePlaylist.value
  openVariantMenuFor.value = null
  if (!playlist) return
  // 再点当前音源就是取消这一行的显式选择，回到默认优先级。
  setPlaylistVariantPreference(
    playlist.id,
    row.anchorTrackId,
    row.selectedVariant.source === source && row.variantPinned ? null : source
  )
}

function closeOverlays(): void {
  openVariantMenuFor.value = null
  pendingDeleteId.value = null
}

// 点页面别处收起浮层。挂在 window 上而不是根容器的 @click 上——根容器是布局，
// 不是点击目标，给它挂交互语义会连带惹上 hover 动效那套约定。
onMounted(() => {
  window.addEventListener('click', closeOverlays)
})

onUnmounted(() => {
  window.removeEventListener('click', closeOverlays)
})

function playRow(track: Track): void {
  playTrack(track, displayTracks.value)
}

function onRowClick(track: Track): void {
  if (settingsStore.settings.value.trackActivationMode === 'doubleClick') return
  playRow(track)
}

function onRowDoubleClick(track: Track): void {
  if (settingsStore.settings.value.trackActivationMode !== 'doubleClick') return
  playRow(track)
}

function removeRow(row: AggregateRow, event: Event): void {
  event.stopPropagation()
  const playlist = activePlaylist.value
  if (!playlist) return
  // 一行代表一段录音，移除时把它的所有音源一起从歌单里拿掉。
  removeTracksFromPlaylistById(
    playlist.id,
    row.allVariants.map((variant) => variant.track.id)
  )
}

function rowNumber(index: number): number {
  return visibleRange.value.start + index + 1
}
</script>

<template>
  <div
    class="aggregate-page"
    :class="[`aggregate-surface-${props.surface}`, { 'has-player': props.hasPlayer }]"
  >
    <!-- ── 网格视图 ───────────────────────────────────────────────────── -->
    <template v-if="!activePlaylist">
      <header class="aggregate-header">
        <div class="aggregate-heading">
          <h2 class="aggregate-title">聚合歌单</h2>
          <p class="aggregate-subtitle">
            把本地和各流媒体的歌收进同一个歌单，同一首歌的多个音源合并成一行
          </p>
        </div>
        <button type="button" class="aggregate-primary-action" @click="openCreateDialog()">
          <i class="pi pi-plus"></i>
          <span>新建聚合歌单</span>
        </button>
      </header>

      <div class="aggregate-grid">
        <button
          type="button"
          class="aggregate-card aggregate-create-card"
          data-te-interactive
          @click="openCreateDialog()"
        >
          <div class="aggregate-cover aggregate-cover-create">
            <ThemeIcon class="aggregate-cover-icon" icon-slot="library.add" />
          </div>
          <div class="aggregate-card-name">新建聚合歌单</div>
          <div class="aggregate-card-meta">跨音源收歌</div>
        </button>

        <div
          v-for="playlist in aggregatePlaylists"
          :key="playlist.id"
          class="aggregate-card"
          role="button"
          tabindex="0"
          data-te-interactive
          :class="{ 'is-pinned': !!playlist.pinnedAt }"
          @click="openPlaylist(playlist.id)"
          @keydown.enter.prevent="openPlaylist(playlist.id)"
          @keydown.space.prevent="openPlaylist(playlist.id)"
        >
          <CoverImg
            v-if="playlist.cover"
            :cover="playlist.cover"
            class="aggregate-cover"
            alt="聚合歌单封面"
            loading="lazy"
          />
          <div v-else class="aggregate-cover aggregate-cover-placeholder">
            <i class="pi pi-sitemap aggregate-cover-icon"></i>
          </div>

          <div class="aggregate-card-name">
            <i v-if="playlist.pinnedAt" class="pi pi-thumbtack aggregate-pin-mark"></i>
            {{ playlist.name }}
          </div>
          <div class="aggregate-card-meta">{{ playlist.trackIds.length }} 首</div>
          <div v-if="playlistSourceSummary(playlist.id)" class="aggregate-card-sources">
            {{ playlistSourceSummary(playlist.id) }}
          </div>

          <div class="aggregate-card-actions">
            <button
              type="button"
              class="aggregate-card-btn"
              data-te-interactive
              :title="playlist.pinnedAt ? '取消置顶' : '置顶'"
              :aria-label="playlist.pinnedAt ? '取消置顶' : '置顶'"
              @click="togglePinned(playlist.id, !!playlist.pinnedAt, $event)"
            >
              <i class="pi pi-thumbtack"></i>
            </button>
            <button
              type="button"
              class="aggregate-card-btn aggregate-card-btn-danger"
              data-te-interactive
              :class="{ 'is-confirming': pendingDeleteId === playlist.id }"
              :title="pendingDeleteId === playlist.id ? '再点一次确认删除' : '删除聚合歌单'"
              :aria-label="pendingDeleteId === playlist.id ? '再点一次确认删除' : '删除聚合歌单'"
              @click="requestDelete(playlist.id, $event)"
            >
              <i class="pi pi-trash"></i>
              <span v-if="pendingDeleteId === playlist.id">确认</span>
            </button>
          </div>
        </div>
      </div>

      <p v-if="aggregatePlaylists.length === 0" class="aggregate-empty">
        还没有聚合歌单。新建一个之后，在本地或流媒体页右键任意歌曲就能加进来。
      </p>
    </template>

    <!-- ── 详情视图 ───────────────────────────────────────────────────── -->
    <template v-else>
      <header class="aggregate-header aggregate-detail-header">
        <button
          type="button"
          class="detail-back-button"
          data-te-back-button="pill"
          @click="backToGrid"
        >
          <i class="pi pi-arrow-left" aria-hidden="true"></i>
          <span>返回</span>
        </button>
        <div class="aggregate-heading">
          <h2 class="aggregate-title">
            <i v-if="activePlaylist.pinnedAt" class="pi pi-thumbtack aggregate-pin-mark"></i>
            {{ activePlaylist.name }}
          </h2>
          <p class="aggregate-subtitle">{{ detailStatsText }}</p>
        </div>
        <div class="aggregate-detail-tools">
          <AnimatedInput
            v-model="searchQuery"
            type="text"
            class="aggregate-search"
            placeholder="在聚合歌单内搜索"
            aria-label="在聚合歌单内搜索"
          />
          <button
            type="button"
            class="aggregate-card-btn"
            :title="activePlaylist.pinnedAt ? '取消置顶' : '置顶'"
            @click="togglePinned(activePlaylist.id, !!activePlaylist.pinnedAt, $event)"
          >
            <i class="pi pi-thumbtack"></i>
          </button>
        </div>
      </header>

      <div v-if="sourceFilters.length > 0" class="aggregate-source-filters" aria-label="音源筛选">
        <button
          v-for="item in sourceFilters"
          :key="item.source"
          type="button"
          class="aggregate-source-chip"
          data-te-interactive
          :class="{ 'is-hidden': item.hidden }"
          :aria-pressed="!item.hidden"
          :title="
            item.hidden ? `显示 ${sourceLabel(item.source)}` : `隐藏 ${sourceLabel(item.source)}`
          "
          @click.stop="toggleSourceVisibility(item.source)"
        >
          <i :class="item.hidden ? 'pi pi-eye-slash' : sourceIcon(item.source)"></i>
          <span>{{ sourceLabel(item.source) }}</span>
          <span class="aggregate-source-count">{{ item.count }}</span>
        </button>
      </div>

      <p v-if="actionError" class="aggregate-notice" role="alert">{{ actionError }}</p>

      <div ref="containerRef" class="aggregate-table-wrapper" @scroll="onScroll">
        <table class="aggregate-table">
          <thead>
            <tr>
              <th class="col-index">#</th>
              <th class="col-cover"></th>
              <th class="col-info">标题</th>
              <th class="col-source">音源</th>
              <th class="col-album">专辑</th>
              <th class="col-duration">时长</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody
            ref="tbodyRef"
            :style="{ height: totalHeight + 'px', position: 'relative', display: 'block' }"
          >
            <tr class="aggregate-spacer" :style="{ height: paddingTop + 'px' }" aria-hidden="true">
              <td colspan="7"></td>
            </tr>
            <tr
              v-for="(track, index) in visibleTracks"
              :key="track.id"
              class="aggregate-row"
              data-te-interactive
              :class="{ 'is-playing': currentTrack?.id === track.id }"
              :style="{ height: rowHeight - 4 + 'px', display: 'flex' }"
              @click="onRowClick(track)"
              @dblclick="onRowDoubleClick(track)"
            >
              <td class="col-index">
                <ThemeIcon
                  v-if="currentTrack?.id === track.id"
                  icon-slot="library.playing"
                  class="aggregate-playing-icon"
                />
                <span v-else>{{ rowNumber(Number(index)) }}</span>
              </td>
              <td class="col-cover">
                <CoverImg
                  v-if="track.coverSmall || track.cover"
                  :cover="track.coverSmall || track.cover"
                  :cover-source="track.coverSmallSource || track.coverSource"
                  :identity="track.id"
                  class="aggregate-row-cover"
                  alt=""
                  loading="lazy"
                />
                <div v-else class="aggregate-row-cover aggregate-row-cover-placeholder">
                  <ThemeIcon icon-slot="navigation.songs" />
                </div>
              </td>
              <td class="col-info">
                <span class="aggregate-row-title">{{ track.title }}</span>
                <span class="aggregate-row-artist">{{ track.artist }}</span>
              </td>
              <td class="col-source">
                <template v-if="rowFor(track)">
                  <button
                    type="button"
                    class="aggregate-variant-btn"
                    data-te-interactive
                    :class="{ 'is-pinned': rowFor(track)!.variantPinned }"
                    :title="
                      rowFor(track)!.visibleVariants.length > 1
                        ? '切换这一行使用的音源'
                        : sourceLabel(rowFor(track)!.selectedVariant.source)
                    "
                    @click="toggleVariantMenu(rowFor(track)!.anchorTrackId, $event)"
                  >
                    <i :class="sourceIcon(rowFor(track)!.selectedVariant.source)"></i>
                    <span>{{ sourceLabel(rowFor(track)!.selectedVariant.source) }}</span>
                    <i
                      v-if="rowFor(track)!.visibleVariants.length > 1"
                      class="pi pi-angle-down aggregate-variant-caret"
                    ></i>
                  </button>
                  <div
                    v-if="openVariantMenuFor === rowFor(track)!.anchorTrackId"
                    class="aggregate-variant-menu"
                    @click.stop
                  >
                    <button
                      v-for="variant in rowFor(track)!.visibleVariants"
                      :key="variant.track.id"
                      type="button"
                      class="aggregate-variant-option"
                      data-te-interactive
                      :class="{
                        'is-selected': variant.source === rowFor(track)!.selectedVariant.source
                      }"
                      @click="chooseVariant(rowFor(track)!, variant.source, $event)"
                    >
                      <i :class="sourceIcon(variant.source)"></i>
                      <span>{{ sourceLabel(variant.source) }}</span>
                      <span v-if="variant.lossless" class="aggregate-variant-tag">无损</span>
                      <i
                        v-if="variant.source === rowFor(track)!.selectedVariant.source"
                        class="pi pi-check aggregate-variant-check"
                      ></i>
                    </button>
                  </div>
                </template>
              </td>
              <td class="col-album">{{ track.album }}</td>
              <td class="col-duration">{{ formatDuration(track.duration) }}</td>
              <td class="col-actions">
                <button
                  type="button"
                  class="aggregate-row-remove"
                  data-te-interactive
                  title="从聚合歌单移除（含这首歌的全部音源）"
                  aria-label="从聚合歌单移除"
                  @click="removeRow(rowFor(track)!, $event)"
                >
                  <i class="pi pi-times"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="displayTracks.length === 0" class="aggregate-empty">
          {{
            activeTracks.length === 0
              ? '这个聚合歌单还是空的。在本地或流媒体页右键歌曲，选“添加到聚合歌单”。'
              : '当前筛选下没有可显示的歌曲，试试取消隐藏某个音源。'
          }}
        </p>
      </div>
    </template>

    <!-- ── 新建对话框 ─────────────────────────────────────────────────── -->
    <Teleport to="body">
      <div
        v-if="showCreateDialog"
        class="aggregate-dialog-overlay"
        @click.self="closeCreateDialog()"
      >
        <div
          ref="createDialogRef"
          class="aggregate-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="新建聚合歌单"
          @click.stop
        >
          <h3 class="aggregate-dialog-title">新建聚合歌单</h3>
          <AnimatedInput
            v-model="newPlaylistName"
            type="text"
            class="aggregate-dialog-input"
            placeholder="聚合歌单名称"
            aria-label="聚合歌单名称"
            animate
            @keydown.enter="confirmCreate()"
          />
          <p v-if="createError" class="aggregate-dialog-error" role="alert">{{ createError }}</p>
          <div class="aggregate-dialog-actions">
            <button type="button" class="aggregate-dialog-btn" @click="closeCreateDialog()">
              取消
            </button>
            <button
              type="button"
              class="aggregate-dialog-btn aggregate-dialog-btn-primary"
              @click="confirmCreate()"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./AggregatePlaylistPage.css"></style>
