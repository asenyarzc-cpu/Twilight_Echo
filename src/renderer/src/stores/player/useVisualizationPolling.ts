import type { Ref } from 'vue'

export const VISUALIZATION_UPDATE_INTERVAL_MS = 200 as const

export type NativeVisualizationData = Awaited<
  ReturnType<Window['api']['audioEngine']['getVisualizationData']>
>

export const visualizationOptions = {
  spectrumPoints: 64,
  waveformPoints: 48,
  spectrogramFrames: 32,
  oscilloscopePoints: 512
} as const

export function createInactiveVisualizationData(): NativeVisualizationData {
  return {
    spectrum: Array.from({ length: visualizationOptions.spectrumPoints }, () => 0),
    waveform: Array.from({ length: visualizationOptions.waveformPoints }, () => 0),
    oscilloscope: Array.from({ length: visualizationOptions.oscilloscopePoints }, () => 0),
    peakDb: -120,
    rmsDb: -120,
    lufsMomentary: null,
    spectrogram: [],
    sampleRate: 0,
    maxFrequency: 20000,
    active: false,
    tapStatus: 'stopped',
    reason: ''
  }
}

export interface VisualizationPollingOptions {
  data: Ref<NativeVisualizationData>
  active: Ref<boolean>
}

export function createVisualizationPolling(options: VisualizationPollingOptions) {
  let timer: number | null = null
  let requestInFlight = false
  let pollingGeneration = 0

  async function refresh(): Promise<void> {
    if (requestInFlight) return
    const generation = pollingGeneration
    requestInFlight = true
    try {
      const next = await window.api.audioEngine.getVisualizationData(visualizationOptions)
      if (generation !== pollingGeneration) return
      options.data.value = next
    } catch {
      if (generation !== pollingGeneration) return
      options.data.value = createInactiveVisualizationData()
    } finally {
      requestInFlight = false
    }
  }

  function stop(clearData = false): void {
    pollingGeneration += 1
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    if (clearData) options.data.value = createInactiveVisualizationData()
  }

  function start(): void {
    if (options.active.value) return
    if (timer !== null) return
    void refresh()
    timer = window.setInterval(() => void refresh(), VISUALIZATION_UPDATE_INTERVAL_MS)
  }

  return {
    refresh,
    stop,
    start
  }
}
