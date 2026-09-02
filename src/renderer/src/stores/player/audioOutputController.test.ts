import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, type Ref } from 'vue'
import type {
  AudioOutputId,
  AudioProcessingSettings,
  OutputConfig,
  OutputConfigApplyStatus
} from '../../types/settings'
import { createAudioOutputController } from './audioOutputController.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, DEFAULT_DSP_STEREO_IMAGE } from '../../../../shared/dspGraph.ts'

type AudioEngineApi = typeof window.api.audioEngine

function createSettings(overrides: Partial<AudioProcessingSettings> = {}): AudioProcessingSettings {
  return {
    dspEnabled: false,
    directMode: false,
    clipGuard: true,
    fftEnabled: true,
    fftResolution: 8192,
    highResolution: true,
    dsdToPcm: false,
    dsdOutputMode: 'auto',
    dsdRatePolicy: 'pcm-fallback',
    dsdRoute: {
      enabled: false,
      backend: '',
      device: '',
      applyToPcmToDsd: true,
      strictPassthrough: false
    },
    sacdProgramMode: 'auto',
    eqEnabled: false,
    eqMode: 'graphic',
    eqPreamp: 0,
    eqBands: [],
    volumeNormalization: 'off',
    replayGainPreamp: 0,
    replayGainFallback: 0,
    replayGainClip: true,
    convolverEnabled: false,
    convolverIrPath: '',
    crossfeedEnabled: false,
    crossfeedStrength: 0,
    crossfeedDelayMs: 0.35,
    crossfeedCutoffHz: 700,
    gapless: true,
    crossfadeSeconds: 0,
    ...overrides
  }
}

interface Harness {
  controller: ReturnType<typeof createAudioOutputController>
  exclusiveMode: Ref<boolean>
  audioProcessing: Ref<AudioProcessingSettings>
  audioOutputConfig: Ref<OutputConfig>
  audioOutputConfigApplyStatus: Ref<OutputConfigApplyStatus>
  errors: string[]
  appliedOutputStates: unknown[]
  crossfadeSchedules: number
  playbackInfoRefreshes: number
  persistCalls: Array<{ settings: AudioProcessingSettings; reason: unknown }>
  processingRequests: AudioProcessingSettings[]
  setOutputConfigCalls: number
  releaseOutputConfig: () => void
  failProcessing: boolean
  failImpulseLoad: boolean
}

function createHarness(): Harness {
  const exclusiveMode = ref(false)
  const audioProcessing = ref(createSettings())
  const audioOutputConfig = ref<OutputConfig>({
    preferredBufferSize: 0,
    routingMode: 'auto',
    wasapiExclusivePushMode: false
  })
  const audioOutputConfigApplyStatus = ref<OutputConfigApplyStatus>({
    requestedRevision: 0,
    appliedRevision: 0,
    failedRevision: 0,
    state: 'idle',
    error: '',
    generation: 0
  })
  const errors: string[] = []
  const appliedOutputStates: unknown[] = []
  const persistCalls: Harness['persistCalls'] = []
  const processingRequests: AudioProcessingSettings[] = []
  let crossfadeSchedules = 0
  let playbackInfoRefreshes = 0
  let setOutputConfigCalls = 0
  let outputConfigResolve: (() => void) | null = null
  let failProcessing = false
  let failImpulseLoad = false

  const outputState = {
    output: 'wasapi' as AudioOutputId,
    device: 'default',
    exclusiveMode: true,
    exclusiveAvailable: true,
    outputOptions: [],
    deviceOptions: []
  }

  const api = {
    setExclusiveMode: async () => outputState,
    setAudioOutput: async () => outputState,
    setAudioDevice: async () => outputState,
    setOutputConfig: async (config: OutputConfig) => {
      setOutputConfigCalls += 1
      if (outputConfigResolve) {
        await new Promise<void>((resolve) => {
          outputConfigResolve = resolve
        })
      }
      return config
    },
    getOutputConfigApplyStatus: async () => ({
      requestedRevision: 1,
      appliedRevision: 1,
      failedRevision: 0,
      state: 'applied',
      error: '',
      generation: 1
    }),
    setAudioProcessing: async (settings: AudioProcessingSettings) => {
      processingRequests.push(settings)
      if (failProcessing) throw new Error('engine rejected processing update')
      return settings
    },
    getDspSceneState: async () => null,
    setOutputStage: async () => null,
    setStereoImage: async () => null,
    selectImpulseResponse: async () => 'ir.wav',
    loadImpulseResponse: async () => {
      if (failImpulseLoad) throw new Error('impulse load failed')
    },
    unloadImpulseResponse: async () => {},
    getAudioProcessing: async () =>
      createSettings({ convolverEnabled: true, convolverIrPath: 'ir.wav' })
  } as unknown as AudioEngineApi

  const harness: Harness = {
    controller: createAudioOutputController({
      exclusiveMode,
      audioProcessing,
      audioOutputConfig,
      audioOutputConfigApplyStatus,
      dspOutputStage: ref({ ...DEFAULT_DSP_OUTPUT_STAGE }),
      dspStereoImage: ref({ ...DEFAULT_DSP_STEREO_IMAGE }),
      getAudioEngineApi: () => api,
      applyAudioOutputState: (state) => appliedOutputStates.push(state),
      setAudioEngineError: (error) => errors.push(error ?? ''),
      scheduleCrossfadeIfNeeded: () => {
        crossfadeSchedules += 1
      },
      refreshPlaybackInfo: async () => {
        playbackInfoRefreshes += 1
      },
      persistAudioProcessingFallback: async (settings, reason) => {
        persistCalls.push({ settings, reason })
      }
    }),
    exclusiveMode,
    audioProcessing,
    audioOutputConfig,
    audioOutputConfigApplyStatus,
    errors,
    appliedOutputStates,
    persistCalls,
    processingRequests,
    get crossfadeSchedules() {
      return crossfadeSchedules
    },
    get playbackInfoRefreshes() {
      return playbackInfoRefreshes
    },
    get setOutputConfigCalls() {
      return setOutputConfigCalls
    },
    releaseOutputConfig: () => {
      const release = outputConfigResolve
      outputConfigResolve = null
      release?.()
    },
    get failProcessing() {
      return failProcessing
    },
    set failProcessing(value: boolean) {
      failProcessing = value
    },
    get failImpulseLoad() {
      return failImpulseLoad
    },
    set failImpulseLoad(value: boolean) {
      failImpulseLoad = value
    }
  }
  return harness
}

test('toggleExclusiveMode applies the engine state on success', async () => {
  const harness = createHarness()
  await harness.controller.toggleExclusiveMode()
  assert.equal(harness.appliedOutputStates.length, 1)
  assert.deepEqual(harness.errors, [])
})

test('setAudioOutput failure is reported without applying state', async () => {
  const failing = createHarnessWithApi({
    setAudioOutput: async () => {
      throw new Error('device gone')
    }
  })
  await failing.controller.setAudioOutput('wasapi' as AudioOutputId)
  assert.deepEqual(failing.errors, ['device gone'])
  assert.deepEqual(failing.appliedOutputStates, [])
})

test('setAudioProcessing applies result, refreshes playback info, and schedules crossfade', async () => {
  const harness = createHarness()
  await harness.controller.setAudioProcessing({ dspEnabled: true })
  assert.equal(harness.audioProcessing.value.dspEnabled, true)
  assert.equal(harness.playbackInfoRefreshes, 1)
  assert.equal(harness.crossfadeSchedules, 1)
  assert.equal(harness.processingRequests.length, 1)
  assert.equal(harness.processingRequests[0].eqBands.length, 0)
})

test('setAudioProcessing rolls back to the previous snapshot on failure', async () => {
  const harness = createHarness()
  harness.audioProcessing.value = createSettings({ crossfadeSeconds: 4 })
  harness.failProcessing = true
  await harness.controller.setAudioProcessing({ dspEnabled: true })
  assert.equal(harness.audioProcessing.value.dspEnabled, false)
  assert.equal(harness.audioProcessing.value.crossfadeSeconds, 4)
  assert.deepEqual(harness.errors, ['engine rejected processing update'])
  assert.equal(harness.crossfadeSchedules, 0)
})

test('setAudioOutputConfig ignores reentrant requests while pending', async () => {
  const harness = createHarness()
  const first = harness.controller.setAudioOutputConfig({ preferredBufferSize: 256 })
  const second = await harness.controller.setAudioOutputConfig({ preferredBufferSize: 512 })
  assert.equal(harness.audioOutputConfigApplyStatus.value.state, 'pending')
  assert.equal(harness.setOutputConfigCalls, 1)
  harness.releaseOutputConfig()
  await first
  void second
  assert.equal(harness.audioOutputConfig.value.preferredBufferSize, 256)
  assert.equal(harness.audioOutputConfigApplyStatus.value.state, 'applied')
})

test('setAudioOutputConfig records failed revision when the engine rejects', async () => {
  const harness = createHarnessWithApi({
    setOutputConfig: async () => {
      throw new Error('config rejected')
    },
    getOutputConfigApplyStatus: async () => ({})
  })
  await harness.controller.setAudioOutputConfig({ routingMode: 'stereo' })
  assert.equal(harness.audioOutputConfigApplyStatus.value.state, 'failed')
  assert.equal(harness.audioOutputConfigApplyStatus.value.failedRevision, 1)
  assert.equal(harness.audioOutputConfigApplyStatus.value.error, 'config rejected')
})

test('toggleCrossfeed seeds the default strength when enabling from zero', async () => {
  const harness = createHarness()
  await harness.controller.toggleCrossfeed()
  const request = harness.processingRequests[0]
  assert.equal(request.crossfeedEnabled, true)
  assert.equal(request.crossfeedStrength, 0.35)
})

test('setCrossfeedStrength clamps into [0, 1] and derives the enable flag', async () => {
  const harness = createHarness()
  await harness.controller.setCrossfeedStrength(2.5)
  assert.equal(harness.processingRequests[0].crossfeedStrength, 1)
  assert.equal(harness.processingRequests[0].crossfeedEnabled, true)
  await harness.controller.setCrossfeedStrength(0)
  assert.equal(harness.processingRequests[1].crossfeedEnabled, false)
})

test('applyAudioProcessingState replaces the snapshot without engine calls', async () => {
  const harness = createHarness()
  harness.controller.applyAudioProcessingState(createSettings({ eqEnabled: true }))
  assert.equal(harness.audioProcessing.value.eqEnabled, true)
  assert.equal(harness.processingRequests.length, 0)
  assert.equal(harness.playbackInfoRefreshes, 0)
})

test('selectImpulseResponse persists the fallback when loading fails', async () => {
  const harness = createHarness()
  harness.failImpulseLoad = true
  await harness.controller.selectImpulseResponse()
  assert.equal(harness.persistCalls.length, 1)
  assert.equal(harness.persistCalls[0].settings.convolverIrPath, 'ir.wav')
  assert.equal(harness.playbackInfoRefreshes, 0)
})

function createHarnessWithApi(apiOverrides: Record<string, unknown>): Harness {
  return rebuildHarness(apiOverrides)
}

function rebuildHarness(apiOverrides: Record<string, unknown>): Harness {
  const base = createHarness()
  const controller = createAudioOutputController({
    exclusiveMode: base.exclusiveMode,
    audioProcessing: base.audioProcessing,
    audioOutputConfig: base.audioOutputConfig,
    audioOutputConfigApplyStatus: base.audioOutputConfigApplyStatus,
    dspOutputStage: ref({ ...DEFAULT_DSP_OUTPUT_STAGE }),
    dspStereoImage: ref({ ...DEFAULT_DSP_STEREO_IMAGE }),
    getAudioEngineApi: () => apiOverrides as unknown as AudioEngineApi,
    applyAudioOutputState: (state) => base.appliedOutputStates.push(state),
    setAudioEngineError: (error) => base.errors.push(error ?? ''),
    scheduleCrossfadeIfNeeded: () => {},
    refreshPlaybackInfo: async () => {},
    persistAudioProcessingFallback: async (settings, reason) => {
      base.persistCalls.push({ settings, reason })
    }
  })
  return {
    ...base,
    controller
  }
}
