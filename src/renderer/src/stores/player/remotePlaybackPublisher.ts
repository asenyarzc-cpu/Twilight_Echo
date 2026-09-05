import { watch, type Ref, type WatchStopHandle } from 'vue'
import type { Track } from '@renderer/types/music.ts'
import type { RemotePlaybackSnapshot } from '../../../../shared/remoteControl.ts'

const SAFE_RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,/i
const MAX_COVER_DATA_URL_LENGTH = 256 * 1024

export interface RemotePlaybackPublisherOptions {
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
  volume: Ref<number>
  muted: Ref<boolean>
  queueIndex: Ref<number>
  queue: Ref<Track[]>
  playMode: Ref<unknown>
  castTarget: Ref<string | null>
  snapshotExtras: () => Pick<RemotePlaybackSnapshot, 'playMode' | 'queueRevision'>
  publish: (snapshot: Partial<RemotePlaybackSnapshot>) => Promise<boolean> | void
  resolveCover: (handle: string | null | undefined) => Promise<string | null>
}

export function createRemotePlaybackPublisher(options: RemotePlaybackPublisherOptions): () => void {
  let lastPublishedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let resolvedCover: string | null = null
  let publishedCover: string | null | undefined
  let coverGeneration = 0

  const publish = (): void => {
    const now = Date.now()
    const wait = 400 - (now - lastPublishedAt)
    if (wait > 0) {
      if (!timer)
        timer = setTimeout(() => {
          timer = null
          publish()
        }, wait)
      return
    }
    lastPublishedAt = now
    const track = options.currentTrack.value
    const isLive =
      track?.source === 'radio' ||
      (typeof track?.duration === 'number' && track.duration <= 0 && options.duration.value <= 0)
    const coverChanged = publishedCover !== resolvedCover
    publishedCover = resolvedCover
    void Promise.resolve(
      options.publish({
        state: options.isPlaying.value ? 'playing' : track ? 'paused' : 'stopped',
        title: track?.title ?? '',
        artist: track?.artist ?? '',
        album: track?.album ?? '',
        position: options.currentTime.value,
        duration: options.duration.value,
        volume: options.volume.value,
        muted: options.muted.value,
        queueIndex: options.queueIndex.value,
        queueLength: options.queue.value.length,
        ...(coverChanged ? { coverUrl: resolvedCover } : {}),
        isLive: Boolean(isLive),
        castTarget: options.castTarget.value,
        ...options.snapshotExtras(),
        updatedAt: now
      })
    ).catch(() => {
      publishedCover = undefined
    })
  }

  const resolveCurrentCover = (): void => {
    const generation = ++coverGeneration
    const handle = options.currentTrack.value?.cover
    resolvedCover = null
    publish()
    if (!handle) {
      publish()
      return
    }
    void options
      .resolveCover(handle)
      .then((cover) => {
        if (generation !== coverGeneration) return
        resolvedCover =
          cover && SAFE_RASTER_DATA_URL.test(cover) && cover.length <= MAX_COVER_DATA_URL_LENGTH
            ? cover
            : null
        publish()
      })
      .catch(() => {
        if (generation === coverGeneration) publish()
      })
  }

  const stop: WatchStopHandle = watch(
    [
      options.isPlaying,
      options.currentTime,
      options.duration,
      options.volume,
      options.muted,
      options.queueIndex,
      options.queue,
      options.playMode,
      options.castTarget,
      () => options.currentTrack.value?.id
    ],
    publish
  )
  const stopCover = watch(() => options.currentTrack.value?.cover, resolveCurrentCover, {
    immediate: true
  })
  publish()
  return () => {
    stop()
    stopCover()
    if (timer) clearTimeout(timer)
    timer = null
    coverGeneration++
  }
}
