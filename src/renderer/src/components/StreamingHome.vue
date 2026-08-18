<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Track } from '../types/music'
import type { NcmPlaylistSummary } from '../stores/useNcmStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { resolveMotionMode } from '../../../shared/motion.ts'
import CoverImg from './CoverImg.vue'

interface RecSection {
  key: string
  title: string
  tracks: Track[]
  icon: string
}

interface CollageCover {
  cover: string
  coverSource: string | null
}

const props = defineProps<{
  isLoggedIn: boolean
  recsLoading: boolean
  recsError: string
  recSections: RecSection[]
  recommendPlaylists: NcmPlaylistSummary[]
  currentTrackId?: string | null
}>()

const emit = defineEmits<{
  loadRecommendations: []
  openRecSection: [section: RecSection]
  openPlaylist: [playlist: NcmPlaylistSummary]
  playTrack: [track: Track, queue: Track[]]
  requestLogin: []
}>()

// ─── Sections ───────────────────────────────────────────────────────────────

const dailySection = computed(() => props.recSections.find((s) => s.key === 'daily') ?? null)
const fmSection = computed(() => props.recSections.find((s) => s.key === 'fm') ?? null)
const radarSection = computed(() => props.recSections.find((s) => s.key === 'radar') ?? null)

const dateLabel = computed(() => {
  const now = new Date()
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${now.getMonth() + 1}月${now.getDate()}日 · ${weekdays[now.getDay()]}`
})

const dayNumber = computed(() => String(new Date().getDate()).padStart(2, '0'))

// ─── Hero cover collage (rotates through daily covers) ─────────────────────

const COLLAGE_SIZE = 3
const ROTATE_INTERVAL_MS = 7000

const dailyCovers = computed((): CollageCover[] => {
  const seen = new Set<string>()
  const covers: CollageCover[] = []
  for (const track of dailySection.value?.tracks ?? []) {
    if (!track.cover || seen.has(track.cover)) continue
    seen.add(track.cover)
    covers.push({ cover: track.cover, coverSource: track.coverSource ?? null })
  }
  return covers
})

const collagePage = ref(0)
const collagePageCount = computed(() =>
  Math.max(1, Math.ceil(dailyCovers.value.length / COLLAGE_SIZE))
)
const collageCovers = computed((): CollageCover[] => {
  const covers = dailyCovers.value
  if (covers.length === 0) return []
  const start = (collagePage.value % collagePageCount.value) * COLLAGE_SIZE
  const slice: CollageCover[] = []
  for (let i = 0; i < Math.min(COLLAGE_SIZE, covers.length); i++) {
    slice.push(covers[(start + i) % covers.length])
  }
  return slice
})
const ambientCover = computed(() => collageCovers.value[0] ?? null)

let rotateTimer: ReturnType<typeof setInterval> | null = null

const { settings } = useSettingsStore()

// The JS-driven rotation must honor the in-app motion setting, not just the OS
// preference — in 'off' mode CSS transitions are stripped, so a rotation would
// degrade to an abrupt full-collage swap every 7s.
function collageMotionAllowed(): boolean {
  const prefersReduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return resolveMotionMode(settings.value.motionPreference, prefersReduced) === 'full'
}

function startCollageRotation(): void {
  stopCollageRotation()
  if (!collageMotionAllowed()) return
  if (collagePageCount.value <= 1) return
  rotateTimer = setInterval(() => {
    collagePage.value = (collagePage.value + 1) % collagePageCount.value
  }, ROTATE_INTERVAL_MS)
}

function stopCollageRotation(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = null
  }
}

onMounted(startCollageRotation)
onBeforeUnmount(stopCollageRotation)

watch(collagePageCount, (count) => {
  if (collagePage.value >= count) collagePage.value = 0
  startCollageRotation()
})

watch(
  () => settings.value.motionPreference,
  () => startCollageRotation()
)

// ─── Daily quick chart ──────────────────────────────────────────────────────

const CHART_LIMIT = 8

const chartTracks = computed(() => (dailySection.value?.tracks ?? []).slice(0, CHART_LIMIT))

function playChartTrack(track: Track): void {
  const queue = dailySection.value?.tracks ?? []
  emit('playTrack', track, queue.length > 0 ? queue : [track])
}

function isPlayingTrack(track: Track): boolean {
  return props.currentTrackId != null && props.currentTrackId === track.id
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Duo cards (FM / radar) ─────────────────────────────────────────────────

function sectionCovers(section: RecSection | null): CollageCover[] {
  const covers: CollageCover[] = []
  const seen = new Set<string>()
  for (const track of section?.tracks ?? []) {
    if (!track.cover || seen.has(track.cover)) continue
    seen.add(track.cover)
    covers.push({ cover: track.cover, coverSource: track.coverSource ?? null })
    if (covers.length >= 3) break
  }
  return covers
}

const fmCovers = computed(() => sectionCovers(fmSection.value))
const radarCovers = computed(() => sectionCovers(radarSection.value))

function openDaily(): void {
  if (dailySection.value) emit('openRecSection', dailySection.value)
}

function playDailyAll(): void {
  const tracks = dailySection.value?.tracks ?? []
  if (tracks.length > 0) {
    emit('playTrack', tracks[0], tracks)
  } else {
    openDaily()
  }
}

function playPersonalizedStream(section: RecSection | null): void {
  if (!section || section.tracks.length === 0) return
  emit('playTrack', section.tracks[0], section.tracks)
}
</script>

<template>
  <div class="home-view">
    <!-- ── Signed-out invite ─────────────────────────────────────────── -->
    <section v-if="!isLoggedIn" class="hero-invite">
      <div class="invite-orb invite-orb-a" aria-hidden="true"></div>
      <div class="invite-orb invite-orb-b" aria-hidden="true"></div>
      <div class="invite-notes" aria-hidden="true">
        <i class="pi pi-headphones invite-note-icon"></i>
      </div>
      <p class="invite-kicker">Twilight Echo · 在线漫游</p>
      <h2 class="invite-title">听见为你而来的音乐</h2>
      <p class="invite-desc">
        登录网易云音乐后，这里会生成你的每日推荐、私人漫游与私人雷达——持续发现符合你口味的歌曲。
      </p>
      <button type="button" class="invite-cta" @click="emit('requestLogin')">
        <i class="pi pi-user"></i>
        登录网易云音乐
      </button>
    </section>

    <!-- ── Loading skeleton ─────────────────────────────────────────── -->
    <div v-else-if="recsLoading" class="home-skeleton" aria-label="正在加载推荐">
      <div class="sk-hero sk-shimmer"></div>
      <div class="sk-duo">
        <div class="sk-card sk-shimmer"></div>
        <div class="sk-card sk-shimmer"></div>
      </div>
      <div class="sk-tiles">
        <div v-for="i in 6" :key="i" class="sk-tile">
          <div class="sk-tile-cover sk-shimmer"></div>
          <div class="sk-tile-line sk-shimmer"></div>
        </div>
      </div>
    </div>

    <!-- ── Error ─────────────────────────────────────────────────────── -->
    <div v-else-if="recsError" class="home-error">
      <span class="home-error-icon"><i class="pi pi-exclamation-triangle"></i></span>
      <p class="home-error-title">推荐暂时走丢了</p>
      <p class="home-error-hint">{{ recsError }}</p>
      <button type="button" class="home-error-retry" @click="emit('loadRecommendations')">
        <i class="pi pi-refresh"></i>
        再试一次
      </button>
    </div>

    <!-- ── Content ───────────────────────────────────────────────────── -->
    <div v-else class="home-flow">
      <!-- Hero: daily mix -->
      <section class="hero" aria-label="每日推荐">
        <div class="hero-ambient" aria-hidden="true">
          <CoverImg
            v-if="ambientCover"
            :key="ambientCover.cover"
            :cover="ambientCover.cover"
            :cover-source="ambientCover.coverSource"
            class="hero-ambient-img"
            alt=""
          />
        </div>
        <div class="hero-inner">
          <div class="hero-copy">
            <p class="hero-kicker">
              <span class="hero-kicker-day">{{ dayNumber }}</span>
              <span class="hero-kicker-meta">
                <span>{{ dateLabel }}</span>
                <span class="hero-kicker-sub">每日 06:00 焕新</span>
              </span>
            </p>
            <h1 class="hero-title">每日推荐</h1>
            <p class="hero-title-en" aria-hidden="true">DAILY&nbsp;MIX</p>
            <p class="hero-desc">从你的听歌足迹里长出来的今日歌单，每一首都有它出现的理由。</p>
            <div class="hero-actions">
              <button type="button" class="hero-play" @click="playDailyAll">
                <i class="pi pi-play"></i>
                播放全部
              </button>
              <button type="button" class="hero-open" @click="openDaily">
                查看全部
                <i class="pi pi-arrow-right"></i>
              </button>
            </div>
          </div>
          <button
            type="button"
            class="hero-stage"
            aria-label="打开每日推荐"
            @click="openDaily"
            @mouseenter="stopCollageRotation"
            @mouseleave="startCollageRotation"
          >
            <Transition name="collage" mode="out-in">
              <div v-if="collageCovers.length > 0" :key="collagePage" class="hero-collage">
                <span
                  v-for="(item, index) in collageCovers"
                  :key="`${item.cover}:${index}`"
                  class="hero-collage-card"
                  :class="`hero-collage-card-${index}`"
                >
                  <CoverImg
                    :cover="item.cover"
                    :cover-source="item.coverSource"
                    class="hero-collage-img"
                    alt=""
                  />
                </span>
              </div>
              <div v-else key="placeholder" class="hero-collage hero-collage-empty">
                <span class="hero-collage-card hero-collage-card-0 hero-collage-placeholder">
                  <i class="pi pi-calendar"></i>
                </span>
              </div>
            </Transition>
          </button>
        </div>
      </section>

      <!-- Duo: FM + radar -->
      <section class="duo" aria-label="电台推荐">
        <button
          v-if="fmSection"
          type="button"
          class="duo-card duo-fm"
          @click="playPersonalizedStream(fmSection)"
        >
          <span class="duo-stack" aria-hidden="true">
            <span
              v-for="(item, index) in fmCovers"
              :key="item.cover"
              class="duo-stack-cover"
              :class="`duo-stack-cover-${index}`"
            >
              <CoverImg :cover="item.cover" :cover-source="item.coverSource" alt="" />
            </span>
            <span
              v-if="fmCovers.length === 0"
              class="duo-stack-cover duo-stack-cover-0 duo-stack-empty"
            >
              <i class="pi pi-compass"></i>
            </span>
          </span>
          <span class="duo-copy">
            <span class="duo-name">私人漫游</span>
            <span class="duo-sub">Roaming FM · 随心而行的电台</span>
          </span>
          <span class="duo-arrow" aria-hidden="true"><i class="pi pi-arrow-right"></i></span>
        </button>

        <button
          v-if="radarSection"
          type="button"
          class="duo-card duo-radar"
          @click="playPersonalizedStream(radarSection)"
        >
          <span class="duo-stack" aria-hidden="true">
            <span
              v-for="(item, index) in radarCovers"
              :key="item.cover"
              class="duo-stack-cover"
              :class="`duo-stack-cover-${index}`"
            >
              <CoverImg :cover="item.cover" :cover-source="item.coverSource" alt="" />
            </span>
            <span
              v-if="radarCovers.length === 0"
              class="duo-stack-cover duo-stack-cover-0 duo-stack-empty"
            >
              <i class="pi pi-send"></i>
            </span>
          </span>
          <span class="duo-copy">
            <span class="duo-name">私人雷达</span>
            <span class="duo-sub">Private Radar · 捕捉你错过的好歌</span>
          </span>
          <span class="duo-arrow" aria-hidden="true"><i class="pi pi-arrow-right"></i></span>
        </button>
      </section>

      <!-- Chart: quick taste of today's mix -->
      <section v-if="chartTracks.length > 0" class="chart" aria-label="今日精选速览">
        <header class="section-head">
          <div class="section-head-copy">
            <h3>今日为你精选</h3>
            <p>点一首就开始 · 队列自动接上整份每日推荐</p>
          </div>
          <button type="button" class="section-more" @click="openDaily">
            完整歌单
            <i class="pi pi-chevron-right"></i>
          </button>
        </header>
        <div class="chart-grid">
          <button
            v-for="(track, index) in chartTracks"
            :key="track.id"
            type="button"
            class="chart-row"
            :class="{ 'is-playing': isPlayingTrack(track) }"
            @click="playChartTrack(track)"
          >
            <span class="chart-index" aria-hidden="true">{{
              String(index + 1).padStart(2, '0')
            }}</span>
            <span class="chart-cover">
              <CoverImg
                v-if="track.cover"
                :cover="track.cover"
                :cover-source="track.coverSource"
                alt=""
              />
              <span v-else class="chart-cover-empty"><i class="pi pi-volume-up"></i></span>
              <span class="chart-cover-action" aria-hidden="true">
                <span v-if="isPlayingTrack(track)" class="chart-eq"> <i></i><i></i><i></i> </span>
                <i v-else class="pi pi-play"></i>
              </span>
            </span>
            <span class="chart-meta">
              <span class="chart-title">{{ track.title }}</span>
              <span class="chart-artist">{{ track.artist }}</span>
            </span>
            <span class="chart-duration">{{ formatDuration(track.duration) }}</span>
          </button>
        </div>
      </section>

      <!-- Shelf: recommended playlists -->
      <section class="shelf" aria-label="精选歌单">
        <header class="section-head">
          <div class="section-head-copy">
            <h3>精选歌单</h3>
            <p>为你挑选 {{ recommendPlaylists.length }} 份歌单</p>
          </div>
        </header>
        <div v-if="recommendPlaylists.length > 0" class="shelf-grid">
          <button
            v-for="playlist in recommendPlaylists"
            :key="playlist.id"
            type="button"
            class="shelf-tile"
            @click="emit('openPlaylist', playlist)"
          >
            <span class="shelf-cover">
              <CoverImg
                v-if="playlist.cover"
                :cover="playlist.cover"
                :cover-source="playlist.coverSource"
                alt=""
              />
              <span v-else class="shelf-cover-empty"><i class="pi pi-list"></i></span>
              <span class="shelf-scrim" aria-hidden="true"></span>
              <span class="shelf-count">{{ playlist.trackCount }} 首</span>
              <span class="shelf-open" aria-hidden="true"><i class="pi pi-play"></i></span>
            </span>
            <span class="shelf-name">{{ playlist.name }}</span>
          </button>
        </div>
        <div v-else class="shelf-empty">
          <i class="pi pi-list"></i>
          <span>暂无推荐歌单，稍后再来看看</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home-view {
  min-height: 100%;
  --home-ink: var(--te-neutral-900);
  --home-ink-soft: var(--te-neutral-500);
  --home-line: var(--te-card-border);
  --home-radius-lg: 22px;
  --home-radius-md: 14px;
  --home-primary-tint: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
  --home-cyan-tint: color-mix(in srgb, var(--te-accent-cyan) 12%, transparent);
  --home-shadow: 0 18px 44px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
  --home-shadow-lift: 0 24px 56px color-mix(in srgb, var(--te-neutral-900) 13%, transparent);
}

.home-flow {
  display: flex;
  flex-direction: column;
  gap: 44px;
  padding-bottom: 8px;
}

/* Staggered entrance */
.home-flow > section {
  animation: home-rise 0.62s var(--te-ease-out-quint) both;
}

.home-flow > section:nth-child(2) {
  animation-delay: 0.06s;
}

.home-flow > section:nth-child(3) {
  animation-delay: 0.12s;
}

.home-flow > section:nth-child(4) {
  animation-delay: 0.18s;
}

@keyframes home-rise {
  from {
    opacity: 0;
    transform: translateY(26px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ══ Hero ══════════════════════════════════════════════════════════════ */

.hero {
  position: relative;
  border-radius: var(--home-radius-lg);
  border: 1px solid var(--home-line);
  background: var(--te-card-bg);
  overflow: hidden;
  box-shadow: var(--home-shadow);
}

.hero-ambient {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.hero-ambient :deep(img),
.hero-ambient-img {
  position: absolute;
  inset: -18%;
  width: 136%;
  height: 136%;
  object-fit: cover;
  filter: blur(64px) saturate(1.35);
  opacity: 0.5;
  transform: translateZ(0);
}

/* Wash the ambient art back toward the surface so copy stays readable. */
.hero-ambient::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      100deg,
      var(--te-card-bg) 0%,
      color-mix(in srgb, var(--te-card-bg) 82%, transparent) 46%,
      color-mix(in srgb, var(--te-card-bg) 30%, transparent) 100%
    ),
    linear-gradient(180deg, color-mix(in srgb, var(--te-card-bg) 30%, transparent), transparent 40%);
}

.hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: stretch;
  gap: 24px;
  min-height: clamp(280px, 30vw, 340px);
}

.hero-copy {
  flex: 1 1 52%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  min-width: 0;
  padding: clamp(28px, 3.6vw, 48px);
}

.hero-kicker {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.hero-kicker-day {
  display: grid;
  place-items: center;
  min-width: 46px;
  height: 46px;
  padding: 0 6px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--home-ink) 92%, transparent);
  color: var(--te-card-bg);
  font-family: var(--te-font-display);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.hero-kicker-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--home-ink);
}

.hero-kicker-sub {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--home-ink-soft);
}

.hero-title {
  margin-top: 22px;
  font-family: var(--te-font-display);
  font-size: clamp(40px, 5vw, 62px);
  line-height: 1.02;
  font-weight: 900;
  letter-spacing: -0.01em;
  color: var(--home-ink);
}

.hero-title-en {
  margin-top: 6px;
  font-family: var(--te-font-display);
  font-size: clamp(13px, 1.3vw, 15px);
  font-weight: 800;
  letter-spacing: 0.42em;
  color: color-mix(in srgb, var(--te-primary-500) 78%, var(--home-ink));
}

.hero-desc {
  max-width: 400px;
  margin-top: 18px;
  font-size: 14px;
  line-height: 1.7;
  font-weight: 500;
  color: var(--home-ink-soft);
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
}

.hero-play {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 46px;
  padding: 0 24px;
  border: none;
  border-radius: 999px;
  background: var(--home-ink);
  color: var(--te-card-bg);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 14px 30px color-mix(in srgb, var(--home-ink) 26%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint),
    background var(--te-motion-hover);
}

.hero-play i {
  font-size: 12px;
}

.hero-play:hover {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--home-ink) 86%, var(--te-primary-500));
  box-shadow: 0 18px 38px color-mix(in srgb, var(--home-ink) 32%, transparent);
}

.hero-play:active {
  transition-duration: var(--te-motion-press);
  transform: scale(var(--te-motion-press-scale));
}

.hero-open {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 20px;
  border: 1px solid color-mix(in srgb, var(--home-ink) 18%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--home-ink);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color var(--te-motion-hover),
    background var(--te-motion-hover),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.hero-open i {
  font-size: 12px;
  transition: transform var(--te-motion-return) var(--te-ease-out-quint);
}

.hero-open:hover {
  border-color: color-mix(in srgb, var(--home-ink) 34%, transparent);
  background: var(--te-hover-bg);
}

.hero-open:hover i {
  transition-duration: var(--te-motion-settle);
  transform: translateX(3px);
}

/* Hero collage stage */

.hero-stage {
  position: relative;
  flex: 1 1 48%;
  min-width: 0;
  border: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
}

.hero-collage {
  position: absolute;
  inset: 0;
}

.hero-collage-card {
  position: absolute;
  border-radius: 18px;
  overflow: hidden;
  box-shadow:
    0 22px 48px color-mix(in srgb, var(--te-neutral-900) 24%, transparent),
    0 0 0 1px color-mix(in srgb, var(--te-card-bg) 40%, transparent);
  transition: transform var(--te-motion-return) var(--te-ease-out-quint);
  will-change: transform;
}

.hero-collage-img,
.hero-collage-card :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-collage-card-0 {
  width: clamp(168px, 15.5vw, 218px);
  height: clamp(168px, 15.5vw, 218px);
  right: 24%;
  top: 50%;
  transform: translateY(-54%) rotate(-3deg);
  z-index: 3;
  animation: collage-float-a 7s ease-in-out infinite;
}

.hero-collage-card-1 {
  width: clamp(120px, 10.5vw, 150px);
  height: clamp(120px, 10.5vw, 150px);
  right: 7%;
  top: 14%;
  transform: rotate(5deg);
  z-index: 2;
  opacity: 0.96;
  animation: collage-float-b 8.5s ease-in-out infinite;
}

.hero-collage-card-2 {
  width: clamp(96px, 8.5vw, 122px);
  height: clamp(96px, 8.5vw, 122px);
  right: 12%;
  bottom: 8%;
  transform: rotate(-7deg);
  z-index: 1;
  opacity: 0.92;
  animation: collage-float-c 9.5s ease-in-out infinite;
}

@keyframes collage-float-a {
  0%,
  100% {
    transform: translateY(-54%) rotate(-3deg);
  }
  50% {
    transform: translateY(-58%) rotate(-2deg);
  }
}

@keyframes collage-float-b {
  0%,
  100% {
    transform: translateY(0) rotate(5deg);
  }
  50% {
    transform: translateY(-8px) rotate(6deg);
  }
}

@keyframes collage-float-c {
  0%,
  100% {
    transform: translateY(0) rotate(-7deg);
  }
  50% {
    transform: translateY(-6px) rotate(-8.5deg);
  }
}

.hero-stage:hover .hero-collage-card-0 {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-56%) rotate(-1.5deg) scale(1.03);
}

.hero-collage-placeholder {
  display: grid;
  place-items: center;
  color: var(--te-primary-500);
  background: linear-gradient(135deg, var(--home-primary-tint), var(--home-cyan-tint));
}

.hero-collage-placeholder i {
  font-size: 34px;
}

.collage-enter-active,
.collage-leave-active {
  transition: opacity 0.6s var(--te-ease-out-quint);
}

.collage-enter-from,
.collage-leave-to {
  opacity: 0;
}

/* ══ Duo cards ═════════════════════════════════════════════════════════ */

.duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.duo-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 20px 22px;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius-lg);
  background: var(--te-card-bg);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  box-shadow: var(--home-shadow);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint),
    border-color var(--te-motion-hover);
}

.duo-card::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.9;
}

.duo-fm::before {
  background:
    radial-gradient(circle at 0% 0%, var(--home-primary-tint), transparent 52%),
    radial-gradient(
      circle at 100% 100%,
      color-mix(in srgb, var(--te-primary-500) 6%, transparent),
      transparent 46%
    );
}

.duo-radar::before {
  background:
    radial-gradient(circle at 0% 0%, var(--home-cyan-tint), transparent 52%),
    radial-gradient(
      circle at 100% 100%,
      color-mix(in srgb, var(--te-accent-cyan) 6%, transparent),
      transparent 46%
    );
}

.duo-card:hover {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--home-ink) 16%, transparent);
  box-shadow: var(--home-shadow-lift);
}

.duo-stack {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 96px;
  height: 72px;
}

.duo-stack-cover {
  position: absolute;
  width: 60px;
  height: 60px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow:
    0 10px 22px color-mix(in srgb, var(--te-neutral-900) 20%, transparent),
    0 0 0 2px var(--te-card-bg);
  transition: transform var(--te-motion-return) var(--te-ease-out-quint);
}

.duo-stack-cover :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.duo-stack-cover-0 {
  left: 0;
  top: 6px;
  z-index: 3;
}

.duo-stack-cover-1 {
  left: 22px;
  top: 0;
  z-index: 2;
  transform: rotate(5deg) scale(0.94);
}

.duo-stack-cover-2 {
  left: 42px;
  top: 10px;
  z-index: 1;
  transform: rotate(-6deg) scale(0.88);
}

.duo-card:hover .duo-stack-cover-0 {
  transform: rotate(-4deg) translateY(-2px);
}

.duo-card:hover .duo-stack-cover-1 {
  transform: rotate(8deg) scale(0.94) translateY(-3px);
}

.duo-card:hover .duo-stack-cover-2 {
  transform: rotate(-9deg) scale(0.88) translateY(-2px);
}

.duo-card:hover .duo-stack-cover {
  transition-duration: var(--te-motion-settle);
}

.duo-stack-empty {
  display: grid;
  place-items: center;
  font-size: 22px;
  color: var(--te-primary-500);
  background: linear-gradient(135deg, var(--home-primary-tint), var(--home-cyan-tint));
}

.duo-radar .duo-stack-empty {
  color: color-mix(in srgb, var(--te-accent-cyan) 78%, var(--home-ink));
}

.duo-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.duo-name {
  font-family: var(--te-font-display);
  font-size: 19px;
  font-weight: 800;
  color: var(--home-ink);
}

.duo-sub {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--home-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.duo-arrow {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-left: auto;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--home-ink) 14%, transparent);
  color: var(--home-ink);
  font-size: 13px;
  background: color-mix(in srgb, var(--te-card-bg) 72%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    background var(--te-motion-hover),
    color var(--te-motion-hover);
}

.duo-card:hover .duo-arrow {
  transition-duration: var(--te-motion-settle);
  transform: translateX(4px);
  background: var(--home-ink);
  color: var(--te-card-bg);
}

/* ══ Section headings ══════════════════════════════════════════════════ */

.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.section-head-copy h3 {
  font-family: var(--te-font-display);
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.005em;
  color: var(--home-ink);
}

.section-head-copy p {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--home-ink-soft);
}

.section-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--home-line);
  border-radius: 999px;
  background: var(--te-card-bg);
  color: var(--home-ink-soft);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    color var(--te-motion-hover),
    border-color var(--te-motion-hover),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.section-more i {
  font-size: 10px;
}

.section-more:hover {
  transition-duration: var(--te-motion-settle);
  color: var(--home-ink);
  border-color: color-mix(in srgb, var(--home-ink) 26%, transparent);
  transform: translateX(2px);
}

/* ══ Chart ═════════════════════════════════════════════════════════════ */

.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 28px;
}

.chart-row {
  display: grid;
  grid-template-columns: 34px 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 9px 12px;
  border: none;
  border-radius: var(--home-radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--te-motion-hover);
}

.chart-row:hover {
  background: var(--te-hover-bg);
}

.chart-row.is-playing {
  background: var(--home-primary-tint);
}

.chart-index {
  font-family: var(--te-font-display);
  font-size: 20px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: color-mix(in srgb, var(--home-ink) 22%, transparent);
  transition: color var(--te-motion-hover);
}

.chart-row:hover .chart-index {
  color: color-mix(in srgb, var(--home-ink) 46%, transparent);
}

.chart-row.is-playing .chart-index {
  color: var(--te-primary-500);
}

.chart-cover {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--te-subtle-bg);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
}

.chart-cover :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chart-cover-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 16px;
  color: var(--home-ink-soft);
}

.chart-cover-action {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in srgb, var(--te-neutral-900) 44%, transparent);
  font-size: 13px;
  opacity: 0;
  transition: opacity var(--te-motion-hover);
}

.chart-row:hover .chart-cover-action,
.chart-row.is-playing .chart-cover-action {
  opacity: 1;
}

.chart-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 3px;
  height: 16px;
}

.chart-eq i {
  width: 3px;
  border-radius: 2px;
  background: #fff;
  animation: chart-eq-bounce 0.9s ease-in-out infinite;
}

.chart-eq i:nth-child(1) {
  height: 60%;
  animation-delay: 0s;
}

.chart-eq i:nth-child(2) {
  height: 100%;
  animation-delay: 0.22s;
}

.chart-eq i:nth-child(3) {
  height: 42%;
  animation-delay: 0.44s;
}

@keyframes chart-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.5);
  }
  50% {
    transform: scaleY(1);
  }
}

.chart-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chart-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--home-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chart-row.is-playing .chart-title {
  color: color-mix(in srgb, var(--te-primary-500) 82%, var(--home-ink));
}

.chart-artist {
  font-size: 12px;
  font-weight: 500;
  color: var(--home-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chart-duration {
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--home-ink-soft) 78%, transparent);
}

/* ══ Shelf ═════════════════════════════════════════════════════════════ */

.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  gap: 24px 20px;
}

.shelf-tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.shelf-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 16px;
  overflow: hidden;
  background: var(--te-subtle-bg);
  box-shadow: 0 14px 30px color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint);
}

.shelf-cover :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.35s var(--te-ease-out-quint);
}

.shelf-tile:hover .shelf-cover {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-4px);
  box-shadow: 0 20px 42px color-mix(in srgb, var(--te-neutral-900) 20%, transparent);
}

.shelf-tile:hover .shelf-cover :deep(img) {
  transition-duration: 0.9s;
  transform: scale(1.06);
}

.shelf-cover-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 26px;
  color: var(--te-primary-500);
  background: linear-gradient(135deg, var(--home-primary-tint), var(--home-cyan-tint));
}

.shelf-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    transparent 46%,
    color-mix(in srgb, var(--te-neutral-900) 62%, transparent)
  );
  opacity: 0;
  transition: opacity var(--te-motion-hover);
}

.shelf-tile:hover .shelf-scrim {
  opacity: 1;
}

.shelf-count {
  position: absolute;
  left: 10px;
  bottom: 10px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: color-mix(in srgb, var(--te-neutral-900) 46%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity var(--te-motion-return),
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.shelf-tile:hover .shelf-count {
  transition-duration: var(--te-motion-settle);
  opacity: 1;
  transform: translateY(0);
}

.shelf-open {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--te-neutral-900);
  background: color-mix(in srgb, #ffffff 92%, transparent);
  box-shadow: 0 10px 22px color-mix(in srgb, var(--te-neutral-900) 30%, transparent);
  opacity: 0;
  transform: translateY(6px) scale(0.9);
  transition:
    opacity var(--te-motion-return),
    transform var(--te-motion-return) var(--te-ease-spring);
}

.shelf-tile:hover .shelf-open {
  transition-duration: var(--te-motion-settle);
  opacity: 1;
  transform: translateY(0) scale(1);
}

.shelf-name {
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--home-ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shelf-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 120px;
  border: 1px dashed color-mix(in srgb, var(--home-ink) 16%, transparent);
  border-radius: var(--home-radius-lg);
  color: var(--home-ink-soft);
  font-size: 13px;
  font-weight: 500;
}

/* ══ Signed-out invite ═════════════════════════════════════════════════ */

.hero-invite {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 420px;
  padding: 60px 24px;
  text-align: center;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius-lg);
  background: var(--te-card-bg);
  overflow: hidden;
  box-shadow: var(--home-shadow);
  animation: home-rise 0.62s var(--te-ease-out-quint) both;
}

.invite-orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(52px);
  pointer-events: none;
}

.invite-orb-a {
  width: 340px;
  height: 340px;
  left: -80px;
  top: -120px;
  background: color-mix(in srgb, var(--te-primary-500) 16%, transparent);
  animation: invite-drift-a 12s ease-in-out infinite;
}

.invite-orb-b {
  width: 300px;
  height: 300px;
  right: -70px;
  bottom: -110px;
  background: color-mix(in srgb, var(--te-accent-cyan) 15%, transparent);
  animation: invite-drift-b 14s ease-in-out infinite;
}

@keyframes invite-drift-a {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(36px, 22px);
  }
}

@keyframes invite-drift-b {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(-30px, -20px);
  }
}

.invite-notes {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 74px;
  height: 74px;
  border-radius: 22px;
  background: linear-gradient(135deg, var(--home-primary-tint), var(--home-cyan-tint));
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 20%, transparent);
}

.invite-note-icon {
  font-size: 30px;
  color: var(--te-primary-500);
}

.invite-kicker {
  position: relative;
  z-index: 1;
  margin-top: 26px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.32em;
  color: var(--home-ink-soft);
}

.invite-title {
  position: relative;
  z-index: 1;
  margin-top: 12px;
  font-family: var(--te-font-display);
  font-size: clamp(30px, 3.6vw, 42px);
  font-weight: 900;
  letter-spacing: -0.01em;
  color: var(--home-ink);
}

.invite-desc {
  position: relative;
  z-index: 1;
  max-width: 440px;
  margin-top: 14px;
  font-size: 14px;
  line-height: 1.75;
  font-weight: 500;
  color: var(--home-ink-soft);
}

.invite-cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 48px;
  margin-top: 32px;
  padding: 0 28px;
  border: none;
  border-radius: 999px;
  background: var(--home-ink);
  color: var(--te-card-bg);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 16px 34px color-mix(in srgb, var(--home-ink) 26%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint),
    background var(--te-motion-hover);
}

.invite-cta:hover {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--home-ink) 84%, var(--te-primary-500));
  box-shadow: 0 20px 42px color-mix(in srgb, var(--home-ink) 34%, transparent);
}

.invite-cta:active {
  transition-duration: var(--te-motion-press);
  transform: scale(var(--te-motion-press-scale));
}

/* ══ Skeleton ══════════════════════════════════════════════════════════ */

.home-skeleton {
  display: flex;
  flex-direction: column;
  gap: 40px;
}

.sk-shimmer {
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--home-ink) 6%, transparent);
}

.sk-shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--te-card-bg) 60%, transparent),
    transparent
  );
  animation: sk-sweep 1.5s ease-in-out infinite;
}

@keyframes sk-sweep {
  to {
    transform: translateX(100%);
  }
}

.sk-hero {
  height: clamp(280px, 30vw, 340px);
  border-radius: var(--home-radius-lg);
}

.sk-duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.sk-card {
  height: 112px;
  border-radius: var(--home-radius-lg);
}

.sk-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  gap: 24px 20px;
}

.sk-tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sk-tile-cover {
  aspect-ratio: 1;
  border-radius: 16px;
}

.sk-tile-line {
  height: 13px;
  width: 78%;
  border-radius: 6px;
}

/* ══ Error ═════════════════════════════════════════════════════════════ */

.home-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 340px;
  padding: 48px 24px;
  text-align: center;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius-lg);
  background: var(--te-card-bg);
  box-shadow: var(--home-shadow);
}

.home-error-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 18px;
  font-size: 24px;
  color: var(--te-warning-500);
  background: color-mix(in srgb, var(--te-warning-500) 12%, transparent);
}

.home-error-title {
  margin-top: 18px;
  font-family: var(--te-font-display);
  font-size: 19px;
  font-weight: 800;
  color: var(--home-ink);
}

.home-error-hint {
  max-width: 380px;
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--home-ink-soft);
}

.home-error-retry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  margin-top: 24px;
  padding: 0 20px;
  border: 1px solid color-mix(in srgb, var(--home-ink) 18%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--home-ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    border-color var(--te-motion-hover);
}

.home-error-retry:hover {
  background: var(--te-hover-bg);
  border-color: color-mix(in srgb, var(--home-ink) 32%, transparent);
}

/* Dark theme: keep hover overlays dark so white glyphs stay legible */

:global(html[data-theme='dark'] .home-view .chart-cover-action) {
  background: color-mix(in srgb, var(--te-neutral-50) 44%, transparent);
}

:global(html[data-theme='dark'] .home-view .shelf-scrim) {
  background: linear-gradient(
    180deg,
    transparent 46%,
    color-mix(in srgb, var(--te-neutral-50) 62%, transparent)
  );
}

:global(html[data-theme='dark'] .home-view .shelf-count) {
  color: var(--te-neutral-900);
  background: color-mix(in srgb, var(--te-neutral-50) 46%, transparent);
}

:global(html[data-theme='dark'] .home-view .shelf-open) {
  color: var(--te-neutral-900);
  background: color-mix(in srgb, var(--te-neutral-50) 55%, transparent);
  box-shadow: 0 10px 22px color-mix(in srgb, var(--te-neutral-50) 40%, transparent);
}

/* ══ Responsive ════════════════════════════════════════════════════════ */

@media (max-width: 1100px) {
  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 880px) {
  .hero-inner {
    flex-direction: column;
    min-height: 0;
  }

  .hero-copy {
    padding: 28px 26px 8px;
  }

  .hero-stage {
    flex: 0 0 auto;
    width: 100%;
    height: 240px;
  }

  .hero-collage-card-0 {
    right: 36%;
  }

  .duo {
    grid-template-columns: minmax(0, 1fr);
  }

  .shelf-grid,
  .sk-tiles {
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  }
}

@media (max-width: 640px) {
  .hero-title {
    font-size: clamp(30px, 8vw, 40px);
  }

  .hero-desc {
    font-size: 13px;
  }

  .hero-actions {
    flex-wrap: wrap;
    gap: 10px;
  }

  .hero-play,
  .hero-open {
    height: 42px;
    padding-inline: 18px;
    font-size: 13px;
  }

  .duo-card {
    gap: 14px;
    padding: 16px;
  }

  .duo-stack {
    width: 80px;
    height: 60px;
  }

  .duo-stack-cover {
    width: 50px;
    height: 50px;
  }

  .duo-stack-cover-1 {
    left: 18px;
  }

  .duo-stack-cover-2 {
    left: 34px;
  }

  .duo-name {
    font-size: 17px;
  }

  .duo-sub {
    font-size: 11px;
  }

  .shelf-grid,
  .sk-tiles {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 16px 12px;
  }

  .shelf-name {
    margin-top: 8px;
    font-size: 12px;
  }

  .shelf-count {
    left: 8px;
    bottom: 8px;
    font-size: 10px;
    padding: 2px 7px;
  }

  .shelf-open {
    right: 8px;
    bottom: 8px;
    width: 30px;
    height: 30px;
    font-size: 11px;
  }

  .chart-row {
    grid-template-columns: 28px 42px minmax(0, 1fr) auto;
    gap: 10px;
    padding: 8px 8px;
  }

  .chart-cover {
    width: 42px;
    height: 42px;
  }

  .chart-title {
    font-size: 13px;
  }

  .chart-artist {
    font-size: 11px;
  }

  .chart-duration {
    font-size: 11px;
  }

  .section-head-copy h3 {
    font-size: 18px;
  }

  .section-head-copy p {
    font-size: 11px;
  }
}

/* ══ Reduced motion ════════════════════════════════════════════════════ */

@media (prefers-reduced-motion: reduce) {
  .home-flow > section,
  .hero-invite {
    animation: none;
  }

  .hero-collage-card-0,
  .hero-collage-card-1,
  .hero-collage-card-2,
  .invite-orb-a,
  .invite-orb-b,
  .chart-eq i,
  .sk-shimmer::after {
    animation: none;
  }
}

html[data-te-surface-material='liquidGlass'] .home-view {
  --home-glass-veil: 76%;
  --home-glass-veil-soft: 34%;
  --home-glass-hover: color-mix(in srgb, var(--home-ink) 8%, transparent);
  --home-glass-soft: color-mix(in srgb, var(--home-ink) 6%, transparent);
  --home-line: color-mix(in srgb, var(--home-ink) 12%, transparent);
  --home-ink-soft: color-mix(in srgb, var(--te-neutral-500) 58%, var(--home-ink));
  --home-ambient-alpha: 0.3;
}

html[data-te-surface-material='liquidGlass']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  ) {
  position: relative;
  isolation: isolate;
  background: transparent !important;
  border-color: transparent !important;
  box-shadow:
    inset 0 0 0 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.54)),
    inset 0 1px 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.2)),
    inset 0 -1px 1px rgba(15, 23, 42, 0.062),
    0 2px 7px rgba(15, 23, 42, 0.026),
    0 13px 32px rgba(15, 23, 42, 0.072) !important;
}

html[data-te-surface-material='liquidGlass']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: inherit;
  background:
    radial-gradient(
      112% 126% at 50% 42%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.17)) 0%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.055)) 21%,
      transparent 55%
    ),
    linear-gradient(
      135deg,
      transparent 0%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.1)) 35%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.022)) 62%,
      transparent 100%
    ),
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.055) 0%,
      transparent 52%,
      rgba(15, 23, 42, 0.062) 100%
    ),
    color-mix(in srgb, var(--te-card-bg) calc(var(--te-lg-tint, 0.12) * 100%), transparent),
    color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil), transparent);
  backdrop-filter: blur(var(--te-lg-blur, 16px)) saturate(var(--te-lg-saturate, 140%));
  -webkit-backdrop-filter: blur(var(--te-lg-blur, 16px)) saturate(var(--te-lg-saturate, 140%));
  filter: url(#te-lg-card);
}

html[data-te-liquid-glass-source='solid'][data-te-surface-material='liquidGlass']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--te-lg-context-rim) 18%, transparent),
      transparent 48%,
      color-mix(in srgb, var(--te-lg-context-label) 8%, transparent)
    ),
    var(--te-lg-context-material);
}

html[data-te-surface-material='liquidGlass'] .home-view .hero::after {
  background-color: color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil-soft), transparent);
}

html[data-te-surface-material='liquidGlass'] .home-view .hero-ambient :deep(img),
html[data-te-surface-material='liquidGlass'] .home-view .hero-ambient-img {
  opacity: var(--home-ambient-alpha);
}

html[data-te-surface-material='liquidGlass'] .home-view .hero-ambient::after {
  background:
    linear-gradient(
      100deg,
      color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil), transparent) 0%,
      color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil), transparent) 36%,
      color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil-soft), transparent) 58%,
      transparent 84%
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil-soft), transparent),
      transparent 38%
    );
}

html[data-te-surface-material='liquidGlass'] .home-view .duo-card:hover {
  box-shadow:
    inset 0 0 0 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.54)),
    inset 0 1px 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.44) * 0.2)),
    inset 0 -1px 1px rgba(15, 23, 42, 0.062),
    0 2px 7px rgba(15, 23, 42, 0.026),
    0 13px 32px rgba(15, 23, 42, 0.072) !important;
}

html[data-te-surface-material='liquidGlass'] .home-view .duo-arrow {
  background: var(--home-glass-soft);
  border-color: var(--home-line);
}

html[data-te-surface-material='liquidGlass'] .home-view .chart-grid {
  padding: 10px 12px;
  border-radius: var(--home-radius-lg);
}

html[data-te-surface-material='liquidGlass'] .home-view .chart-row:hover {
  background: var(--home-glass-hover);
}

html[data-te-surface-material='liquidGlass'] .home-view .shelf-tile {
  padding: 10px;
  border-radius: 26px;
}

html[data-te-surface-material='liquidGlass'] .home-view .shelf-empty {
  border-style: solid;
}

html[data-te-surface-material='liquidGlass'] .home-view .section-more:hover {
  border-color: var(--home-line) !important;
}

html[data-te-surface-material='liquidGlass'] .home-view .home-error-retry:hover {
  background: var(--home-glass-hover);
}

html[data-theme='dark'][data-te-surface-material='liquidGlass']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  ) {
  box-shadow:
    inset 0 0 0 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.38) * 0.54)),
    inset 0 1px 0.5px rgba(255, 255, 255, calc(var(--te-lg-specular, 0.38) * 0.2)),
    inset 0 -1px 1px rgba(0, 0, 0, 0.15),
    0 2px 7px rgba(0, 0, 0, 0.07),
    0 13px 32px rgba(0, 0, 0, 0.18) !important;
}

html[data-theme='dark'][data-te-surface-material='liquidGlass']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after {
  background:
    radial-gradient(
      112% 126% at 50% 42%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.38) * 0.17)) 0%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.38) * 0.055)) 21%,
      transparent 55%
    ),
    linear-gradient(
      135deg,
      transparent 0%,
      rgba(255, 255, 255, calc(var(--te-lg-specular, 0.38) * 0.1)) 35%,
      transparent 100%
    ),
    linear-gradient(180deg, transparent 48%, rgba(0, 0, 0, 0.13) 100%),
    color-mix(in srgb, var(--te-card-bg) calc(var(--te-lg-tint, 0.16) * 100%), transparent),
    color-mix(in srgb, var(--te-card-bg) var(--home-glass-veil), transparent);
}

html[data-te-surface-material='liquidGlass']
  body.te-no-blur
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after,
html[data-te-surface-material='liquidGlass'][data-te-effects-mode='reduced']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after,
html[data-te-surface-material='liquidGlass'][data-window-transparent='on'][data-platform='linux']
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after {
  filter: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

html[data-te-surface-material='liquidGlass'] body.te-no-blur .home-view,
html[data-te-surface-material='liquidGlass'][data-te-effects-mode='reduced'] .home-view,
html[data-te-surface-material='liquidGlass'][data-window-transparent='on'][data-platform='linux']
  .home-view {
  --home-glass-veil: 90%;
  --home-glass-veil-soft: 62%;
  --home-ambient-alpha: 0.24;
}

html[data-te-surface-material='liquidGlass']:is([data-te-motion='reduced'], [data-te-motion='off'])
  .home-view
  :is(
    .hero,
    .duo-card,
    .chart-grid,
    .shelf-tile,
    .shelf-empty,
    .section-more,
    .hero-invite,
    .home-error
  )::after {
  transition: none !important;
}
</style>
