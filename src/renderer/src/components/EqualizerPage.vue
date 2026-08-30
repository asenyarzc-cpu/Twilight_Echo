<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useBackHandler } from '../app/useBackStack.ts'
import { useAudioOutputDspStore } from '../stores/useAudioOutputDspStore'
import { usePlayerStore } from '../stores/usePlayerStore'
import ParametricEqWorkspace from './equalizer/ParametricEqWorkspace.vue'
import OpraEqPanel from './equalizer/OpraEqPanel.vue'
import FrequencyResponseChart from './equalizer/FrequencyResponseChart.vue'
import FrequencyResponseToolbar from './equalizer/FrequencyResponseToolbar.vue'
import GraphicEqPanel from './equalizer/GraphicEqPanel.vue'
import {
  EQ_RESPONSE_DEFAULT_SAMPLE_RATE,
  computeAutoPreampDb,
  computeBandResponse,
  computeCompositeResponse,
  computeEstimatedSourceDeviation,
  isBandActive
} from '@renderer/utils/eqResponse'
import {
  GRAPH_MAX_FREQUENCY,
  GRAPH_MIN_FREQUENCY,
  builtInEqPresets,
  clampNumber,
  cloneBands,
  defaultEqBands,
  filterTypes,
  gainToY,
  normalizeAudioProcessing,
  patchBand,
  responseToPath,
  tabs
} from '../utils/equalizerPageLogic'
import { computeFrequencyResponseComparison } from '../../../shared/frequencyResponse.ts'
import type { ImportedFrequencyResponse } from '../../../shared/frequencyResponse.ts'
import { createParametricBand, spectrumToPath } from '@renderer/utils/parametricEqInteraction'
import type {
  AppSettings,
  AudioEqPreset,
  AudioProcessingSettings,
  EqualizerBand,
  EqualizerFilterType,
  EqMode,
  HeadphoneCompensationSettings
} from '../types/settings'
import type { DspSceneState } from '../../../shared/dspGraph.ts'

type EqualizerTab = EqMode
type ResponseView = 'dsp' | 'headphone'
type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'
type EqApplyFeedback = 'idle' | 'editing' | 'applying' | 'applied' | 'failed'
type OpraProfile = Awaited<ReturnType<typeof window.api.opra.search>>[number]
type OpraCatalogStatus = Awaited<ReturnType<typeof window.api.opra.getStatus>>

const audioOutputDspStore = useAudioOutputDspStore()
const playerStore = usePlayerStore()
const { audioProcessing, outputInfo, audioEngineReady } = storeToRefs(audioOutputDspStore)
const { visualizationData, isPlaying } = playerStore
const { setAudioProcessing } = audioOutputDspStore

const autoPreampStorageKey = 'twilight-echo:eq-auto-preamp:v1'

const activeTab = ref<EqualizerTab>('graphic')
const autoPreampEnabled = ref(false)
const appSettings = ref<AppSettings | null>(null)
const presetName = ref('')
const saving = ref(false)
const presetMenuOpen = ref(false)
const filterMenuOpen = ref(false)
const selectedBandIndex = ref(0)
const eqApplyFeedback = ref<EqApplyFeedback>('idle')
const eqApplyError = ref('')
const spectrumVisible = ref(true)
const spectrumPath = ref('')
const opraQuery = ref('')
const opraResults = ref<OpraProfile[]>([])
const opraStatus = ref<OpraCatalogStatus | null>(null)
const opraSearching = ref(false)
const opraRefreshing = ref(false)
const opraApplyingEqId = ref('')
const opraError = ref('')
let pendingBandFrame = 0
let pendingBandIndex = -1
let pendingBandPatch: Partial<EqualizerBand> | null = null
let pendingPreamp: number | null = null
let commitChain: Promise<void> = Promise.resolve()
let applyFeedbackTimer: number | null = null
let spectrumAnimationFrame = 0
const SPECTRUM_ATTACK = 0.42
const SPECTRUM_RELEASE = 0.18
let smoothedSpectrum: number[] = []

const userPresets = computed(() => appSettings.value?.audioEqPresets ?? [])
const headphoneCompensation = computed<HeadphoneCompensationSettings>(
  () =>
    appSettings.value?.headphoneCompensation ?? {
      enabled: false,
      productId: '',
      productName: '',
      vendorName: '',
      eqId: '',
      author: '',
      details: '',
      link: '',
      preampDb: 0,
      bands: []
    }
)
const opraCompensationEnabled = computed(
  () => headphoneCompensation.value.enabled && headphoneCompensation.value.bands.length > 0
)

// The engine stacks OPRA compensation on top of the manual EQ (see
// buildEffectiveAudioProcessingSettings). Mirror that here so the plotted
// curve keeps reflecting OPRA even after the manual EQ is reset.
const displayEqMode = computed<EqMode>(() =>
  opraCompensationEnabled.value ? 'parametric' : audioProcessing.value.eqMode
)
const displayEqPreamp = computed(() =>
  opraCompensationEnabled.value
    ? audioProcessing.value.eqPreamp + headphoneCompensation.value.preampDb
    : audioProcessing.value.eqPreamp
)
const displayEqBands = computed(() =>
  opraCompensationEnabled.value
    ? [
        ...cloneBands(headphoneCompensation.value.bands),
        ...cloneBands(audioProcessing.value.eqBands)
      ]
    : audioProcessing.value.eqBands
)
const selectedBand = computed(
  () => audioProcessing.value.eqBands[selectedBandIndex.value] ?? audioProcessing.value.eqBands[0]
)
const eqApplyStatusText = computed(() => {
  if (eqApplyFeedback.value === 'editing') return '正在编辑'
  if (eqApplyFeedback.value === 'applying') return '正在同步 DSP'
  if (eqApplyFeedback.value === 'applied') return 'DSP 已同步'
  if (eqApplyFeedback.value === 'failed') return 'DSP 同步失败'
  if (!audioProcessing.value.eqEnabled) return '均衡器已旁路'
  return audioEngineReady.value ? 'DSP 就绪' : '音频引擎未就绪'
})

const responseView = ref<ResponseView>('dsp')
const importedFrequencyResponse = ref<ImportedFrequencyResponse | null>(null)
const frequencyResponseImporting = ref(false)
const frequencyResponseError = ref('')
const showManualResponse = ref(true)
const showOpraResponse = ref(true)
const showOpraEstimatedDeviation = ref(true)
const showMeasuredSource = ref(true)
const showTargetResponse = ref(true)
const showIndividualFilters = ref(true)
const showCombinedFilter = ref(true)
const showCorrectedResponse = ref(true)

// Display reference rate: use the actual device output rate when known so the
// plotted curve matches the coefficients the engine builds for that rate.
const responseSampleRate = computed(() => {
  const info = outputInfo.value
  const rate = info?.actualSampleRate || info?.outputSampleRate || 0
  return rate > 0 ? rate : EQ_RESPONSE_DEFAULT_SAMPLE_RATE
})

const responseOptions = computed(() => ({
  sampleRate: responseSampleRate.value,
  pointCount: 257,
  minFrequency: GRAPH_MIN_FREQUENCY,
  maxFrequency: GRAPH_MAX_FREQUENCY
}))

// Exact RBJ biquad responses (same math as ParametricEqProcessor.cpp). Keep
// each processing contribution separate while retaining the effective total.
const manualResponsePath = computed(() =>
  responseToPath(
    computeCompositeResponse(audioProcessing.value.eqBands, audioProcessing.value.eqPreamp, {
      ...responseOptions.value,
      mode: audioProcessing.value.eqMode
    })
  )
)
const opraResponsePath = computed(() =>
  opraCompensationEnabled.value
    ? responseToPath(
        computeCompositeResponse(
          headphoneCompensation.value.bands,
          headphoneCompensation.value.preampDb,
          { ...responseOptions.value, mode: 'parametric' }
        )
      )
    : ''
)
const opraEstimatedDeviationPath = computed(() =>
  opraCompensationEnabled.value
    ? responseToPath(
        computeEstimatedSourceDeviation(headphoneCompensation.value.bands, responseOptions.value)
      )
    : ''
)
const effectiveDspResponse = computed(() =>
  computeCompositeResponse(displayEqBands.value, displayEqPreamp.value, {
    ...responseOptions.value,
    mode: displayEqMode.value
  })
)
const responsePath = computed(() => responseToPath(effectiveDspResponse.value))
const acousticDspResponse = computed(() =>
  computeCompositeResponse(displayEqBands.value, 0, {
    ...responseOptions.value,
    mode: displayEqMode.value
  })
)
// The imported source and target remain absolute curves. The filter response is
// an acoustic estimate only: digital preamp is excluded before adding H(f) to M(f).
const frequencyResponseComparison = computed(() => {
  const imported = importedFrequencyResponse.value
  if (!imported) return null
  return computeFrequencyResponseComparison(
    imported,
    acousticDspResponse.value,
    acousticDspResponse.value.map((point) => point.frequency)
  )
})
const measuredSourcePath = computed(() =>
  frequencyResponseComparison.value ? responseToPath(frequencyResponseComparison.value.source) : ''
)
const targetResponsePath = computed(() =>
  frequencyResponseComparison.value ? responseToPath(frequencyResponseComparison.value.target) : ''
)
const combinedFilterPath = computed(() =>
  frequencyResponseComparison.value
    ? responseToPath(frequencyResponseComparison.value.combinedFilter)
    : ''
)
const correctedAcousticPath = computed(() =>
  frequencyResponseComparison.value
    ? responseToPath(frequencyResponseComparison.value.corrected)
    : ''
)
const responseFillPath = computed(() => {
  if (!responsePath.value) return ''
  const zero = gainToY(0).toFixed(2)
  return `${responsePath.value} L100,${zero} L0,${zero} Z`
})
const parametricResponseFillPath = computed(() => {
  if (!responsePath.value) return ''
  return `${responsePath.value} L100,100 L0,100 Z`
})

// Preserve the source band index so interactive control points, colors, and
// curves stay aligned even when inactive bands are omitted from processing.
function computeBandResponsePaths(
  bands: readonly EqualizerBand[],
  mode: EqMode
): { index: number; path: string }[] {
  const sampleRate = responseSampleRate.value
  const paths: { index: number; path: string }[] = []
  bands.forEach((band, index) => {
    if (!isBandActive(band, mode)) return
    paths.push({
      index,
      path: responseToPath(
        computeBandResponse(band, {
          sampleRate,
          mode,
          pointCount: 97,
          minFrequency: GRAPH_MIN_FREQUENCY,
          maxFrequency: GRAPH_MAX_FREQUENCY
        })
      )
    })
  })
  return paths
}

const bandResponsePaths = computed(() =>
  computeBandResponsePaths(audioProcessing.value.eqBands, audioProcessing.value.eqMode)
)
const headphoneBandResponsePaths = computed(() =>
  computeBandResponsePaths(displayEqBands.value, displayEqMode.value)
)

// Auto gain compensation target: offset the highest boost of the band-only
// response by a 0.5 dB safety margin, clamped to the preamp slider range.
const autoPreampTargetDb = computed(() =>
  computeAutoPreampDb(audioProcessing.value.eqBands, {
    sampleRate: responseSampleRate.value,
    mode: audioProcessing.value.eqMode,
    minFrequency: GRAPH_MIN_FREQUENCY,
    maxFrequency: GRAPH_MAX_FREQUENCY,
    marginDb: 0.5,
    minPreampDb: -24,
    maxPreampDb: 24
  })
)

function loadAutoPreampPreference(): void {
  try {
    autoPreampEnabled.value = globalThis.localStorage?.getItem(autoPreampStorageKey) === '1'
  } catch {
    // A blocked localStorage must not break the equalizer page.
  }
}

function saveAutoPreampPreference(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(autoPreampStorageKey, enabled ? '1' : '0')
  } catch {
    // Persisting the toggle is best-effort only.
  }
}

function toggleAutoPreamp(): void {
  autoPreampEnabled.value = !autoPreampEnabled.value
  saveAutoPreampPreference(autoPreampEnabled.value)
  if (autoPreampEnabled.value) void applyAutoPreamp()
}

async function applyAutoPreamp(): Promise<void> {
  const target = autoPreampTargetDb.value
  if (Math.abs(audioProcessing.value.eqPreamp - target) < 0.05) return
  await updateAudioProcessing({ eqPreamp: target })
}

async function loadAppSettings(): Promise<void> {
  try {
    const settings = await window.api.settings.get()
    appSettings.value = {
      ...settings,
      audioProcessing: normalizeAudioProcessing(settings.audioProcessing),
      audioEqPresets: settings.audioEqPresets.map((preset) => ({
        ...preset,
        eqBands: normalizeAudioProcessing({ eqBands: preset.eqBands }).eqBands
      }))
    }
    appSettings.value.headphoneCompensation = {
      ...settings.headphoneCompensation,
      bands: cloneBands(settings.headphoneCompensation?.bands ?? [])
    }
    audioOutputDspStore.applyAudioProcessingState(appSettings.value.audioProcessing)
    const dspState = await window.api.audioEngine.getDspSceneState()
    applyActiveSceneEqToEditor(dspState)
    if (audioProcessing.value.eqMode === 'parametric') {
      activeTab.value = 'parametric'
    }
  } catch (err) {
    console.error('读取均衡器设置失败：', err)
  }
}

function applyActiveSceneEqToEditor(dspState: DspSceneState): void {
  // The scene EQ node holds the effective (OPRA-stacked) bands; never fold
  // those into the manual editor state or the next manual edit would persist
  // OPRA bands as user EQ and the engine would apply them twice.
  if (opraCompensationEnabled.value) return
  const scene = dspState.scenes.find((item) => item.id === dspState.activeSceneId)
  const node = scene?.graph.nodes.find((item) => item.type === 'equalizer')
  if (!node) return
  const params = node.params
  const settings = normalizeAudioProcessing({
    ...audioProcessing.value,
    dspEnabled: true,
    eqEnabled: node.enabled,
    eqMode: params.mode === 'parametric' ? 'parametric' : 'graphic',
    eqPreamp: typeof params.preampDb === 'number' ? params.preampDb : 0,
    eqBands: Array.isArray(params.bands) ? (params.bands as EqualizerBand[]) : []
  })
  audioOutputDspStore.applyAudioProcessingState(settings)
  if (appSettings.value) appSettings.value.audioProcessing = settings
}

async function syncActiveSceneEq(nextSettings: AudioProcessingSettings): Promise<void> {
  const dspState = await window.api.audioEngine.getDspSceneState()
  const scene = dspState.scenes.find((item) => item.id === dspState.activeSceneId)
  const node = scene?.graph.nodes.find((item) => item.type === 'equalizer')
  if (!node) return
  // OPRA contributes to the equalizer node but must not override the user's EQ
  // bypass. Preserve its parameters while disabled so re-enabling EQ restores
  // the same stacked response without continuing to process audio in bypass.
  node.enabled = nextSettings.dspEnabled && nextSettings.eqEnabled
  node.params = {
    ...node.params,
    mode: opraCompensationEnabled.value ? 'parametric' : nextSettings.eqMode,
    preampDb: opraCompensationEnabled.value
      ? nextSettings.eqPreamp + headphoneCompensation.value.preampDb
      : nextSettings.eqPreamp,
    bands: opraCompensationEnabled.value
      ? [...cloneBands(headphoneCompensation.value.bands), ...cloneBands(nextSettings.eqBands)]
      : nextSettings.eqBands
  }
  await window.api.audioEngine.setDspScenes(dspState.scenes, dspState.pinnedSceneId)
}

async function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): Promise<void> {
  const eqTouched =
    patch.eqEnabled === true ||
    patch.eqMode !== undefined ||
    patch.eqPreamp !== undefined ||
    patch.eqBands !== undefined
  const nextSettings = normalizeAudioProcessing({
    ...audioProcessing.value,
    ...patch,
    dspEnabled: patch.dspEnabled ?? (audioProcessing.value.dspEnabled || eqTouched),
    eqEnabled: patch.eqEnabled ?? true
  })
  // Auto gain compensation follows band/mode edits in the same engine update
  // so the compensated preamp reaches the DSP scene without a second apply.
  if (autoPreampEnabled.value && patch.eqPreamp === undefined) {
    nextSettings.eqPreamp = computeAutoPreampDb(nextSettings.eqBands, {
      sampleRate: responseSampleRate.value,
      mode: nextSettings.eqMode,
      minFrequency: GRAPH_MIN_FREQUENCY,
      maxFrequency: GRAPH_MAX_FREQUENCY,
      marginDb: 0.5,
      minPreampDb: -24,
      maxPreampDb: 24
    })
  }
  await setAudioProcessing(nextSettings)
  await syncActiveSceneEq(nextSettings)
  if (appSettings.value) {
    appSettings.value = {
      ...appSettings.value,
      audioProcessing: nextSettings
    }
  }
}

async function updateEqBand(index: number, patch: Partial<EqualizerBand>): Promise<void> {
  const bands = patchBand(audioProcessing.value.eqBands, index, patch, audioProcessing.value.eqMode)
  if (!bands[index]) return
  await runEqApply(() => updateAudioProcessing({ eqBands: bands }))
}

function clearApplyFeedbackTimer(): void {
  if (applyFeedbackTimer === null) return
  window.clearTimeout(applyFeedbackTimer)
  applyFeedbackTimer = null
}

async function runEqApply(action: () => Promise<void>): Promise<void> {
  clearApplyFeedbackTimer()
  eqApplyFeedback.value = 'applying'
  eqApplyError.value = ''
  try {
    await action()
    eqApplyFeedback.value = 'applied'
    applyFeedbackTimer = window.setTimeout(() => {
      eqApplyFeedback.value = 'idle'
      applyFeedbackTimer = null
    }, 1400)
  } catch (error) {
    eqApplyFeedback.value = 'failed'
    eqApplyError.value = error instanceof Error ? error.message : String(error)
  }
}

// Apply the staged edit to renderer state only. The engine apply is deferred to
// commit so a gesture issues one round trip instead of one per input event;
// concurrent applies resolve out of order and can strand the UI (and the DSP
// scene) on an earlier value than the one the user dragged to.
function flushStagedEdit(): void {
  if (pendingBandIndex < 0 && pendingPreamp === null) return
  const bands =
    pendingBandIndex >= 0 && pendingBandPatch
      ? patchBand(
          audioProcessing.value.eqBands,
          pendingBandIndex,
          pendingBandPatch,
          audioProcessing.value.eqMode
        )
      : audioProcessing.value.eqBands
  const preamp = pendingPreamp ?? audioProcessing.value.eqPreamp
  pendingBandIndex = -1
  pendingBandPatch = null
  pendingPreamp = null
  audioOutputDspStore.applyAudioProcessingState({
    ...audioProcessing.value,
    eqPreamp: preamp,
    eqBands: bands,
    eqEnabled: true,
    dspEnabled: true
  })
  if (appSettings.value) {
    appSettings.value = { ...appSettings.value, audioProcessing: audioProcessing.value }
  }
}

function scheduleStagedFlush(): void {
  eqApplyFeedback.value = 'editing'
  if (pendingBandFrame !== 0) return
  pendingBandFrame = window.requestAnimationFrame(() => {
    pendingBandFrame = 0
    flushStagedEdit()
  })
}

function stageBandPatch(index: number, patch: Partial<EqualizerBand>): void {
  if (!audioProcessing.value.eqBands[index]) return
  // Staging a different band must not retarget the patch already queued for the
  // previous one; land it first, then start the new one.
  if (pendingBandIndex >= 0 && pendingBandIndex !== index) {
    if (pendingBandFrame !== 0) {
      window.cancelAnimationFrame(pendingBandFrame)
      pendingBandFrame = 0
    }
    flushStagedEdit()
  }
  pendingBandIndex = index
  pendingBandPatch = { ...(pendingBandPatch ?? {}), ...patch }
  scheduleStagedFlush()
}

function stagePreamp(value: number): void {
  pendingPreamp = clampNumber(value, -24, 24, audioProcessing.value.eqPreamp)
  scheduleStagedFlush()
}

async function commitStagedBands(): Promise<void> {
  if (pendingBandFrame !== 0) {
    window.cancelAnimationFrame(pendingBandFrame)
    pendingBandFrame = 0
  }
  flushStagedEdit()
  // Snapshot the staged bands now, before any in-flight commit's response can
  // overwrite the shared state. Reading them inside the chained thunk would pick
  // up the earlier engine response and silently drop this gesture's edit.
  // Do not pass eqPreamp: updateAudioProcessing recomputes it for auto gain
  // compensation only when the patch omits it, and the staged value is already
  // spread in from audioProcessing.value.
  const bands = cloneBands(audioProcessing.value.eqBands)
  // Serialize commits. setAudioProcessing assigns the engine response straight
  // onto the shared state, so a slow earlier response landing after a faster
  // later one would overwrite the newer edit in both the UI and the DSP scene.
  commitChain = commitChain
    .then(async () => {
      await runEqApply(() => updateAudioProcessing({ eqBands: bands }))
    })
    // Never leave the chain rejected: a settled failure would make every later
    // slider release reject without ever reaching the engine.
    .catch((error) => {
      eqApplyFeedback.value = 'failed'
      eqApplyError.value = error instanceof Error ? error.message : String(error)
    })
  await commitChain
}

async function addBand(frequency: number, gain: number): Promise<void> {
  const bands = [
    ...cloneBands(audioProcessing.value.eqBands),
    createParametricBand(frequency, gain)
  ]
  selectedBandIndex.value = bands.length - 1
  await runEqApply(() => updateAudioProcessing({ eqMode: 'parametric', eqBands: bands }))
}

async function deleteBand(index = selectedBandIndex.value): Promise<void> {
  const bands = cloneBands(audioProcessing.value.eqBands)
  if (!bands[index]) return
  bands.splice(index, 1)
  selectedBandIndex.value = Math.max(0, Math.min(index, bands.length - 1))
  await runEqApply(() => updateAudioProcessing({ eqBands: bands }))
}

async function toggleBandEnabled(index = selectedBandIndex.value): Promise<void> {
  const band = audioProcessing.value.eqBands[index]
  if (!band) return
  await updateEqBand(index, { enabled: band.enabled === false })
}

function onEqualizerKeydown(event: KeyboardEvent): void {
  if (activeTab.value !== 'parametric') return
  const target = event.target as HTMLElement | null
  if (target?.matches('input, select, textarea, [contenteditable="true"]')) return
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedBand.value) {
    event.preventDefault()
    void deleteBand()
  }
  if (event.key.toLowerCase() === 'b' && selectedBand.value) {
    event.preventDefault()
    void toggleBandEnabled()
  }
}

function updateSpectrumPath(): void {
  spectrumAnimationFrame = 0
  const data = visualizationData.value
  if (!spectrumVisible.value || !data.active || data.spectrum.length < 2) {
    spectrumPath.value = ''
    smoothedSpectrum = []
    return
  }
  if (smoothedSpectrum.length !== data.spectrum.length) {
    smoothedSpectrum = Array.from(data.spectrum, (value) => clampNumber(value, 0, 1, 0))
  } else {
    data.spectrum.forEach((value, index) => {
      const target = clampNumber(value, 0, 1, 0)
      const speed = target > smoothedSpectrum[index] ? SPECTRUM_ATTACK : SPECTRUM_RELEASE
      smoothedSpectrum[index] += (target - smoothedSpectrum[index]) * speed
    })
  }
  spectrumPath.value = spectrumToPath(smoothedSpectrum, data.sampleRate || responseSampleRate.value)
}

function scheduleSpectrumPathUpdate(): void {
  if (spectrumAnimationFrame !== 0) return
  spectrumAnimationFrame = window.requestAnimationFrame(updateSpectrumPath)
}

async function importFrequencyResponse(): Promise<void> {
  if (frequencyResponseImporting.value) return
  frequencyResponseImporting.value = true
  frequencyResponseError.value = ''
  try {
    const imported = await window.api.audioEngine.importFrequencyResponse()
    if (!imported) return
    importedFrequencyResponse.value = imported
    responseView.value = 'headphone'
  } catch (err) {
    frequencyResponseError.value = err instanceof Error ? err.message : String(err)
  } finally {
    frequencyResponseImporting.value = false
  }
}

function clearFrequencyResponse(): void {
  importedFrequencyResponse.value = null
  frequencyResponseError.value = ''
  responseView.value = 'dsp'
}

function toggleHeadphoneCurve(curve: HeadphoneCurveKey): void {
  const visibility = {
    source: showMeasuredSource,
    target: showTargetResponse,
    individual: showIndividualFilters,
    combined: showCombinedFilter,
    corrected: showCorrectedResponse
  }
  visibility[curve].value = !visibility[curve].value
}

async function loadOpraStatus(): Promise<void> {
  try {
    opraStatus.value = await window.api.opra.getStatus()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  }
}

async function searchOpraProfiles(query: string): Promise<void> {
  const trimmed = query.trim()
  if (!trimmed) {
    opraResults.value = []
    return
  }
  opraSearching.value = true
  opraError.value = ''
  try {
    opraResults.value = await window.api.opra.search(trimmed)
    opraStatus.value = await window.api.opra.getStatus()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraSearching.value = false
  }
}

async function refreshOpraCatalog(): Promise<void> {
  opraRefreshing.value = true
  opraError.value = ''
  try {
    opraStatus.value = await window.api.opra.refresh()
    await searchOpraProfiles(opraQuery.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraRefreshing.value = false
  }
}

async function applyOpraProfile(profile: OpraProfile): Promise<void> {
  if (!profile.applicable || opraApplyingEqId.value) return
  opraApplyingEqId.value = profile.eqId
  opraError.value = ''
  try {
    const fullProfile = (await window.api.opra.getProfile(profile.eqId)) ?? profile
    if (!fullProfile.applicable) {
      opraError.value = `该 profile 包含暂不支持的滤波器：${fullProfile.unsupportedBandTypes.join(', ')}`
      return
    }
    const savedSettings = await window.api.settings.update({
      headphoneCompensation: {
        enabled: true,
        productId: fullProfile.productId,
        productName: fullProfile.productName,
        vendorName: fullProfile.vendorName,
        eqId: fullProfile.eqId,
        author: fullProfile.author,
        details: fullProfile.details,
        link: fullProfile.link,
        preampDb: fullProfile.preampDb,
        bands: cloneBands(fullProfile.bands)
      }
    })
    appSettings.value = { ...appSettings.value, ...savedSettings }
    await syncActiveSceneEq(audioProcessing.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraApplyingEqId.value = ''
  }
}

async function disableOpraCompensation(): Promise<void> {
  if (!appSettings.value) return
  try {
    const savedSettings = await window.api.settings.update({
      headphoneCompensation: {
        ...headphoneCompensation.value,
        enabled: false
      }
    })
    // Explicitly construct a new object to guarantee Vue reactivity triggers
    appSettings.value = {
      ...appSettings.value,
      ...savedSettings,
      headphoneCompensation: {
        ...headphoneCompensation.value,
        enabled: false
      }
    }
    await syncActiveSceneEq(audioProcessing.value)
  } catch (err) {
    console.error('停用 OPRA 补偿失败：', err)
    // Fallback: at least update local state so the UI reflects the change
    appSettings.value = {
      ...appSettings.value,
      headphoneCompensation: {
        ...headphoneCompensation.value,
        enabled: false
      }
    }
  }
}

async function applyEqPreset(preset: AudioEqPreset): Promise<void> {
  activeTab.value = preset.eqMode
  await updateAudioProcessing({
    eqMode: preset.eqMode,
    eqPreamp: preset.eqPreamp,
    eqBands: cloneBands(preset.eqBands)
  })
  presetMenuOpen.value = false
}

async function saveEqPreset(): Promise<void> {
  const name =
    presetName.value.trim() ||
    `自定义 ${new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    })}`
  if (!name || !appSettings.value || saving.value) return
  saving.value = true
  try {
    const nextPreset: AudioEqPreset = {
      id: `custom-${Date.now()}`,
      name,
      eqMode: audioProcessing.value.eqMode,
      eqPreamp: audioProcessing.value.eqPreamp,
      eqBands: cloneBands(audioProcessing.value.eqBands)
    }
    appSettings.value = await window.api.settings.update({
      audioEqPresets: [...userPresets.value, nextPreset]
    })
    presetName.value = ''
    presetMenuOpen.value = true
  } catch (err) {
    console.error('保存均衡器预设失败：', err)
  } finally {
    saving.value = false
  }
}

function saveAsCurrentPreset(): void {
  void saveEqPreset()
}

function switchTab(tab: EqualizerTab): void {
  activeTab.value = tab
  presetMenuOpen.value = false
  filterMenuOpen.value = false
  if (tab === 'graphic' || tab === 'parametric') {
    void updateAudioProcessing({ eqMode: tab })
  }
}

// 参数均衡是页面内部的一层：标题栏返回键先退回图形标签，再退出均衡器页
// （页面层由 App.vue 按页面旗标注冊）。
useBackHandler(
  computed(() => activeTab.value === 'parametric'),
  () => switchTab('graphic'),
  '返回图形'
)

function openAdvancedSettings(index = selectedBandIndex.value): void {
  selectedBandIndex.value = Math.min(Math.max(index, 0), audioProcessing.value.eqBands.length - 1)
  activeTab.value = 'parametric'
  presetMenuOpen.value = false
  filterMenuOpen.value = false
  void updateAudioProcessing({ eqMode: 'parametric' })
}

async function resetEqualizer(): Promise<void> {
  await updateAudioProcessing({
    eqEnabled: false,
    eqMode: activeTab.value === 'parametric' ? 'parametric' : 'graphic',
    eqPreamp: 0,
    eqBands: cloneBands(defaultEqBands)
  })
}

function togglePresetMenu(): void {
  presetMenuOpen.value = !presetMenuOpen.value
  if (presetMenuOpen.value) filterMenuOpen.value = false
}

async function selectFilterType(filterType: EqualizerFilterType): Promise<void> {
  filterMenuOpen.value = false
  await updateEqBand(selectedBandIndex.value, { filterType })
}

function selectFilterForBand(index: number, filterType: EqualizerFilterType): void {
  selectedBandIndex.value = index
  void selectFilterType(filterType)
}

function selectBand(index: number): void {
  selectedBandIndex.value = index
  filterMenuOpen.value = false
}

onMounted(() => {
  loadAutoPreampPreference()
  void loadAppSettings()
  void loadOpraStatus()
})

onBeforeUnmount(() => {
  clearApplyFeedbackTimer()
  if (pendingBandFrame !== 0) window.cancelAnimationFrame(pendingBandFrame)
  if (spectrumAnimationFrame !== 0) window.cancelAnimationFrame(spectrumAnimationFrame)
})

// Keep the compensated preamp in sync when bands change through paths that
// bypass updateAudioProcessing (preset apply on load, external scene edits).
watch(autoPreampTargetDb, () => {
  if (!autoPreampEnabled.value) return
  void applyAutoPreamp()
})

watch(
  () => visualizationData.value,
  () => scheduleSpectrumPathUpdate(),
  { deep: false }
)

watch([spectrumVisible, responseView, isPlaying], () => scheduleSpectrumPathUpdate())
</script>

<template>
  <div class="eq-page" @keydown="onEqualizerKeydown">
    <div class="eq-container">
      <aside class="eq-sidebar">
        <div
          v-for="tab in tabs"
          :key="tab.key"
          class="nav-item"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-pressed="activeTab === tab.key"
          :class="{ active: activeTab === tab.key }"
          @click="switchTab(tab.key)"
          @keydown.enter.prevent="switchTab(tab.key)"
          @keydown.space.prevent="switchTab(tab.key)"
        >
          <i :class="tab.icon"></i>
          <div class="nav-info">
            <span>{{ tab.label }}</span
            ><small>{{ tab.desc }}</small>
          </div>
        </div>
      </aside>

      <main class="eq-content">
        <!-- Toolbar for Presets across Graphic and Parametric -->
        <div class="eq-toolbar-modern">
          <div class="preset-menu-anchor">
            <button type="button" class="eq-command preset-menu-button" @click="togglePresetMenu">
              选择预设 <i class="pi pi-chevron-down"></i>
            </button>
            <div v-if="presetMenuOpen" class="preset-menu">
              <div class="preset-menu-section">
                <span class="preset-menu-title">内置预设</span>
                <button
                  v-for="preset in builtInEqPresets"
                  :key="preset.id"
                  type="button"
                  class="preset-menu-item"
                  @click="applyEqPreset(preset)"
                >
                  {{ preset.name }}
                </button>
              </div>
              <div class="preset-menu-section">
                <span class="preset-menu-title">自定义预设</span>
                <button
                  v-for="preset in userPresets"
                  :key="preset.id"
                  type="button"
                  class="preset-menu-item"
                  @click="applyEqPreset(preset)"
                >
                  {{ preset.name }}
                </button>
                <span v-if="userPresets.length === 0" class="preset-empty">暂无自定义预设</span>
              </div>
              <div class="preset-create">
                <input v-model="presetName" type="text" placeholder="新建预设名称" />
                <button
                  type="button"
                  :disabled="saving || !presetName.trim()"
                  @click="saveEqPreset"
                >
                  新建
                </button>
              </div>
            </div>
          </div>
          <button
            v-if="activeTab === 'graphic'"
            type="button"
            class="eq-command"
            @click="openAdvancedSettings()"
          >
            高级设置
          </button>
          <button v-else type="button" class="eq-command" @click="switchTab('graphic')">
            返回图形
          </button>
          <button
            type="button"
            class="eq-command auto-preamp-toggle"
            :class="{ active: autoPreampEnabled }"
            :aria-pressed="autoPreampEnabled"
            title="根据当前曲线的最大增益自动下调前置放大，预留 0.5 dB 余量"
            @click="toggleAutoPreamp"
          >
            <i :class="autoPreampEnabled ? 'pi pi-check-circle' : 'pi pi-circle'"></i>
            自动增益补偿
          </button>
          <button type="button" class="eq-command soft" @click="resetEqualizer">重置</button>
          <button type="button" class="eq-command" :disabled="saving" @click="saveAsCurrentPreset">
            另存为
          </button>
        </div>

        <div v-if="activeTab === 'graphic'" class="tab-pane active">
          <header class="eq-header">
            <div class="eq-title">
              <h1>图形均衡器</h1>
              <p>全局频率响应塑形工具，调整此面板将改变最终输出听感。</p>
            </div>
            <div
              class="master-switch"
              data-te-interactive
              role="switch"
              tabindex="0"
              aria-label="启用均衡器"
              :aria-checked="audioProcessing.eqEnabled"
              :class="{ off: !audioProcessing.eqEnabled }"
              @click="updateAudioProcessing({ eqEnabled: !audioProcessing.eqEnabled })"
              @keydown.enter.prevent="
                updateAudioProcessing({ eqEnabled: !audioProcessing.eqEnabled })
              "
              @keydown.space.prevent="
                updateAudioProcessing({ eqEnabled: !audioProcessing.eqEnabled })
              "
            >
              {{ audioProcessing.eqEnabled ? '已启用' : '已关闭' }}
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </div>
          </header>

          <OpraEqPanel
            :compensation="headphoneCompensation"
            :status="opraStatus"
            :searching="opraSearching"
            :refreshing="opraRefreshing"
            :applying-eq-id="opraApplyingEqId"
            :results="opraResults"
            :error="opraError"
            :query="opraQuery"
            @update:query="opraQuery = $event"
            @search="searchOpraProfiles"
            @select="applyOpraProfile"
            @clear="disableOpraCompensation"
            @refresh="refreshOpraCatalog"
          />

          <FrequencyResponseChart
            :bands="audioProcessing.eqBands"
            :response-view="responseView"
            :imported-frequency-response="importedFrequencyResponse"
            :importing="frequencyResponseImporting"
            :error="frequencyResponseError"
            :opra-compensation-enabled="opraCompensationEnabled"
            :manual-response-path="manualResponsePath"
            :opra-response-path="opraResponsePath"
            :opra-estimated-deviation-path="opraEstimatedDeviationPath"
            :response-path="responsePath"
            :response-fill-path="responseFillPath"
            :measured-source-path="measuredSourcePath"
            :target-response-path="targetResponsePath"
            :combined-filter-path="combinedFilterPath"
            :corrected-acoustic-path="correctedAcousticPath"
            :band-response-paths="
              responseView === 'headphone' ? headphoneBandResponsePaths : bandResponsePaths
            "
            :show-manual-response="showManualResponse"
            :show-opra-response="showOpraResponse"
            :show-opra-estimated-deviation="showOpraEstimatedDeviation"
            :show-measured-source="showMeasuredSource"
            :show-target-response="showTargetResponse"
            :show-individual-filters="showIndividualFilters"
            :show-combined-filter="showCombinedFilter"
            :show-corrected-response="showCorrectedResponse"
            @update:response-view="responseView = $event"
            @toggle-manual="showManualResponse = !showManualResponse"
            @toggle-opra="showOpraResponse = !showOpraResponse"
            @toggle-estimated-deviation="showOpraEstimatedDeviation = !showOpraEstimatedDeviation"
            @toggle-headphone-curve="toggleHeadphoneCurve"
            @import="importFrequencyResponse"
            @clear="clearFrequencyResponse"
          />

          <GraphicEqPanel
            :preamp="audioProcessing.eqPreamp"
            :bands="audioProcessing.eqBands"
            :auto-preamp-enabled="autoPreampEnabled"
            @preview-preamp="stagePreamp"
            @preview-band="stageBandPatch"
            @commit="commitStagedBands"
            @advanced="openAdvancedSettings"
          />
        </div>

        <div v-else-if="activeTab === 'parametric'" class="tab-pane active parametric-pane">
          <header class="parametric-page-header">
            <div class="parametric-page-title">
              <div>
                <h1>参数均衡器</h1>
                <p>精确控制中心频率、增益与品质因数，并实时写入当前处理场景。</p>
              </div>
            </div>
            <div class="parametric-context-status" aria-label="参数均衡器工作模式">
              <span class="context-status-dot"></span>
              <span>32 频段 · 实时处理</span>
            </div>
          </header>

          <FrequencyResponseToolbar
            card
            :response-view="responseView"
            :imported-frequency-response="importedFrequencyResponse"
            :importing="frequencyResponseImporting"
            :error="frequencyResponseError"
            @update:response-view="responseView = $event"
            @import="importFrequencyResponse"
            @clear="clearFrequencyResponse"
          />

          <ParametricEqWorkspace
            :bands="audioProcessing.eqBands"
            :selected-index="selectedBandIndex"
            :filter-types="filterTypes"
            :response-view="responseView"
            :response-path="responsePath"
            :response-fill-path="parametricResponseFillPath"
            :spectrum-path="spectrumPath"
            :spectrum-visible="spectrumVisible"
            :measured-source-path="measuredSourcePath"
            :target-response-path="targetResponsePath"
            :combined-filter-path="combinedFilterPath"
            :corrected-acoustic-path="correctedAcousticPath"
            :band-response-paths="
              responseView === 'headphone' ? headphoneBandResponsePaths : bandResponsePaths
            "
            :show-measured-source="showMeasuredSource"
            :show-target-response="showTargetResponse"
            :show-individual-filters="showIndividualFilters"
            :show-combined-filter="showCombinedFilter"
            :show-corrected-response="showCorrectedResponse"
            :eq-enabled="audioProcessing.eqEnabled"
            :meter-peak-db="visualizationData.peakDb"
            :meter-rms-db="visualizationData.rmsDb"
            :status="eqApplyStatusText"
            :status-state="eqApplyFeedback"
            :error="eqApplyError"
            @select="selectBand"
            @add="addBand"
            @preview="stageBandPatch"
            @commit="commitStagedBands"
            @delete="deleteBand"
            @toggle="toggleBandEnabled"
            @filter="selectFilterForBand"
            @toggle-spectrum="spectrumVisible = !spectrumVisible"
            @toggle-headphone-curve="toggleHeadphoneCurve"
          />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.eq-page {
  position: fixed;
  inset: 0;
  /* Above the sidebar (1000) and player bar (1002); below the title bar (9999). */
  z-index: 2000;
  overflow: hidden;
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
}

:global(html[data-theme='dark'] .eq-page) {
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

.eq-toolbar-modern {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 20px 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  margin-bottom: 24px;
}

.eq-command {
  background: var(--te-glass-bg);
  border: 1px solid var(--te-glass-border);
  padding: 8px 16px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--te-neutral-700);
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
  display: flex;
  align-items: center;
  gap: 8px;
}

.eq-command:hover:not(:disabled) {
  background: var(--te-card-bg);
  border-color: var(--te-primary-400);
  color: var(--te-primary-500);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1);
}

.eq-command.soft {
  background: transparent;
  border-color: transparent;
}
.eq-command.soft:hover {
  background: rgba(15, 23, 42, 0.04);
  color: var(--te-neutral-900);
}

.eq-command:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.auto-preamp-toggle.active {
  background: rgba(var(--te-primary-rgb), 0.1);
  border-color: var(--te-primary-400);
  color: var(--te-primary-500);
}

.preset-menu-anchor {
  position: relative;
}

.preset-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  background: var(--te-glass-bg-strong);
  backdrop-filter: blur(20px);
  border: 1px solid var(--te-glass-border);
  border-radius: 16px;
  box-shadow: 0 10px 40px rgba(15, 23, 42, 0.1);
  padding: 12px;
  width: 240px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preset-menu-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset-menu-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--te-neutral-400);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 8px 4px;
}

.preset-menu-item {
  background: transparent;
  border: none;
  padding: 8px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--te-neutral-700);
  border-radius: 8px;
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
}

.preset-menu-item:hover {
  background: var(--te-primary-50);
  color: var(--te-primary-600);
}

.preset-empty {
  font-size: 12px;
  color: var(--te-neutral-400);
  padding: 4px 8px;
}

.preset-create {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.preset-create input {
  flex: 1;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  outline: none;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft);
  width: 100%;
}

.preset-create input:focus {
  background: var(--te-card-bg);
  border-color: var(--te-primary-400);
}

.preset-create button {
  background: var(--te-primary-500);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.preset-create button:hover:not(:disabled) {
  background: var(--te-primary-600);
}
.preset-create button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.eq-container {
  width: 100%;
  height: 100%;
  margin: 0;
  max-width: none;
  background: var(--te-glass-bg);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  border: none;
  border-radius: 0;
  box-shadow: none;
  display: flex;
  overflow: hidden;
}

/* Sidebar Navigation */
.eq-sidebar {
  width: 240px;
  background: var(--te-glass-bg);
  border-right: 1px solid var(--te-glass-border);
  padding: 90px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 16px;
  cursor: pointer;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
  color: var(--te-neutral-500);
}
.nav-item:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.nav-item.active {
  background: var(--te-active-bg);
  color: var(--te-primary-500);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
  border: 1px solid var(--te-card-border);
}
.nav-item i {
  font-size: 1.2rem;
  background: var(--te-subtle-bg);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
}
.nav-item.active i {
  background: rgba(var(--te-primary-rgb), 0.1);
  color: var(--te-primary-500);
}
.nav-info {
  display: flex;
  flex-direction: column;
}
.nav-info span {
  font-weight: 700;
  font-size: 14px;
}
.nav-info small {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.7;
}

/* Content Area */
.eq-content {
  flex: 1;
  padding: 40px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 30px;
}
.tab-pane {
  display: none;
  flex-direction: column;
  gap: 30px;
  animation: fadeIn 0.4s var(--te-ease-soft);
}
.tab-pane.active {
  display: flex;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.eq-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.eq-title h1 {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 6px;
}
.eq-title p {
  color: var(--te-neutral-500);
  font-size: 14px;
  font-weight: 500;
}

.master-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--te-card-bg);
  padding: 8px 16px 8px 20px;
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
  border: 1px solid var(--te-card-border);
  font-weight: 700;
  font-size: 14px;
  color: var(--te-primary-500);
  cursor: pointer;
  transition: color 0.2s;
}
.master-switch.off {
  color: var(--te-neutral-500);
}
.toggle-track {
  width: 44px;
  height: 24px;
  background: linear-gradient(135deg, var(--te-primary-500), #22d3ee);
  border-radius: 999px;
  position: relative;
  transition: background 0.2s;
}
.master-switch.off .toggle-track {
  background: rgba(15, 23, 42, 0.12);
}
.toggle-thumb {
  width: 20px;
  height: 20px;
  background: #fff; /* keep-white: toggle knob */
  border-radius: 50%;
  position: absolute;
  top: 2px;
  right: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  transition:
    right 0.2s,
    left 0.2s;
}
.master-switch.off .toggle-thumb {
  right: auto;
  left: 2px;
}

/* Detailed SVG Chart Area */
.parametric-pane {
  gap: 10px;
}

.parametric-page-header {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 2px;
}

.parametric-page-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 13px;
}

.parametric-eyebrow,
.parametric-toolbar-label,
.parametric-context-status {
  font-size: 9px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.parametric-eyebrow {
  flex: 0 0 auto;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 24%, var(--te-card-border));
  border-radius: 5px;
  color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500) 7%, transparent);
}

.parametric-page-title h1 {
  margin: 0 0 2px;
  font-size: 17px;
  font-weight: 760;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.parametric-page-title p {
  overflow: hidden;
  color: var(--te-neutral-500);
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parametric-context-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--te-neutral-500);
  font-variant-numeric: tabular-nums;
}

.context-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--te-success-500);
  box-shadow: 0 0 8px color-mix(in srgb, var(--te-success-500) 62%, transparent);
}

/* Parametric Specific Styles */
.band-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 20px;
  background: var(--te-glass-bg);
  border-radius: 16px;
  border: 1px solid var(--te-glass-border);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.02);
}
.band-tab {
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg);
  font-size: 13px;
  font-weight: 700;
  color: var(--te-neutral-500);
  cursor: pointer;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
}
.band-tab:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.band-tab.active {
  background: var(--te-active-bg);
  color: var(--te-primary-500);
  border-color: var(--te-active-bg);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15);
}

.parameter-card {
  background: var(--te-glass-bg);
  border-radius: 20px;
  padding: 30px;
  border: 1px solid var(--te-glass-border);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
}
.param-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.param-group label {
  font-size: 12px;
  font-weight: 700;
  color: var(--te-neutral-500);
}
.param-group input,
.param-group select {
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  padding: 12px 16px;
  border-radius: 12px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--te-neutral-900);
  outline: none;
  width: 100%;
}
.param-group input:focus,
.param-group select:focus {
  border-color: var(--te-primary-500);
  box-shadow: 0 0 0 3px rgba(var(--te-primary-rgb), 0.1);
}

.square-card {
  background: var(--te-glass-bg);
  border-radius: 20px;
  padding: 40px;
  border: 1px solid var(--te-glass-border);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
}
.square-card i {
  font-size: 48px;
  color: var(--te-primary-500);
  background: #fff; /* keep-white: icon circle */
  width: 100px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  box-shadow: 0 16px 32px rgba(15, 23, 42, 0.05);
  margin-bottom: 24px;
}
.square-card h2 {
  font-size: 24px;
  font-weight: 800;
  margin-bottom: 12px;
}
.square-card p {
  color: var(--te-neutral-500);
  max-width: 400px;
  line-height: 1.6;
}

@media (max-width: 900px) {
  .parametric-page-title p {
    max-width: 44vw;
  }
}

@media (max-width: 620px) {
  .parametric-pane {
    gap: 8px;
  }

  .parametric-page-header {
    align-items: flex-start;
  }

  .parametric-eyebrow,
  .parametric-context-status,
  .parametric-toolbar-label {
    display: none;
  }

  .parametric-page-title h1 {
    font-size: 15px;
  }

  .parametric-page-title p {
    max-width: none;
    white-space: normal;
  }
}

:global(html[data-te-equalizer-panel] .eq-page .band-selector),
:global(html[data-te-equalizer-panel] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel] .eq-page .square-card) {
  border-color: var(--te-equalizer-panel-border);
  border-radius: var(--te-equalizer-panel-radius);
  background: var(--te-equalizer-panel-bg);
}

:global(html[data-te-equalizer-panel='tinted'] .eq-page .band-selector),
:global(html[data-te-equalizer-panel='tinted'] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel='tinted'] .eq-page .square-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 82%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .eq-page .band-selector),
:global(html[data-te-equalizer-panel='glass'] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel='glass'] .eq-page .square-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

:global(html[data-te-equalizer-button] .eq-page .eq-command),
:global(html[data-te-equalizer-button] .eq-page .band-tab) {
  border-radius: var(--te-equalizer-button-radius);
}

:global(html[data-te-equalizer-button='soft'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='soft'] .eq-page .band-tab) {
  border-color: transparent;
  background: var(--te-equalizer-button-bg);
}

:global(html[data-te-equalizer-button='outline'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='outline'] .eq-page .band-tab) {
  border-color: var(--te-equalizer-panel-border);
  background: transparent;
}

:global(html[data-te-equalizer-button='solid'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='solid'] .eq-page .band-tab) {
  border-color: var(--te-primary-500);
  background: var(--te-primary-500);
  color: var(--te-neutral-50);
}

:global(html[data-te-equalizer-knob] .eq-page .toggle-thumb) {
  width: var(--te-equalizer-knob-size);
  height: var(--te-equalizer-knob-size);
}

:global(html[data-te-equalizer-knob] .eq-page .toggle-thumb::after) {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  background: var(--te-primary-500);
  transform: translate(-50%, -50%);
}

:global(html[data-te-equalizer-knob='line'] .eq-page .toggle-thumb::after) {
  width: 8px;
  height: 2px;
  border-radius: 1px;
}

:global(html[data-te-equalizer-knob='dot'] .eq-page .toggle-thumb::after) {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}

/* The parametric view is a flat instrument surface that follows the page theme. */
.parametric-pane {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.parametric-page-header {
  min-height: 38px;
  padding: 0 2px;
}

.parametric-eyebrow {
  border-color: color-mix(in srgb, var(--te-neutral-900) 14%, transparent);
  border-radius: 4px;
  color: var(--te-neutral-700);
  background: transparent;
}

.parametric-page-title h1 {
  color: var(--te-neutral-900);
}

.parametric-page-title p,
.parametric-context-status {
  color: var(--te-neutral-500);
}

:global(html[data-theme='pureWhite'] .parametric-pane) {
  background: transparent;
}

:global(html[data-theme='pureWhite'] .parametric-page-title h1) {
  color: var(--te-neutral-900);
}
</style>
