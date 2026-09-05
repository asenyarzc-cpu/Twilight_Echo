<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Track } from '@renderer/types/music'
import ArchiveArtwork from '@renderer/components/local-dashboard/ArchiveArtwork.vue'

const props = defineProps<{
  summary: { tracks: number; albums: number; artists: number; hours: number }
  hero: Track | null
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
  isPlaying: boolean
  currentTrackId: string | null
  currentTime: number
  duration: number
}>()
const emit = defineEmits<{
  play: [track: Track]
  shuffle: []
  seek: [position: number]
  'open-album': [index: number]
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()

const now = ref(new Date())
const activity = ref<'recent' | 'added'>(props.recent.length ? 'recent' : 'added')
const visibleTracks = computed(() =>
  (activity.value === 'recent' ? props.recent : props.added).slice(0, 6)
)
const visibleAlbums = computed(() => props.albums.slice(0, 4))
const heroIsCurrent = computed(
  () => !!props.currentTrackId && props.hero?.id === props.currentTrackId
)
const heroIsPlaying = computed(() => heroIsCurrent.value && props.isPlaying)
const progress = computed(() =>
  props.duration > 0 ? Math.min(100, Math.max(0, (props.currentTime / props.duration) * 100)) : 0
)
const heroLabel = computed(() => {
  if (heroIsPlaying.value) return '正在播放'
  if (heroIsCurrent.value) return '已暂停'
  return props.recent.some((track) => track.id === props.hero?.id) ? '继续聆听' : '从这首开始'
})
const dateLabel = computed(() =>
  now.value.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
)
const greeting = computed(() => {
  const hour = now.value.getHours()
  if (hour < 5) return '夜深了，留一盏灯给音乐。'
  if (hour < 11) return '早上好，让喜欢的旋律先醒来。'
  if (hour < 18) return '给忙碌按下暂停，把时间留给音乐。'
  return '晚上好，把世界调轻，把音乐调响。'
})
let clockTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = new Date()
  }, 60_000)
})
onBeforeUnmount(() => clearInterval(clockTimer))

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

function seekFromInput(event: Event): void {
  emit('seek', Number((event.target as HTMLInputElement).value))
}

function openActivity(): void {
  emit('select-view', activity.value === 'recent' ? 'recent' : 'allSongs', null)
}
</script>

<template>
  <main class="night-harbor dashboard-wrapper">
    <div class="nh-page">
      <header class="nh-masthead">
        <div class="nh-wordmark">
          <i class="ph ph-vinyl-record" aria-hidden="true"></i
          ><span>NIGHT HARBOR<span class="nh-wordmark-sub">私人唱片厅</span></span>
        </div>
        <span class="nh-date">{{ dateLabel }}</span>
      </header>
      <section class="nh-intro" aria-labelledby="nh-title">
        <div>
          <p class="nh-eyebrow">TWILIGHT ECHO / PERSONAL COLLECTION</p>
          <h1 id="nh-title">夜港<span>。</span><small>Night Harbor</small></h1>
          <p class="nh-greeting">{{ greeting }}</p>
        </div>
        <button
          class="nh-library-link"
          type="button"
          @click="emit('select-view', 'allSongs', null)"
        >
          我的音乐库<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
        </button>
      </section>
      <div class="nh-stage">
        <section class="nh-turntable" aria-label="唱片播放台">
          <div class="nh-deck-head">
            <span
              ><span class="nh-status-dot" :class="{ 'is-playing': heroIsPlaying }"></span
              >{{ hero ? heroLabel : '等待第一张唱片' }}</span
            ><span class="nh-deck-edition" aria-hidden="true">SIDE A <span>/</span> VOL. 03</span>
          </div>
          <div class="nh-deck-body">
            <div class="nh-art-stage" aria-hidden="true">
              <div class="nh-vinyl">
                <span class="nh-vinyl-label"
                  ><i class="ph ph-waveform"></i><span>TWILIGHT<br />RECORDS</span></span
                >
              </div>
              <ArchiveArtwork
                class="nh-sleeve"
                :cover="hero?.cover"
                :cover-source="hero?.coverSource"
                :identity="hero?.id"
                :title="hero?.title || '夜'"
              />
              <span class="nh-art-caption">ORIGINAL SOUND / YOUR COLLECTION</span>
            </div>
            <div class="nh-deck-copy">
              <p class="nh-deck-script">On the turntable.</p>
              <h2 :title="hero?.title">{{ hero?.title || '你的第一张唱片' }}</h2>
              <p class="nh-artist" :title="hero?.artist">
                {{ hero?.artist || '一间安静的房间，等一个喜欢的声音。' }}
              </p>
              <p v-if="hero" class="nh-album-name" :title="hero.album">
                <i class="ph ph-disc" aria-hidden="true"></i
                ><span>{{ hero.album || '本地音乐' }}</span>
              </p>
              <div class="nh-deck-actions">
                <button v-if="hero" type="button" class="nh-play" @click="emit('play', hero)">
                  <i :class="heroIsPlaying ? 'ph ph-pause' : 'ph ph-play'" aria-hidden="true"></i
                  ><span>{{ heroIsPlaying ? '暂停播放' : '开始聆听' }}</span>
                </button>
                <button v-else type="button" class="nh-play" @click="emit('open-library-settings')">
                  <i class="ph ph-folder-simple-plus" aria-hidden="true"></i><span>添加音乐</span>
                </button>
                <span v-if="hero?.format" class="nh-format">{{
                  hero.format.split('/')[0].toUpperCase()
                }}</span>
              </div>
            </div>
          </div>
          <div class="nh-deck-foot">
            <template v-if="heroIsCurrent && duration > 0">
              <span>{{ formatTime(currentTime) }}</span>
              <div class="nh-progress">
                <span class="nh-progress-rail" aria-hidden="true"
                  ><span :style="{ transform: 'scaleX(' + progress / 100 + ')' }"></span></span
                ><input
                  type="range"
                  min="0"
                  :max="duration"
                  step="1"
                  :value="currentTime"
                  aria-label="播放进度"
                  :aria-valuetext="formatTime(currentTime) + ' / ' + formatTime(duration)"
                  @input="seekFromInput"
                />
              </div>
              <span>{{ formatTime(duration) }}</span>
            </template>
            <template v-else
              ><i class="ph ph-headphones" aria-hidden="true"></i><span>放下一切，听完这一首。</span
              ><span class="nh-deck-foot-note">TAKE YOUR TIME</span></template
            >
          </div>
        </section>
        <aside class="nh-library" aria-label="音乐库一览">
          <p class="nh-eyebrow">THE COLLECTION</p>
          <button
            type="button"
            class="nh-library-total"
            @click="emit('select-view', 'allSongs', null)"
          >
            <strong>{{ summary.tracks.toLocaleString('zh-CN') }}</strong
            ><span>首私藏曲目<i class="ph ph-arrow-up-right" aria-hidden="true"></i></span>
          </button>
          <div class="nh-library-details">
            <button type="button" @click="emit('select-view', 'albums', null)">
              <span><i class="ph ph-disc" aria-hidden="true"></i>专辑</span
              ><strong
                >{{ summary.albums.toLocaleString('zh-CN')
                }}<i class="ph ph-caret-right" aria-hidden="true"></i
              ></strong>
            </button>
            <button type="button" @click="emit('select-view', 'artists', null)">
              <span><i class="ph ph-microphone-stage" aria-hidden="true"></i>艺术家</span
              ><strong
                >{{ summary.artists.toLocaleString('zh-CN')
                }}<i class="ph ph-caret-right" aria-hidden="true"></i
              ></strong>
            </button>
            <div>
              <span><i class="ph ph-hourglass-simple" aria-hidden="true"></i>音乐时长</span
              ><strong>{{ summary.hours.toLocaleString('zh-CN') }}<small>小时</small></strong>
            </div>
          </div>
          <button v-if="summary.tracks" type="button" class="nh-shuffle" @click="emit('shuffle')">
            <span class="nh-eyebrow">LET IT PLAY</span><strong>不如，随心一首。</strong
            ><span class="nh-shuffle-bottom"
              >下一首惊喜，交给偶然。<i class="ph ph-shuffle" aria-hidden="true"></i
            ></span>
          </button>
          <button v-else type="button" class="nh-shuffle" @click="emit('open-library-settings')">
            <span class="nh-eyebrow">MAKE IT YOURS</span><strong>让音乐住进来。</strong
            ><span class="nh-shuffle-bottom"
              >添加本地音乐文件夹<i class="ph ph-plus" aria-hidden="true"></i
            ></span>
          </button>
        </aside>
      </div>
      <section class="nh-rotation" aria-labelledby="nh-rotation-title">
        <header class="nh-section-head">
          <div>
            <p class="nh-eyebrow"><span>01</span> IN ROTATION</p>
            <h2 id="nh-rotation-title">最近轮换</h2>
          </div>
          <div class="nh-activity-controls">
            <div class="nh-tabs" role="group" aria-label="聆听记录来源">
              <button
                type="button"
                :aria-pressed="activity === 'recent'"
                @click="activity = 'recent'"
              >
                最近聆听
              </button>
              <button
                type="button"
                :aria-pressed="activity === 'added'"
                @click="activity = 'added'"
              >
                最近添加
              </button>
            </div>
            <button
              type="button"
              class="nh-section-link"
              aria-label="查看全部曲目"
              title="查看全部曲目"
              @click="openActivity"
            >
              <i class="ph ph-arrow-up-right" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <div v-if="visibleTracks.length" class="nh-tracks">
          <button
            v-for="(track, index) in visibleTracks"
            :key="track.id"
            class="nh-track"
            type="button"
            :class="{ 'is-current': currentTrackId === track.id }"
            :aria-label="`${currentTrackId === track.id && isPlaying ? '暂停' : '播放'} ${track.title} · ${track.artist}`"
            @click="emit('play', track)"
          >
            <span class="nh-track-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <ArchiveArtwork
              :cover="track.coverSmall || track.cover"
              :cover-source="track.coverSmallSource || track.coverSource"
              :identity="track.id"
              :title="track.title"
            />
            <span class="nh-track-copy"
              ><strong :title="track.title">{{ track.title }}</strong
              ><small>{{ track.artist || '未知艺术家' }}</small></span
            >
            <span class="nh-track-duration">{{ formatTime(track.duration) }}</span>
            <span class="nh-track-action" aria-hidden="true"
              ><i
                :class="currentTrackId === track.id && isPlaying ? 'ph ph-pause' : 'ph ph-play'"
              ></i
            ></span>
          </button>
        </div>
        <div v-else class="nh-empty-activity">
          <i class="ph ph-headphones" aria-hidden="true"></i>
          <div>
            <strong>{{ activity === 'recent' ? '还没有聆听记录' : '音乐库暂无曲目' }}</strong>
          </div>
          <button
            type="button"
            class="nh-library-link"
            @click="
              summary.tracks ? emit('select-view', 'allSongs', null) : emit('open-library-settings')
            "
          >
            {{ summary.tracks ? '去听一首' : '添加音乐'
            }}<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
          </button>
        </div>
      </section>
      <section v-if="visibleAlbums.length" class="nh-shelf" aria-labelledby="nh-shelf-title">
        <header class="nh-section-head">
          <div>
            <p class="nh-eyebrow"><span>02</span> THE RECORD SHELF</p>
            <h2 id="nh-shelf-title">我的唱片架</h2>
          </div>
          <button
            type="button"
            class="nh-library-link"
            @click="emit('select-view', 'albums', null)"
          >
            全部专辑<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
          </button>
        </header>
        <div class="nh-albums">
          <button
            v-for="(album, index) in visibleAlbums"
            :key="album.key"
            type="button"
            class="nh-album"
            :aria-label="`打开专辑 ${album.name} · ${album.artist}`"
            @click="emit('open-album', index)"
          >
            <span class="nh-album-art"
              ><ArchiveArtwork
                :cover="album.cover"
                :cover-source="album.coverSource"
                :identity="album.identity"
                :title="album.name" /><span class="nh-album-open" aria-hidden="true"
                ><i class="ph ph-arrow-up-right"></i></span
            ></span>
            <span class="nh-album-index"
              >{{ String(index + 1).padStart(2, '0')
              }}<span>{{ album.trackCount }} TRACKS</span></span
            >
            <strong :title="album.name">{{ album.name }}</strong
            ><small>{{ album.artist }}</small>
          </button>
        </div>
      </section>
      <footer class="nh-colophon">
        <span>TWILIGHT ECHO<span>/</span>NIGHT HARBOR</span><span>好音乐，不必急着听完。</span
        ><i class="ph ph-waveform" aria-hidden="true"></i>
      </footer>
    </div>
  </main>
</template>

<style scoped src="./NightHarborHome.css"></style>
