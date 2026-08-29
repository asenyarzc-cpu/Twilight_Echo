import { onBeforeUnmount, watch } from 'vue'
import {
  DESKTOP_LYRICS_CLOCK_INTERVAL_MS,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsSession,
  type DesktopLyricsTransportState
} from '../../../shared/desktopLyrics.ts'
import { projectManagedLyrics } from '../../../shared/lyricsManagement.ts'
import { useLyricsManagement } from '../stores/lyricsManagement.ts'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore.ts'
import { buildLyricLines } from '../utils/lyrics.ts'
import { projectDesktopLyricsLines } from '../utils/desktopLyricsProjection.ts'

function transportState(state: string): DesktopLyricsTransportState {
  if (state === 'playing') return 'playing'
  if (state === 'loading' || state === 'stalled') return 'loading'
  if (state === 'idle') return 'idle'
  return 'paused'
}

export function useDesktopLyricsPublisher(): void {
  const api = window.api?.desktopLyrics
  if (!api?.publishSession || !api.publishClock) return

  const player = usePlayerStore()
  const management = useLyricsManagement()
  const settingsStore = useSettingsStore()
  let activation = 0
  let contentRevision = 0
  let sequence = 0
  let activeTrackId = ''
  let sessionId = 'desktop-lyrics:idle:0'
  let lastClockAt = 0
  let lastEpoch = -1
  let lastState = ''
  let clockTimer: ReturnType<typeof setTimeout> | null = null
  let publishingEnabled = settingsStore.settings.value.desktopLyrics.enabled
  const disposers: Array<() => void> = []

  function ensureSessionId(trackId: string): void {
    if (trackId === activeTrackId) return
    activeTrackId = trackId
    activation += 1
    sequence = 0
    lastEpoch = -1
    sessionId = `desktop-lyrics:${activation}:${trackId || 'idle'}`.slice(0, 160)
  }

  function buildSession(): DesktopLyricsSession {
    const track = player.currentTrack.value
    ensureSessionId(track?.id ?? '')
    if (!track) {
      return {
        schemaVersion: 1,
        sessionId,
        contentRevision: ++contentRevision,
        track: null,
        status: 'idle',
        lyricOffsetMs: 0,
        lines: []
      }
    }
    const override = management.entryFor(track.id)
    const managed = projectManagedLyrics(
      {
        original: track.lyrics,
        translation: track.translatedLyrics,
        romanization: track.romanizedLyrics,
        originalSource: track.lyricsSource,
        translationSource: track.translatedLyricsSource,
        romanizationSource: track.romanizedLyricsSource
      },
      override
    )
    const lines = projectDesktopLyricsLines(
      buildLyricLines(managed.original, managed.translation, managed.romanization, {
        replaceTtmlTranslation:
          override?.translationSelection === 'manual' ||
          (override?.translationSelection == null && override?.source === 'manual'),
        replaceTtmlRomanization:
          override?.romanizationSelection === 'manual' ||
          (override?.romanizationSelection == null && override?.source === 'manual')
      })
    )
    const loadState = player.lyricsLoadState.value
    const status =
      loadState.trackId === track.id && loadState.status === 'loading'
        ? 'loading'
        : loadState.trackId === track.id && loadState.status === 'failed'
          ? 'error'
          : lines.length > 0
            ? 'ready'
            : 'empty'
    return {
      schemaVersion: 1,
      sessionId,
      contentRevision: ++contentRevision,
      track: { id: track.id, title: track.title || '', artist: track.artist || '' },
      status,
      lyricOffsetMs: Math.round(management.effectiveOffsetSeconds(track.id) * 1000),
      lines
    }
  }

  function publishSession(force = false): void {
    if (!publishingEnabled && !force) return
    api.publishSession(buildSession())
  }

  function publishClock(force = false): void {
    if (!publishingEnabled && !force) return
    const snapshot = player.playbackClockSnapshot.value
    ensureSessionId(player.currentTrack.value?.id ?? '')
    const now = performance.now()
    const immediate =
      force || snapshot.epoch !== lastEpoch || snapshot.state !== lastState || lastClockAt === 0
    const remaining = DESKTOP_LYRICS_CLOCK_INTERVAL_MS - (now - lastClockAt)
    if (!immediate && remaining > 0) {
      if (clockTimer == null) {
        clockTimer = setTimeout(() => {
          clockTimer = null
          publishClock(true)
        }, remaining)
      }
      return
    }
    if (clockTimer != null) {
      clearTimeout(clockTimer)
      clockTimer = null
    }
    lastClockAt = now
    lastEpoch = snapshot.epoch
    lastState = snapshot.state
    const clock: DesktopLyricsClockSnapshot = {
      schemaVersion: 1,
      sessionId,
      sequence: ++sequence,
      epoch: snapshot.epoch,
      positionMs: Math.max(0, Math.round(snapshot.position * 1000)),
      durationMs: Math.max(0, Math.round(snapshot.duration * 1000)),
      rate: Math.min(2, Math.max(0.5, snapshot.rate || 1)),
      state: transportState(snapshot.state)
    }
    api.publishClock(clock)
  }

  watch(
    [player.currentTrack, management.document, player.lyricsLoadState],
    () => publishSession(),
    { immediate: true }
  )
  watch(player.playbackClockSnapshot, () => publishClock(), { immediate: true })
  watch(
    () => settingsStore.settings.value.desktopLyrics.enabled,
    (enabled) => {
      publishingEnabled = enabled
      if (!enabled) return
      publishSession(true)
      publishClock(true)
    }
  )
  disposers.push(
    api.onEnabledChanged((enabled) => {
      publishingEnabled = enabled
      if (!enabled) return
      publishSession(true)
      publishClock(true)
    }),
    api.onResyncRequested(() => {
      publishSession(true)
      publishClock(true)
    })
  )

  onBeforeUnmount(() => {
    if (clockTimer != null) clearTimeout(clockTimer)
    for (const dispose of disposers) dispose()
  })
}
