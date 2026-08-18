<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import type { RemoteControlStatus } from '../../../../shared/remoteControl.ts'

const props = defineProps<{
  discordEnabled: boolean
  remoteEnabled: boolean
}>()

const emit = defineEmits<{
  'update:discordEnabled': [enabled: boolean]
  'update:remoteEnabled': [enabled: boolean]
}>()

const remoteStatus = ref<RemoteControlStatus | null>(null)
const remoteStatusError = ref('')
const remoteBusy = ref(false)
const remoteQrDataUrl = ref('')
const remoteQrUrl = ref('')
const discordStatus = ref<{
  enabled: boolean
  connected: boolean
  lastError: string | null
} | null>(null)
const notice = ref('')

let discordStatusTimer: number | null = null

async function refreshDiscordStatus(): Promise<void> {
  try {
    if (!window.api?.discord?.getStatus) {
      discordStatus.value = null
      return
    }
    discordStatus.value = await window.api.discord.getStatus()
  } catch {
    discordStatus.value = null
  }
}

const discordStatusText = computed(() => {
  if (!props.discordEnabled) return '已关闭'
  if (!discordStatus.value) return '状态未知'
  if (discordStatus.value.connected) return '已连接'
  return discordStatus.value.lastError
    ? `未连接：${discordStatus.value.lastError}`
    : '未连接（等待 Discord）'
})

async function refreshRemoteStatus(): Promise<void> {
  remoteStatusError.value = ''
  try {
    if (!window.api?.remote?.getStatus) {
      remoteStatus.value = null
      return
    }
    remoteStatus.value = await window.api.remote.getStatus()
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refreshRemoteQr(urls: string[] | undefined | null): Promise<void> {
  const primary = urls?.find((u) => typeof u === 'string' && u.trim()) ?? ''
  if (!primary) {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
    return
  }
  if (primary === remoteQrUrl.value && remoteQrDataUrl.value) return
  try {
    remoteQrDataUrl.value = await QRCode.toDataURL(primary, {
      margin: 1,
      width: 160,
      errorCorrectionLevel: 'M'
    })
    remoteQrUrl.value = primary
  } catch {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
  }
}

watch(
  () => remoteStatus.value?.urls,
  (urls) => {
    void refreshRemoteQr(urls)
  },
  { deep: true }
)

watch(
  () => props.remoteEnabled,
  (enabled) => {
    if (!enabled) {
      remoteQrDataUrl.value = ''
      remoteQrUrl.value = ''
    }
  }
)

function toggleDiscord(): void {
  emit('update:discordEnabled', !props.discordEnabled)
  window.setTimeout(() => {
    void refreshDiscordStatus()
  }, 400)
}

async function toggleRemote(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    const next = !props.remoteEnabled
    emit('update:remoteEnabled', next)
    if (window.api?.remote?.setEnabled) {
      remoteStatus.value = await window.api.remote.setEnabled(next)
    } else {
      await refreshRemoteStatus()
    }
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function rotateRemotePin(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    if (!window.api?.remote?.rotatePin) return
    const result = await window.api.remote.rotatePin()
    remoteStatus.value = result.status
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function copyRemoteUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    notice.value = '已复制远程地址'
  } catch {
    notice.value = url
  }
}

onMounted(() => {
  void refreshRemoteStatus()
  void refreshDiscordStatus()
  discordStatusTimer = window.setInterval(() => {
    if (props.discordEnabled) void refreshDiscordStatus()
  }, 8_000)
})

onBeforeUnmount(() => {
  if (discordStatusTimer !== null) {
    window.clearInterval(discordStatusTimer)
    discordStatusTimer = null
  }
})
</script>

<template>
  <div class="section-block">
    <h3>集成 (Integrations)</h3>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>Discord Rich Presence <i class="pi pi-discord discord-icon"></i></strong>
          <span>在 Discord 状态中向好友展示您正在播放的音乐。</span>
          <span class="setting-substatus" aria-live="polite">{{ discordStatusText }}</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: props.discordEnabled, inactive: !props.discordEnabled }"
          role="switch"
          :aria-checked="props.discordEnabled"
          @click="toggleDiscord"
        ></span>
      </div>
      <hr />
      <div class="setting-item top-align">
        <div class="setting-copy">
          <strong>局域网远程控制</strong>
          <span>
            默认关闭。开启后在局域网提供 Web 遥控页（PIN 配对 + Token），并支持 DLNA 投送。
          </span>
        </div>
        <span
          class="toggle-switch"
          :class="{
            active: props.remoteEnabled,
            inactive: !props.remoteEnabled
          }"
          role="switch"
          :aria-checked="props.remoteEnabled"
          :aria-busy="remoteBusy"
          @click="toggleRemote"
        ></span>
      </div>
      <div
        v-if="props.remoteEnabled"
        class="setting-item top-align remote-control-panel"
      >
        <div class="setting-copy">
          <strong>配对 PIN / 访问地址</strong>
          <span>
            状态：
            {{
              remoteStatus?.running ? `运行中 · 端口 ${remoteStatus.port ?? '—'}` : '未运行'
            }}
            <template v-if="remoteStatus?.paired"> · 已配对</template>
            <template v-if="(remoteStatus?.clientCount ?? 0) > 0">
              · {{ remoteStatus?.clientCount }} 客户端
            </template>
          </span>
          <div v-if="remoteStatus?.pin" class="remote-pin-row">
            <code class="remote-pin">{{ remoteStatus.pin }}</code>
            <button
              type="button"
              class="soft-button"
              :disabled="remoteBusy"
              @click="rotateRemotePin"
            >
              更换 PIN
            </button>
            <button
              type="button"
              class="soft-button"
              :disabled="remoteBusy"
              @click="refreshRemoteStatus"
            >
              刷新
            </button>
          </div>
          <div
            v-if="remoteQrDataUrl || (remoteStatus?.urls?.length ?? 0) > 0"
            class="remote-access-row"
          >
            <div v-if="remoteQrDataUrl" class="remote-qr-block">
              <img
                class="remote-qr"
                :src="remoteQrDataUrl"
                :alt="`远程控制二维码：${remoteQrUrl}`"
                width="160"
                height="160"
              />
              <span class="remote-qr-hint">手机扫码打开遥控页</span>
            </div>
            <ul v-if="(remoteStatus?.urls?.length ?? 0) > 0" class="remote-url-list">
              <li v-for="url in remoteStatus?.urls ?? []" :key="url">
                <button type="button" class="linkish" @click="copyRemoteUrl(url)">
                  {{ url }}
                </button>
              </li>
            </ul>
          </div>
          <span v-if="remoteStatus?.lastError" class="remote-error">
            {{ remoteStatus.lastError }}
          </span>
          <span v-if="remoteStatusError" class="remote-error">{{ remoteStatusError }}</span>
          <span v-if="notice" class="setting-substatus">{{ notice }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
