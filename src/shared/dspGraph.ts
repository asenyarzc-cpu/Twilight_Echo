import { TRANSPARENT_GAIN_EPSILON_DB, equalizerBandAltersSignal } from './audioProcessingOptions.ts'

export const DSP_GRAPH_VERSION = 2

export type DspChannelLayout = 'mono' | 'stereo' | '5.1' | '7.1'

export type DspNodeType =
  | 'replayGain'
  | 'equalizer'
  | 'dynamicEqualizer'
  | 'convolver'
  | 'crossfeed'
  | 'channelMatrix'
  | 'channelStrip'
  | 'bassManagement'
  | 'gate'
  | 'compressor'
  | 'multibandCompressor'
  | 'stereoField'
  | 'loudnessContour'
  | 'truePeakLimiter'
  | 'nativePlugin'
  | 'vst3Plugin'
  | 'meter'

export type DspResamplerQuality = 'native' | 'high' | 'ultra' | 'soxrHq' | 'soxrVhq'
export type DspDitherMode = 'off' | 'tpdf' | 'highpassTpdf' | 'noiseShaped'

export interface DspOutputStageConfig {
  targetSampleRate: 'device' | number
  resamplerQuality: DspResamplerQuality
  dither: DspDitherMode
  /** Applied only to PCM graphs; it never enables PCM fallback by itself. */
  safetyClamp: boolean
}

export const DEFAULT_DSP_OUTPUT_STAGE: DspOutputStageConfig = {
  targetSampleRate: 'device',
  resamplerQuality: 'native',
  dither: 'off',
  safetyClamp: true
}

export interface Vst3PluginReference {
  catalogId: string
  classId: string
  stateAssetId?: string
}

export interface DspGraphNode {
  id: string
  type: DspNodeType
  enabled: boolean
  params: Record<string, unknown>
  pluginId?: string
  pluginAbiVersion?: 1 | 2
  vst3?: Vst3PluginReference
}

export interface DspGraphConfig {
  version: number
  nodes: DspGraphNode[]
  outputStage: DspOutputStageConfig
}

export interface DspSceneRule {
  deviceIds?: string[]
  backends?: string[]
  channelLayouts?: DspChannelLayout[]
  sourceKinds?: Array<'pcm' | 'dsd'>
  minSampleRate?: number
  maxSampleRate?: number
}

export interface DspScene {
  id: string
  name: string
  enabled: boolean
  priority: number
  rules: DspSceneRule
  graph: DspGraphConfig
  allowDsdPcmFallback?: boolean
}

export const DSP_FACTORY_SCENE_TEMPLATES = [
  { id: 'transparent', name: 'Transparent Playback' },
  { id: 'headphoneCrossfeed', name: 'Headphone Crossfeed' },
  { id: 'headphoneCorrection', name: 'Headphone Correction' },
  { id: 'roomCorrection', name: 'Room Correction' },
  { id: 'speakerCalibration51', name: '5.1 Speaker Calibration' },
  { id: 'speakerCalibration71', name: '7.1 Speaker Calibration' }
] as const

export type DspFactorySceneTemplateId = (typeof DSP_FACTORY_SCENE_TEMPLATES)[number]['id']

export interface DspSceneContext {
  deviceId: string
  backend: string
  channelLayout: DspChannelLayout
  sourceKind: 'pcm' | 'dsd'
  sampleRate: number
}

export interface DspSceneResolution {
  scene: DspScene | null
  graph: DspGraphConfig
  reason: string
  requiresPcmFallback: boolean
  pinned: boolean
}

export interface DspGraphNodeStatus {
  id: string
  type: DspNodeType
  enabled: boolean
  active: boolean
  bypassed: boolean
  bypassReason: string
  latencyFrames: number
  tailFrames: number
  processCalls: number
  lastProcessMs: number
  maxProcessMs: number
  averageProcessMs?: number
  overrunCount?: number
  clipCount?: number
  format?: string
}

export interface DspMeterSnapshot {
  momentaryLufs: number | null
  shortTermLufs: number | null
  integratedLufs: number | null
  loudnessRangeLu: number | null
  truePeakDb: number | null
  correlation: number | null
  clipCount: number
  updatedAt: number
}

export interface DspOutputStageStatus {
  targetSampleRate: number | null
  actualSampleRate: number | null
  resamplerQuality: DspResamplerQuality
  /** Engine actually in effect ('soxr' or 'swr'); absent on older native builds. */
  resamplerEngine?: 'swr' | 'soxr'
  /** True when a soxr tier was requested but the FFmpeg build lacks libsoxr. */
  resamplerFallback?: boolean
  dither: DspDitherMode
  active: boolean
  reason: string
}

export interface DspGraphStatus {
  /** Revision most recently reported by the native graph runtime. */
  revision: number
  /** Latest graph revision requested by the host. Absent on an unwrapped native response. */
  requestedRevision?: number
  /** Latest host revision confirmed by a native status ACK. */
  appliedRevision?: number
  /** Host-side application state; native ABI responses do not need to provide it. */
  applyState?: 'idle' | 'pending' | 'applied' | 'failed'
  /** Service/RPC/compile/revision error associated with the latest request. */
  applyError?: string
  activeSceneId: string | null
  totalLatencyFrames: number
  totalTailFrames: number
  nodes: DspGraphNodeStatus[]
  compileState?: 'ready' | 'compiling' | 'failed' | 'bypassed'
  compileError?: string
  meter?: DspMeterSnapshot
  outputStage?: DspOutputStageStatus
}

export type DspAssetKind = 'impulseResponse' | 'correctionProfile' | 'vst3Preset' | 'vst3State'

export interface DspAsset {
  id: string
  kind: DspAssetKind
  name: string
  fileName: string
  sha256: string
  byteSize: number
  mediaType: string
  createdAt: string
  sourceSampleRate?: number
  sourceChannels?: number
  referenceCount: number
}

export type DspCorrectionFormat = 'equalizerApo' | 'rew' | 'autoeq'

export type DspCorrectionFilterType =
  | 'peak'
  | 'lowShelf'
  | 'highShelf'
  | 'bandPass'
  | 'lowPass'
  | 'highPass'
  | 'allPass'
  | 'notch'

/** A validated parametric EQ profile imported from a text-based correction tool. */
export interface DspCorrectionBand {
  frequency: number
  gain: number
  q: number
  filterType: DspCorrectionFilterType
  enabled: boolean
  channelMask: number
}

export interface DspCorrectionProfile {
  format: DspCorrectionFormat
  preampDb: number
  bands: DspCorrectionBand[]
}

export interface DspCorrectionImportResult {
  asset: DspAsset
  profile: DspCorrectionProfile
}

export interface DspProfile {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  scenes: DspScene[]
  pinnedSceneId: string | null
  assetIds: string[]
}

export type Vst3CatalogStatus = 'available' | 'incompatible' | 'quarantined' | 'failed'

export interface Vst3ParameterDescriptor {
  id: number
  title: string
  unit: string
  defaultNormalizedValue: number
  stepCount: number
  flags: number
}

export interface Vst3ScanDescriptor {
  classId: string
  name: string
  vendor: string
  version: string
  category?: string
  supportedLayouts?: DspChannelLayout[]
  parameters?: Vst3ParameterDescriptor[]
}

export interface Vst3CatalogEntry {
  id: string
  modulePath: string
  moduleFingerprint: string
  classId: string
  name: string
  vendor: string
  version: string
  category: string
  supportedLayouts: DspChannelLayout[]
  parameters: Vst3ParameterDescriptor[]
  status: Vst3CatalogStatus
  error: string | null
  scannedAt: string
  quarantinedAt?: string
}

export interface Vst3HelpersAvailability {
  platformSupported: boolean
  scannerPresent: boolean
  hostPresent: boolean
}

export interface Vst3CatalogState {
  enabled: boolean
  searchPaths: string[]
  entries: Vst3CatalogEntry[]
  helpers?: Vst3HelpersAvailability
}

export interface DspSceneState {
  scenes: DspScene[]
  pinnedSceneId: string | null
  activeSceneId: string | null
  /** Stored scene graph selected for this route. It is never mutated by direct mode. */
  graph: DspGraphConfig
  /** Graph actually acknowledged by the engine after master/module/direct gates. */
  effectiveGraph?: DspGraphConfig
  /** Empty when the selected graph is active; otherwise explains the effective bypass. */
  effectiveBypassReason?: string
  directMode?: boolean
  requiresPcmFallback: boolean
  dsdPcmFallbackApplied: boolean
}

export interface LegacyDspSettings {
  dspEnabled?: boolean
  eqEnabled?: boolean
  eqMode?: string
  eqPreamp?: number
  eqBands?: unknown[]
  volumeNormalization?: string
  replayGainPreamp?: number
  replayGainFallback?: number
  replayGainClip?: boolean
  /** Loudnorm EBU R128 target (default −23 LUFS). */
  loudnormTargetLufs?: number
  /** Loudnorm true-peak ceiling (default −1 dBTP). */
  loudnormTruePeakCeilingDb?: number
  convolverEnabled?: boolean
  convolverIrPath?: string
  crossfeedEnabled?: boolean
  crossfeedStrength?: number
  crossfeedDelayMs?: number
  crossfeedCutoffHz?: number
  /** Preserved across createLegacyDspGraph rewrites (HiFi sample-rate lock). */
  outputStage?: Partial<DspOutputStageConfig>
  /** StereoField balance/width (+ optional mid/side) for HiFi console. */
  stereoImage?: Partial<DspStereoImageConfig>
}

/** Common output-stage sample rate locks for HiFi / DspRack. */
export const DSP_OUTPUT_SAMPLE_RATE_OPTIONS: readonly {
  value: 'device' | number
  label: string
}[] = [
  { value: 'device', label: 'Device' },
  { value: 44100, label: '44.1 kHz' },
  { value: 48000, label: '48 kHz' },
  { value: 88200, label: '88.2 kHz' },
  { value: 96000, label: '96 kHz' },
  { value: 176400, label: '176.4 kHz' },
  { value: 192000, label: '192 kHz' }
] as const

export const DSP_RESAMPLER_QUALITY_OPTIONS: readonly {
  value: DspResamplerQuality
  label: string
}[] = [
  { value: 'native', label: 'Native' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'soxrHq', label: 'SoX HQ' },
  { value: 'soxrVhq', label: 'SoX VHQ (最高)' }
] as const

export const DSP_DITHER_MODE_OPTIONS: readonly {
  value: DspDitherMode
  label: string
}[] = [
  { value: 'off', label: 'Off' },
  { value: 'tpdf', label: 'TPDF' },
  { value: 'highpassTpdf', label: 'High-pass TPDF' },
  { value: 'noiseShaped', label: 'Noise-shaped' }
] as const

const BUILT_IN_NODE_TYPES = new Set<DspNodeType>([
  'replayGain',
  'equalizer',
  'dynamicEqualizer',
  'convolver',
  'crossfeed',
  'channelMatrix',
  'channelStrip',
  'bassManagement',
  'gate',
  'compressor',
  'multibandCompressor',
  'stereoField',
  'loudnessContour',
  'truePeakLimiter',
  'nativePlugin',
  'vst3Plugin',
  'meter'
])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? [...new Set(items)] : undefined
}

function normalizeLayout(value: unknown): DspChannelLayout | null {
  return value === 'mono' || value === 'stereo' || value === '5.1' || value === '7.1' ? value : null
}

function normalizeVst3Reference(value: unknown): Vst3PluginReference | undefined {
  const raw = asRecord(value)
  const catalogId = typeof raw.catalogId === 'string' ? raw.catalogId.trim() : ''
  const classId = typeof raw.classId === 'string' ? raw.classId.trim() : ''
  if (!catalogId || !classId) return undefined
  const stateAssetId =
    typeof raw.stateAssetId === 'string' && raw.stateAssetId.trim()
      ? raw.stateAssetId.trim()
      : undefined
  return { catalogId, classId, ...(stateAssetId ? { stateAssetId } : {}) }
}

export function normalizeDspOutputStage(value: unknown): DspOutputStageConfig {
  const raw = asRecord(value)
  const targetSampleRate =
    raw.targetSampleRate === 'device'
      ? 'device'
      : typeof raw.targetSampleRate === 'number' && Number.isFinite(raw.targetSampleRate)
        ? Math.max(8000, Math.min(768000, Math.trunc(raw.targetSampleRate)))
        : DEFAULT_DSP_OUTPUT_STAGE.targetSampleRate
  const resamplerQuality =
    raw.resamplerQuality === 'high' ||
    raw.resamplerQuality === 'ultra' ||
    raw.resamplerQuality === 'soxrHq' ||
    raw.resamplerQuality === 'soxrVhq'
      ? raw.resamplerQuality
      : 'native'
  const dither =
    raw.dither === 'tpdf' || raw.dither === 'highpassTpdf' || raw.dither === 'noiseShaped'
      ? raw.dither
      : 'off'
  return {
    targetSampleRate,
    resamplerQuality,
    dither,
    safetyClamp: raw.safetyClamp !== false
  }
}

function normalizeNode(value: unknown, index: number): DspGraphNode | null {
  const raw = asRecord(value)
  const type = raw.type
  if (typeof type !== 'string' || !BUILT_IN_NODE_TYPES.has(type as DspNodeType)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${type}-${index + 1}`
  const params = asRecord(raw.params)
  const pluginId =
    typeof raw.pluginId === 'string' && raw.pluginId.trim() ? raw.pluginId.trim() : undefined
  const pluginAbiVersion =
    raw.pluginAbiVersion === 1 || raw.pluginAbiVersion === 2 ? raw.pluginAbiVersion : undefined
  const vst3 = normalizeVst3Reference(raw.vst3)
  return {
    id,
    type: type as DspNodeType,
    enabled: raw.enabled !== false,
    params,
    ...(pluginId ? { pluginId } : {}),
    ...(pluginAbiVersion ? { pluginAbiVersion } : {}),
    ...(vst3 ? { vst3 } : {})
  }
}

export function normalizeDspGraph(value: unknown): DspGraphConfig {
  const raw = asRecord(value)
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((node, index) => normalizeNode(node, index))
        .filter((node): node is DspGraphNode => !!node)
    : []
  const seen = new Set<string>()
  const uniqueNodes = nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
  return {
    version: DSP_GRAPH_VERSION,
    nodes: uniqueNodes,
    outputStage: normalizeDspOutputStage(raw.outputStage)
  }
}

export function createLegacyDspGraph(settings: LegacyDspSettings = {}): DspGraphConfig {
  const dspEnabled = settings.dspEnabled === true
  const stereoImage = normalizeDspStereoImage(settings.stereoImage ?? DEFAULT_DSP_STEREO_IMAGE)
  return {
    version: DSP_GRAPH_VERSION,
    outputStage: normalizeDspOutputStage({
      ...DEFAULT_DSP_OUTPUT_STAGE,
      ...(settings.outputStage ?? {})
    }),
    nodes: [
      {
        id: 'replay-gain',
        type: 'replayGain',
        enabled:
          dspEnabled &&
          settings.volumeNormalization !== undefined &&
          settings.volumeNormalization !== 'off',
        params: {
          mode: settings.volumeNormalization ?? 'off',
          preampDb: settings.replayGainPreamp ?? 0,
          fallbackDb: settings.replayGainFallback ?? 0,
          clip: settings.replayGainClip !== false,
          targetLufs: settings.loudnormTargetLufs ?? -23,
          truePeakCeilingDb: settings.loudnormTruePeakCeilingDb ?? -1
        }
      },
      {
        id: 'equalizer',
        type: 'equalizer',
        enabled: dspEnabled && settings.eqEnabled === true,
        params: {
          mode: settings.eqMode ?? 'graphic',
          preampDb: settings.eqPreamp ?? 0,
          bands: Array.isArray(settings.eqBands) ? settings.eqBands : []
        }
      },
      {
        id: 'convolver',
        type: 'convolver',
        enabled: dspEnabled && settings.convolverEnabled === true && !!settings.convolverIrPath,
        params: { impulseResponsePath: settings.convolverIrPath ?? '', wet: 1, dry: 0 }
      },
      {
        id: 'crossfeed',
        type: 'crossfeed',
        enabled:
          dspEnabled && settings.crossfeedEnabled === true && (settings.crossfeedStrength ?? 0) > 0,
        params: {
          algorithm: 'custom',
          strength: settings.crossfeedStrength ?? 0,
          delayMs: settings.crossfeedDelayMs ?? 0.35,
          cutoffHz: settings.crossfeedCutoffHz ?? 700
        }
      },
      buildChannelStripNode(stereoImage, dspEnabled),
      { id: 'bass-management', type: 'bassManagement', enabled: false, params: {} },
      { id: 'gate', type: 'gate', enabled: false, params: {} },
      { id: 'compressor', type: 'compressor', enabled: false, params: {} },
      { id: 'dynamic-equalizer', type: 'dynamicEqualizer', enabled: false, params: { bands: [] } },
      {
        id: 'multiband-compressor',
        type: 'multibandCompressor',
        enabled: false,
        params: { bands: [] }
      },
      buildStereoFieldNode(stereoImage, dspEnabled),
      { id: 'loudness-contour', type: 'loudnessContour', enabled: false, params: {} },
      {
        id: 'true-peak-limiter',
        type: 'truePeakLimiter',
        enabled: false,
        params: { ceilingDb: -0.1 }
      },
      { id: 'meter', type: 'meter', enabled: true, params: {} }
    ]
  }
}

export function createDspFactoryScene(
  templateId: DspFactorySceneTemplateId,
  id = `factory-${templateId}`
): DspScene {
  const meter: DspGraphNode = { id: 'meter', type: 'meter', enabled: true, params: {} }
  const scene: DspScene = {
    id,
    name:
      DSP_FACTORY_SCENE_TEMPLATES.find((template) => template.id === templateId)?.name ??
      'DSP Scene',
    enabled: true,
    priority: 0,
    rules: { sourceKinds: ['pcm'] },
    graph: {
      version: DSP_GRAPH_VERSION,
      outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE },
      nodes: [meter]
    }
  }

  switch (templateId) {
    case 'transparent':
      scene.rules = {}
      break
    case 'headphoneCrossfeed':
      scene.priority = 20
      scene.rules.channelLayouts = ['stereo']
      scene.graph.nodes = [
        {
          id: 'crossfeed',
          type: 'crossfeed',
          enabled: true,
          params: { algorithm: 'bauer', strength: 0.35, delayMs: 0.35, cutoffHz: 700 }
        },
        meter
      ]
      break
    case 'headphoneCorrection':
      scene.priority = 30
      scene.rules.channelLayouts = ['stereo']
      scene.graph.nodes = [
        {
          id: 'equalizer',
          type: 'equalizer',
          enabled: false,
          params: { mode: 'parametric', preampDb: 0, bands: [] }
        },
        meter
      ]
      break
    case 'roomCorrection':
      scene.priority = 30
      scene.rules.channelLayouts = ['stereo']
      scene.graph.nodes = [
        {
          id: 'convolver',
          type: 'convolver',
          enabled: false,
          params: {
            impulseResponseAssetId: '',
            impulseResponsePath: '',
            wet: 1,
            dry: 0,
            gainDb: 0,
            routingMode: 'diagonal',
            layout: 'stereo',
            matrix: []
          }
        },
        meter
      ]
      break
    case 'speakerCalibration51':
      scene.priority = 40
      scene.rules.channelLayouts = ['5.1']
      scene.graph.nodes = [
        createSpeakerCalibrationNode('5.1'),
        {
          id: 'bass-management',
          type: 'bassManagement',
          enabled: false,
          params: { crossoverHz: 80, lfeGainDb: 0 }
        },
        meter
      ]
      break
    case 'speakerCalibration71':
      scene.priority = 40
      scene.rules.channelLayouts = ['7.1']
      scene.graph.nodes = [
        createSpeakerCalibrationNode('7.1'),
        {
          id: 'bass-management',
          type: 'bassManagement',
          enabled: false,
          params: { crossoverHz: 80, lfeGainDb: 0 }
        },
        meter
      ]
      break
  }

  return scene
}

function createSpeakerCalibrationNode(layout: '5.1' | '7.1'): DspGraphNode {
  const channelCount = layout === '5.1' ? 6 : 8
  return {
    id: 'channel-strip',
    type: 'channelStrip',
    // Keep the identity calibration inactive until the listener enters the
    // measured gains/delays and explicitly enables it.
    enabled: false,
    params: {
      layout,
      channels: Array.from({ length: channelCount }, () => ({
        gainDb: 0,
        delayMs: 0,
        polarityInverted: false,
        muted: false
      }))
    }
  }
}

/**
 * Whether an enabled graph node would actually change the samples.
 *
 * A scene generated from the renderer's module toggles enables a node as soon as
 * its toggle is on, so an untouched 10-band EQ looks like processing while being
 * bit-transparent. The engine decides DSD passthrough from the same rule
 * (graphNodeAltersSignal in audio-engine/core/AudioPipeline.cpp), so keep the two
 * in lockstep: the UI must name the blockers the engine actually acts on.
 *
 * Unknown node types count as processing - claiming bit-perfect output that is
 * not bit-perfect is the worse failure.
 */
export function dspGraphNodeAltersSignal(node: DspGraphNode): boolean {
  if (!node.enabled || node.type === 'meter') return false
  const params = node.params as Record<string, unknown>
  const numberParam = (key: string): number => {
    const value = params[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  if (node.type === 'replayGain') return (params.mode ?? 'off') !== 'off'
  if (node.type === 'crossfeed') return numberParam('strength') > 0
  if (node.type === 'convolver') {
    return typeof params.impulseResponsePath === 'string' && params.impulseResponsePath.length > 0
  }
  if (node.type === 'equalizer') {
    if (Math.abs(numberParam('preampDb')) > TRANSPARENT_GAIN_EPSILON_DB) return true
    const bands = Array.isArray(params.bands) ? (params.bands as Record<string, unknown>[]) : []
    return bands.some((band) =>
      equalizerBandAltersSignal({
        gain: typeof band.gain === 'number' ? band.gain : 0,
        filterType: typeof band.filterType === 'string' ? band.filterType : 'peak',
        enabled: band.enabled !== false
      })
    )
  }
  return true
}

export function graphHasEnabledProcessing(graph: DspGraphConfig): boolean {
  const outputStage = normalizeDspOutputStage(graph.outputStage)
  return (
    graph.nodes.some((node) => node.enabled && node.type !== 'meter') ||
    outputStageIsActive(outputStage)
  )
}

/** True when sample-rate lock / SRC / dither will force non-passthrough processing. */
export function outputStageIsActive(stage: DspOutputStageConfig): boolean {
  const outputStage = normalizeDspOutputStage(stage)
  return (
    outputStage.targetSampleRate !== 'device' ||
    outputStage.resamplerQuality !== 'native' ||
    outputStage.dither !== 'off'
  )
}

export function mergeDspOutputStage(
  current: DspOutputStageConfig | undefined,
  partial: Partial<DspOutputStageConfig>
): DspOutputStageConfig {
  return normalizeDspOutputStage({
    ...(current ?? DEFAULT_DSP_OUTPUT_STAGE),
    ...partial
  })
}

/** HiFi balance / width / per-channel polarity (default-scene stereoField + channelStrip). */
export interface DspStereoImageConfig {
  balance: number
  width: number
  midGainDb: number
  sideGainDb: number
  invertLeft: boolean
  invertRight: boolean
  swap: boolean
  mono: boolean
}

export const DEFAULT_DSP_STEREO_IMAGE: DspStereoImageConfig = {
  balance: 0,
  width: 1,
  midGainDb: 0,
  sideGainDb: 0,
  invertLeft: false,
  invertRight: false,
  swap: false,
  mono: false
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function normalizeDspStereoImage(value: unknown): DspStereoImageConfig {
  const raw = asRecord(value)
  return {
    balance: clampNumber(raw.balance, -1, 1, DEFAULT_DSP_STEREO_IMAGE.balance),
    width: clampNumber(raw.width, 0, 2, DEFAULT_DSP_STEREO_IMAGE.width),
    midGainDb: clampNumber(raw.midGainDb, -24, 24, DEFAULT_DSP_STEREO_IMAGE.midGainDb),
    sideGainDb: clampNumber(raw.sideGainDb, -24, 24, DEFAULT_DSP_STEREO_IMAGE.sideGainDb),
    invertLeft: raw.invertLeft === true,
    invertRight: raw.invertRight === true,
    swap: raw.swap === true,
    mono: raw.mono === true
  }
}

export function mergeDspStereoImage(
  current: DspStereoImageConfig | undefined,
  partial: Partial<DspStereoImageConfig>
): DspStereoImageConfig {
  return normalizeDspStereoImage({
    ...(current ?? DEFAULT_DSP_STEREO_IMAGE),
    ...partial
  })
}

/** True when balance/width/polarity will force non-passthrough processing. */
export function stereoImageIsActive(image: DspStereoImageConfig): boolean {
  const stereo = normalizeDspStereoImage(image)
  return (
    Math.abs(stereo.balance) > 1e-6 ||
    Math.abs(stereo.width - 1) > 1e-6 ||
    Math.abs(stereo.midGainDb) > 1e-6 ||
    Math.abs(stereo.sideGainDb) > 1e-6 ||
    stereo.invertLeft ||
    stereo.invertRight ||
    stereo.swap ||
    stereo.mono
  )
}

export function extractStereoImageFromGraph(
  graph: DspGraphConfig | undefined | null
): DspStereoImageConfig {
  if (!graph) return { ...DEFAULT_DSP_STEREO_IMAGE }
  const stereoNode = graph.nodes.find((node) => node.type === 'stereoField')
  const stripNode = graph.nodes.find((node) => node.type === 'channelStrip')
  const stereoParams = asRecord(stereoNode?.params)
  const channels = Array.isArray(stripNode?.params?.channels)
    ? (stripNode?.params?.channels as unknown[])
    : []
  const left = asRecord(channels[0])
  const right = asRecord(channels[1])
  return normalizeDspStereoImage({
    balance: stereoParams.balance,
    width: stereoParams.width,
    midGainDb: stereoParams.midGainDb,
    sideGainDb: stereoParams.sideGainDb,
    invertLeft:
      stereoParams.invertLeft === true || left.polarityInverted === true || left.polarity === true,
    invertRight:
      stereoParams.invertRight === true ||
      right.polarityInverted === true ||
      right.polarity === true,
    swap: stereoParams.swap,
    mono: stereoParams.mono
  })
}

function buildStereoFieldNode(image: DspStereoImageConfig, _dspEnabled: boolean): DspGraphNode {
  // Stereo image is independent of classic master-DSP flag; active params enable the node.
  void _dspEnabled
  return {
    id: 'stereo-field',
    type: 'stereoField',
    enabled: stereoImageIsActive(image),
    params: {
      width: image.width,
      balance: image.balance,
      midGainDb: image.midGainDb,
      sideGainDb: image.sideGainDb,
      swap: image.swap,
      mono: image.mono,
      invertLeft: image.invertLeft,
      invertRight: image.invertRight
    }
  }
}

function buildChannelStripNode(image: DspStereoImageConfig, _dspEnabled: boolean): DspGraphNode {
  void _dspEnabled
  const polarityActive = image.invertLeft || image.invertRight
  return {
    id: 'channel-strip',
    type: 'channelStrip',
    enabled: polarityActive,
    params: {
      channels: [
        {
          gainDb: 0,
          delayMs: 0,
          polarityInverted: image.invertLeft,
          muted: false
        },
        {
          gainDb: 0,
          delayMs: 0,
          polarityInverted: image.invertRight,
          muted: false
        }
      ]
    }
  }
}

/** Apply stereo image params onto an existing graph (shallow-copies nodes). */
export function applyStereoImageToGraph(
  graph: DspGraphConfig,
  partial: Partial<DspStereoImageConfig>
): DspGraphConfig {
  const next = mergeDspStereoImage(extractStereoImageFromGraph(graph), partial)
  const stereoNode = buildStereoFieldNode(next, true)
  const stripNode = buildChannelStripNode(next, true)
  const nodes = [...graph.nodes]
  const stereoIndex = nodes.findIndex((node) => node.type === 'stereoField')
  const stripIndex = nodes.findIndex((node) => node.type === 'channelStrip')
  if (stereoIndex >= 0) nodes[stereoIndex] = stereoNode
  else nodes.push(stereoNode)
  if (stripIndex >= 0) nodes[stripIndex] = stripNode
  else nodes.push(stripNode)
  return { ...graph, nodes }
}

export function normalizeDspSceneRule(value: unknown): DspSceneRule {
  const raw = asRecord(value)
  const channelLayouts = Array.isArray(raw.channelLayouts)
    ? raw.channelLayouts.map(normalizeLayout).filter((item): item is DspChannelLayout => !!item)
    : undefined
  const sourceKinds = Array.isArray(raw.sourceKinds)
    ? raw.sourceKinds.filter((item): item is 'pcm' | 'dsd' => item === 'pcm' || item === 'dsd')
    : undefined
  const minSampleRate =
    typeof raw.minSampleRate === 'number' && Number.isFinite(raw.minSampleRate)
      ? Math.max(0, Math.trunc(raw.minSampleRate))
      : undefined
  const maxSampleRate =
    typeof raw.maxSampleRate === 'number' && Number.isFinite(raw.maxSampleRate)
      ? Math.max(0, Math.trunc(raw.maxSampleRate))
      : undefined
  return {
    ...(asStringArray(raw.deviceIds) ? { deviceIds: asStringArray(raw.deviceIds) } : {}),
    ...(asStringArray(raw.backends) ? { backends: asStringArray(raw.backends) } : {}),
    ...(channelLayouts && channelLayouts.length > 0
      ? { channelLayouts: [...new Set(channelLayouts)] }
      : {}),
    ...(sourceKinds && sourceKinds.length > 0 ? { sourceKinds: [...new Set(sourceKinds)] } : {}),
    ...(minSampleRate !== undefined ? { minSampleRate } : {}),
    ...(maxSampleRate !== undefined
      ? { maxSampleRate: Math.max(minSampleRate ?? 0, maxSampleRate) }
      : {})
  }
}

export function normalizeDspScenes(value: unknown, legacy: LegacyDspSettings = {}): DspScene[] {
  const rawScenes = Array.isArray(value) ? value : []
  const scenes: DspScene[] = []
  const seen = new Set<string>()
  for (let index = 0; index < rawScenes.length; index += 1) {
    const raw = asRecord(rawScenes[index])
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `scene-${index + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    scenes.push({
      id,
      name:
        typeof raw.name === 'string' && raw.name.trim()
          ? raw.name.trim()
          : `DSP Scene ${index + 1}`,
      enabled: raw.enabled !== false,
      priority:
        typeof raw.priority === 'number' && Number.isFinite(raw.priority)
          ? Math.trunc(raw.priority)
          : 0,
      rules: normalizeDspSceneRule(raw.rules),
      graph: normalizeDspGraph(raw.graph),
      ...(raw.allowDsdPcmFallback === true ? { allowDsdPcmFallback: true } : {})
    })
  }
  if (scenes.length > 0) return scenes
  return [
    {
      id: 'default',
      name: 'Default',
      enabled: true,
      priority: 0,
      rules: {},
      graph: createLegacyDspGraph(legacy)
    }
  ]
}

function matchesSceneRule(rule: DspSceneRule, context: DspSceneContext): boolean {
  if (rule.deviceIds && !rule.deviceIds.includes(context.deviceId)) return false
  if (rule.backends && !rule.backends.includes(context.backend)) return false
  if (rule.channelLayouts && !rule.channelLayouts.includes(context.channelLayout)) return false
  if (rule.sourceKinds && !rule.sourceKinds.includes(context.sourceKind)) return false
  if (rule.minSampleRate !== undefined && context.sampleRate < rule.minSampleRate) return false
  if (rule.maxSampleRate !== undefined && context.sampleRate > rule.maxSampleRate) return false
  return true
}

function sceneSpecificity(rule: DspSceneRule): number {
  return (
    (rule.deviceIds?.length ? 1 : 0) +
    (rule.backends?.length ? 1 : 0) +
    (rule.channelLayouts?.length ? 1 : 0) +
    (rule.sourceKinds?.length ? 1 : 0) +
    (rule.minSampleRate !== undefined || rule.maxSampleRate !== undefined ? 1 : 0)
  )
}

export function resolveDspScene(
  scenes: DspScene[],
  context: DspSceneContext,
  pinnedSceneId?: string | null
): DspSceneResolution {
  const pinned = pinnedSceneId
    ? scenes.find((scene) => scene.id === pinnedSceneId && scene.enabled)
    : undefined
  const candidates = pinned
    ? [pinned]
    : scenes
        .map((scene, index) => ({ scene, index }))
        .filter(({ scene }) => scene.enabled && matchesSceneRule(scene.rules, context))
        .sort(
          (left, right) =>
            right.scene.priority - left.scene.priority ||
            sceneSpecificity(right.scene.rules) - sceneSpecificity(left.scene.rules) ||
            left.index - right.index
        )
        .map(({ scene }) => scene)
  const scene = candidates[0] ?? null
  const graph = scene?.graph ?? createLegacyDspGraph()
  const requiresPcmFallback = context.sourceKind === 'dsd' && graphHasEnabledProcessing(graph)
  return {
    scene,
    graph,
    reason: scene ? (pinned ? 'manual-pin' : 'rule-match') : 'no-matching-scene',
    requiresPcmFallback,
    pinned: !!pinned
  }
}
