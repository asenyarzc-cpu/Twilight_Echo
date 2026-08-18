import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type { AppSettings } from '../../types/settings'
import { hasLyricContent } from '../../utils/lyrics.ts'
import { LYRICS_RETRY_DELAYS_MS } from '../../utils/playerConstants.ts'
import { getTrackSource } from '../../utils/playerTrackUtils.ts'
import {
  resolveLyricsWithSources,
  type LyricResolverSource
} from '../../utils/lyricSourceResolution.ts'
import { resolverLyricsInput } from '../../utils/managedLyricsSource.ts'
import { useLyricsManagement } from '../lyricsManagement.ts'
import { syncPluginProviders, useMediaProviders } from '../../providers'

export interface LyricsLoadState {
  trackId: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed'
}

interface ActiveLyricsLoad {
  signature: string
  generation: number
  activation: number
  controller: AbortController
  promise: Promise<void>
}

const automaticLyricsBaselines = new Map<string, Track>()
const activeLyricsLoads = new Map<string, ActiveLyricsLoad>()
const lyricsLoadGenerationByTrackId = new Map<string, number>()
const lyricsRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lyricsRetryAttemptsByTrackId = new Map<string, number>()
let lyricsTrackActivation = 0

export interface LyricsLoaderOptions {
  currentTrack: Ref<Track | null>
  lyricsLoadState: Ref<LyricsLoadState>
  getAppSettings: () => Ref<AppSettings>
  patchTrackInQueues: (updatedTrack: Track) => void
  getLyricsManagement: typeof useLyricsManagement
}

export function createLyricsLoader(options: LyricsLoaderOptions) {
  function clearLyricsRetryTimer(trackId: string): void {
    const timer = lyricsRetryTimers.get(trackId)
    if (timer != null) clearTimeout(timer)
    lyricsRetryTimers.delete(trackId)
  }

  function clearLyricsRetryTimersExcept(activeTrackId: string): void {
    for (const trackId of lyricsRetryTimers.keys()) {
      if (trackId !== activeTrackId) clearLyricsRetryTimer(trackId)
    }
  }

  function abortInactiveLyricsLoads(activeTrackId: string): void {
    for (const [trackId, request] of activeLyricsLoads) {
      if (trackId !== activeTrackId) request.controller.abort()
    }
  }

  function scheduleCurrentLyricsRetry(trackId: string, activation: number): void {
    if (options.currentTrack.value?.id !== trackId || lyricsTrackActivation !== activation) return
    const attempt = lyricsRetryAttemptsByTrackId.get(trackId) ?? 0
    const delay = LYRICS_RETRY_DELAYS_MS[attempt]
    if (delay == null) return

    lyricsRetryAttemptsByTrackId.set(trackId, attempt + 1)
    clearLyricsRetryTimer(trackId)
    lyricsRetryTimers.set(
      trackId,
      setTimeout(() => {
        lyricsRetryTimers.delete(trackId)
        if (
          options.currentTrack.value?.id !== trackId ||
          lyricsTrackActivation !== activation ||
          hasLyricContent(options.currentTrack.value.lyrics)
        ) {
          return
        }
        void ensureCurrentTrackLyricsLoaded(options.currentTrack.value, true, true)
      }, delay)
    )
  }

  function commitResolvedLyrics(
    triggerTrack: Track,
    resolverTrack: Track,
    resolved: {
      lyrics: string | null
      translatedLyrics: string | null
      lyricsSource: Track['lyricsSource']
      translatedLyricsSource: Track['translatedLyricsSource']
    }
  ): void {
    if (options.currentTrack.value?.id !== triggerTrack.id) return
    const existing = options.currentTrack.value
    const nextLyrics = resolved.lyrics ?? ''
    if (
      !nextLyrics &&
      typeof existing?.lyrics === 'string' &&
      existing.lyrics.length > 0 &&
      existing.id === triggerTrack.id
    ) {
      return
    }
    const updatedTrack = {
      ...resolverTrack,
      ...existing,
      lyrics: nextLyrics,
      translatedLyrics: resolved.translatedLyrics,
      lyricsSource: resolved.lyricsSource,
      translatedLyricsSource: resolved.translatedLyricsSource,
      romanizedLyrics: existing.romanizedLyrics ?? resolverTrack.romanizedLyrics ?? null,
      romanizedLyricsSource:
        existing.romanizedLyricsSource ?? resolverTrack.romanizedLyricsSource ?? null
    }
    options.currentTrack.value = updatedTrack
    options.patchTrackInQueues(updatedTrack)
  }

  async function ensureCurrentTrackLyricsLoaded(
    triggerTrack: Track | null = options.currentTrack.value,
    allowProviderLookup = true,
    forceReload = false
  ): Promise<void> {
    const fallbackTrack = options.currentTrack.value
    if (!triggerTrack && fallbackTrack) triggerTrack = fallbackTrack
    if (!triggerTrack || options.currentTrack.value?.id !== triggerTrack.id) {
      return
    }
    const activation = lyricsTrackActivation
    const lyricsManagement = options.getLyricsManagement()
    try {
      await lyricsManagement.ensureLoaded()
    } catch {
      // The optional management document must never prevent automatic resolution.
    }
    if (options.currentTrack.value?.id !== triggerTrack.id || lyricsTrackActivation !== activation)
      return

    const override = lyricsManagement.entryFor(triggerTrack.id)
    const requestedSource = override?.source ?? 'auto'
    const layerSource = (
      key: 'originalSelection' | 'translationSelection'
    ): LyricResolverSource | 'manual' => {
      const selection = override?.[key]
      if (selection === 'local' || selection === 'provider' || selection === 'manual') {
        return selection
      }
      if (requestedSource === 'local' || requestedSource === 'provider') return requestedSource
      return 'automatic'
    }
    const originalLayerSource = layerSource('originalSelection')
    const translationLayerSource = layerSource('translationSelection')
    const resolverOriginalSource: LyricResolverSource =
      originalLayerSource === 'manual' ? 'automatic' : originalLayerSource
    const resolverTranslationSource: LyricResolverSource =
      translationLayerSource === 'manual' ? 'automatic' : translationLayerSource
    const sourceSelectionSignature = `${requestedSource}:${originalLayerSource}:${translationLayerSource}`

    const requestSignature = `${sourceSelectionSignature}:${allowProviderLookup ? 'provider' : 'local'}`
    const existingRequest = activeLyricsLoads.get(triggerTrack.id)
    if (
      !forceReload &&
      existingRequest?.signature === requestSignature &&
      existingRequest.activation === activation
    ) {
      await existingRequest.promise
      return
    }
    existingRequest?.controller.abort()

    const previousGeneration = lyricsLoadGenerationByTrackId.get(triggerTrack.id) ?? 0
    const loadGeneration = previousGeneration + 1
    lyricsLoadGenerationByTrackId.set(triggerTrack.id, loadGeneration)
    clearLyricsRetryTimer(triggerTrack.id)
    options.lyricsLoadState.value = { trackId: triggerTrack.id, status: 'loading' }

    const request: ActiveLyricsLoad = {
      signature: requestSignature,
      generation: loadGeneration,
      activation,
      controller: new AbortController(),
      promise: Promise.resolve()
    }
    const isCurrentRequest = (): boolean =>
      activeLyricsLoads.get(triggerTrack.id) === request &&
      lyricsLoadGenerationByTrackId.get(triggerTrack.id) === request.generation &&
      lyricsTrackActivation === request.activation &&
      options.currentTrack.value?.id === triggerTrack.id &&
      !request.controller.signal.aborted
    const completeIfCurrent = (status: 'ready' | 'empty' = 'ready'): void => {
      if (isCurrentRequest()) {
        clearLyricsRetryTimer(triggerTrack.id)
        lyricsRetryAttemptsByTrackId.delete(triggerTrack.id)
        options.lyricsLoadState.value = { trackId: triggerTrack.id, status }
      }
    }

    const run = async (): Promise<void> => {
      if (requestedSource === 'manual') {
        if (
          options.currentTrack.value?.id === triggerTrack.id &&
          options.currentTrack.value.lyrics == null &&
          options.currentTrack.value.translatedLyrics == null
        ) {
          commitResolvedLyrics(triggerTrack, triggerTrack, {
            lyrics: '',
            translatedLyrics: null,
            lyricsSource: null,
            translatedLyricsSource: null
          })
        }
        completeIfCurrent('empty')
        return
      }

      if (
        (requestedSource !== 'auto' ||
          originalLayerSource === 'local' ||
          originalLayerSource === 'provider' ||
          translationLayerSource === 'local' ||
          translationLayerSource === 'provider') &&
        !automaticLyricsBaselines.has(triggerTrack.id)
      ) {
        automaticLyricsBaselines.set(triggerTrack.id, { ...triggerTrack })
      }
      const resolverTrack = resolverLyricsInput(
        triggerTrack,
        automaticLyricsBaselines.get(triggerTrack.id),
        requestedSource
      )

      const hasOriginal = hasLyricContent(resolverTrack.lyrics)

      const source = getTrackSource(resolverTrack)
      const canLoadLocalLyrics =
        source === 'local' &&
        (resolverOriginalSource === 'local' ||
          (resolverOriginalSource === 'automatic' && !hasOriginal)) &&
        !!resolverTrack.dir &&
        !!resolverTrack.fileName
      const canLoadProviderLyrics =
        allowProviderLookup &&
        (resolverOriginalSource === 'provider' ||
          resolverTranslationSource === 'provider' ||
          (resolverOriginalSource === 'automatic' && !hasOriginal) ||
          (resolverTranslationSource === 'automatic' &&
            !hasLyricContent(resolverTrack.translatedLyrics)))
      const canLoadOnlineLyrics =
        resolverOriginalSource === 'automatic' &&
        options.getAppSettings().value?.onlineLyricsFallback === true &&
        !!resolverTrack.title?.trim() &&
        !!resolverTrack.artist?.trim() &&
        !hasOriginal

      if (!canLoadLocalLyrics && !canLoadProviderLyrics && !canLoadOnlineLyrics) {
        commitResolvedLyrics(triggerTrack, resolverTrack, {
          lyrics: hasOriginal ? resolverTrack.lyrics! : '',
          translatedLyrics: resolverTrack.translatedLyrics ?? null,
          lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
          translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null
        })
        completeIfCurrent(
          hasOriginal || hasLyricContent(resolverTrack.translatedLyrics) ? 'ready' : 'empty'
        )
        return
      }

      let resolved: Awaited<ReturnType<typeof resolveLyricsWithSources>>
      try {
        resolved = await resolveLyricsWithSources({
          track: resolverTrack,
          originalSource: resolverOriginalSource,
          translationSource: resolverTranslationSource,
          loadLocalLyrics: canLoadLocalLyrics
            ? () =>
                window.api.data
                  .getLyrics(resolverTrack.dir!, resolverTrack.fileName, resolverTrack.filePath)
                  .catch(() => null)
            : undefined,
          loadProviderLyrics: canLoadProviderLyrics
            ? async () => {
                await syncPluginProviders()
                return useMediaProviders().resolveLyrics(resolverTrack, {
                  signal: request.controller.signal
                })
              }
            : undefined,
          loadOnlineLyrics: canLoadOnlineLyrics
            ? async () => {
                const result = await window.api.data.searchOnlineLyrics({
                  title: resolverTrack.title,
                  artist: resolverTrack.artist,
                  album: resolverTrack.album || undefined,
                  durationSeconds:
                    typeof resolverTrack.duration === 'number' &&
                    Number.isFinite(resolverTrack.duration)
                      ? resolverTrack.duration
                      : undefined
                })
                return result.best?.syncedLyrics ?? result.best?.plainLyrics ?? null
              }
            : undefined,
          loadOnlineTranslation: canLoadOnlineLyrics
            ? async () => {
                await syncPluginProviders()
                const lyrics = await useMediaProviders().resolveLyrics(resolverTrack)
                return lyrics?.translatedLyrics ?? null
              }
            : undefined
        })
      } catch {
        resolved = {
          lyrics: resolverTrack.lyrics ?? null,
          translatedLyrics: resolverTrack.translatedLyrics ?? null,
          lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
          translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null,
          failure: 'provider'
        }
      }

      const currentOverride = lyricsManagement.entryFor(triggerTrack.id)
      const currentRequestedSource = currentOverride?.source ?? 'auto'
      const currentLayerSource = (
        key: 'originalSelection' | 'translationSelection'
      ): LyricResolverSource | 'manual' => {
        const selection = currentOverride?.[key]
        if (selection === 'local' || selection === 'provider' || selection === 'manual') {
          return selection
        }
        if (currentRequestedSource === 'local' || currentRequestedSource === 'provider') {
          return currentRequestedSource
        }
        return 'automatic'
      }
      if (
        `${currentRequestedSource}:${currentLayerSource('originalSelection')}:${currentLayerSource('translationSelection')}` !==
        sourceSelectionSignature
      ) {
        completeIfCurrent()
        return
      }
      if (
        resolved.failure &&
        !hasLyricContent(resolved.lyrics) &&
        !hasLyricContent(resolved.translatedLyrics)
      ) {
        if (isCurrentRequest()) {
          options.lyricsLoadState.value = { trackId: triggerTrack.id, status: 'failed' }
          scheduleCurrentLyricsRetry(triggerTrack.id, request.activation)
        }
        return
      }
      commitResolvedLyrics(triggerTrack, resolverTrack, resolved)
      completeIfCurrent(
        hasLyricContent(resolved.lyrics) || hasLyricContent(resolved.translatedLyrics)
          ? 'ready'
          : 'empty'
      )
    }

    request.promise = Promise.resolve().then(run)
    activeLyricsLoads.set(triggerTrack.id, request)
    try {
      await request.promise
    } finally {
      if (activeLyricsLoads.get(triggerTrack.id) === request) {
        activeLyricsLoads.delete(triggerTrack.id)
      }
    }
  }

  function retryCurrentTrackLyricsIfNeeded(forceReload = false): void {
    const track = options.currentTrack.value
    if (!track) return
    const loading =
      options.lyricsLoadState.value.trackId === track.id &&
      options.lyricsLoadState.value.status === 'loading'
    const failed =
      options.lyricsLoadState.value.trackId === track.id &&
      options.lyricsLoadState.value.status === 'failed'
    if (!hasLyricContent(track.lyrics) || loading) {
      void ensureCurrentTrackLyricsLoaded(track, true, forceReload)
      return
    }
    if (failed) {
      void ensureCurrentTrackLyricsLoaded(track, true, forceReload)
    }
  }

  function onTrackChanged(trackId: string, previousTrackId: string): void {
    if (trackId === previousTrackId) return
    lyricsTrackActivation += 1
    abortInactiveLyricsLoads(trackId)
    clearLyricsRetryTimersExcept(trackId)
    if (!trackId) {
      options.lyricsLoadState.value = { trackId: '', status: 'idle' }
      return
    }
    lyricsRetryAttemptsByTrackId.delete(trackId)
    options.lyricsLoadState.value = {
      trackId,
      status: hasLyricContent(options.currentTrack.value?.lyrics) ? 'ready' : 'loading'
    }
  }

  function deleteLyricsBaseline(trackId: string): void {
    automaticLyricsBaselines.delete(trackId)
  }

  function clearLyricsBaselines(): void {
    automaticLyricsBaselines.clear()
  }

  return {
    ensureCurrentTrackLyricsLoaded,
    commitResolvedLyrics,
    retryCurrentTrackLyricsIfNeeded,
    onTrackChanged,
    deleteLyricsBaseline,
    clearLyricsBaselines
  }
}
