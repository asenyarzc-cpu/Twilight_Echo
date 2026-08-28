import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { equalizerSettingsAlterSignal } from '../../shared/audioProcessingOptions.ts'
import {
  dspGraphNodeAltersSignal,
  graphHasEnabledProcessing,
  outputStageIsActive,
  type DspSceneState
} from '../../shared/dspGraph.ts'
import type {
  AudioOutputState,
  AudioProcessingSettings,
  OutputConfig,
  PlaybackInfo
} from './audioEngineTypes.ts'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_EVENT_TEXT_LENGTH = 16 * 1024
const MAX_EXPORTED_EVENTS = 4000

export interface AudioDiagnosticEnvironment {
  appName: string
  appVersion: string
  packaged: boolean
  platform: NodeJS.Platform
  architecture: string
  osRelease: string
  locale: string
  processVersions: {
    electron?: string
    chrome?: string
    node: string
    modules: string
  }
}

export interface AudioDiagnosticBlocker {
  code: string
  value?: unknown
  origin: 'player' | 'processing' | 'dsp-scene' | 'output'
}

export interface AudioDiagnosticEvent {
  timestamp: string
  sessionId: string
  sequence: number
  level: 'info' | 'warning' | 'error'
  event: string
  details: unknown
}

export interface AudioDiagnosticSnapshot {
  playback: unknown
  outputState: unknown
  outputConfig: unknown
  effectiveOutputConfig: unknown
  outputConfigApplyStatus: unknown
  configuredProcessing: unknown
  effectiveProcessing: unknown
  engineProcessing: unknown
  headphoneCompensation: unknown
  dspSceneState: unknown
  dspGraphStatus: unknown
  diagnosis: unknown
}

export interface AudioDiagnosticReport {
  schemaVersion: 1
  generatedAt: string
  sessionId: string
  /** Locale the human-readable companion report was rendered in. */
  locale?: string
  privacy: {
    audioPayloadCaptured: false
    fullLocalPathsCaptured: false
    urlQueryCaptured: false
    note: string
  }
  environment: AudioDiagnosticEnvironment
  snapshot: AudioDiagnosticSnapshot
  events: AudioDiagnosticEvent[]
}

export interface AudioDiagnosticRecorderOptions {
  directory: string
  environment: AudioDiagnosticEnvironment
  maxLogBytes?: number
}

export class AudioDiagnosticRecorder {
  readonly sessionId = randomUUID()
  private readonly options: AudioDiagnosticRecorderOptions
  private readonly currentLogPath: string
  private readonly previousLogPath: string
  private readonly maxLogBytes: number
  private sequence = 0
  private currentBytes = 0
  private writeChain: Promise<void>

  constructor(options: AudioDiagnosticRecorderOptions) {
    this.options = options
    this.currentLogPath = join(options.directory, 'audio-diagnostics.jsonl')
    this.previousLogPath = join(options.directory, 'audio-diagnostics.previous.jsonl')
    this.maxLogBytes = Math.max(256 * 1024, options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES)
    this.writeChain = this.initialize()
  }

  record(
    event: string,
    details: unknown = {},
    level: AudioDiagnosticEvent['level'] = 'info'
  ): void {
    const entry: AudioDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      level,
      event,
      details: redactAudioDiagnosticValue(details)
    }
    const line = `${JSON.stringify(entry)}\n`
    const byteLength = Buffer.byteLength(line)
    this.writeChain = this.writeChain
      .then(async () => {
        if (this.currentBytes > 0 && this.currentBytes + byteLength > this.maxLogBytes) {
          await this.rotateCurrentLog()
        }
        await appendFile(this.currentLogPath, line, 'utf8')
        this.currentBytes += byteLength
      })
      .catch(() => undefined)
  }

  /**
   * Assemble the report without writing it.
   *
   * Split out from {@link exportReport} so the human-readable renderer can work
   * from the same object the JSON is serialized from — the prose report and the
   * machine report must never describe different states. The renderer lives in
   * `diagnosticReport.ts`, which imports these types, so composing the two
   * happens at the call site rather than here (a direct import would be a cycle).
   */
  async buildReport(
    snapshot: AudioDiagnosticSnapshot,
    locale?: string
  ): Promise<AudioDiagnosticReport> {
    await this.flush()
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      ...(locale ? { locale } : {}),
      privacy: {
        audioPayloadCaptured: false,
        fullLocalPathsCaptured: false,
        urlQueryCaptured: false,
        note: 'Local paths and remote URLs are reduced to type, extension and a one-way fingerprint.'
      },
      environment: this.options.environment,
      snapshot: redactAudioDiagnosticValue(snapshot) as AudioDiagnosticSnapshot,
      events: await this.readEvents()
    }
  }

  async exportReport(
    filePath: string,
    snapshot: AudioDiagnosticSnapshot,
    locale?: string
  ): Promise<AudioDiagnosticReport> {
    const report = await this.buildReport(snapshot, locale)
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true })
    try {
      const current = await stat(this.currentLogPath)
      if (current.size > 0) {
        await rm(this.previousLogPath, { force: true })
        await rename(this.currentLogPath, this.previousLogPath)
      }
    } catch {
      void 0
    }
    this.currentBytes = 0
  }

  private async rotateCurrentLog(): Promise<void> {
    try {
      await rm(this.previousLogPath, { force: true })
      await rename(this.currentLogPath, this.previousLogPath)
    } catch {
      void 0
    }
    this.currentBytes = 0
  }

  private async readEvents(): Promise<AudioDiagnosticEvent[]> {
    const events: AudioDiagnosticEvent[] = []
    for (const path of [this.previousLogPath, this.currentLogPath]) {
      let contents = ''
      try {
        contents = await readFile(path, 'utf8')
      } catch {
        continue
      }
      for (const line of contents.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const event = parseJsonWithNestingLimit(line) as AudioDiagnosticEvent
          if (event && typeof event.event === 'string') events.push(event)
        } catch {
          void 0
        }
      }
    }
    return events.slice(-MAX_EXPORTED_EVENTS)
  }
}

export function summarizeAudioSource(source: string): {
  kind: 'local-file' | 'remote-url' | 'custom-url' | 'unknown'
  extension: string
  fingerprint: string
} {
  const normalized = String(source ?? '')
  let kind: 'local-file' | 'remote-url' | 'custom-url' | 'unknown' = 'unknown'
  let extension = ''
  let fingerprintInput = normalized
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(normalized)) {
    kind = 'local-file'
    extension = extname(normalized.split(/[?#]/, 1)[0]).toLowerCase()
  } else {
    try {
      const parsed = new URL(normalized)
      kind =
        parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'remote-url' : 'custom-url'
      extension = extname(parsed.pathname).toLowerCase()
      fingerprintInput = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    } catch {
      extension = extname(normalized.split(/[?#]/, 1)[0]).toLowerCase()
    }
  }
  return {
    kind,
    extension: extension.slice(0, 16),
    fingerprint: createHash('sha256').update(fingerprintInput).digest('hex').slice(0, 16)
  }
}

export function redactAudioDiagnosticValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (
      /(?:source|filePath|modulePath|searchPath|convolverIrPath|url|uri|link|paths?)$/i.test(key)
    ) {
      return summarizeAudioSource(value)
    }
    return redactSensitiveText(value)
  }
  if (Array.isArray(value)) return value.map((item) => redactAudioDiagnosticValue(item, key))
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result[childKey] = redactAudioDiagnosticValue(childValue, childKey)
  }
  return result
}

export function redactSensitiveText(value: string): string {
  return value
    .slice(0, MAX_EVENT_TEXT_LENGTH)
    .replace(/https?:\/\/[^\s"']+/gi, (url) => {
      const summary = summarizeAudioSource(url)
      return `<remote-url:${summary.extension || 'unknown'}:${summary.fingerprint}>`
    })
    .replace(/[a-zA-Z]:[\\/][^\r\n"']+/g, (path) => {
      const summary = summarizeAudioSource(path.trim())
      return `<local-file:${summary.extension || 'unknown'}:${summary.fingerprint}>`
    })
    .replace(/\\\\[^\r\n"']+/g, (path) => {
      const summary = summarizeAudioSource(path.trim())
      return `<local-file:${summary.extension || 'unknown'}:${summary.fingerprint}>`
    })
}

export function collectDsdPcmBlockers(input: {
  playback: Pick<PlaybackInfo, 'volume' | 'playbackRate'>
  processing: AudioProcessingSettings
  outputConfig: OutputConfig
  sceneState: DspSceneState
}): AudioDiagnosticBlocker[] {
  const blockers: AudioDiagnosticBlocker[] = []
  const seen = new Set<string>()
  const add = (blocker: AudioDiagnosticBlocker): void => {
    if (seen.has(blocker.code)) return
    seen.add(blocker.code)
    blockers.push(blocker)
  }

  // The graph is what actually runs. A module toggle whose node sits disabled in
  // the effective graph is not a blocker -- reporting it as one is how a scene
  // with every node off still told the user their flat EQ was costing them DSD
  // passthrough. `meter` is a read-only tap and is skipped below for the same
  // reason. Without a graph (legacy config-only state) the toggles stand alone.
  const graphNodes = (input.sceneState.effectiveGraph ?? input.sceneState.graph).nodes
  const nodeIsActive = (type: string): boolean => {
    const node = graphNodes.find((candidate) => candidate.type === type)
    return node ? node.enabled : true
  }

  if (Math.abs(input.playback.volume - 1) > 0.001) {
    add({ code: 'volume_not_unity', value: input.playback.volume, origin: 'player' })
  }
  const directMode = input.processing.directMode === true
  const playbackRate = input.playback.playbackRate ?? 1
  if (!directMode && Math.abs(playbackRate - 1) > 0.001) {
    add({ code: 'playback_rate_not_unity', value: playbackRate, origin: 'player' })
  }
  if (!directMode && input.processing.crossfadeSeconds > 0.0001) {
    add({
      code: 'crossfade_active',
      value: input.processing.crossfadeSeconds,
      origin: 'processing'
    })
  }
  if (!directMode && input.outputConfig.routingMode !== 'auto') {
    add({
      code: 'routing_not_auto',
      value: input.outputConfig.routingMode,
      origin: 'output'
    })
  }
  if (input.processing.dsdOutputMode === 'pcm') {
    add({ code: 'dsd_output_mode_pcm', value: 'pcm', origin: 'processing' })
  }
  if (
    !directMode &&
    input.processing.dspEnabled &&
    input.processing.volumeNormalization !== 'off' &&
    nodeIsActive('replayGain')
  ) {
    add({
      code:
        input.processing.volumeNormalization === 'loudnorm'
          ? 'loudnorm_active'
          : 'replaygain_active',
      value: input.processing.volumeNormalization,
      origin: 'processing'
    })
  }
  if (
    !directMode &&
    input.processing.dspEnabled &&
    input.processing.eqEnabled &&
    nodeIsActive('equalizer') &&
    equalizerSettingsAlterSignal(input.processing)
  ) {
    add({ code: 'eq_active', origin: 'processing' })
  }
  if (
    !directMode &&
    input.processing.dspEnabled &&
    input.processing.convolverEnabled &&
    nodeIsActive('convolver')
  ) {
    add({ code: 'convolver_active', origin: 'processing' })
  }
  if (
    !directMode &&
    input.processing.dspEnabled &&
    input.processing.crossfeedEnabled &&
    input.processing.crossfeedStrength > 0 &&
    nodeIsActive('crossfeed')
  ) {
    add({
      code: 'crossfeed_active',
      value: input.processing.crossfeedStrength,
      origin: 'processing'
    })
  }

  const effectiveGraph = input.sceneState.effectiveGraph ?? input.sceneState.graph
  for (const node of effectiveGraph.nodes) {
    // A node left at its identity settings is not a blocker; the engine decides
    // DSD passthrough from the same rule.
    if (!dspGraphNodeAltersSignal(node)) continue
    add({ code: `dsp_node_${node.type}`, value: node.id, origin: 'dsp-scene' })
  }
  const outputStage = effectiveGraph.outputStage
  if (outputStageIsActive(outputStage)) {
    if (outputStage.targetSampleRate !== 'device') {
      add({
        code: 'output_sample_rate_locked',
        value: outputStage.targetSampleRate,
        origin: 'dsp-scene'
      })
    }
    if (outputStage.resamplerQuality !== 'native') {
      add({
        code: 'output_resampler_active',
        value: outputStage.resamplerQuality,
        origin: 'dsp-scene'
      })
    }
    if (outputStage.dither !== 'off') {
      add({ code: 'output_dither_active', value: outputStage.dither, origin: 'dsp-scene' })
    }
  }
  if (input.sceneState.requiresPcmFallback && graphHasEnabledProcessing(effectiveGraph)) {
    add({ code: 'dsp_scene_requires_pcm', origin: 'dsp-scene' })
  }
  return blockers
}

export function createPlaybackDiagnosticEvent(input: {
  playback: PlaybackInfo
  processing: AudioProcessingSettings
  outputConfig: OutputConfig
  sceneState: DspSceneState
  selectedOutput?: Pick<AudioOutputState, 'output' | 'device' | 'exclusiveMode'>
}): Record<string, unknown> {
  const { playback } = input
  const blockers = collectDsdPcmBlockers(input)
  return {
    source: summarizeAudioSource(playback.source),
    state: playback.state,
    position: Number(playback.position.toFixed(3)),
    duration: playback.duration,
    codec: playback.codec,
    sourceFormat: {
      sampleRate: playback.sourceSampleRate,
      bitDepth: playback.sourceBitDepth,
      channels: playback.channelCount,
      dsd: playback.isDsd,
      dsdRate: playback.dsdRate
    },
    controls: {
      volume: playback.volume,
      playbackRate: playback.playbackRate ?? 1
    },
    processing: {
      directMode: input.processing.directMode,
      effectiveGraph: input.sceneState.effectiveGraph ?? input.sceneState.graph,
      bypassReason: input.sceneState.effectiveBypassReason ?? ''
    },
    selectedOutput: input.selectedOutput,
    actualOutput: {
      backend: playback.actualBackend,
      driverName: playback.driverName,
      driverVersion: playback.driverVersion,
      format: playback.actualOutputFormat,
      sampleRate: playback.actualSampleRate,
      bitDepth: playback.actualBitDepth,
      channels: playback.actualChannels,
      dsdMode: playback.dsdMode,
      outputPerfect: playback.outputPerfect,
      sourceExact: playback.sourceExact,
      perfectReasonCode: playback.perfectReasonCode,
      perfectReason: playback.perfectReason
    },
    nativeDsd: {
      state: playback.outputInfo.nativeDsdRuntimeState,
      requestedRate: playback.outputInfo.nativeDsdRequestedRate,
      actualRate: playback.outputInfo.nativeDsdActualRate,
      channels: playback.outputInfo.nativeDsdChannels,
      explicitlyCapable: playback.outputInfo.nativeDsdExplicitlyCapable,
      advertisedSampleRates: playback.outputInfo.nativeDsdAdvertisedSampleRates,
      reason: playback.outputInfo.nativeDsdRuntimeReason
    },
    transportEvidence: {
      nativeDsdNegotiation: playback.outputInfo.diagnostics.nativeDsdNegotiation ?? '',
      dopRuntimeEvidence: playback.outputInfo.diagnostics.dopRuntimeEvidence ?? '',
      actualWireFormat: playback.outputInfo.diagnostics.actualWireFormat ?? '',
      typedRawPath: playback.outputInfo.diagnostics.typedRawPath === true,
      processingBypassed: playback.outputInfo.diagnostics.processingBypassed === true
    },
    deviceCapabilities: {
      reason: playback.outputInfo.capabilityReason,
      dopCapable: playback.outputInfo.driverDopCapable,
      nativeDsdCapable: playback.outputInfo.driverNativeDsdCapable,
      dopCarrierSampleRates: playback.outputInfo.driverDopCarrierSampleRates,
      dopCarrierFormats: playback.outputInfo.driverDopCarrierFormats,
      nativeDsdSampleRates: playback.outputInfo.driverNativeDsdSampleRates
    },
    diagnostics: playback.outputInfo.diagnostics,
    dsdPcmFallback: playback.isDsd && playback.dsdMode === 'pcm',
    blockers
  }
}
