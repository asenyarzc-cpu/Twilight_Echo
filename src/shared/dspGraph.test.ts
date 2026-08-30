import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyStereoImageToGraph,
  createDspFactoryScene,
  createLegacyDspGraph,
  DEFAULT_DSP_OUTPUT_STAGE,
  DEFAULT_DSP_STEREO_IMAGE,
  DSP_FACTORY_SCENE_TEMPLATES,
  DSP_RESAMPLER_QUALITY_OPTIONS,
  dspGraphNodeAltersSignal,
  extractStereoImageFromGraph,
  mergeDspOutputStage,
  mergeDspStereoImage,
  normalizeDspOutputStage,
  normalizeDspScenes,
  outputStageIsActive,
  resolveDspScene,
  stereoImageIsActive,
  type DspScene
} from './dspGraph.ts'

test('legacy DSP settings migrate into the fixed legacy graph order', () => {
  const graph = createLegacyDspGraph({
    dspEnabled: true,
    eqEnabled: true,
    convolverEnabled: true,
    convolverIrPath: 'room.wav',
    crossfeedEnabled: true,
    crossfeedStrength: 0.5
  })
  assert.deepEqual(
    graph.nodes.slice(0, 4).map((node) => node.type),
    ['replayGain', 'equalizer', 'convolver', 'crossfeed']
  )
  assert.equal(graph.nodes[1]?.enabled, true)
  assert.equal(graph.nodes[2]?.enabled, true)
})

test('legacy loudnorm mode enables replayGain node without aliasing to track', () => {
  const graph = createLegacyDspGraph({
    dspEnabled: true,
    volumeNormalization: 'loudnorm',
    replayGainPreamp: 1.5,
    replayGainFallback: -3,
    replayGainClip: true
  })
  const replayGain = graph.nodes.find((node) => node.type === 'replayGain')
  assert.equal(replayGain?.enabled, true)
  assert.equal(replayGain?.params.mode, 'loudnorm')
  assert.equal(replayGain?.params.preampDb, 1.5)
  assert.equal(replayGain?.params.fallbackDb, -3)
  assert.equal(replayGain?.params.targetLufs, -23)
  assert.equal(replayGain?.params.truePeakCeilingDb, -1)
})

test('createLegacyDspGraph preserves HiFi outputStage sample-rate lock', () => {
  const graph = createLegacyDspGraph({
    dspEnabled: true,
    eqEnabled: true,
    outputStage: {
      targetSampleRate: 96000,
      resamplerQuality: 'high',
      dither: 'tpdf',
      safetyClamp: true
    }
  })
  assert.equal(graph.outputStage.targetSampleRate, 96000)
  assert.equal(graph.outputStage.resamplerQuality, 'high')
  assert.equal(graph.outputStage.dither, 'tpdf')
  assert.equal(graph.outputStage.safetyClamp, true)
})

test('normalizeDspOutputStage accepts SoX resampler tiers and rejects unknown values', () => {
  assert.equal(
    normalizeDspOutputStage({ ...DEFAULT_DSP_OUTPUT_STAGE, resamplerQuality: 'soxrHq' })
      .resamplerQuality,
    'soxrHq'
  )
  assert.equal(
    normalizeDspOutputStage({ ...DEFAULT_DSP_OUTPUT_STAGE, resamplerQuality: 'soxrVhq' })
      .resamplerQuality,
    'soxrVhq'
  )
  assert.equal(
    normalizeDspOutputStage({ ...DEFAULT_DSP_OUTPUT_STAGE, resamplerQuality: 'soxr' })
      .resamplerQuality,
    'native'
  )
  assert.deepEqual(
    DSP_RESAMPLER_QUALITY_OPTIONS.map((option) => option.value),
    ['native', 'high', 'ultra', 'soxrHq', 'soxrVhq']
  )
  // A SoX tier alone (device rate, no dither) still forces non-passthrough SRC.
  assert.equal(
    outputStageIsActive(
      mergeDspOutputStage(DEFAULT_DSP_OUTPUT_STAGE, { resamplerQuality: 'soxrVhq' })
    ),
    true
  )
})

test('outputStageIsActive and mergeDspOutputStage treat device+native+off as inactive', () => {
  assert.equal(outputStageIsActive(DEFAULT_DSP_OUTPUT_STAGE), false)
  assert.equal(
    outputStageIsActive(mergeDspOutputStage(DEFAULT_DSP_OUTPUT_STAGE, { targetSampleRate: 48000 })),
    true
  )
  assert.equal(
    mergeDspOutputStage(
      { ...DEFAULT_DSP_OUTPUT_STAGE, targetSampleRate: 44100 },
      { dither: 'tpdf' }
    ).targetSampleRate,
    44100
  )
})

test('scene resolver prefers a manual pin and otherwise uses priority then specificity', () => {
  const scenes = normalizeDspScenes([
    { id: 'default', name: 'Default', enabled: true, priority: 0, rules: {}, graph: { nodes: [] } },
    {
      id: 'dac',
      name: 'DAC',
      enabled: true,
      priority: 1,
      rules: { deviceIds: ['dac-1'] },
      graph: { nodes: [] }
    }
  ]) as DspScene[]
  const context = {
    deviceId: 'dac-1',
    backend: 'wasapi',
    channelLayout: 'stereo' as const,
    sourceKind: 'pcm' as const,
    sampleRate: 96000
  }
  assert.equal(resolveDspScene(scenes, context).scene?.id, 'dac')
  assert.equal(resolveDspScene(scenes, context, 'default').scene?.id, 'default')
})

test('DSD resolution reports a PCM fallback requirement without applying it', () => {
  const scenes = normalizeDspScenes([
    {
      id: 'eq',
      name: 'EQ',
      enabled: true,
      priority: 0,
      rules: {},
      graph: { nodes: [{ id: 'eq', type: 'equalizer', enabled: true, params: {} }] }
    }
  ])
  const resolution = resolveDspScene(scenes, {
    deviceId: 'dac-1',
    backend: 'asio',
    channelLayout: 'stereo',
    sourceKind: 'dsd',
    sampleRate: 2822400
  })
  assert.equal(resolution.requiresPcmFallback, true)
})

test('factory DSP templates provide editable professional starting points', () => {
  assert.deepEqual(
    DSP_FACTORY_SCENE_TEMPLATES.map((template) => template.id),
    [
      'transparent',
      'headphoneCrossfeed',
      'headphoneCorrection',
      'roomCorrection',
      'speakerCalibration51',
      'speakerCalibration71'
    ]
  )

  const transparent = createDspFactoryScene('transparent', 'transparent')
  assert.deepEqual(
    transparent.graph.nodes.map((node) => node.type),
    ['meter']
  )

  const crossfeed = createDspFactoryScene('headphoneCrossfeed', 'headphones')
  assert.equal(crossfeed.rules.channelLayouts?.[0], 'stereo')
  assert.equal(crossfeed.graph.nodes[0]?.type, 'crossfeed')
  assert.equal(crossfeed.graph.nodes[0]?.enabled, true)

  const room = createDspFactoryScene('roomCorrection', 'room')
  assert.equal(room.graph.nodes[0]?.type, 'convolver')
  assert.equal(room.graph.nodes[0]?.enabled, false)

  const surround = createDspFactoryScene('speakerCalibration71', 'surround')
  const strip = surround.graph.nodes.find((node) => node.type === 'channelStrip')
  assert.equal(surround.rules.channelLayouts?.[0], '7.1')
  assert.equal(strip?.enabled, false)
  assert.equal((strip?.params.channels as unknown[])?.length, 8)
  ;(strip?.params.channels as Array<Record<string, unknown>>)[0].gainDb = 3
  const freshSurround = createDspFactoryScene('speakerCalibration71', 'fresh-surround')
  const freshStrip = freshSurround.graph.nodes.find((node) => node.type === 'channelStrip')
  assert.equal((freshStrip?.params.channels as Array<Record<string, unknown>>)[0].gainDb, 0)
})

test('createLegacyDspGraph preserves HiFi stereoImage balance/phase across rewrite', () => {
  const graph = createLegacyDspGraph({
    dspEnabled: true,
    stereoImage: {
      balance: 0.35,
      width: 1.2,
      invertLeft: true,
      invertRight: false
    }
  })
  const stereo = graph.nodes.find((node) => node.type === 'stereoField')
  const strip = graph.nodes.find((node) => node.type === 'channelStrip')
  assert.equal(stereo?.enabled, true)
  assert.equal(stereo?.params.balance, 0.35)
  assert.equal(stereo?.params.width, 1.2)
  assert.equal(stereo?.params.invertLeft, true)
  assert.equal(strip?.enabled, true)
  const channels = strip?.params.channels as Array<Record<string, unknown>>
  assert.equal(channels[0]?.polarityInverted, true)
  assert.equal(channels[1]?.polarityInverted, false)

  const rewritten = createLegacyDspGraph({
    dspEnabled: true,
    eqEnabled: true,
    stereoImage: extractStereoImageFromGraph(graph)
  })
  assert.deepEqual(extractStereoImageFromGraph(rewritten), extractStereoImageFromGraph(graph))
})

test('stereoImage helpers treat neutral balance/width/phase as inactive', () => {
  assert.equal(stereoImageIsActive(DEFAULT_DSP_STEREO_IMAGE), false)
  assert.equal(
    stereoImageIsActive(mergeDspStereoImage(DEFAULT_DSP_STEREO_IMAGE, { balance: 0.1 })),
    true
  )
  assert.equal(
    stereoImageIsActive(mergeDspStereoImage(DEFAULT_DSP_STEREO_IMAGE, { invertRight: true })),
    true
  )
  const patched = applyStereoImageToGraph(createLegacyDspGraph({}), { width: 0.5, mono: true })
  const image = extractStereoImageFromGraph(patched)
  assert.equal(image.width, 0.5)
  assert.equal(image.mono, true)
  assert.equal(stereoImageIsActive(image), true)
})

test('an enabled node left at its identity settings does not alter the signal', () => {
  const node = (type: string, params: Record<string, unknown>) =>
    ({ id: type, type, enabled: true, params }) as Parameters<typeof dspGraphNodeAltersSignal>[0]

  // A legacy scene enables the node as soon as the module toggle is on, so these
  // identity settings are the common case - and used to cost DSD its passthrough.
  assert.equal(
    dspGraphNodeAltersSignal(
      node('equalizer', {
        mode: 'graphic',
        preampDb: 0,
        bands: [{ frequency: 1000, gain: 0, q: 1, filterType: 'peak', enabled: true }]
      })
    ),
    false
  )
  assert.equal(dspGraphNodeAltersSignal(node('replayGain', { mode: 'off' })), false)
  assert.equal(dspGraphNodeAltersSignal(node('crossfeed', { strength: 0 })), false)
  assert.equal(dspGraphNodeAltersSignal(node('convolver', { impulseResponsePath: '' })), false)
  assert.equal(dspGraphNodeAltersSignal(node('meter', {})), false)

  assert.equal(dspGraphNodeAltersSignal(node('replayGain', { mode: 'track' })), true)
  assert.equal(dspGraphNodeAltersSignal(node('crossfeed', { strength: 0.4 })), true)
  assert.equal(
    dspGraphNodeAltersSignal(node('convolver', { impulseResponsePath: 'C:/ir/room.wav' })),
    true
  )
  assert.equal(
    dspGraphNodeAltersSignal(
      node('equalizer', {
        preampDb: 0,
        bands: [{ frequency: 80, gain: 0, q: 1, filterType: 'highPass', enabled: true }]
      })
    ),
    true
  )
  // Unknown or unmodelled node types stay conservative.
  assert.equal(dspGraphNodeAltersSignal(node('truePeakLimiter', {})), true)
  assert.equal(
    dspGraphNodeAltersSignal({
      id: 'eq',
      type: 'equalizer',
      enabled: false,
      params: { preampDb: -6, bands: [] }
    } as Parameters<typeof dspGraphNodeAltersSignal>[0]),
    false
  )
})
