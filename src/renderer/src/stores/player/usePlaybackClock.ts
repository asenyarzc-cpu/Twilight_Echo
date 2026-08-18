import type { Ref } from 'vue'

export const TIME_UPDATE_INTERVAL_MS = 250 as const

export interface PlaybackClockOptions {
  currentTime: Ref<number>
  getNow: () => number
  enforceAbLoop: (time: number) => void
  onTick: () => void
}

export function createPlaybackClock(options: PlaybackClockOptions) {
  let latestPlaybackTime = 0
  let lastTimePublishAt = 0
  let pendingTimePublishTimer: number | null = null
  let rendererClockTimer: number | null = null

  function cancelScheduledPublish(): void {
    if (pendingTimePublishTimer !== null) {
      window.clearTimeout(pendingTimePublishTimer)
      pendingTimePublishTimer = null
    }
  }

  function publishCurrentTime(time: number): void {
    latestPlaybackTime = time
    options.currentTime.value = time
    lastTimePublishAt = options.getNow()
    options.enforceAbLoop(time)
  }

  function publishLatestCurrentTime(): void {
    pendingTimePublishTimer = null
    publishCurrentTime(latestPlaybackTime)
  }

  function setCurrentTimeThrottled(time: number): void {
    latestPlaybackTime = time
    options.enforceAbLoop(time)
    const now = options.getNow()
    const remainingMs = TIME_UPDATE_INTERVAL_MS - (now - lastTimePublishAt)

    if (remainingMs <= 0 || options.currentTime.value === 0) {
      cancelScheduledPublish()
      publishCurrentTime(time)
      return
    }

    if (pendingTimePublishTimer === null) {
      pendingTimePublishTimer = window.setTimeout(publishLatestCurrentTime, remainingMs)
    }
  }

  function flushLatestCurrentTime(): void {
    cancelScheduledPublish()
    publishCurrentTime(latestPlaybackTime)
  }

  function startRendererClock(): void {
    if (rendererClockTimer !== null) return
    rendererClockTimer = window.setInterval(options.onTick, TIME_UPDATE_INTERVAL_MS)
  }

  function stopRendererClock(): void {
    if (rendererClockTimer === null) return
    window.clearInterval(rendererClockTimer)
    rendererClockTimer = null
  }

  function getLatestPlaybackTime(): number {
    return latestPlaybackTime
  }

  return {
    getLatestPlaybackTime,
    publishCurrentTime,
    publishLatestCurrentTime,
    setCurrentTimeThrottled,
    flushLatestCurrentTime,
    cancelScheduledPublish,
    startRendererClock,
    stopRendererClock
  }
}
