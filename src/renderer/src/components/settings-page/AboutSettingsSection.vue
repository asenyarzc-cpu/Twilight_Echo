<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'
import { resolveCover } from '../../utils/coverLoader.ts'
import { GITHUB_URL, HOMEPAGE_URL, RELEASES_URL } from './types.ts'
import type { AppUpdateProgress } from '../../../../shared/appUpdate.ts'

const AFDIAN_URL = 'https://ifdian.net/a/pxasen'
// Public assets are copied to the renderer root at build time. Relative paths
// resolve against the loaded document in both dev (http) and packaged builds
// (file://), where a leading "/" would point at the filesystem root.
const ALIPAY_QR_URL = './sponsor/alipay.jpg'
const WECHAT_QR_URL = './sponsor/wechat.png'
const QQ_GROUP_QR_URL = './qq-group-qrcode.jpg'

interface Sponsor {
  id: string
  name: string
  avatarUrl: string
  requestedText?: string
}

const SPONSORS: readonly Sponsor[] = [
  {
    id: 'celestique',
    name: 'Celestique',
    avatarUrl: 'https://s41.ax1x.com/2026/08/03/pmI8JIJ.jpg',
    requestedText: '運命のルーレット廻して，ずっと君を見ていた。'
  },
  {
    id: 'afdian-user-b3f86',
    name: '爱发电用户_b3f86',
    avatarUrl: 'https://s41.ax1x.com/2026/08/03/pmI8Lzq.png'
  },
  {
    id: 'jiang-feng-jiang1021',
    name: '江枫Jiang1021',
    avatarUrl: ''
  },
  {
    id: 'your-rain',
    name: 'YourRain',
    avatarUrl: 'https://s41.ax1x.com/2026/08/10/pmbqWUH.jpg'
  },
  {
    id: 'afdian-user-fa664',
    name: '剑锋',
    avatarUrl: 'https://s41.ax1x.com/2026/08/10/pmbL1de.jpg'
  },
  {
    id: 'yunshan',
    name: '云杉',
    avatarUrl: 'https://s41.ax1x.com/2026/08/10/pmbq7Kf.jpg'
  },
  {
    id: 'yu',
    name: '羽',
    avatarUrl: 'https://s41.ax1x.com/2026/08/10/pmbqHr8.jpg'
  },
  {
    id: 'mumu-hina',
    name: 'MuMuHina',
    avatarUrl: 'https://s41.ax1x.com/2026/08/30/pnP5zOH.jpg'
  }
]

const props = defineProps<{
  appVersion: string
  updateCheckState: 'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  latestVersion: string
  lastUpdateCheck: string
  releaseUrl: string
  assetName: string
  hasChecksum: boolean
  updateError: string
  updateProgress: AppUpdateProgress | null
  updateActionState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
}>()

const emit = defineEmits<{
  checkForUpdates: []
  downloadUpdate: []
  cancelUpdateDownload: []
  installUpdate: []
  openReleasePage: []
  exportAudioDiagnostics: []
}>()

function openExternal(url: string): void {
  void window.api?.shell?.openExternal?.(url)
}

function openGithub(): void {
  openExternal(GITHUB_URL)
}

function openHomepage(): void {
  openExternal(HOMEPAGE_URL)
}

function openChangelog(): void {
  openExternal(RELEASES_URL)
}

const sponsorDialogOpen = ref(false)
const sponsorDialogRef = ref<HTMLElement | null>(null)
const sponsorListOpen = ref(false)
const sponsorListRef = ref<HTMLElement | null>(null)
const qqGroupDialogOpen = ref(false)
const qqGroupDialogRef = ref<HTMLElement | null>(null)
const sponsorAvatarSources = ref<Record<string, string>>({})
const sponsorAvatarLoadFailed = ref<Record<string, boolean>>({})

onMounted(() => {
  for (const sponsor of SPONSORS) {
    void resolveCover(null, sponsor.avatarUrl).then((source) => {
      if (!source) return
      sponsorAvatarSources.value = { ...sponsorAvatarSources.value, [sponsor.id]: source }
    })
  }
})

function sponsorInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function markSponsorAvatarLoadFailed(id: string): void {
  sponsorAvatarLoadFailed.value = { ...sponsorAvatarLoadFailed.value, [id]: true }
}

function openSponsorDialog(): void {
  sponsorListOpen.value = false
  sponsorDialogOpen.value = true
}

function closeSponsorDialog(): void {
  sponsorDialogOpen.value = false
}

function openSponsorList(): void {
  sponsorDialogOpen.value = false
  sponsorListOpen.value = true
}

function closeSponsorList(): void {
  sponsorListOpen.value = false
}

function openQqGroupDialog(): void {
  qqGroupDialogOpen.value = true
}

function closeQqGroupDialog(): void {
  qqGroupDialogOpen.value = false
}

function openAfdian(): void {
  openExternal(AFDIAN_URL)
}

useEscapeToClose(sponsorDialogOpen, closeSponsorDialog)
useFocusTrap(sponsorDialogRef, sponsorDialogOpen)
useEscapeToClose(sponsorListOpen, closeSponsorList)
useFocusTrap(sponsorListRef, sponsorListOpen)
useEscapeToClose(qqGroupDialogOpen, closeQqGroupDialog)
useFocusTrap(qqGroupDialogRef, qqGroupDialogOpen)

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function progressLabel(): string {
  const progress = props.updateProgress
  if (!progress) return ''
  if (progress.phase === 'downloading') {
    return `${progress.percent}% · ${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
  }
  return progress.message || ''
}
</script>

<template>
  <section id="about" class="glass-card preview-section about-section">
    <div class="about-glow" aria-hidden="true"></div>
    <div class="section-title-row">
      <i class="pi pi-info-circle"></i>
      <h2>关于 (About)</h2>
    </div>

    <div class="about-hero">
      <div class="logo-shell">
        <div class="logo-mark">
          <img src="/icon.png" alt="Twilight Echo" class="logo-icon" />
        </div>
      </div>
      <div class="about-copy">
        <h3>Twilight Echo</h3>
        <span>Version {{ appVersion || '—' }}</span>
        <p>一款专为发烧友打造的现代级桌面音乐枢纽，支持海量本地高解析度音频与插件化流媒体扩展。</p>
      </div>
    </div>

    <div class="about-cards">
      <div class="update-card">
        <div class="status-icon">
          <i
            :class="
              updateActionState === 'downloading' || updateCheckState === 'checking'
                ? 'pi pi-spin pi-spinner'
                : updateCheckState === 'available' || updateActionState === 'ready'
                  ? 'pi pi-download'
                  : updateCheckState === 'error' || updateActionState === 'error'
                    ? 'pi pi-exclamation-circle'
                    : updateCheckState === 'idle'
                      ? 'pi pi-sync'
                      : 'pi pi-check-circle'
            "
          ></i>
        </div>
        <div class="update-copy">
          <strong v-if="updateCheckState === 'idle'">点击检查更新</strong>
          <strong v-else-if="updateCheckState === 'checking'">正在检查更新…</strong>
          <strong v-else-if="updateActionState === 'downloading'">正在下载更新…</strong>
          <strong v-else-if="updateActionState === 'ready'">更新包已就绪</strong>
          <strong v-else-if="updateActionState === 'installing'">正在启动安装程序…</strong>
          <strong v-else-if="updateCheckState === 'available'"
            >发现新版本 v{{ latestVersion }}</strong
          >
          <strong v-else-if="updateCheckState === 'error' || updateActionState === 'error'"
            >更新失败</strong
          >
          <strong v-else>当前已是最新版本</strong>
          <span v-if="updateError" class="update-error">{{ updateError }}</span>
          <span v-else-if="updateActionState === 'downloading' || updateActionState === 'ready'">
            {{ progressLabel() || assetName || '—' }}
            <!-- downloads are refused without a checksum, so a ready package is always verified -->
            <template v-if="updateActionState === 'ready'"> · SHA-256 已校验 </template>
          </span>
          <span v-else-if="updateCheckState === 'available' && assetName">
            {{ assetName }}{{ hasChecksum ? ' · 可校验' : ' · 无校验和' }}
          </span>
          <span v-else>上次检查：{{ lastUpdateCheck || '—' }}</span>
          <div
            v-if="updateActionState === 'downloading' && updateProgress"
            class="update-progress-track"
            aria-hidden="true"
          >
            <div
              class="update-progress-fill"
              :style="{
                transform: `scaleX(${Math.max(0, Math.min(100, updateProgress.percent)) / 100})`
              }"
            ></div>
          </div>
        </div>
        <div class="update-actions">
          <template v-if="updateActionState === 'downloading'">
            <button class="soft-button" type="button" @click="emit('cancelUpdateDownload')">
              <i class="pi pi-times"></i>
              取消
            </button>
          </template>
          <template v-else-if="updateActionState === 'ready'">
            <button class="brand-soft-button" type="button" @click="emit('installUpdate')">
              <i class="pi pi-download"></i>
              安装并退出
            </button>
            <button class="soft-button" type="button" @click="emit('openReleasePage')">
              打开发布页
            </button>
          </template>
          <template v-else-if="updateCheckState === 'available'">
            <button
              v-if="assetName"
              class="brand-soft-button"
              type="button"
              @click="emit('downloadUpdate')"
            >
              <i class="pi pi-download"></i>
              下载更新
            </button>
            <button class="soft-button" type="button" @click="emit('openReleasePage')">
              打开发布页
            </button>
          </template>
          <template v-else>
            <button
              class="soft-button"
              type="button"
              :disabled="updateCheckState === 'checking' || updateActionState === 'installing'"
              @click="emit('checkForUpdates')"
            >
              <i class="pi pi-sync"></i>
              检查更新
            </button>
          </template>
        </div>
      </div>

      <div class="sponsor-card">
        <i class="pi pi-heart-fill sponsor-watermark" aria-hidden="true"></i>
        <div>
          <h3><i class="pi pi-heart"></i> 支持项目发展</h3>
          <p>
            Twilight Echo
            是一个由热情驱动的免费开源项目。您的赞助将用于软件维护、功能开发与发布服务。
          </p>
        </div>
        <div class="sponsor-card-actions">
          <button class="sponsor-primary-button" type="button" @click="openSponsorDialog">
            <i class="pi pi-heart-fill"></i>
            赞助作者
          </button>
          <button class="sponsor-secondary-button" type="button" @click="openSponsorList">
            <i class="pi pi-users"></i>
            赞助名单
          </button>
        </div>
      </div>
    </div>

    <hr />

    <div class="about-links">
      <button type="button" @click="emit('exportAudioDiagnostics')">
        <i class="pi pi-file-export"></i> 导出音频诊断
      </button>
      <button type="button" @click="openGithub"><i class="pi pi-github"></i> GitHub</button>
      <button type="button" @click="openChangelog"><i class="pi pi-file-o"></i> 更新日志</button>
      <button type="button" @click="openHomepage"><i class="pi pi-heart-fill"></i> 开源致谢</button>
      <button type="button" @click="openQqGroupDialog"><i class="pi pi-comments"></i> Q群</button>
    </div>

    <Teleport to="body">
      <Transition name="sponsor-dialog">
        <div
          v-if="sponsorDialogOpen"
          class="sponsor-dialog-overlay"
          @click.self="closeSponsorDialog"
        >
          <section
            ref="sponsorDialogRef"
            class="sponsor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sponsor-dialog-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon"><i class="pi pi-heart-fill"></i></span>
                <div>
                  <h3 id="sponsor-dialog-title">赞助作者</h3>
                  <p>选择适合你的支持方式</p>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭赞助窗口"
                @click="closeSponsorDialog"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div class="sponsor-dialog-notice" role="note">
              <i class="pi pi-info-circle"></i>
              <p>请务必添加我的联系方式，我会将你加入软件的赞助者名单中，感谢你的支持！</p>
            </div>

            <button class="afdian-option" type="button" @click="openAfdian">
              <span class="afdian-option-icon"><i class="pi pi-external-link"></i></span>
              <span class="afdian-option-copy">
                <strong>前往爱发电</strong>
                <small>通过爱发电平台支持作者</small>
              </span>
              <i class="pi pi-angle-right"></i>
            </button>

            <div class="sponsor-qr-grid">
              <figure class="sponsor-qr-card alipay">
                <figcaption>
                  <span><i class="pi pi-wallet"></i></span>
                  <div>
                    <strong>支付宝</strong>
                    <small>打开支付宝扫一扫</small>
                  </div>
                </figcaption>
                <div class="sponsor-qr-image-shell">
                  <img :src="ALIPAY_QR_URL" alt="支付宝收款二维码" />
                </div>
              </figure>

              <figure class="sponsor-qr-card wechat">
                <figcaption>
                  <span><i class="pi pi-qrcode"></i></span>
                  <div>
                    <strong>微信支付</strong>
                    <small>打开微信扫一扫</small>
                  </div>
                </figcaption>
                <div class="sponsor-qr-image-shell">
                  <img :src="WECHAT_QR_URL" alt="微信收款二维码" />
                </div>
              </figure>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="sponsor-dialog">
        <div v-if="sponsorListOpen" class="sponsor-dialog-overlay" @click.self="closeSponsorList">
          <section
            ref="sponsorListRef"
            class="sponsor-dialog sponsor-list-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sponsor-list-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon"><i class="pi pi-users"></i></span>
                <div>
                  <h3 id="sponsor-list-title">赞助名单</h3>
                  <p>感谢每一位支持 Twilight Echo 的朋友</p>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭赞助名单"
                @click="closeSponsorList"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div v-if="SPONSORS.length > 0" class="sponsor-list-entries">
              <article v-for="sponsor in SPONSORS" :key="sponsor.id" class="sponsor-list-entry">
                <div class="sponsor-list-avatar" aria-hidden="true">
                  <img
                    v-if="sponsorAvatarSources[sponsor.id] && !sponsorAvatarLoadFailed[sponsor.id]"
                    :src="sponsorAvatarSources[sponsor.id]"
                    :alt="`${sponsor.name} 的头像`"
                    @error="markSponsorAvatarLoadFailed(sponsor.id)"
                  />
                  <span v-else>{{ sponsorInitial(sponsor.name) }}</span>
                </div>
                <div class="sponsor-list-entry-copy">
                  <strong>{{ sponsor.name }}</strong>
                  <small v-if="sponsor.requestedText">{{ sponsor.requestedText }}</small>
                </div>
                <i class="pi pi-heart-fill sponsor-list-entry-heart" aria-hidden="true"></i>
              </article>
            </div>
            <div v-else class="sponsor-list-empty">
              <span><i class="pi pi-heart"></i></span>
              <strong>赞助名单持续更新中</strong>
              <p>完成赞助后请添加作者联系方式，我会在确认后将你加入名单。</p>
              <button type="button" class="sponsor-primary-button" @click="openSponsorDialog">
                赞助作者
              </button>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="sponsor-dialog">
        <div
          v-if="qqGroupDialogOpen"
          class="sponsor-dialog-overlay"
          @click.self="closeQqGroupDialog"
        >
          <section
            ref="qqGroupDialogRef"
            class="sponsor-dialog qq-group-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qq-group-dialog-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon qq-group-dialog-icon">
                  <i class="pi pi-comments"></i>
                </span>
                <div>
                  <h3 id="qq-group-dialog-title">TwilightEcho 交流群</h3>
                  <p>群号：1093775290</p>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭 Q 群二维码"
                @click="closeQqGroupDialog"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div class="qq-group-qr-shell">
              <img :src="QQ_GROUP_QR_URL" alt="TwilightEcho 交流群二维码，群号 1093775290" />
            </div>
            <p class="qq-group-dialog-hint">使用手机 QQ 扫描二维码加入群聊</p>
          </section>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>
