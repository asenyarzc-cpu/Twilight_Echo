<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Track } from '@renderer/types/music'
import ArchiveArtwork from '@renderer/components/local-dashboard/ArchiveArtwork.vue'

const props = defineProps<{
  summary: {
    tracks: number
    albums: number
    artists: number
    duration: string
    durationUnit: string
  }
  recent: Track[]
  added: Track[]
  albums: Array<{
    key: string
    name: string
    artist: string
    cover: string | null
    coverSource?: string | null
    identity?: string
    trackCount: number
  }>
  hero: Track | null
  isPlaying: boolean
  currentTrackId: string | null
}>()
const emit = defineEmits<{
  play: [track: Track]
  shuffle: []
  'open-album': [index: number]
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()

const now = ref(new Date())
const shelf = ref<HTMLElement | null>(null)
const activity = ref<'recent' | 'added'>(props.recent.length ? 'recent' : 'added')
const page = ref(0)
const pageSize = ref(5)
const activityTracks = computed(() => (activity.value === 'recent' ? props.recent : props.added))
const pageCount = computed(() =>
  Math.max(1, Math.ceil(activityTracks.value.length / pageSize.value))
)
const currentPage = computed(() => Math.min(page.value, pageCount.value - 1))
const visibleTracks = computed(() =>
  activityTracks.value.slice(
    currentPage.value * pageSize.value,
    (currentPage.value + 1) * pageSize.value
  )
)
const dateLabel = computed(() =>
  now.value.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
)
const greeting = computed(() => {
  const hour = now.value.getHours()
  if (hour < 5) return '夜深了，给自己留一首歌的时间。'
  if (hour < 11) return '早上好，从喜欢的旋律开始今天。'
  if (hour < 14) return '午间片刻，让音乐慢慢流淌。'
  if (hour < 18) return '下午好，找张唱片，放松一下。'
  return '晚上好，把此刻交给音乐。'
})
let observer: ResizeObserver | undefined
let clockTimer: number | undefined

onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width
    pageSize.value = width >= 900 ? 5 : width >= 680 ? 4 : width >= 460 ? 3 : 2
  })
  if (shelf.value) observer.observe(shelf.value)
  clockTimer = window.setInterval(() => {
    now.value = new Date()
  }, 60_000)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.clearInterval(clockTimer)
})
watch(activity, () => {
  page.value = 0
})

function selectTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  activity.value =
    event.key === 'Home'
      ? 'recent'
      : event.key === 'End'
        ? 'added'
        : activity.value === 'recent'
          ? 'added'
          : 'recent'
  const group = (event.currentTarget as HTMLElement).parentElement
  group?.querySelector<HTMLButtonElement>(`#archive-tab-${activity.value}`)?.focus()
}

function turnPage(offset: number): void {
  page.value = Math.min(pageCount.value - 1, Math.max(0, currentPage.value + offset))
}

function openActivity(): void {
  emit('select-view', activity.value === 'recent' ? 'recent' : 'allSongs', null)
}

function trackFormat(track: Track): string {
  return track.format?.split('/')[0].toUpperCase() || 'AUDIO'
}
</script>

<template>
  <main class="archive-home dashboard-wrapper">
    <div class="archive-page">
      <header class="archive-masthead">
        <div class="archive-intro">
          <p class="archive-eyebrow">
            <span class="archive-status-dot"></span> YOUR PERSONAL MUSIC ROOM
            <span class="archive-date">{{ dateLabel }}</span>
          </p>
          <h1>Hi, music lover<span class="archive-title-dot">.</span></h1>
          <p class="archive-greeting">{{ greeting }}</p>
        </div>
        <button
          v-if="summary.tracks"
          class="archive-shuffle"
          type="button"
          @click="emit('shuffle')"
        >
          <i class="ph ph-shuffle" aria-hidden="true"></i><span>随心漫游</span
          ><i class="ph ph-arrow-up-right" aria-hidden="true"></i>
        </button>
      </header>

      <section class="archive-stats" aria-label="音乐库一览">
        <button type="button" @click="emit('select-view', 'artists', null)">
          <i class="ph ph-microphone-stage" aria-hidden="true"></i
          ><span
            ><strong>{{ summary.artists.toLocaleString('zh-CN') }}</strong
            ><small>位艺术家</small></span
          ><i class="ph ph-arrow-up-right archive-stat-arrow" aria-hidden="true"></i>
        </button>
        <button type="button" @click="emit('select-view', 'albums', null)">
          <i class="ph ph-disc" aria-hidden="true"></i
          ><span
            ><strong>{{ summary.albums.toLocaleString('zh-CN') }}</strong
            ><small>张专辑</small></span
          ><i class="ph ph-arrow-up-right archive-stat-arrow" aria-hidden="true"></i>
        </button>
        <button type="button" @click="emit('select-view', 'allSongs', null)">
          <i class="ph ph-music-notes" aria-hidden="true"></i
          ><span
            ><strong>{{ summary.tracks.toLocaleString('zh-CN') }}</strong
            ><small>首歌曲</small></span
          ><i class="ph ph-arrow-up-right archive-stat-arrow" aria-hidden="true"></i>
        </button>
        <div class="archive-stat-time">
          <i class="ph ph-hourglass-medium" aria-hidden="true"></i
          ><span
            ><strong>{{ summary.duration }}</strong
            ><small>{{ summary.durationUnit }}</small></span
          ><span class="archive-stat-caption" aria-hidden="true">ALL YOURS</span>
        </div>
      </section>

      <section ref="shelf" class="archive-rotation" aria-label="最近活动">
        <div class="archive-rotation-head">
          <div class="archive-section-name">
            <span class="archive-overline">IN ROTATION</span>
            <h2>最近活动<span class="archive-heading-dot">·</span></h2>
          </div>
          <div class="archive-tabs" role="tablist" aria-label="活动类型">
            <button
              id="archive-tab-recent"
              type="button"
              role="tab"
              :aria-selected="activity === 'recent'"
              aria-controls="archive-activity-panel"
              :tabindex="activity === 'recent' ? 0 : -1"
              @click="activity = 'recent'"
              @keydown="selectTab"
            >
              最近收听
            </button>
            <button
              id="archive-tab-added"
              type="button"
              role="tab"
              :aria-selected="activity === 'added'"
              aria-controls="archive-activity-panel"
              :tabindex="activity === 'added' ? 0 : -1"
              @click="activity = 'added'"
              @keydown="selectTab"
            >
              最近添加
            </button>
          </div>
          <div class="archive-paging">
            <span class="archive-page-count" aria-live="polite"
              >{{ String(currentPage + 1).padStart(2, '0') }}
              <span>/ {{ String(pageCount).padStart(2, '0') }}</span></span
            ><button
              type="button"
              aria-label="上一页唱片"
              :disabled="currentPage === 0"
              @click="turnPage(-1)"
            >
              <i class="ph ph-caret-left" aria-hidden="true"></i></button
            ><button
              type="button"
              aria-label="下一页唱片"
              :disabled="currentPage >= pageCount - 1"
              @click="turnPage(1)"
            >
              <i class="ph ph-caret-right" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <div
          id="archive-activity-panel"
          role="tabpanel"
          :aria-labelledby="`archive-tab-${activity}`"
          tabindex="0"
          class="archive-activity-panel"
        >
          <div
            v-if="visibleTracks.length"
            class="archive-records"
            :style="{ gridTemplateColumns: `repeat(${pageSize}, minmax(0, 1fr))` }"
          >
            <button
              v-for="track in visibleTracks"
              :key="track.id"
              class="archive-record"
              type="button"
              :aria-label="`${isPlaying && currentTrackId === track.id ? '暂停' : '播放'} ${track.title} · ${track.artist}`"
              @click="emit('play', track)"
            >
              <span class="archive-record-cover"
                ><ArchiveArtwork
                  :cover="track.coverSmall || track.cover"
                  :cover-source="track.coverSmallSource || track.coverSource"
                  :identity="track.id"
                  :title="track.title"
                /><span
                  class="archive-record-play"
                  :class="{ 'is-current': currentTrackId === track.id }"
                  ><i
                    :class="isPlaying && currentTrackId === track.id ? 'ph ph-pause' : 'ph ph-play'"
                    aria-hidden="true"
                  ></i></span
                ><span class="archive-record-format">{{ trackFormat(track) }}</span></span
              >
              <strong :title="track.title">{{ track.title }}</strong
              ><small :title="track.artist">{{ track.artist || '未知艺术家' }}</small>
            </button>
          </div>
          <div v-else class="archive-shelf-empty">
            <span class="archive-empty-disc" aria-hidden="true"><i class="ph ph-disc"></i></span>
            <div>
              <h3>
                {{
                  activity === 'recent' && summary.tracks
                    ? '下一首，就从喜欢的开始。'
                    : '你的唱片房间，等待第一张收藏。'
                }}
              </h3>
              <p>
                {{
                  activity === 'recent' && summary.tracks
                    ? '播放过的音乐会在这里留下足迹。'
                    : '添加音乐文件夹，让每一张封面都有自己的位置。'
                }}
              </p>
              <button
                type="button"
                @click="
                  activity === 'recent' && summary.tracks
                    ? emit('shuffle')
                    : emit('open-library-settings')
                "
              >
                <i
                  :class="summary.tracks ? 'ph ph-play' : 'ph ph-folder-simple-plus'"
                  aria-hidden="true"
                ></i
                >{{ activity === 'recent' && summary.tracks ? '开始聆听' : '添加音乐文件夹' }}
              </button>
            </div>
          </div>
        </div>
        <footer class="archive-rotation-footer">
          <span
            ><i class="ph ph-vinyl-record" aria-hidden="true"></i>
            {{
              activity === 'recent' ? '熟悉的旋律，值得再次相遇。' : '新的收藏，新的心动。'
            }}</span
          ><button type="button" @click="openActivity">
            浏览全部 <i class="ph ph-arrow-right" aria-hidden="true"></i>
          </button>
        </footer>
      </section>

      <div class="archive-discover">
        <section class="archive-resume-section">
          <div class="archive-section-head">
            <h2>{{ isPlaying ? '此刻，正在聆听' : '继续聆听' }}</h2>
            <span>YOUR MOMENT</span>
          </div>
          <div v-if="hero" class="archive-resume">
            <button
              type="button"
              class="archive-resume-art"
              :aria-label="`${isPlaying ? '暂停' : '播放'} ${hero.title}`"
              @click="emit('play', hero)"
            >
              <span class="archive-vinyl" aria-hidden="true"></span
              ><ArchiveArtwork
                :cover="hero.cover"
                :cover-source="hero.coverSource"
                :identity="hero.id"
                :title="hero.title"
              />
            </button>
            <div class="archive-resume-copy">
              <span class="archive-resume-status"
                ><span :class="{ 'archive-status-dot': isPlaying }"></span
                >{{ isPlaying ? 'NOW PLAYING' : 'PRESS PLAY, SLOW DOWN' }}</span
              >
              <h3 :title="hero.title">{{ hero.title }}</h3>
              <p :title="hero.artist">{{ hero.artist || '未知艺术家' }}</p>
              <span class="archive-resume-meta"
                >{{ trackFormat(hero)
                }}<template v-if="hero.sampleRate">
                  · {{ Number((hero.sampleRate / 1000).toFixed(1)) }} kHz</template
                ></span
              ><button class="archive-resume-play" type="button" @click="emit('play', hero)">
                <i :class="isPlaying ? 'ph ph-pause' : 'ph ph-play'" aria-hidden="true"></i
                >{{ isPlaying ? '暂停播放' : '播放音乐' }}
              </button>
            </div>
          </div>
          <div v-else class="archive-resume-empty">
            <i class="ph ph-headphones" aria-hidden="true"></i>
            <p>留一点时间，听听自己喜欢的。</p>
            <span>MAKE ROOM FOR MUSIC.</span>
          </div>
        </section>
        <section class="archive-album-section">
          <div class="archive-section-head">
            <h2>你的专辑架</h2>
            <button type="button" @click="emit('select-view', 'albums', null)">
              全部专辑 <i class="ph ph-arrow-up-right" aria-hidden="true"></i>
            </button>
          </div>
          <div v-if="albums.length" class="archive-albums">
            <button
              v-for="(album, index) in albums"
              :key="album.key"
              type="button"
              class="archive-album"
              :aria-label="`打开专辑 ${album.name}`"
              @click="emit('open-album', index)"
            >
              <ArchiveArtwork
                :cover="album.cover"
                :cover-source="album.coverSource"
                :identity="album.identity"
                :title="album.name"
              /><span class="archive-album-copy"
                ><strong :title="album.name">{{ album.name }}</strong
                ><small>{{ album.artist }} · {{ album.trackCount }} 首</small></span
              ><i class="ph ph-arrow-up-right" aria-hidden="true"></i>
            </button>
          </div>
          <div v-else class="archive-albums-empty">
            <i class="ph ph-stack" aria-hidden="true"></i>
            <p>好唱片，值得好好收藏。</p>
            <button type="button" @click="emit('open-library-settings')">
              整理我的音乐库 <i class="ph ph-arrow-right" aria-hidden="true"></i>
            </button>
          </div>
        </section>
      </div>
      <footer class="archive-colophon">
        <span>TWILIGHT ECHO <span>/</span> 暮光档案</span><span>A LITTLE CLOSER TO MUSIC.</span
        ><i class="ph ph-asterisk" aria-hidden="true"></i>
      </footer>
    </div>
  </main>
</template>

<style scoped src="./ArchiveHome.css"></style>
