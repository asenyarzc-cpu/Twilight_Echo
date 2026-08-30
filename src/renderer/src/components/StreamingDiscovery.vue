<script setup lang="ts">
import { computed } from 'vue'
import type {
  MediaProviderPlaylistCatalogue,
  MediaProviderPlaylistSummary
} from '../providers/mediaProvider'
import type { StreamingProviderOption } from '../utils/streamingNavigation'
import type { DiscoveryOrder } from './streaming-page/useStreamingDiscovery'
import type { PageState } from './streaming-page/types'
import CoverImg from './CoverImg.vue'
import StreamingProviderSwitcher from './streaming-page/StreamingProviderSwitcher.vue'

const props = defineProps<{
  providerId: string
  providerLabel: string
  providerOptions: StreamingProviderOption[]
  supportsCategories: boolean
  supportsHighQuality: boolean
  catalogue: MediaProviderPlaylistCatalogue | null
  catalogueLoading: boolean
  catalogueError: string
  selectedTag: string
  order: DiscoveryOrder
  highQuality: boolean
  panelExpanded: boolean
  playlists: MediaProviderPlaylistSummary[]
  total: number
  offset: number
  hasMore: boolean
  listLoading: boolean
  listError: string
  loadingMore: boolean
}>()

const emit = defineEmits<{
  selectTag: [name: string]
  setOrder: [order: DiscoveryOrder]
  toggleHighQuality: []
  togglePanel: []
  pageChange: [event: PageState]
  loadMore: []
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  retry: []
  selectProvider: [providerId: string]
}>()

const pageSize = 30

// ─── Masthead copy ──────────────────────────────────────────────────────────

const headline = computed(() => {
  if (props.highQuality) return '精品歌单'
  return props.selectedTag === '全部' ? '全部歌单' : props.selectedTag
})

const totalLabel = computed(() => props.total.toLocaleString('zh-Hans-CN'))

const subline = computed(() => {
  if (props.listLoading && props.playlists.length === 0) return '正在为你整理歌单…'
  if (props.listError && props.playlists.length === 0) return '加载遇到了一点问题'
  if (props.total > 0) {
    if (props.highQuality) return `${props.providerLabel} 精选 · 共 ${totalLabel.value} 张`
    return `共 ${totalLabel.value} 张歌单 · 按${props.order === 'hot' ? '最热' : '最新'}排列`
  }
  return '每一张歌单，都是一次有主张的收藏'
})

const featureRibbon = computed(() => {
  if (props.highQuality) return "编辑精选 · EDITOR'S PICK"
  return props.order === 'new' ? '新鲜出炉 · FRESH' : '本页主打 · FEATURED'
})

// ─── Channel rail ───────────────────────────────────────────────────────────

const railTags = computed(() => {
  const hot = props.catalogue?.hotTags ?? []
  const tags = ['全部', ...hot.filter((tag) => tag !== '全部')]
  return tags.slice(0, 13)
})

const isSelectedTagInRail = computed(() => railTags.value.includes(props.selectedTag))

// ─── Mosaic ─────────────────────────────────────────────────────────────────

const featured = computed(() => props.playlists[0] ?? null)
const restPlaylists = computed(() => props.playlists.slice(1))

// ─── Pagination ─────────────────────────────────────────────────────────────

const currentPage = computed(() => Math.floor(props.offset / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / pageSize)))
const showPaginator = computed(
  () =>
    !props.highQuality && !props.listLoading && props.playlists.length > 0 && props.total > pageSize
)

function formatPlayCount(playCount: number | undefined): string {
  if (typeof playCount !== 'number' || !Number.isFinite(playCount) || playCount <= 0) return ''
  if (playCount >= 100_000_000) return `${(playCount / 100_000_000).toFixed(1)} 亿`
  if (playCount >= 10_000) return `${Math.round(playCount / 10_000)} 万`
  return String(playCount)
}

function emitPage(nextOffset: number): void {
  const first = Math.max(0, nextOffset)
  emit('pageChange', { first, rows: pageSize })
}
</script>

<template>
  <div class="disc">
    <!-- ── Masthead ──────────────────────────────────────────────────── -->
    <header class="disc-masthead">
      <div class="disc-masthead-copy">
        <p class="disc-kicker">
          <span class="disc-kicker-dot" aria-hidden="true"></span>
          发现歌单 · PLAYLIST&nbsp;DISCOVERY
        </p>
        <Transition name="disc-headline" mode="out-in">
          <h1 :key="headline" class="disc-title">{{ headline }}</h1>
        </Transition>
        <p class="disc-sub">{{ subline }}</p>
      </div>

      <div class="disc-tools">
        <StreamingProviderSwitcher
          :model-value="providerId"
          :options="providerOptions"
          @change="emit('selectProvider', $event)"
        />
        <div v-if="!highQuality" class="disc-order" role="group" aria-label="排序方式">
          <button
            type="button"
            class="disc-order-btn"
            data-te-interactive
            :class="{ active: order === 'hot' }"
            :aria-pressed="order === 'hot'"
            @click="emit('setOrder', 'hot')"
          >
            最热
          </button>
          <button
            type="button"
            class="disc-order-btn"
            data-te-interactive
            :class="{ active: order === 'new' }"
            :aria-pressed="order === 'new'"
            @click="emit('setOrder', 'new')"
          >
            最新
          </button>
        </div>
        <button
          v-if="supportsHighQuality"
          type="button"
          class="disc-hq"
          data-te-interactive
          :class="{ active: highQuality }"
          :aria-pressed="highQuality"
          @click="emit('toggleHighQuality')"
        >
          <i class="pi pi-crown"></i>
          <span>精品</span>
        </button>
      </div>
    </header>

    <!-- ── Channel rail ─────────────────────────────────────────────── -->
    <nav v-if="supportsCategories" class="disc-rail" role="tablist" aria-label="热门歌单标签">
      <button
        v-for="tag in railTags"
        :key="tag"
        type="button"
        class="disc-chip"
        data-te-interactive
        role="tab"
        :aria-selected="selectedTag === tag"
        :class="{ active: selectedTag === tag && !highQuality }"
        @click="emit('selectTag', tag)"
      >
        {{ tag }}
      </button>
      <button
        v-if="!isSelectedTagInRail"
        type="button"
        class="disc-chip active"
        data-te-interactive
        @click="emit('togglePanel')"
      >
        {{ selectedTag }}
      </button>
      <button
        type="button"
        class="disc-chip disc-chip-more"
        data-te-interactive
        :class="{ open: panelExpanded }"
        :aria-expanded="panelExpanded"
        @click="emit('togglePanel')"
      >
        <span>全部分类</span>
        <i class="pi pi-chevron-down disc-chip-caret"></i>
      </button>
    </nav>

    <!-- ── Category atlas ───────────────────────────────────────────── -->
    <Transition name="disc-atlas">
      <section v-if="panelExpanded" class="disc-atlas" aria-label="全部歌单分类">
        <div v-if="catalogueLoading" class="disc-atlas-status">
          <i class="pi pi-spin pi-spinner"></i>
          <span>正在加载分类…</span>
        </div>
        <div v-else-if="catalogueError" class="disc-atlas-status">
          <span>{{ catalogueError }}</span>
          <button type="button" class="disc-ghost-btn" data-te-interactive @click="emit('retry')">
            重试
          </button>
        </div>
        <template v-else>
          <div v-for="group in catalogue?.groups ?? []" :key="group.id" class="disc-atlas-group">
            <p class="disc-atlas-name">{{ group.name }}</p>
            <div class="disc-atlas-tags">
              <button
                v-for="tag in group.tags"
                :key="tag.name"
                type="button"
                class="disc-atlas-chip"
                data-te-interactive
                :class="{ active: selectedTag === tag.name, hot: tag.hot }"
                @click="emit('selectTag', tag.name)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>
        </template>
      </section>
    </Transition>

    <!-- ── Skeleton ─────────────────────────────────────────────────── -->
    <div v-if="listLoading && playlists.length === 0" class="disc-mosaic" aria-label="正在加载歌单">
      <div class="disc-feature disc-sk disc-shimmer"></div>
      <div v-for="i in 9" :key="i" class="disc-sk-tile">
        <div class="disc-sk-cover disc-shimmer"></div>
        <div class="disc-sk-line disc-shimmer"></div>
        <div class="disc-sk-line disc-sk-line-short disc-shimmer"></div>
      </div>
    </div>

    <!-- ── Error ────────────────────────────────────────────────────── -->
    <div v-else-if="listError && playlists.length === 0" class="disc-state">
      <span class="disc-state-icon"><i class="pi pi-exclamation-triangle"></i></span>
      <p class="disc-state-title">歌单暂时走丢了</p>
      <p class="disc-state-hint">{{ listError }}</p>
      <button type="button" class="disc-ink-btn" data-te-interactive @click="emit('retry')">
        <i class="pi pi-refresh"></i>
        再试一次
      </button>
    </div>

    <!-- ── Empty ────────────────────────────────────────────────────── -->
    <div v-else-if="playlists.length === 0" class="disc-state">
      <span class="disc-state-icon"><i class="pi pi-inbox"></i></span>
      <p class="disc-state-title">这个频道还很安静</p>
      <p class="disc-state-hint">换一个标签，也许就有惊喜</p>
    </div>

    <!-- ── Mosaic wall ──────────────────────────────────────────────── -->
    <div v-else class="disc-results" :class="{ 'is-refreshing': listLoading }">
      <div class="disc-mosaic">
        <article
          v-if="featured"
          :key="`feature:${featured.id}`"
          class="disc-feature"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-label="`打开歌单 ${featured.name}`"
          @click="emit('openPlaylist', featured)"
          @keydown.enter="emit('openPlaylist', featured)"
        >
          <div class="disc-feature-media" aria-hidden="true">
            <CoverImg
              v-if="featured.cover"
              :cover="featured.cover"
              :cover-source="featured.coverSource"
              class="disc-feature-img"
              alt=""
            />
            <span v-else class="disc-feature-empty"><i class="pi pi-list"></i></span>
          </div>
          <div class="disc-feature-scrim" aria-hidden="true"></div>
          <div class="disc-feature-copy">
            <span class="disc-feature-ribbon" :class="{ gold: highQuality }">{{
              featureRibbon
            }}</span>
            <h2 class="disc-feature-name">{{ featured.name }}</h2>
            <p class="disc-feature-meta">
              <span v-if="featured.creatorName" class="disc-feature-meta-item">
                <i class="pi pi-user"></i>{{ featured.creatorName }}
              </span>
              <span class="disc-feature-meta-item">
                <i class="pi pi-list"></i>{{ featured.trackCount }} 首
              </span>
              <span v-if="formatPlayCount(featured.playCount)" class="disc-feature-meta-item">
                <i class="pi pi-headphones"></i>{{ formatPlayCount(featured.playCount) }}
              </span>
            </p>
          </div>
          <span class="disc-feature-go" aria-hidden="true">
            <i class="pi pi-arrow-up-right"></i>
          </span>
        </article>

        <article
          v-for="(playlist, index) in restPlaylists"
          :key="playlist.id"
          class="disc-card"
          data-te-interactive
          role="button"
          tabindex="0"
          :style="{ '--d': Math.min(index, 11) }"
          :aria-label="`打开歌单 ${playlist.name}`"
          @click="emit('openPlaylist', playlist)"
          @keydown.enter="emit('openPlaylist', playlist)"
        >
          <div class="disc-card-media">
            <CoverImg
              v-if="playlist.coverSmall || playlist.cover"
              :cover="playlist.coverSmall || playlist.cover"
              :cover-source="playlist.coverSmallSource || playlist.coverSource"
              class="disc-card-img"
              alt=""
            />
            <span v-else class="disc-card-empty"><i class="pi pi-list"></i></span>
            <span v-if="formatPlayCount(playlist.playCount)" class="disc-card-plays">
              <i class="pi pi-headphones"></i>
              {{ formatPlayCount(playlist.playCount) }}
            </span>
            <span class="disc-card-go" aria-hidden="true">
              <i class="pi pi-arrow-up-right"></i>
            </span>
          </div>
          <p class="disc-card-name">{{ playlist.name }}</p>
          <p class="disc-card-meta">
            {{ playlist.trackCount }} 首{{
              playlist.creatorName ? ` · ${playlist.creatorName}` : ''
            }}
          </p>
        </article>
      </div>

      <!-- ── Footer: pager / load more ──────────────────────────────── -->
      <footer v-if="showPaginator" class="disc-pager">
        <button
          type="button"
          class="disc-pager-btn"
          data-te-interactive
          aria-label="上一页"
          :disabled="offset <= 0"
          @click="emitPage(offset - pageSize)"
        >
          <i class="pi pi-arrow-left"></i>
        </button>
        <span class="disc-pager-text">
          第 <em>{{ currentPage }}</em> 页 · 共 {{ pageCount }} 页
        </span>
        <button
          type="button"
          class="disc-pager-btn"
          data-te-interactive
          aria-label="下一页"
          :disabled="!hasMore && offset + pageSize >= total"
          @click="emitPage(offset + pageSize)"
        >
          <i class="pi pi-arrow-right"></i>
        </button>
      </footer>

      <footer v-else-if="highQuality && hasMore" class="disc-pager">
        <button
          type="button"
          class="disc-more-btn"
          data-te-interactive
          :disabled="loadingMore"
          @click="emit('loadMore')"
        >
          <i v-if="loadingMore" class="pi pi-spin pi-spinner"></i>
          <span>{{ loadingMore ? '正在加载…' : '继续发掘精品' }}</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.disc {
  --disc-ink: var(--te-neutral-900);
  --disc-ink-soft: var(--te-neutral-500);
  --disc-line: var(--te-card-border);
  --disc-card: var(--te-card-bg);
  --disc-accent: var(--te-primary-500);
  --disc-gold: var(--te-warning-500);
  --disc-radius-lg: 22px;
  --disc-radius-md: 14px;
  --disc-shadow: 0 18px 44px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
  --disc-shadow-lift: 0 24px 56px color-mix(in srgb, var(--te-neutral-900) 13%, transparent);
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: disc-rise 0.55s var(--te-ease-out-quint) both;
}

@keyframes disc-rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ── Masthead ─────────────────────────────────────────────────────── */

.disc-masthead {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.disc-masthead-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.disc-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--disc-ink-soft);
}

.disc-kicker-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--disc-accent), var(--te-accent-cyan));
}

.disc-title {
  margin: 0;
  font-family: var(--te-font-display);
  font-size: clamp(28px, 3.6vw, 38px);
  font-weight: 800;
  line-height: 1.12;
  letter-spacing: 0.01em;
  color: var(--disc-ink);
}

.disc-headline-enter-active,
.disc-headline-leave-active {
  transition:
    opacity var(--te-motion-return) var(--te-ease-out-quint),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-headline-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.disc-headline-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.disc-sub {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--disc-ink-soft);
  font-variant-numeric: tabular-nums;
}

.disc-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 4px;
}

.disc-order {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--disc-line);
  border-radius: 999px;
  background: var(--disc-card);
}

.disc-order-btn {
  min-height: 28px;
  padding: 0 16px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--disc-ink-soft);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    color var(--te-motion-hover);
}

.disc-order-btn:hover {
  color: var(--disc-ink);
}

.disc-order-btn.active {
  background: var(--disc-ink);
  color: var(--disc-card);
}

.disc-hq {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 18px;
  border: 1px solid var(--disc-line);
  border-radius: 999px;
  background: var(--disc-card);
  color: var(--disc-ink-soft);
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    border-color var(--te-motion-hover),
    color var(--te-motion-hover),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-hq:hover {
  transform: translateY(var(--te-motion-hover-translate));
  color: color-mix(in srgb, var(--disc-gold) 62%, var(--disc-ink));
  border-color: color-mix(in srgb, var(--disc-gold) 44%, transparent);
}

.disc-hq.active {
  background: color-mix(in srgb, var(--disc-gold) 16%, var(--disc-card));
  border-color: color-mix(in srgb, var(--disc-gold) 52%, transparent);
  color: color-mix(in srgb, var(--disc-gold) 62%, var(--disc-ink));
}

/* ── Channel rail ─────────────────────────────────────────────────── */

.disc-rail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.disc-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 15px;
  border: 1px solid var(--disc-line);
  border-radius: 999px;
  background: var(--disc-card);
  color: color-mix(in srgb, var(--disc-ink) 82%, transparent);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    border-color var(--te-motion-hover),
    color var(--te-motion-hover),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-chip:hover {
  transform: translateY(var(--te-motion-hover-translate));
  background: var(--te-hover-bg);
  color: var(--disc-ink);
}

.disc-chip.active {
  background: var(--disc-ink);
  border-color: var(--disc-ink);
  color: var(--disc-card);
}

.disc-chip-more {
  margin-left: auto;
  color: var(--disc-ink-soft);
}

.disc-chip-caret {
  font-size: 10px;
  transition: transform var(--te-motion-panel) var(--te-ease-out-quint);
}

.disc-chip-more.open .disc-chip-caret {
  transform: rotate(180deg);
}

/* ── Category atlas ───────────────────────────────────────────────── */

.disc-atlas {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 22px;
  border: 1px solid var(--disc-line);
  border-radius: var(--disc-radius-lg);
  background: var(--disc-card);
  box-shadow: var(--disc-shadow);
}

.disc-atlas-enter-active,
.disc-atlas-leave-active {
  transition:
    opacity var(--te-motion-panel) var(--te-ease-out-quint),
    transform var(--te-motion-panel) var(--te-ease-out-quint);
}

.disc-atlas-enter-from,
.disc-atlas-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.disc-atlas-status {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--disc-ink-soft);
  font-size: 13px;
  font-weight: 700;
}

.disc-atlas-group {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 12px;
  align-items: baseline;
}

.disc-atlas-name {
  margin: 0;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: var(--disc-ink-soft);
}

.disc-atlas-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.disc-atlas-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--te-hover-bg);
  color: color-mix(in srgb, var(--disc-ink) 78%, transparent);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    border-color var(--te-motion-hover),
    color var(--te-motion-hover);
}

.disc-atlas-chip:hover {
  border-color: color-mix(in srgb, var(--disc-ink) 24%, transparent);
  color: var(--disc-ink);
}

.disc-atlas-chip.active {
  background: var(--disc-ink);
  color: var(--disc-card);
}

.disc-atlas-chip.hot::after {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--disc-accent);
}

.disc-atlas-chip.active.hot::after {
  background: var(--disc-card);
}

/* ── States ───────────────────────────────────────────────────────── */

.disc-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 72px 20px;
  text-align: center;
}

.disc-state-icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--disc-accent) 14%, transparent),
    color-mix(in srgb, var(--te-accent-cyan) 14%, transparent)
  );
  color: var(--disc-accent);
  font-size: 24px;
}

.disc-state-title {
  margin: 0;
  font-family: var(--te-font-display);
  font-size: 18px;
  font-weight: 800;
  color: var(--disc-ink);
}

.disc-state-hint {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--disc-ink-soft);
}

.disc-ink-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  margin-top: 12px;
  padding: 0 22px;
  border: none;
  border-radius: 999px;
  background: var(--disc-ink);
  color: var(--disc-card);
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  box-shadow: 0 14px 30px color-mix(in srgb, var(--disc-ink) 24%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint),
    background var(--te-motion-hover);
}

.disc-ink-btn:hover {
  transform: translateY(var(--te-motion-hover-translate));
  background: color-mix(in srgb, var(--disc-ink) 86%, var(--disc-accent));
  box-shadow: 0 18px 38px color-mix(in srgb, var(--disc-ink) 30%, transparent);
}

.disc-ink-btn:active {
  transform: scale(var(--te-motion-press-scale));
  transition-duration: var(--te-motion-press);
}

.disc-ghost-btn {
  min-height: 30px;
  padding: 0 14px;
  border: 1px solid var(--disc-line);
  border-radius: 999px;
  background: var(--disc-card);
  color: var(--disc-ink);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background var(--te-motion-hover);
}

.disc-ghost-btn:hover {
  background: var(--te-hover-bg);
}

/* ── Mosaic wall ──────────────────────────────────────────────────── */

.disc-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity var(--te-motion-hover);
}

.disc-results.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}

.disc-mosaic {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(184px, 1fr));
  gap: 20px 18px;
}

@media (max-width: 900px) {
  .disc-mosaic {
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 14px 12px;
  }

  .disc-card-name {
    font-size: 12.5px;
  }

  .disc-card-meta {
    font-size: 11px;
  }
}

@media (max-width: 640px) {
  .disc-mosaic {
    grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
    gap: 12px 10px;
  }

  .disc-card-name {
    font-size: 11.5px;
  }

  .disc-card-meta {
    font-size: 10.5px;
  }

  .disc-card-plays {
    left: 6px;
    bottom: 6px;
    font-size: 9.5px;
    padding: 2px 7px;
  }

  .disc-card-go {
    right: 6px;
    bottom: 6px;
    width: 28px;
    height: 28px;
    font-size: 11px;
  }
}

/* Featured cover story — spans a 2×2 cell of the wall */

.disc-feature {
  position: relative;
  grid-column: span 2;
  grid-row: span 2;
  min-height: 340px;
  border-radius: var(--disc-radius-lg);
  overflow: hidden;
  cursor: pointer;
  box-shadow: var(--disc-shadow);
  animation: disc-pop 0.5s var(--te-ease-out-quint) both;
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-feature:hover {
  transform: translateY(-3px);
  box-shadow: var(--disc-shadow-lift);
}

.disc-feature:focus-visible,
.disc-card:focus-visible {
  outline: 2px solid var(--disc-accent);
  outline-offset: 3px;
}

.disc-feature-media {
  position: absolute;
  inset: 0;
}

.disc-feature-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--te-motion-settle) var(--te-ease-out-quint);
}

.disc-feature:hover .disc-feature-img {
  transform: scale(1.045);
}

.disc-feature-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--disc-accent) 22%, var(--disc-card)),
    color-mix(in srgb, var(--te-accent-cyan) 18%, var(--disc-card))
  );
  color: var(--disc-accent);
  font-size: 40px;
}

.disc-feature-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    195deg,
    rgba(9, 11, 20, 0) 34%,
    rgba(9, 11, 20, 0.42) 62%,
    rgba(9, 11, 20, 0.82) 100%
  );
}

.disc-feature-copy {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 22px 24px;
}

.disc-feature-ribbon {
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(9, 11, 20, 0.44);
  backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.9);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.disc-feature-ribbon.gold {
  background: color-mix(in srgb, var(--disc-gold) 78%, rgba(9, 11, 20, 0.4));
  color: rgba(20, 14, 2, 0.92);
}

.disc-feature-name {
  margin: 0;
  font-family: var(--te-font-display);
  font-size: clamp(19px, 2.1vw, 25px);
  font-weight: 800;
  line-height: 1.28;
  color: #fff;
  text-shadow: 0 2px 18px rgba(9, 11, 20, 0.5);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.disc-feature-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.disc-feature-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.disc-feature-meta-item .pi {
  font-size: 11px;
  opacity: 0.85;
}

.disc-feature-go {
  position: absolute;
  top: 18px;
  right: 18px;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(9, 11, 20, 0.4);
  backdrop-filter: blur(8px);
  color: #fff;
  font-size: 14px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity var(--te-motion-return) var(--te-ease-out-quint),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-feature:hover .disc-feature-go {
  opacity: 1;
  transform: translateY(0);
}

/* Regular cards */

.disc-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  border-radius: var(--disc-radius-md);
  animation: disc-pop 0.5s var(--te-ease-out-quint) both;
  animation-delay: calc(var(--d, 0) * 26ms);
}

@keyframes disc-pop {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.disc-card-media {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--disc-radius-md);
  overflow: hidden;
  box-shadow: var(--disc-shadow);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-card:hover .disc-card-media {
  transform: translateY(-4px);
  box-shadow: var(--disc-shadow-lift);
}

.disc-card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--te-motion-settle) var(--te-ease-out-quint);
}

.disc-card:hover .disc-card-img {
  transform: scale(1.06);
}

.disc-card-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--disc-accent) 14%, var(--disc-card)),
    color-mix(in srgb, var(--te-accent-cyan) 12%, var(--disc-card))
  );
  color: var(--disc-accent);
  font-size: 26px;
}

.disc-card-plays {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(9, 11, 20, 0.5);
  backdrop-filter: blur(6px);
  color: rgba(255, 255, 255, 0.92);
  font-size: 10.5px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}

.disc-card-plays .pi {
  font-size: 10px;
}

.disc-card-go {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(9, 11, 20, 0.46);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 12px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity var(--te-motion-return) var(--te-ease-out-quint),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.disc-card:hover .disc-card-go {
  opacity: 1;
  transform: translateY(0);
}

.disc-card-name {
  margin: 8px 2px 0;
  font-size: 13.5px;
  font-weight: 750;
  line-height: 1.4;
  color: var(--disc-ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.disc-card-meta {
  margin: 0 2px;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--disc-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

/* ── Skeleton ─────────────────────────────────────────────────────── */

.disc-sk {
  animation: none;
  box-shadow: none;
  cursor: default;
}

.disc-sk-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.disc-sk-cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--disc-radius-md);
}

.disc-sk-line {
  height: 12px;
  width: 82%;
  border-radius: 6px;
}

.disc-sk-line-short {
  width: 52%;
}

.disc-shimmer {
  background: linear-gradient(
    100deg,
    var(--te-hover-bg) 36%,
    color-mix(in srgb, var(--te-hover-bg) 40%, var(--disc-card)) 50%,
    var(--te-hover-bg) 64%
  );
  background-size: 220% 100%;
  animation: disc-shimmer 1.5s ease-in-out infinite;
}

@keyframes disc-shimmer {
  from {
    background-position: 130% 0;
  }
  to {
    background-position: -80% 0;
  }
}

/* ── Pager ────────────────────────────────────────────────────────── */

.disc-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 22px;
}

.disc-pager-btn {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--disc-line);
  border-radius: 50%;
  background: var(--disc-card);
  color: var(--disc-ink);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    border-color var(--te-motion-hover),
    transform var(--te-motion-return) var(--te-ease-out-quint),
    opacity var(--te-motion-hover);
}

.disc-pager-btn:hover:not(:disabled) {
  transform: translateY(var(--te-motion-hover-translate));
  background: var(--te-hover-bg);
  border-color: color-mix(in srgb, var(--disc-ink) 26%, transparent);
}

.disc-pager-btn:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}

.disc-pager-text {
  min-width: 118px;
  text-align: center;
  color: var(--disc-ink-soft);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.disc-pager-text em {
  font-style: normal;
  color: var(--disc-ink);
  font-weight: 800;
}

.disc-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 26px;
  border: 1px solid var(--disc-line);
  border-radius: 999px;
  background: var(--disc-card);
  color: var(--disc-ink);
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  box-shadow: var(--disc-shadow);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    background var(--te-motion-hover),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint),
    opacity var(--te-motion-hover);
}

.disc-more-btn:hover:not(:disabled) {
  transform: translateY(var(--te-motion-hover-translate));
  background: var(--te-hover-bg);
  box-shadow: var(--disc-shadow-lift);
}

.disc-more-btn:disabled {
  cursor: default;
  opacity: 0.62;
}

/* ── Narrow layout ────────────────────────────────────────────────── */

@media (max-width: 560px) {
  .disc-feature {
    grid-column: 1 / -1;
    grid-row: auto;
    min-height: 240px;
  }
}

/* ── Dark theme: neutral-900 flips light, so shadow mixes glow — pin to black */

:global(html[data-theme='dark']) .disc {
  --disc-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
  --disc-shadow-lift: 0 24px 56px rgba(0, 0, 0, 0.42);
}

:global(html[data-theme='dark']) .disc .disc-ink-btn {
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.34);
}

/* ── Reduced motion ───────────────────────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  .disc,
  .disc-feature,
  .disc-card,
  .disc-shimmer {
    animation: none;
  }

  .disc-feature:hover .disc-feature-img,
  .disc-card:hover .disc-card-img {
    transform: none;
  }
}
</style>
