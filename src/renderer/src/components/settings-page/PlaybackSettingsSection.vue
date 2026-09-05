<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useAudioOutputDspStore } from '../../stores/useAudioOutputDspStore'
import { usePlayerStore } from '../../stores/usePlayerStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  HIFI_STATUS_COPY,
  dsdRouteTargetsDistinctRoute,
  withDsdRoutePatch,
  type DsdRouteSettings
} from '../../../../shared/audioProcessingOptions.ts'
import { isDsdProxyDevice } from '../../../../shared/dsdProxyDrivers.ts'
import { resolveReasonCode } from '../../../../shared/audio/reasonCodes.ts'
import { useLocale } from '../../app/useLocale.ts'
import {
  type AudioCapabilitySupportState,
  type AudioDeviceOption,
  type AudioOutputId,
  type AudioProcessingSettings,
  type ChannelRoutingMode,
  type DsdOutputMode,
  type NcmPlaybackQuality,
  type OutputConfig,
  type PcmToDsdMode,
  type PlaybackResumeMode,
  type PreviousButtonAction
} from '../../types/settings'
import {
  bufferSizeOptions,
  dsdOutputModeOptions,
  ncmPlaybackQualityOptions,
  pcmToDsdModeOptions,
  playbackResumeOptions,
  previousButtonActionOptions,
  routingModeOptions
} from './types.ts'

const { settings, updateSettings } = useSettingsStore()
const { locale, t } = useLocale()
const audioOutputDspStore = useAudioOutputDspStore()
const playbackQueueStore = usePlayerStore()
const {
  exclusiveMode,
  audioOutput,
  audioDevice,
  audioOutputOptions,
  audioDeviceOptions,
  audioOutputDeviceOptions,
  audioProcessing,
  audioOutputConfig,
  audioOutputConfigApplyStatus,
  playbackInfo,
  outputInfo,
  audioEngineError
} = storeToRefs(audioOutputDspStore)

const { volume } = playbackQueueStore

const {
  toggleExclusiveMode,
  setAudioOutput,
  setAudioDevice,
  setAudioOutputConfig,
  setAudioProcessing,
  refreshAudioOutputState,
  toggleGapless
} = audioOutputDspStore

const { setVolume, setUnityVolume } = playbackQueueStore

const volumePercent = computed({
  get: () => Math.round(volume.value * 100),
  set: (value: number) => {
    setVolume(value / 100)
  }
})

const selectedAudioOutput = computed(() =>
  audioOutputOptions.value.find((option) => option.id === audioOutput.value)
)
const exclusiveAvailable = computed(() => selectedAudioOutput.value?.supportsExclusive ?? false)
const isUpmixActive = computed(
  () =>
    audioOutputConfig.value.routingMode === 'stereo-to-5.1' ||
    audioOutputConfig.value.routingMode === 'stereo-to-7.1'
)
const showWasapiPushMode = computed(() => audioOutput.value === 'wasapi' && exclusiveMode.value)

const advancedParamsOpen = ref(false)

const audioOutputPanelExpanded = ref(false)

const outputChainText = computed(() => {
  const info = playbackInfo.value
  if (!info) return '等待音频引擎'
  const codec = info.codec || 'Source'
  const depth = info.sourceBitDepth > 0 ? `${info.sourceBitDepth}bit` : ''
  const rate = info.sourceSampleRate > 0 ? compactRate(info.sourceSampleRate) : ''
  const src = [codec, depth, rate].filter(Boolean).join(' ')
  const out = outputInfo.value
  const backend = out?.actualBackend || info.actualBackend || audioOutput.value
  const actualDepth =
    (out?.actualBitDepth || info.actualBitDepth || 0) > 0
      ? `${out?.actualBitDepth || info.actualBitDepth}bit`
      : ''
  const actualRate =
    (out?.actualSampleRate || info.actualSampleRate || 0) > 0
      ? compactRate(out?.actualSampleRate || info.actualSampleRate)
      : ''
  return `${src} -> ${backend.toUpperCase()} ${actualDepth} ${actualRate}`.trim()
})

const outputLatencyText = computed(() => {
  const info = outputInfo.value
  if (!info) return ''
  const total = info.latencyInfo?.totalLatencyMs ?? info.latencyMs ?? 0
  return `Latency ${total.toFixed(1)} ms`
})

const outputDiagnosticsText = computed(() => {
  const diagnostics = outputInfo.value?.diagnostics ?? playbackInfo.value?.diagnostics
  if (!diagnostics) return 'Underrun 0 · Drop 0'
  return `Underrun ${diagnostics.sessionUnderrunCount} · Drop ${diagnostics.sessionBufferDropCount}`
})

const outputProviderImplementation = computed(() => outputInfo.value?.providerImplementation ?? '')

/**
 * Why the output chain is not bit-perfect, in prose.
 *
 * The panel used to render `outputDiagnosticsText` twice — once as the status and
 * again under a warning triangle — so it showed underrun counters twice and never
 * said why passthrough was not achieved. The engine has always reported a reason
 * code; nothing resolved it into an explanation the user could act on.
 */
const outputReason = computed(() => {
  const code = outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
  if (!code) return null
  const resolved = resolveReasonCode(locale.value, code)
  return resolved.known ? resolved : null
})

/** Free-text capability note from the driver, when there is no code to resolve. */
const outputReasonFallback = computed(() => {
  if (outputReason.value) return ''
  return (
    outputInfo.value?.capabilityReason?.trim() ||
    outputInfo.value?.perfectReason?.trim() ||
    playbackInfo.value?.perfectReason?.trim() ||
    ''
  )
})

const outputIsPerfect = computed(
  () => outputInfo.value?.sourceExact === true && outputInfo.value?.outputPerfect === true
)

/**
 * The headline verdict: "verified bit-exact" or the single reason it is not.
 *
 * This replaces the underrun counters that used to sit here. Counters still show
 * in the meta row below, where they belong — a stream health statistic is not an
 * answer to "is my audio bit-perfect".
 */
const outputVerdictText = computed(() => {
  if (outputIsPerfect.value) return t('diagnostics.panel.perfect')
  if (outputReason.value) return outputReason.value.label
  if (outputReasonFallback.value) return outputReasonFallback.value
  return t('diagnostics.panel.noBlockers')
})

const outputVerdictTone = computed(() => {
  if (outputIsPerfect.value) return 'success'
  if (!outputReason.value) return 'muted'
  return outputReason.value.severity === 'info' ? 'muted' : 'warning'
})

function compactRate(rate: number): string {
  return rate > 0 ? `${Math.round(rate / 100) / 10}kHz` : ''
}

function deviceIcon(device: AudioDeviceOption): string {
  const text = `${device.id} ${device.label} ${device.backend || ''}`.toLowerCase()
  if (/speaker|soundbar|monitor|音响|音箱|扬声器|喇叭/.test(text)) return 'pi pi-volume-up'
  if (/usb|dac|asio|hifi|exclusive/.test(text)) return 'pi pi-microchip'
  return 'pi pi-headphones'
}

function deviceSpecText(device: AudioDeviceOption): string {
  const parts = [
    device.backend || audioOutput.value,
    typeof device.channels === 'number' && device.channels > 0 ? `${device.channels}ch` : '',
    device.sampleRates && device.sampleRates.length > 0
      ? compactRate(Math.max(...device.sampleRates))
      : '',
    device.bitDepths && device.bitDepths.length > 0 ? `${Math.max(...device.bitDepths)}bit` : ''
  ].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  if (device.id === 'auto') return '跟随系统默认输出'
  if (device.isDefault) return '系统默认设备'
  return '原生输出设备'
}

function normalizeCapabilityState(
  state: AudioCapabilitySupportState | undefined
): AudioCapabilitySupportState {
  return state ?? 'unknown'
}

function capabilityStateLabel(state: AudioCapabilitySupportState | undefined): string {
  return {
    verified: '已验证',
    'runtime-probed': '运行时探测',
    unsupported: '不支持',
    unknown: '未知'
  }[normalizeCapabilityState(state)]
}

function capabilityStateTone(state: AudioCapabilitySupportState | undefined): string {
  return {
    verified: 'verified',
    'runtime-probed': 'runtime',
    unsupported: 'unsupported',
    unknown: 'unknown'
  }[normalizeCapabilityState(state)]
}

function capabilityStateTitle(device: AudioDeviceOption, label: string): string {
  const reason = device.capabilityReason?.trim()
  return reason ? `${label}: ${reason}` : label
}

function setPlaybackResumeMode(playbackResumeMode: PlaybackResumeMode): void {
  if (settings.value.playbackResumeMode === playbackResumeMode) return
  void updateSettings({ playbackResumeMode })
}

function setPlaybackResumeModeFromSelect(event: Event): void {
  setPlaybackResumeMode((event.target as HTMLSelectElement).value as PlaybackResumeMode)
}

function setPreviousButtonActionFromSelect(event: Event): void {
  const previousButtonAction = (event.target as HTMLSelectElement).value as PreviousButtonAction
  if (settings.value.previousButtonAction === previousButtonAction) return
  void updateSettings({ previousButtonAction })
}

function setSleepTimerDefaultMinutes(event: Event): void {
  const value = Math.trunc(Number((event.target as HTMLInputElement).value))
  if (!Number.isFinite(value)) return
  void updateSettings({
    sleepTimer: { ...settings.value.sleepTimer, defaultMinutes: Math.max(1, Math.min(720, value)) }
  })
}

function setSleepTimerFadeSeconds(event: Event): void {
  const value = Math.trunc(Number((event.target as HTMLInputElement).value))
  if (!Number.isFinite(value)) return
  void updateSettings({
    sleepTimer: { ...settings.value.sleepTimer, fadeSeconds: Math.max(0, Math.min(120, value)) }
  })
}

function setNcmPlaybackQuality(event: Event): void {
  void updateSettings({
    ncmPlaybackQuality: (event.target as HTMLSelectElement).value as NcmPlaybackQuality
  })
}

function selectAudioOutput(output: AudioOutputId): void {
  if (audioOutput.value === output) return
  void setAudioOutput(output)
}

function selectAudioDevice(deviceId: string): void {
  if (audioDevice.value === deviceId) return
  void setAudioDevice(deviceId)
}

function setPreferredBufferSize(event: Event): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  const value = Number((event.target as HTMLSelectElement).value)
  if (audioOutputConfig.value.preferredBufferSize === value) return
  void setAudioOutputConfig({ preferredBufferSize: value })
}

function setRoutingMode(event: Event): void {
  const target = event.target as HTMLSelectElement
  void setAudioOutputConfig({ routingMode: target.value as ChannelRoutingMode })
}

function setPcmToDsdMode(event: Event): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  const value = (event.target as HTMLSelectElement).value as PcmToDsdMode
  if ((audioOutputConfig.value.pcmToDsdMode ?? 'off') === value) return
  void setAudioOutputConfig({ pcmToDsdMode: value })
}

function setUpmixParam(field: keyof OutputConfig, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  void setAudioOutputConfig({ [field]: value } as Partial<OutputConfig>)
}

function toggleWasapiExclusivePushMode(): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  void setAudioOutputConfig({
    wasapiExclusivePushMode: !audioOutputConfig.value.wasapiExclusivePushMode
  })
}

function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): void {
  void setAudioProcessing(patch)
}

async function selectDsdOutputMode(value: DsdOutputMode): Promise<void> {
  await setAudioProcessing({ dsdOutputMode: value, dsdToPcm: value === 'pcm' })
}

const dsdRoute = computed<DsdRouteSettings>(() => audioProcessing.value.dsdRoute)
const dsdRouteActive = computed(() => dsdRouteTargetsDistinctRoute(dsdRoute.value))

const dsdRouteBackendOptions = computed(() =>
  audioOutputOptions.value.filter((option) => option.id === 'asio' || option.id === 'alsa')
)

const dsdRouteDeviceOptions = computed(() => {
  const backend = dsdRoute.value.backend || audioOutput.value
  return audioDeviceOptions.value.filter((device) => {
    const id = (device.id ?? '').toLowerCase()
    const deviceBackend = device.backend ?? (id.startsWith('asio:') ? 'asio' : '')
    return deviceBackend === backend || id.startsWith(`${backend}:`)
  })
})

const dsdRouteProxyDevices = computed(() =>
  dsdRouteDeviceOptions.value.filter((device) => isDsdProxyDevice(device))
)

const dsdRouteRuntimeText = computed(() => {
  const diagnostics = outputInfo.value?.diagnostics
  if (!diagnostics) return ''
  if (diagnostics.dsdRouteOverrideActive) {
    const target = [diagnostics.dsdRouteBackend, diagnostics.dsdRouteDevice]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' / ')
    return target ? `DSD 正经由兼容层路由输出：${target}` : 'DSD 正经由兼容层路由输出'
  }
  if (diagnostics.dsdRouteFallbackReason) {
    return `兼容层路由未生效，已回退主输出：${diagnostics.dsdRouteFallbackReason}`
  }
  return ''
})

function patchDsdRoute(patch: Partial<DsdRouteSettings>): void {
  updateAudioProcessing({ dsdRoute: withDsdRoutePatch(dsdRoute.value, patch) })
}

function toggleDsdRouteEnabled(): void {
  patchDsdRoute({ enabled: !dsdRoute.value.enabled })
}

function setDsdRouteBackend(event: Event): void {
  const backend = (event.target as HTMLSelectElement).value
  patchDsdRoute({ backend, device: '' })
}

function setDsdRouteDevice(event: Event): void {
  patchDsdRoute({ device: (event.target as HTMLSelectElement).value })
}

function toggleDsdRoutePcmToDsd(): void {
  patchDsdRoute({ applyToPcmToDsd: !dsdRoute.value.applyToPcmToDsd })
}

function toggleDsdRouteStrict(): void {
  patchDsdRoute({ strictPassthrough: !dsdRoute.value.strictPassthrough })
}

function setDsdOutputMode(event: Event): void {
  void selectDsdOutputMode((event.target as HTMLSelectElement).value as DsdOutputMode)
}

function setVolumeFromInput(event: Event): void {
  volumePercent.value = Number((event.target as HTMLInputElement).value)
}

function toggleClipGuard(): void {
  updateAudioProcessing({ clipGuard: !audioProcessing.value.clipGuard })
}

function toggleGaplessPlayback(): void {
  void toggleGapless()
}

function setCrossfadeSeconds(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ crossfadeSeconds: value })
}
</script>

<template>
  <section id="playback" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-volume-up"></i>
      <h2>播放 (Playback)</h2>
    </div>

    <div v-if="audioEngineError" class="engine-error">{{ audioEngineError }}</div>

    <div v-if="playbackInfo" class="output-diagnostic-panel">
      <div class="diagnostic-head">
        <span class="diagnostic-label">{{ t('diagnostics.panel.title') }}</span>
        <span class="diagnostic-status" :data-tone="outputVerdictTone">
          {{ outputVerdictText }}
        </span>
      </div>
      <div class="diagnostic-chain">{{ outputChainText }}</div>

      <!-- The reason the chain is not bit-perfect, with what is happening and
           what to do. This panel previously printed the underrun counters twice
           and never showed the reason at all. -->
      <div v-if="outputReason" class="diagnostic-reason">
        <p class="diagnostic-reason-label">
          <span class="diagnostic-severity" :data-severity="outputReason.severity">
            {{ t(`diagnostics.severity.${outputReason.severity}`) }}
          </span>
          {{ outputReason.label }}
        </p>
        <p v-if="outputReason.explain" class="diagnostic-reason-explain">
          {{ outputReason.explain }}
        </p>
        <p v-if="outputReason.fix" class="diagnostic-reason-fix">
          <i class="pi pi-wrench" aria-hidden="true"></i> {{ outputReason.fix }}
        </p>
      </div>

      <div class="diagnostic-meta">
        <span v-if="outputLatencyText"><i class="pi pi-clock"></i> {{ outputLatencyText }}</span>
        <span><i class="pi pi-chart-bar"></i> {{ outputDiagnosticsText }}</span>
        <span v-if="outputProviderImplementation">
          <i class="pi pi-cog"></i> Provider {{ outputProviderImplementation }}
        </span>
      </div>
    </div>

    <div class="device-panel">
      <div class="device-panel-head">
        <div>
          <p>Audio Output</p>
          <h3>输出设备与链路</h3>
        </div>
        <div class="device-panel-actions">
          <label class="device-panel-disclosure">
            <input
              v-model="audioOutputPanelExpanded"
              type="checkbox"
              aria-controls="audio-output-device-panel"
              :aria-expanded="audioOutputPanelExpanded"
            />
            <span>{{ audioOutputPanelExpanded ? '收起设备列表' : '展开设备列表' }}</span>
          </label>
          <button
            type="button"
            class="icon-button"
            title="刷新设备列表"
            @click="refreshAudioOutputState"
          >
            <i class="pi pi-refresh"></i>
          </button>
        </div>
      </div>
      <div
        v-if="audioOutputPanelExpanded"
        id="audio-output-device-panel"
        class="device-panel-content"
      >
        <div class="device-grid">
          <button
            v-for="device in audioOutputDeviceOptions"
            :key="device.id"
            type="button"
            class="device-card"
            :class="{ active: audioDevice === device.id }"
            @click="selectAudioDevice(device.id)"
          >
            <i :class="deviceIcon(device)"></i>
            <span>{{ device.label }}</span>
            <small>{{ deviceSpecText(device) }}</small>
            <div
              v-if="
                normalizeCapabilityState(device.dopSupportState) !== 'unsupported' ||
                normalizeCapabilityState(device.nativeDsdSupportState) !== 'unsupported'
              "
              class="device-capability-row"
            >
              <span
                v-if="normalizeCapabilityState(device.dopSupportState) !== 'unsupported'"
                class="device-capability-chip"
                :class="capabilityStateTone(device.dopSupportState)"
                :title="capabilityStateTitle(device, 'DoP')"
              >
                DoP {{ capabilityStateLabel(device.dopSupportState) }}
              </span>
              <span
                v-if="normalizeCapabilityState(device.nativeDsdSupportState) !== 'unsupported'"
                class="device-capability-chip"
                :class="capabilityStateTone(device.nativeDsdSupportState)"
                :title="capabilityStateTitle(device, 'Native DSD')"
              >
                Native DSD {{ capabilityStateLabel(device.nativeDsdSupportState) }}
              </span>
            </div>
            <b v-if="audioDevice === device.id">当前</b>
          </button>
        </div>
        <p class="device-capability-note">
          列表为设备能力声明；是否 Native DSD / DoP 以播放时 HiFi 状态为准（筛选≠当前输出模式）。
        </p>
      </div>
    </div>

    <div class="section-block">
      <h3>播放引擎 (Engine)</h3>
      <div class="setting-list">
        <div class="setting-item">
          <div class="setting-copy">
            <strong>输出模式</strong>
            <span>选择音频后端和系统混音路径。</span>
          </div>
          <div class="segmented-control">
            <button
              v-for="option in audioOutputOptions"
              :key="option.id"
              type="button"
              :class="{ active: audioOutput === option.id }"
              @click="selectAudioOutput(option.id)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <hr />
        <div class="setting-item top-align dsd-route-setting">
          <div class="setting-copy">
            <strong>DSD 直通路由</strong>
          </div>
          <div
            class="segmented-control dsd-route-control"
            role="radiogroup"
            aria-label="DSD 直通路由"
          >
            <button
              v-for="option in dsdOutputModeOptions"
              :key="option.value"
              type="button"
              role="radio"
              :class="{ active: audioProcessing.dsdOutputMode === option.value }"
              :aria-checked="audioProcessing.dsdOutputMode === option.value"
              :title="option.description"
              @click="selectDsdOutputMode(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <hr />
        <div class="setting-item top-align dsd-compat-route">
          <div class="setting-copy">
            <strong>DSD 兼容层路由</strong>
            <span>
              DAC 自带 ASIO 驱动不接受 DSD 采样类型（或只有 WASAPI）时，DSD 会被迫降级为 DoP /
              PCM。把 DSD 单独路由到已注册的 DSD 代理 ASIO 驱动可以恢复直通，PCM
              仍走主输出、不受影响。
            </span>
            <small>
              代理驱动（如 foo_dsd_asio）是独立的系统级 ASIO 驱动，与是否安装 foobar2000
              无关；本软件不加载任何第三方组件，只按你选定的 后端与设备协商。
            </small>
            <span
              v-if="dsdRouteRuntimeText"
              class="setting-substatus"
              :class="{ available: outputInfo?.diagnostics?.dsdRouteOverrideActive }"
            >
              {{ dsdRouteRuntimeText }}
            </span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: dsdRoute.enabled, inactive: !dsdRoute.enabled }"
            role="switch"
            :aria-checked="dsdRoute.enabled"
            aria-label="启用 DSD 兼容层路由"
            @click="toggleDsdRouteEnabled()"
          ></span>
        </div>
        <template v-if="dsdRoute.enabled">
          <div class="setting-item compact-row">
            <div class="setting-copy">
              <strong>路由后端</strong>
              <span>留空则沿用主输出后端。</span>
            </div>
            <select
              class="settings-select"
              :value="dsdRoute.backend"
              aria-label="DSD 兼容层路由后端"
              @change="setDsdRouteBackend"
            >
              <option value="">跟随主输出（{{ audioOutput }}）</option>
              <option v-for="option in dsdRouteBackendOptions" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div class="setting-item compact-row">
            <div class="setting-copy">
              <strong>路由设备</strong>
              <span v-if="dsdRouteProxyDevices.length > 0">
                检测到 {{ dsdRouteProxyDevices.length }} 个疑似 DSD 代理驱动。
              </span>
              <span v-else> 未检测到疑似代理驱动；若已安装仍可手动选择对应设备。 </span>
            </div>
            <select
              class="settings-select"
              :value="dsdRoute.device"
              aria-label="DSD 兼容层路由设备"
              @change="setDsdRouteDevice"
            >
              <option value="">跟随主输出设备</option>
              <option v-for="device in dsdRouteDeviceOptions" :key="device.id" :value="device.id">
                {{ device.label }}{{ isDsdProxyDevice(device) ? '（DSD 代理）' : '' }}
              </option>
            </select>
          </div>
          <div class="setting-item">
            <div class="setting-copy">
              <strong>PCM→DSD 上采样也走此路由</strong>
              <span>关闭则仅 DSD 源使用兼容层，上采样仍走主输出。</span>
            </div>
            <span
              class="toggle-switch"
              :class="{
                active: dsdRoute.applyToPcmToDsd,
                inactive: !dsdRoute.applyToPcmToDsd
              }"
              role="switch"
              :aria-checked="dsdRoute.applyToPcmToDsd"
              aria-label="PCM 转 DSD 上采样使用兼容层路由"
              @click="toggleDsdRoutePcmToDsd()"
            ></span>
          </div>
          <div class="setting-item">
            <div class="setting-copy">
              <strong>严格直通模式</strong>
              <span>
                开启后无法建立 DSD 直通时报错停止，不静默降级为 PCM。默认关闭，保持自动回退。
              </span>
            </div>
            <span
              class="toggle-switch"
              :class="{
                active: dsdRoute.strictPassthrough,
                inactive: !dsdRoute.strictPassthrough
              }"
              role="switch"
              :aria-checked="dsdRoute.strictPassthrough"
              aria-label="DSD 严格直通模式"
              @click="toggleDsdRouteStrict()"
            ></span>
          </div>
          <div v-if="!dsdRouteActive" class="setting-item">
            <div class="setting-copy">
              <span class="setting-substatus">
                已启用但未指定后端或设备，当前等同于沿用主输出。
              </span>
            </div>
          </div>
        </template>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>独占模式 (Exclusive)</strong>
            <span>尝试绕过系统混音器以获得更直接的输出链路。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: exclusiveMode, inactive: !exclusiveMode }"
            role="switch"
            :aria-checked="exclusiveMode"
            :title="exclusiveAvailable ? '' : '当前后端不支持独占模式'"
            @click="exclusiveAvailable && toggleExclusiveMode()"
          ></span>
        </div>
        <hr />
        <div class="setting-item compact-row">
          <div class="setting-copy">
            <strong>音量与削波保护</strong>
            <span> {{ HIFI_STATUS_COPY.volumeNotUnityHint }}。低于 100% 会改变样本值。 </span>
          </div>
          <div class="inline-controls">
            <input
              class="number-input"
              type="number"
              min="0"
              max="100"
              :value="volumePercent"
              @input="setVolumeFromInput"
            />
            <button
              type="button"
              class="soft-button"
              :disabled="volumePercent >= 100"
              title="将软件音量固定为 100%（Unity）"
              @click="setUnityVolume"
            >
              {{ HIFI_STATUS_COPY.unityButton }}
            </button>
            <span
              class="toggle-switch"
              :class="{
                active: audioProcessing.clipGuard,
                inactive: !audioProcessing.clipGuard
              }"
              role="switch"
              :aria-checked="audioProcessing.clipGuard"
              title="削波保护"
              @click="toggleClipGuard"
            ></span>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>无缝播放 (Gapless Playback)</strong>
            <span>{{ HIFI_STATUS_COPY.gaplessNote }}</span>
          </div>
          <div class="inline-controls">
            <div class="crossfade-group">
              <span>交叉淡入淡出 (秒)</span>
              <input
                class="number-input"
                type="number"
                min="0"
                max="12"
                step="0.5"
                :value="audioProcessing.crossfadeSeconds"
                @input="setCrossfadeSeconds"
              />
            </div>
            <span
              class="toggle-switch"
              :class="{ active: audioProcessing.gapless, inactive: !audioProcessing.gapless }"
              role="switch"
              :aria-checked="audioProcessing.gapless"
              @click="toggleGaplessPlayback"
            ></span>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>启动时恢复播放</strong>
            <span
              >默认关闭。开启后下次启动会恢复队列与曲目（可选进度）；不会自动开始播放，需手动点播放。</span
            >
          </div>
          <select
            class="preview-select"
            :value="settings.playbackResumeMode"
            @change="setPlaybackResumeModeFromSelect"
          >
            <option
              v-for="option in playbackResumeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>上一首按钮行为</strong>
            <span
              >播放超过 3 秒时点击“上一首”，是回到当前歌曲开头，还是直接切到上一首曲目；不超过 3
              秒时总是切歌。</span
            >
          </div>
          <select
            class="preview-select"
            :value="settings.previousButtonAction"
            @change="setPreviousButtonActionFromSelect"
          >
            <option
              v-for="option in previousButtonActionOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <hr />
        <div class="setting-item compact-row">
          <div class="setting-copy">
            <strong>睡眠定时器</strong>
            <span>播放器可按默认时长停止，或等待当前曲目、队列结束。</span>
          </div>
          <div class="inline-controls">
            <label class="crossfade-group">
              <span>默认分钟</span>
              <input
                class="number-input"
                type="number"
                min="1"
                max="720"
                :value="settings.sleepTimer.defaultMinutes"
                @input="setSleepTimerDefaultMinutes"
              />
            </label>
            <label class="crossfade-group">
              <span>淡出秒数</span>
              <input
                class="number-input"
                type="number"
                min="0"
                max="120"
                :value="settings.sleepTimer.fadeSeconds"
                @input="setSleepTimerFadeSeconds"
              />
            </label>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>网易云播放音质</strong>
            <span>自动按 Hi-Res、无损、极高和标准依次回退；也可固定为其中一档。</span>
          </div>
          <select
            class="preview-select"
            :value="settings.ncmPlaybackQuality"
            @change="setNcmPlaybackQuality"
          >
            <option
              v-for="option in ncmPlaybackQualityOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div class="accordion-preview" :class="{ open: advancedParamsOpen }">
      <button
        type="button"
        class="accordion-head"
        @click="advancedParamsOpen = !advancedParamsOpen"
      >
        <div>
          <strong>高级引擎参数 (Advanced Engine)</strong>
          <span>缓冲、声道路由、DSD 输出和 SACD program。</span>
        </div>
        <i class="pi pi-chevron-down" :class="{ rotated: advancedParamsOpen }"></i>
      </button>
      <div v-if="advancedParamsOpen" class="accordion-body">
        <div class="engine-warning">
          <i class="pi pi-exclamation-triangle"></i>
          <span>警告：以下参数直接与声卡底层交互，调节不当可能导致音频卡顿、无声或爆音。</span>
        </div>
        <div class="advanced-grid">
          <label>
            <span>Buffer Size</span>
            <select
              class="preview-select"
              :value="audioOutputConfig.preferredBufferSize"
              :disabled="audioOutputConfigApplyStatus.state === 'pending'"
              @change="setPreferredBufferSize"
            >
              <option v-for="option in bufferSizeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            <span>Routing</span>
            <select
              class="preview-select"
              :value="audioOutputConfig.routingMode"
              @change="setRoutingMode"
            >
              <option
                v-for="option in routingModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            <span>DSD Output</span>
            <select
              class="preview-select"
              :value="audioProcessing.dsdOutputMode"
              @change="setDsdOutputMode"
            >
              <option
                v-for="option in dsdOutputModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            <span>PCM → DSD</span>
            <select
              class="preview-select"
              :value="audioOutputConfig.pcmToDsdMode ?? 'off'"
              :disabled="audioOutputConfigApplyStatus.state === 'pending'"
              @change="setPcmToDsdMode"
            >
              <option
                v-for="option in pcmToDsdModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
        <p class="setting-hint">
          PCM → DSD 在解码/DSP 之后将 PCM 调制为 DSD，经 Native DSD 或 DoP 输出；源文件已是 DSD
          时不受影响。
        </p>
        <div v-if="isUpmixActive" class="advanced-grid">
          <label>
            <span>Center Gain</span>
            <input
              class="number-input"
              type="number"
              step="0.1"
              :value="audioOutputConfig.upmixCenterGain ?? 0"
              @input="(e) => setUpmixParam('upmixCenterGain', e)"
            />
          </label>
          <label>
            <span>LFE Gain</span>
            <input
              class="number-input"
              type="number"
              step="0.1"
              :value="audioOutputConfig.upmixLfeGain ?? 0"
              @input="(e) => setUpmixParam('upmixLfeGain', e)"
            />
          </label>
          <label>
            <span>LFE Lowpass (Hz)</span>
            <input
              class="number-input"
              type="number"
              step="1"
              :value="audioOutputConfig.upmixLfeLowpassHz ?? 80"
              @input="(e) => setUpmixParam('upmixLfeLowpassHz', e)"
            />
          </label>
          <label>
            <span>Surround Gain</span>
            <input
              class="number-input"
              type="number"
              step="0.1"
              :value="audioOutputConfig.upmixSurroundGain ?? 0"
              @input="(e) => setUpmixParam('upmixSurroundGain', e)"
            />
          </label>
          <label>
            <span>Side Gain</span>
            <input
              class="number-input"
              type="number"
              step="0.1"
              :value="audioOutputConfig.upmixSideGain ?? 0"
              @input="(e) => setUpmixParam('upmixSideGain', e)"
            />
          </label>
          <label>
            <span>Surround Delay (ms)</span>
            <input
              class="number-input"
              type="number"
              step="0.1"
              :value="audioOutputConfig.upmixSurroundDelayMs ?? 0"
              @input="(e) => setUpmixParam('upmixSurroundDelayMs', e)"
            />
          </label>
        </div>
        <div v-if="showWasapiPushMode" class="setting-item wasapi-push-row">
          <div class="setting-copy">
            <strong>WASAPI 独占推送模式</strong>
            <span>事件驱动不兼容时切换到定时器驱动，可解决部分声卡无声/爆音。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: !!audioOutputConfig.wasapiExclusivePushMode,
              inactive: !audioOutputConfig.wasapiExclusivePushMode
            }"
            role="switch"
            :aria-checked="!!audioOutputConfig.wasapiExclusivePushMode"
            :aria-disabled="audioOutputConfigApplyStatus.state === 'pending'"
            @click="toggleWasapiExclusivePushMode"
          ></span>
        </div>
      </div>
    </div>
  </section>
</template>
