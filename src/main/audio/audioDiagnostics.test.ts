import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_AUDIO_PROCESSING, DEFAULT_OUTPUT_CONFIG } from './audioEngineHelpers.ts'
import { createLegacyDspGraph, type DspSceneState } from '../../shared/dspGraph.ts'
import {
  AudioDiagnosticRecorder,
  collectDsdPcmBlockers,
  redactAudioDiagnosticValue,
  summarizeAudioSource,
  type AudioDiagnosticSnapshot
} from './audioDiagnostics.ts'

function sceneState(processing = DEFAULT_AUDIO_PROCESSING): DspSceneState {
  return {
    scenes: [],
    pinnedSceneId: null,
    activeSceneId: null,
    graph: createLegacyDspGraph(processing),
    requiresPcmFallback: false,
    dsdPcmFallbackApplied: false
  }
}

test('identifies software volume as a DSD PCM blocker with DSP bypassed', () => {
  const blockers = collectDsdPcmBlockers({
    playback: { volume: 0.7, playbackRate: 1 },
    processing: { ...DEFAULT_AUDIO_PROCESSING, dspEnabled: false },
    outputConfig: { ...DEFAULT_OUTPUT_CONFIG, routingMode: 'auto' },
    sceneState: sceneState({ ...DEFAULT_AUDIO_PROCESSING, dspEnabled: false })
  })

  assert.deepEqual(blockers, [{ code: 'volume_not_unity', value: 0.7, origin: 'player' }])
})

const BOOSTED_EQ_BANDS = DEFAULT_AUDIO_PROCESSING.eqBands.map((band, index) =>
  index === 0 ? { ...band, gain: 3 } : band
)

test('reports non-DSP output and scene processing that require PCM', () => {
  const processing = {
    ...DEFAULT_AUDIO_PROCESSING,
    dspEnabled: true,
    eqEnabled: true,
    eqBands: BOOSTED_EQ_BANDS,
    crossfadeSeconds: 2
  }
  const state = sceneState(processing)
  state.requiresPcmFallback = true
  state.graph.outputStage = {
    targetSampleRate: 192000,
    resamplerQuality: 'soxrVhq',
    dither: 'tpdf',
    safetyClamp: true
  }
  const codes = collectDsdPcmBlockers({
    playback: { volume: 1, playbackRate: 1.25 },
    processing,
    outputConfig: { ...DEFAULT_OUTPUT_CONFIG, routingMode: 'stereo' },
    sceneState: state
  }).map((blocker) => blocker.code)

  assert.ok(codes.includes('playback_rate_not_unity'))
  assert.ok(codes.includes('crossfade_active'))
  assert.ok(codes.includes('routing_not_auto'))
  assert.ok(codes.includes('eq_active'))
  assert.ok(codes.includes('output_sample_rate_locked'))
  assert.ok(codes.includes('output_resampler_active'))
  assert.ok(codes.includes('output_dither_active'))
  assert.ok(codes.includes('dsp_scene_requires_pcm'))
})

test('a flat equalizer is not a DSD PCM blocker', () => {
  const processing = { ...DEFAULT_AUDIO_PROCESSING, dspEnabled: true, eqEnabled: true }
  const codes = collectDsdPcmBlockers({
    playback: { volume: 1, playbackRate: 1 },
    processing,
    outputConfig: DEFAULT_OUTPUT_CONFIG,
    sceneState: sceneState(processing)
  }).map((blocker) => blocker.code)

  assert.deepEqual(codes, [])
})

test('an equalizer node disabled in the effective graph is not a DSD PCM blocker', () => {
  const processing = {
    ...DEFAULT_AUDIO_PROCESSING,
    dspEnabled: true,
    eqEnabled: true,
    eqBands: BOOSTED_EQ_BANDS
  }
  const state = sceneState(processing)
  state.effectiveGraph = {
    ...state.graph,
    nodes: state.graph.nodes.map((node) => ({ ...node, enabled: false }))
  }

  const codes = collectDsdPcmBlockers({
    playback: { volume: 1, playbackRate: 1 },
    processing,
    outputConfig: DEFAULT_OUTPUT_CONFIG,
    sceneState: state
  }).map((blocker) => blocker.code)

  assert.deepEqual(codes, [])
})

test('redacts local paths and URL queries into stable fingerprints', () => {
  const local = summarizeAudioSource('E:\\Private Music\\album\\track.dsf')
  const remote = summarizeAudioSource('https://example.com/music/track.dsf?token=secret')
  const redacted = redactAudioDiagnosticValue({
    source: 'E:\\Private Music\\album\\track.dsf',
    message: 'failed to open E:\\Private Music\\album\\track.dsf',
    url: 'https://example.com/music/track.dsf?token=secret'
  }) as Record<string, unknown>

  assert.equal(local.kind, 'local-file')
  assert.equal(local.extension, '.dsf')
  assert.equal(remote.kind, 'remote-url')
  assert.equal(remote.extension, '.dsf')
  assert.notEqual(local.fingerprint, remote.fingerprint)
  assert.doesNotMatch(JSON.stringify(redacted), /Private Music|token=secret/)
})

test('exports current and persisted diagnostic events as one JSON report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-audio-diagnostics-'))
  const outputPath = join(directory, 'report.json')
  try {
    const recorder = new AudioDiagnosticRecorder({
      directory,
      environment: {
        appName: 'TwilightEcho',
        appVersion: '1.0.2',
        packaged: true,
        platform: process.platform,
        architecture: process.arch,
        osRelease: 'test',
        locale: 'zh-CN',
        processVersions: { node: process.versions.node, modules: process.versions.modules }
      }
    })
    recorder.record('play-requested', { source: 'E:\\Private\\sample.dsf' })
    recorder.record('playback-state', { perfectReasonCode: 'volume_not_unity' }, 'warning')
    const snapshot: AudioDiagnosticSnapshot = {
      playback: { source: 'E:\\Private\\sample.dsf' },
      outputState: {},
      outputConfig: {},
      effectiveOutputConfig: {},
      outputConfigApplyStatus: {},
      configuredProcessing: {},
      effectiveProcessing: {},
      engineProcessing: {},
      headphoneCompensation: {},
      dspSceneState: {},
      dspGraphStatus: {},
      diagnosis: { blockers: ['volume_not_unity'] }
    }

    await recorder.exportReport(outputPath, snapshot)
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.privacy.audioPayloadCaptured, false)
    assert.equal(report.events.length, 2)
    assert.equal(report.events[1].level, 'warning')
    assert.doesNotMatch(JSON.stringify(report), /E:\\\\Private/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
