/**
 * Podcast subscriptions and cached episode metadata.
 * Episode media is streamed from the feed enclosure URL.
 */

export const PODCAST_SUBSCRIPTIONS_SCHEMA_VERSION = 1 as const
export const MAX_PODCAST_SUBSCRIPTIONS = 200
export const MAX_PODCAST_EPISODES_PER_FEED = 200
export const MAX_PODCAST_TITLE_LENGTH = 240
export const MAX_PODCAST_URL_LENGTH = 2048
export const MAX_PODCAST_DESCRIPTION_LENGTH = 4_000
export const MAX_PODCAST_GUID_LENGTH = 512

export interface PodcastEpisode {
  guid: string
  title: string
  description?: string
  /** Enclosure / media URL. */
  mediaUrl: string
  /** Duration in seconds when the feed provides it; 0/unknown otherwise. */
  durationSeconds: number
  publishedAt?: string
  /** Last known playback progress in seconds (local UX badge). */
  progressSeconds?: number
  coverUrl?: string
}

export interface PodcastSubscription {
  id: string
  feedUrl: string
  title: string
  description?: string
  author?: string
  coverUrl?: string
  homepage?: string
  lastRefreshedAt?: string
  feedEtag?: string | null
  feedLastModified?: string | null
  lastError?: string | null
  episodes: PodcastEpisode[]
  createdAt: string
  updatedAt: string
}

export interface PodcastSubscriptionsDocument {
  schemaVersion: typeof PODCAST_SUBSCRIPTIONS_SCHEMA_VERSION
  subscriptions: PodcastSubscription[]
}

export const DEFAULT_PODCAST_SUBSCRIPTIONS: PodcastSubscriptionsDocument = {
  schemaVersion: PODCAST_SUBSCRIPTIONS_SCHEMA_VERSION,
  subscriptions: []
}

function isHttpOrHttpsUrl(value: string, maxLength = MAX_PODCAST_URL_LENGTH): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\0\r\n]/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return true
  } catch {
    return false
  }
}

export function isPodcastEpisode(value: unknown): value is PodcastEpisode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.guid !== 'string' ||
    !record.guid.trim() ||
    record.guid.length > MAX_PODCAST_GUID_LENGTH
  ) {
    return false
  }
  if (
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    record.title.length > MAX_PODCAST_TITLE_LENGTH
  ) {
    return false
  }
  if (typeof record.mediaUrl !== 'string' || !isHttpOrHttpsUrl(record.mediaUrl)) return false
  if (
    typeof record.durationSeconds !== 'number' ||
    !Number.isFinite(record.durationSeconds) ||
    record.durationSeconds < 0
  ) {
    return false
  }
  if (record.description !== undefined && record.description !== null) {
    if (
      typeof record.description !== 'string' ||
      record.description.length > MAX_PODCAST_DESCRIPTION_LENGTH
    ) {
      return false
    }
  }
  if (
    record.publishedAt !== undefined &&
    record.publishedAt !== null &&
    typeof record.publishedAt !== 'string'
  ) {
    return false
  }
  if (record.progressSeconds !== undefined && record.progressSeconds !== null) {
    if (
      typeof record.progressSeconds !== 'number' ||
      !Number.isFinite(record.progressSeconds) ||
      record.progressSeconds < 0
    ) {
      return false
    }
  }
  if (record.coverUrl !== undefined && record.coverUrl !== null) {
    if (typeof record.coverUrl !== 'string' || !isHttpOrHttpsUrl(record.coverUrl)) return false
  }
  return true
}

export function isPodcastSubscription(value: unknown): value is PodcastSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim()) return false
  if (typeof record.feedUrl !== 'string' || !isHttpOrHttpsUrl(record.feedUrl)) return false
  if (
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    record.title.length > MAX_PODCAST_TITLE_LENGTH
  ) {
    return false
  }
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (!Array.isArray(record.episodes) || record.episodes.length > MAX_PODCAST_EPISODES_PER_FEED)
    return false
  if (!record.episodes.every(isPodcastEpisode)) return false
  if (record.description !== undefined && record.description !== null) {
    if (
      typeof record.description !== 'string' ||
      record.description.length > MAX_PODCAST_DESCRIPTION_LENGTH
    ) {
      return false
    }
  }
  if (record.author !== undefined && record.author !== null && typeof record.author !== 'string')
    return false
  if (record.coverUrl !== undefined && record.coverUrl !== null) {
    if (typeof record.coverUrl !== 'string' || !isHttpOrHttpsUrl(record.coverUrl)) return false
  }
  if (record.homepage !== undefined && record.homepage !== null) {
    if (typeof record.homepage !== 'string' || !isHttpOrHttpsUrl(record.homepage)) return false
  }
  if (
    record.lastRefreshedAt !== undefined &&
    record.lastRefreshedAt !== null &&
    typeof record.lastRefreshedAt !== 'string'
  ) {
    return false
  }
  if (
    record.feedEtag !== undefined &&
    record.feedEtag !== null &&
    typeof record.feedEtag !== 'string'
  ) {
    return false
  }
  if (
    record.feedLastModified !== undefined &&
    record.feedLastModified !== null &&
    typeof record.feedLastModified !== 'string'
  ) {
    return false
  }
  if (
    record.lastError !== undefined &&
    record.lastError !== null &&
    typeof record.lastError !== 'string'
  ) {
    return false
  }
  return true
}

export function isPodcastSubscriptionsDocument(
  value: unknown
): value is PodcastSubscriptionsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== PODCAST_SUBSCRIPTIONS_SCHEMA_VERSION) return false
  if (!Array.isArray(record.subscriptions)) return false
  if (record.subscriptions.length > MAX_PODCAST_SUBSCRIPTIONS) return false
  return record.subscriptions.every(isPodcastSubscription)
}

export function clonePodcastSubscriptionsDocument(
  document: PodcastSubscriptionsDocument
): PodcastSubscriptionsDocument {
  return {
    schemaVersion: PODCAST_SUBSCRIPTIONS_SCHEMA_VERSION,
    subscriptions: document.subscriptions.map((sub) => ({
      ...sub,
      episodes: sub.episodes.map((episode) => ({ ...episode }))
    }))
  }
}

export function podcastEpisodeProgressRatio(episode: PodcastEpisode): number | null {
  if (!episode.durationSeconds || episode.durationSeconds <= 0) return null
  const progress = episode.progressSeconds ?? 0
  if (progress <= 0) return 0
  return Math.min(1, progress / episode.durationSeconds)
}

/**
 * Parse player track ids of the form `podcast:{subscriptionId}:{episodeGuid}`.
 * Episode guids may themselves contain `:`.
 */
export function parsePodcastTrackId(
  trackId: string | null | undefined
): { subscriptionId: string; episodeGuid: string } | null {
  if (!trackId || !trackId.startsWith('podcast:')) return null
  const rest = trackId.slice('podcast:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep >= rest.length - 1) return null
  return {
    subscriptionId: rest.slice(0, sep),
    episodeGuid: rest.slice(sep + 1)
  }
}
