import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDsdState, normalizeNativePlaybackInfo } from './playerPlaybackInfo.ts'
import type { PlaybackInfo } from '../../../preload/types'

function makeInfo(partial: Record<string, unknown> = {}): PlaybackInfo {
  return {
    state: 'playing',
    position: 10,
    duration: 240,
    volume: 0.7,
    requestedConfigRevision: 1,
    appliedConfigRevision: 1,
    queueIndex: 0,
    playMode: 'sequential',
    source: 'C:\\music\\track.flac',
    codec: 'flac',
    bitrate: 900,
    sourceSampleRate: 44100,
    sourceBitDepth: 16,
    decodedSampleRate: 44100,
    decodedBitDepth: 16,
    decodedChannels: 2,
    decodedSampleFormat: 's16',
    outputBackend: 'wasapi',
    outputDevice: 'default',
    outputInfo: {} as PlaybackInfo['outputInfo'],
    actualBackend: 'wasapi',
    driverName: '',
    driverVersion: 0,
    actualOutputFormat: 'PCM',
    actualSampleRate: 44100,
    actualBitDepth: 16,
    actualChannels: 2,
    bufferSizeFrames: 512,
    latencyFrames: 11,
    latencyMs: 5,
    latencyInfo: { bufferLatencyMs: 5, outputLatencyMs: 0, totalLatencyMs: 5 },
    channelRoutingMode: 'auto',
    supportsOutputPerfect: true,
    sourceExact: true,
    diagnostics: {
      sessionUnderrunCount: 0,
      sessionBufferDropCount: 0,
      sessionRecoveryCount: 0,
      lifetimeUnderrunCount: 0,
      lifetimeBufferDropCount: 0,
      lifetimeRecoveryCount: 0,
      driverRestartCount: 0,
      deviceLostCount: 0,
      lastError: ''
    },
    deviceRecovered: false,
    recoveryCount: 0,
    outputSampleRate: 44100,
    outputBitDepth: 16,
    channelCount: 2,
    outputPerfect: true,
    pcmPassthrough: true,
    dspActive: false,
    replayGainActive: false,
    eqActive: false,
    convolverActive: false,
    crossfeedActive: false,
    crossfadeActive: false,
    fftActive: false,
    irResampled: false,
    replayGainDb: 0,
    crossfeedStrength: 0,
    crossfadeSeconds: 0,
    convolverLatencyFrames: 0,
    partitionSize: 0,
    channelMappingMode: 'stereo',
    perfectReason: '',
    perfectReasonCode: '',
    isDsd: false,
    dsdMode: 'pcm',
    dsdRate: 0,
    actualDsdRate: 0,
    dsdRatePolicy: 'pcm-fallback',
    dsdConversion: 'exact',
    dsdConversionReason: '',
    gaplessActive: false,
    preloadReady: true,
    gaplessBlockedReason: '',
    upcomingTrack: null,
    nativePlaybackActive: true,
    ...partial
  }
}

test('normalizeDsdState prefers canonical output state and falls back to mirror state', () => {
  assert.deepEqual(normalizeDsdState({ dsdMode: ' native ', dsdRate: 352800 }, null), {
    isDsd: true,
    dsdMode: 'native',
    dsdRate: 352800
  })
  assert.deepEqual(normalizeDsdState({ isDsd: false, dsdMode: 'native', dsdRate: 352800 }, null), {
    isDsd: false,
    dsdMode: 'pcm',
    dsdRate: 0
  })
  assert.deepEqual(normalizeDsdState({}, { dsdMode: 'unsupported', dsdRate: 2822400 }), {
    isDsd: true,
    dsdMode: 'unsupported',
    dsdRate: 2822400
  })
  assert.deepEqual(normalizeDsdState({}, { isDsd: true }), {
    isDsd: true,
    dsdMode: 'unsupported',
    dsdRate: 0
  })
  assert.deepEqual(normalizeDsdState(null, { dsdMode: 'dop', dsdRate: 2822400 }), {
    isDsd: true,
    dsdMode: 'dop',
    dsdRate: 2822400
  })
  assert.deepEqual(normalizeDsdState({}, {}), { isDsd: false, dsdMode: 'pcm', dsdRate: 0 })
})

test('normalizeNativePlaybackInfo merges canonical output info over mirror fields', () => {
  const normalized = normalizeNativePlaybackInfo(
    makeInfo({
      outputInfo: {
        actualBackend: 'asio',
        accessMode: 'exclusive',
        devicePathKind: 'asio',
        actualOutputFormat: 'DSD',
        actualSampleRate: 352800,
        actualBitDepth: 1,
        actualChannels: 2,
        bufferSizeFrames: 256,
        latencyFrames: 5,
        latencyMs: 2,
        latencyInfo: { bufferLatencyMs: 2, outputLatencyMs: 0, totalLatencyMs: 2 },
        channelRoutingMode: 'manual',
        supportsOutputPerfect: false,
        sourceExact: false,
        diagnostics: {
          sessionUnderrunCount: 0,
          sessionBufferDropCount: 0,
          sessionRecoveryCount: 0,
          lifetimeUnderrunCount: 0,
          lifetimeBufferDropCount: 0,
          lifetimeRecoveryCount: 0,
          driverRestartCount: 0,
          deviceLostCount: 0
        },
        deviceRecovered: true,
        recoveryCount: 3,
        outputSampleRate: 352800,
        outputBitDepth: 1,
        outputPerfect: false,
        pcmPassthrough: false,
        perfectReason: 'x',
        perfectReasonCode: 'x',
        capabilityReason: 'x',
        isDsd: true,
        dsdMode: 'native',
        dsdRate: 352800,
        deviceName: 'ASIO Device'
      }
    })
  ) as Record<string, any>

  assert.equal(normalized.outputInfo.actualBackend, 'asio')
  assert.equal(normalized.actualBackend, 'asio')
  assert.equal(normalized.outputInfo.accessMode, 'exclusive')
  assert.equal(normalized.actualSampleRate, 352800)
  assert.equal(normalized.outputInfo.channelRoutingMode, 'manual')
  assert.equal(normalized.outputInfo.sourceExact, false)
  assert.equal(normalized.outputInfo.outputPerfect, false)
  assert.equal(normalized.outputInfo.deviceRecovered, true)
  assert.equal(normalized.outputInfo.recoveryCount, 3)
  assert.equal(normalized.outputInfo.pcmPassthrough, false)
  assert.equal(normalized.outputInfo.perfectReason, 'x')
  assert.equal(normalized.outputInfo.perfectReasonCode, 'x')
  assert.equal(normalized.outputInfo.capabilityReason, 'x')
  assert.equal(normalized.outputInfo.isDsd, true)
  assert.equal(normalized.outputInfo.dsdMode, 'native')
  assert.equal(normalized.outputInfo.dsdRate, 352800)
  assert.equal(normalized.outputInfo.deviceName, 'ASIO Device')
  assert.equal(normalized.nativePlaybackActive, true)
})

test('normalizeNativePlaybackInfo fills missing output fields from the top-level mirror', () => {
  const normalized = normalizeNativePlaybackInfo(makeInfo({ outputInfo: {} })) as Record<
    string,
    any
  >

  assert.equal(normalized.outputInfo.actualBackend, 'wasapi')
  assert.equal(normalized.actualBackend, 'wasapi')
  assert.equal(normalized.outputInfo.actualOutputFormat, 'PCM')
  assert.equal(normalized.outputInfo.actualSampleRate, 44100)
  assert.equal(normalized.outputInfo.actualBitDepth, 16)
  assert.equal(normalized.outputInfo.actualChannels, 2)
  assert.equal(normalized.outputInfo.bufferSizeFrames, 512)
  assert.equal(normalized.outputInfo.latencyFrames, 11)
  assert.equal(normalized.outputInfo.latencyMs, 5)
  assert.deepEqual(normalized.outputInfo.latencyInfo, {
    bufferLatencyMs: 5,
    outputLatencyMs: 0,
    totalLatencyMs: 5
  })
  assert.equal(normalized.outputInfo.channelRoutingMode, 'auto')
  assert.equal(normalized.outputInfo.diagnostics.sessionUnderrunCount, 0)
  assert.equal(normalized.outputInfo.deviceRecovered, false)
  assert.equal(normalized.outputInfo.recoveryCount, 0)
  assert.equal(normalized.outputInfo.outputSampleRate, 44100)
  assert.equal(normalized.outputInfo.outputBitDepth, 16)
})

test('normalizeNativePlaybackInfo normalizes DSD state from output or mirror mode', () => {
  const fromOutput = normalizeNativePlaybackInfo(
    makeInfo({ outputInfo: { dsdMode: ' native ', dsdRate: 352800 } })
  ) as Record<string, any>
  assert.equal(fromOutput.outputInfo.isDsd, true)
  assert.equal(fromOutput.outputInfo.dsdMode, 'native')
  assert.equal(fromOutput.outputInfo.dsdRate, 352800)
  assert.equal(fromOutput.isDsd, true)
  assert.equal(fromOutput.dsdMode, 'native')
  assert.equal(fromOutput.dsdRate, 352800)

  const fromMirror = normalizeNativePlaybackInfo(
    makeInfo({ outputInfo: {}, dsdMode: 'unsupported', dsdRate: 2822400 })
  ) as Record<string, any>
  assert.equal(fromMirror.outputInfo.isDsd, true)
  assert.equal(fromMirror.outputInfo.dsdMode, 'unsupported')
  assert.equal(fromMirror.outputInfo.dsdRate, 2822400)

  const canonicalWins = normalizeNativePlaybackInfo(
    makeInfo({ outputInfo: { isDsd: false, dsdMode: 'native', dsdRate: 352800 } })
  ) as Record<string, any>
  assert.equal(canonicalWins.outputInfo.isDsd, false)
  assert.equal(canonicalWins.outputInfo.dsdMode, 'pcm')
  assert.equal(canonicalWins.outputInfo.dsdRate, 0)
})

test('normalizeNativePlaybackInfo falls back to mirror pcmPassthrough when outputInfo is absent', () => {
  const normalized = normalizeNativePlaybackInfo(makeInfo({ outputInfo: undefined })) as Record<
    string,
    any
  >
  assert.equal(normalized.outputInfo.pcmPassthrough, true)
  assert.equal(normalized.pcmPassthrough, true)
  assert.equal(normalized.outputInfo.channelRoutingMode, 'auto')
})

test('normalizeNativePlaybackInfo adds legacy conversion facts to an old payload', () => {
  const normalized = normalizeNativePlaybackInfo(
    makeInfo({ outputInfo: { resampled: true } })
  ) as Record<string, any>

  assert.equal(normalized.outputInfo.providerImplementation, 'legacy-native')
  assert.deepEqual(normalized.outputInfo.conversionInfo, {
    sampleFormatConverted: false,
    sampleRateConverted: true,
    channelLayoutConverted: false,
    source: 'unavailable'
  })
})

test('normalizeNativePlaybackInfo keeps provider facts while resampled remains authoritative', () => {
  const normalized = normalizeNativePlaybackInfo(
    makeInfo({
      outputInfo: {
        resampled: false,
        providerImplementation: 'miniaudio',
        conversionInfo: {
          sampleFormatConverted: true,
          sampleRateConverted: true,
          channelLayoutConverted: true,
          source: 'backend-runtime'
        }
      }
    })
  ) as Record<string, any>

  assert.equal(normalized.outputInfo.providerImplementation, 'miniaudio')
  assert.deepEqual(normalized.outputInfo.conversionInfo, {
    sampleFormatConverted: true,
    sampleRateConverted: false,
    channelLayoutConverted: true,
    source: 'backend-runtime'
  })
})
