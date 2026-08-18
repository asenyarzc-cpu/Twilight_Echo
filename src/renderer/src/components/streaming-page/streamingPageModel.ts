import type { PersonalizedStreamKey } from '../../stores/usePlayerStore.ts'

export function getPersonalizedStreamKey(
  section: { key: string } | null
): PersonalizedStreamKey | null {
  if (section?.key === 'fm' || section?.key === 'radar') return section.key
  return null
}

export function appendUniqueTracks<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  const seen = new Set(current.map((track) => track.id))
  return incoming.filter((track) => track.id && !seen.has(track.id) && seen.add(track.id))
}

export function mergePlaylistSummaries<T extends { id: string | number }>(...groups: T[][]): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const group of groups) {
    for (const playlist of group) {
      const id = String(playlist.id)
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(playlist)
    }
  }
  return merged
}

export function resolveStreamingTabIndex<T extends { tab: string }>(
  tabs: readonly T[],
  key: string
): number {
  const index = tabs.findIndex((tab) => tab.tab === key)
  return index === -1 ? 0 : index
}

export function getSharedLibraryProviderId(
  activeProvider: string,
  libraryProviderIds: readonly string[],
  fallback: string
): string {
  if (libraryProviderIds.includes(activeProvider)) return activeProvider
  return libraryProviderIds[0] ?? fallback
}

export function getSidebarItemsSignature(
  items: ReadonlyArray<{ key: string; provider: string; tab?: string | null }>
): string {
  return items.map((item) => `${item.key}:${item.provider}:${item.tab ?? 'external'}`).join('|')
}

export function resolveExternalProviderName(
  providerId: string,
  resolveName: (id: string) => string | null | undefined
): string {
  return resolveName(providerId) ?? providerId
}

export function timeGreeting(hour: number): string {
  if (hour < 5) return '夜深了，放一首安静的歌'
  if (hour < 11) return '早上好，开启美好的一天'
  if (hour < 14) return '中午好，让音乐陪你休息'
  if (hour < 18) return '下午好，继续享受音乐'
  if (hour < 22) return '晚上好，放松一下'
  return '夜深了，放一首安静的歌'
}
