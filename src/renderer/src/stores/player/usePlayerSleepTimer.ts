import type { Ref } from 'vue'
import type {
  SleepTimerMode,
  SleepTimerSettings,
  SleepTimerState
} from '../../../../shared/sleepTimer.ts'
import { createSleepTimerController, type SleepTimerBridge } from '../sleepTimerController.ts'
import { createSleepTimerFadeController } from '../sleepTimerFade.ts'

export interface PlayerSleepTimerOptions {
  volume: Ref<number>
  muted: Ref<boolean>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  state: Ref<SleepTimerState | null>
  notice: Ref<string | null>
  getSettings: () => SleepTimerSettings
  getBridge: () => SleepTimerBridge | null | undefined
  persistSession: () => void
  clearCrossfade: () => void
  stopVisualization: () => void
  stopRendererAudio: () => void
  stopNativeAudio: () => Promise<void>
}

export function createPlayerSleepTimer(options: PlayerSleepTimerOptions) {
  let fadeController: ReturnType<typeof createSleepTimerFadeController> | null = null
  let timerController: ReturnType<typeof createSleepTimerController> | null = null

  function clearIntervals(): void {
    fadeController?.clear()
  }

  function stopForSleepTimer(): void {
    options.clearCrossfade()
    options.stopVisualization()
    options.stopRendererAudio()
    void options.stopNativeAudio()
    options.isPlaying.value = false
    options.isLoading.value = false
    options.notice.value = '睡眠定时器已停止播放'
  }

  function beginSleepShutdown(state: SleepTimerState): void {
    getFadeController().begin(state)
  }

  function getFadeController(): ReturnType<typeof createSleepTimerFadeController> {
    if (!fadeController) {
      fadeController = createSleepTimerFadeController({
        getVolume: () => (options.muted.value ? 0 : options.volume.value),
        setVolume: (nextVolume) => {
          options.volume.value = nextVolume
          if (nextVolume > 0.001) options.muted.value = false
        },
        stop: stopForSleepTimer
      })
    }
    return fadeController
  }

  function getController(): ReturnType<typeof createSleepTimerController> {
    if (!timerController) {
      timerController = createSleepTimerController({
        bridge: options.getBridge(),
        getSettings: options.getSettings,
        getState: () => options.state.value,
        setState: (state) => {
          options.state.value = state
        },
        persistSession: options.persistSession,
        setNotice: (notice) => {
          options.notice.value = notice
        },
        onTriggered: beginSleepShutdown
      })
    }
    return timerController
  }

  function configure(mode: SleepTimerMode, minutes?: number): void {
    clearIntervals()
    getController().configure(mode, minutes)
  }

  function cancel(): void {
    clearIntervals()
    getController().cancel()
  }

  return {
    clearIntervals,
    getController,
    configure,
    cancel
  }
}

