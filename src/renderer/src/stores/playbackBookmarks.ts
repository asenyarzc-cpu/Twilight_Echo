import { computed, readonly, ref } from 'vue'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  MAX_BOOKMARKS,
  MAX_BOOKMARKS_PER_TRACK,
  MAX_BOOKMARK_LABEL_LENGTH,
  bookmarksForTrack,
  clampBookmarkPosition,
  clonePlaybackBookmarksDocument,
  type PlaybackBookmark,
  type PlaybackBookmarksDocument
} from '../../../shared/playbackBookmarks.ts'
import { isPersistentDataRevisionConflict } from '../../../shared/versionedPersistence.ts'
import type { Track } from '../types/music'

const document = ref<PlaybackBookmarksDocument>(
  clonePlaybackBookmarksDocument(DEFAULT_PLAYBACK_BOOKMARKS)
)
const revision = ref(0)
const loading = ref<Promise<void> | null>(null)

function trackKeyFor(track: Pick<Track, 'id' | 'filePath' | 'source'>): string {
  const source = track.source ?? 'local'
  if (source === 'local' && track.filePath) return `local:${track.filePath}`
  return `${source}:${track.id}`
}

async function ensureLoaded(): Promise<void> {
  if (loading.value) return loading.value
  loading.value = (async () => {
    const result = await window.api.data.loadPlaybackBookmarks()
    if (result?.data) {
      document.value = clonePlaybackBookmarksDocument(result.data)
      revision.value = result.revision
    }
  })().finally(() => {
    loading.value = null
  })
  return loading.value
}

async function persist(next: PlaybackBookmarksDocument): Promise<void> {
  try {
    const saved = await window.api.data.savePlaybackBookmarks(next, revision.value)
    document.value = clonePlaybackBookmarksDocument(saved.data)
    revision.value = saved.revision
  } catch (error) {
    if (!isPersistentDataRevisionConflict(error)) throw error
    const current = error.current
    if (!current) throw error
    document.value = clonePlaybackBookmarksDocument(current.data as PlaybackBookmarksDocument)
    revision.value = current.revision
    throw error
  }
}

function nextDocument(): PlaybackBookmarksDocument {
  return clonePlaybackBookmarksDocument(document.value)
}

function makeId(): string {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function addBookmark(
  track: Track,
  positionSeconds: number,
  options: { label?: string; kind?: PlaybackBookmark['kind'] } = {}
): Promise<PlaybackBookmark | null> {
  if (!track?.id) return null
  await ensureLoaded()
  const next = nextDocument()
  const trackKey = trackKeyFor(track)
  const now = new Date().toISOString()
  const kind = options.kind ?? 'manual'
  const label = (options.label ?? '').trim().slice(0, MAX_BOOKMARK_LABEL_LENGTH)

  if (kind === 'resume') {
    next.bookmarks = next.bookmarks.filter(
      (bookmark) => !(bookmark.trackKey === trackKey && bookmark.kind === 'resume')
    )
  }

  const forTrack = next.bookmarks.filter((bookmark) => bookmark.trackKey === trackKey)
  if (forTrack.length >= MAX_BOOKMARKS_PER_TRACK) {
    const oldest = forTrack
      .filter((bookmark) => bookmark.kind !== 'resume')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (oldest) {
      next.bookmarks = next.bookmarks.filter((bookmark) => bookmark.id !== oldest.id)
    }
  }

  const bookmark: PlaybackBookmark = {
    id: makeId(),
    trackKey,
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    positionSeconds: clampBookmarkPosition(positionSeconds),
    label: label || (kind === 'resume' ? 'Resume' : formatBookmarkLabel(positionSeconds)),
    createdAt: now,
    updatedAt: now,
    kind
  }
  next.bookmarks = [bookmark, ...next.bookmarks].slice(0, MAX_BOOKMARKS)
  await persist(next)
  return bookmark
}

function formatBookmarkLabel(positionSeconds: number): string {
  const total = Math.max(0, Math.floor(positionSeconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

async function removeBookmark(id: string): Promise<void> {
  if (!id) return
  await ensureLoaded()
  const next = nextDocument()
  next.bookmarks = next.bookmarks.filter((bookmark) => bookmark.id !== id)
  await persist(next)
}

async function renameBookmark(id: string, label: string): Promise<void> {
  if (!id) return
  await ensureLoaded()
  const next = nextDocument()
  const target = next.bookmarks.find((bookmark) => bookmark.id === id)
  if (!target) return
  const trimmed = label.trim().slice(0, MAX_BOOKMARK_LABEL_LENGTH)
  if (!trimmed || trimmed === target.label) return
  target.label = trimmed
  target.updatedAt = new Date().toISOString()
  await persist(next)
}

async function setLongTrackResumeSeconds(seconds: number): Promise<void> {
  await ensureLoaded()
  const next = nextDocument()
  next.longTrackResumeSeconds = Math.max(60, Math.min(24 * 60 * 60, Math.round(seconds)))
  await persist(next)
}

function bookmarksFor(track: Track | null | undefined): PlaybackBookmark[] {
  if (!track) return []
  return bookmarksForTrack(document.value, trackKeyFor(track))
}

function resumeBookmarkFor(track: Track | null | undefined): PlaybackBookmark | null {
  if (!track) return null
  return bookmarksFor(track).find((bookmark) => bookmark.kind === 'resume') ?? null
}

function shouldOfferLongTrackResume(track: Track | null | undefined): boolean {
  if (!track) return false
  const threshold = document.value.longTrackResumeSeconds
  return typeof track.duration === 'number' && track.duration >= threshold
}

export function usePlaybackBookmarks() {
  return {
    document: readonly(document),
    longTrackResumeSeconds: computed(() => document.value.longTrackResumeSeconds),
    ensureLoaded,
    trackKeyFor,
    bookmarksFor,
    resumeBookmarkFor,
    shouldOfferLongTrackResume,
    addBookmark,
    removeBookmark,
    renameBookmark,
    setLongTrackResumeSeconds
  }
}
