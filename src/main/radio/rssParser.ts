/**
 * Lightweight RSS 2.0 / Atom feed parser for podcast episode lists.
 * Intentionally dependency-free; only extracts fields Twilight Echo needs.
 */

import {
  MAX_PODCAST_DESCRIPTION_LENGTH,
  MAX_PODCAST_EPISODES_PER_FEED,
  MAX_PODCAST_GUID_LENGTH,
  MAX_PODCAST_TITLE_LENGTH,
  MAX_PODCAST_URL_LENGTH,
  type PodcastEpisode
} from '../../shared/podcastSubscriptions.ts'

export interface ParsedPodcastFeed {
  title: string
  description?: string
  author?: string
  coverUrl?: string
  homepage?: string
  episodes: PodcastEpisode[]
}

const MAX_FEED_BYTES = 8 * 1024 * 1024

export function parsePodcastFeedXml(xml: string): ParsedPodcastFeed {
  if (typeof xml !== 'string') throw new Error('Podcast feed must be a string')
  if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new Error('Podcast feed is too large')
  }
  const normalized = xml.replace(/^\uFEFF/, '')
  if (/<feed[\s>]/i.test(normalized)) {
    return parseAtomFeed(normalized)
  }
  return parseRssFeed(normalized)
}

function parseRssFeed(xml: string): ParsedPodcastFeed {
  const channel = extractTagBlock(xml, 'channel', true) ?? xml
  // Channel metadata lives before the first <item>; avoid matching episode titles.
  const channelHead = channel.split(/<item[\s>]/i)[0] ?? channel
  const title = decodeXmlEntities(textOfFirst(channelHead, 'title') || 'Podcast').slice(
    0,
    MAX_PODCAST_TITLE_LENGTH
  )
  const description = optionalText(channelHead, 'description', MAX_PODCAST_DESCRIPTION_LENGTH)
  const author =
    optionalText(channelHead, 'itunes:author', 200) ||
    optionalText(channelHead, 'managingEditor', 200) ||
    undefined
  const coverUrl =
    firstAttr(channelHead, 'itunes:image', 'href') ||
    firstAttr(channelHead, 'image', 'href') ||
    optionalText(channelHead, 'url', MAX_PODCAST_URL_LENGTH) ||
    undefined
  const homepage = optionalLink(channelHead) || undefined

  const items = extractAllTagBlocks(channel, 'item').slice(0, MAX_PODCAST_EPISODES_PER_FEED)
  const episodes: PodcastEpisode[] = []
  for (const item of items) {
    const mediaUrl =
      firstAttr(item, 'enclosure', 'url') ||
      firstAttr(item, 'media:content', 'url') ||
      optionalText(item, 'link', MAX_PODCAST_URL_LENGTH)
    if (!mediaUrl || !isHttpUrl(mediaUrl)) continue
    const guidRaw = optionalText(item, 'guid', MAX_PODCAST_GUID_LENGTH) || mediaUrl
    const episodeTitle = decodeXmlEntities(textOfFirst(item, 'title') || 'Episode').slice(
      0,
      MAX_PODCAST_TITLE_LENGTH
    )
    const durationSeconds = parseDuration(
      optionalText(item, 'itunes:duration', 64) || firstAttr(item, 'enclosure', 'length') || '0'
    )
    const publishedAt =
      optionalText(item, 'pubDate', 64) || optionalText(item, 'dc:date', 64) || undefined
    const episodeDescription = optionalText(item, 'description', MAX_PODCAST_DESCRIPTION_LENGTH)
    const episodeCover =
      firstAttr(item, 'itunes:image', 'href') ||
      firstAttr(item, 'media:thumbnail', 'url') ||
      undefined

    episodes.push({
      guid: guidRaw.slice(0, MAX_PODCAST_GUID_LENGTH),
      title: episodeTitle,
      description: episodeDescription,
      mediaUrl: mediaUrl.trim().slice(0, MAX_PODCAST_URL_LENGTH),
      durationSeconds,
      publishedAt,
      coverUrl: episodeCover && isHttpUrl(episodeCover) ? episodeCover : undefined
    })
  }

  return {
    title: title || 'Podcast',
    description,
    author,
    coverUrl: coverUrl && isHttpUrl(coverUrl) ? coverUrl : undefined,
    homepage: homepage && isHttpUrl(homepage) ? homepage : undefined,
    episodes
  }
}

function parseAtomFeed(xml: string): ParsedPodcastFeed {
  const feed = extractTagBlock(xml, 'feed') ?? xml
  const title = decodeXmlEntities(textOfFirst(feed, 'title') || 'Podcast').slice(
    0,
    MAX_PODCAST_TITLE_LENGTH
  )
  const description =
    optionalText(feed, 'subtitle', MAX_PODCAST_DESCRIPTION_LENGTH) ||
    optionalText(feed, 'summary', MAX_PODCAST_DESCRIPTION_LENGTH)
  const authorBlock = extractTagBlock(feed, 'author')
  const author = authorBlock ? optionalText(authorBlock, 'name', 200) : undefined
  const coverUrl =
    firstAttr(feed, 'logo', 'href') || optionalText(feed, 'logo', MAX_PODCAST_URL_LENGTH)
  const homepage =
    firstAttr(feed, 'link', 'href') || optionalText(feed, 'id', MAX_PODCAST_URL_LENGTH)

  const entries = extractAllTagBlocks(feed, 'entry').slice(0, MAX_PODCAST_EPISODES_PER_FEED)
  const episodes: PodcastEpisode[] = []
  for (const entry of entries) {
    const mediaUrl =
      firstAttr(entry, 'link', 'href', (attrs) =>
        /audio|video|enclosure/i.test(attrs.rel || attrs.type || '')
      ) ||
      firstAttr(entry, 'link', 'href') ||
      optionalText(entry, 'id', MAX_PODCAST_URL_LENGTH)
    if (!mediaUrl || !isHttpUrl(mediaUrl)) continue
    const guid = (optionalText(entry, 'id', MAX_PODCAST_GUID_LENGTH) || mediaUrl).slice(
      0,
      MAX_PODCAST_GUID_LENGTH
    )
    const episodeTitle = decodeXmlEntities(textOfFirst(entry, 'title') || 'Episode').slice(
      0,
      MAX_PODCAST_TITLE_LENGTH
    )
    const durationSeconds = parseDuration(optionalText(entry, 'itunes:duration', 64) || '0')
    const publishedAt =
      optionalText(entry, 'published', 64) || optionalText(entry, 'updated', 64) || undefined
    const episodeDescription =
      optionalText(entry, 'summary', MAX_PODCAST_DESCRIPTION_LENGTH) ||
      optionalText(entry, 'content', MAX_PODCAST_DESCRIPTION_LENGTH)

    episodes.push({
      guid,
      title: episodeTitle,
      description: episodeDescription,
      mediaUrl: mediaUrl.trim().slice(0, MAX_PODCAST_URL_LENGTH),
      durationSeconds,
      publishedAt
    })
  }

  return {
    title: title || 'Podcast',
    description,
    author,
    coverUrl: coverUrl && isHttpUrl(coverUrl) ? coverUrl : undefined,
    homepage: homepage && isHttpUrl(homepage) ? homepage : undefined,
    episodes
  }
}

function extractTagBlock(xml: string, tag: string, greedy = false): string | null {
  const quantifier = greedy ? '[\\s\\S]*' : '[\\s\\S]*?'
  const pattern = new RegExp(
    `<${escapeRegExp(tag)}(?:\\s[^>]*)?>(${quantifier})<\\/${escapeRegExp(tag)}>`,
    'i'
  )
  const match = pattern.exec(xml)
  return match ? match[1] : null
}

function extractAllTagBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`,
    'gi'
  )
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    blocks.push(match[1])
  }
  return blocks
}

function textOfFirst(xml: string, tag: string): string {
  const cdata = new RegExp(
    `<${escapeRegExp(tag)}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escapeRegExp(tag)}>`,
    'i'
  ).exec(xml)
  if (cdata) return cdata[1].trim()
  const plain = new RegExp(
    `<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`,
    'i'
  ).exec(xml)
  return plain ? stripTags(plain[1]).trim() : ''
}

function optionalText(xml: string, tag: string, maxLength: number): string | undefined {
  const value = textOfFirst(xml, tag)
  if (!value) return undefined
  return decodeXmlEntities(value).slice(0, maxLength)
}

function optionalLink(xml: string): string | undefined {
  const href = firstAttr(xml, 'link', 'href')
  if (href) return href
  return optionalText(xml, 'link', MAX_PODCAST_URL_LENGTH)
}

function firstAttr(
  xml: string,
  tag: string,
  attr: string,
  predicate?: (attrs: Record<string, string>) => boolean
): string | undefined {
  const pattern = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)\\/?>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] || '')
    if (predicate && !predicate(attrs)) continue
    const value = attrs[attr.toLowerCase()]
    if (value) return decodeXmlEntities(value).trim()
  }
  // Nested <image><url>...</url>
  if (tag === 'image' && attr === 'href') {
    const block = extractTagBlock(xml, 'image')
    if (block) {
      const url = optionalText(block, 'url', MAX_PODCAST_URL_LENGTH)
      if (url) return url
    }
  }
  return undefined
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([:@A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

export function parseDuration(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed)
    // itunes:duration may be seconds; enclosure length is often bytes — only treat small ints as seconds.
    if (asNumber > 0 && asNumber < 86_400 * 12) return Math.floor(asNumber)
    return 0
  }
  const parts = trimmed.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0
  if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2])
  if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1])
  return 0
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      value.length <= MAX_PODCAST_URL_LENGTH
    )
  } catch {
    return false
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
    .replace(/&amp;/g, '&')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
