export type StreamingTabKey = 'home' | 'discover' | 'library' | 'cloud' | 'recent'

export interface StreamingNavigationProvider {
  id: string
  name: string
  capabilities: string[]
  supportedMethods?: string[]
  ui?: {
    icon?: string
    color?: string
    streamingSections?: Array<{ method: string }>
    streamingLibraryTab?: boolean
    unifiedLibrary?: boolean
  }
}

export interface StreamingProviderOption {
  id: string
  name: string
  icon: string
  color?: string
}

export interface StreamingSidebarItem {
  key: string
  provider: string
  label: string
  icon: string
  tab?: StreamingTabKey
}

const NCM_PROVIDER_ID = 'ncm'
const SHARED_SURFACE_PROVIDER_ID = 'shared'

function getAvailableProviders({
  ncmAvailable,
  providers
}: {
  ncmAvailable: boolean
  providers: StreamingNavigationProvider[]
}): StreamingNavigationProvider[] {
  const available = providers.filter((provider) => provider.id !== NCM_PROVIDER_ID || ncmAvailable)
  if (ncmAvailable && !available.some((provider) => provider.id === NCM_PROVIDER_ID)) {
    available.unshift({
      id: NCM_PROVIDER_ID,
      name: '网易云音乐',
      capabilities: ['library', 'playlist'],
      supportedMethods: [
        'fetchRecommendSongs',
        'fetchRecommendPlaylists',
        'fetchPlaylistCategories',
        'fetchDiscoveryPlaylists',
        'fetchHighQualityPlaylists',
        'fetchPersonalFm',
        'fetchPrivateContent'
      ],
      ui: {
        icon: 'pi pi-cloud',
        streamingSections: [
          { method: 'fetchRecommendSongs' },
          { method: 'fetchPersonalFm' },
          { method: 'fetchPrivateContent' }
        ]
      }
    })
  }
  return available
}

function toProviderOption(provider: StreamingNavigationProvider): StreamingProviderOption {
  return {
    id: provider.id,
    name: provider.id === NCM_PROVIDER_ID ? '网易云音乐' : provider.name,
    icon: provider.ui?.icon || 'pi pi-music',
    color: provider.ui?.color
  }
}

export function getStreamingHomeProviders(options: {
  ncmAvailable: boolean
  providers: StreamingNavigationProvider[]
}): StreamingProviderOption[] {
  return getAvailableProviders(options)
    .filter((provider) => {
      const methods = new Set(provider.supportedMethods ?? [])
      return provider.ui?.streamingSections?.some((section) => methods.has(section.method)) === true
    })
    .map(toProviderOption)
}

export function getStreamingDiscoveryProviders(options: {
  ncmAvailable: boolean
  providers: StreamingNavigationProvider[]
}): StreamingProviderOption[] {
  return getAvailableProviders(options)
    .filter((provider) => provider.supportedMethods?.includes('fetchDiscoveryPlaylists') === true)
    .map(toProviderOption)
}

export function getUnifiedLibraryProviders({
  ncmAvailable,
  providers
}: {
  ncmAvailable: boolean
  providers: StreamingNavigationProvider[]
}): Array<{ id: string; name: string; icon: string }> {
  const list: Array<{ id: string; name: string; icon: string }> = []
  if (ncmAvailable) {
    list.push({ id: NCM_PROVIDER_ID, name: '网易云音乐', icon: 'pi pi-cloud' })
  }
  for (const provider of providers) {
    if (provider.id === NCM_PROVIDER_ID) continue
    if (provider.capabilities.includes('library') && provider.ui?.unifiedLibrary === true) {
      list.push({
        id: provider.id,
        name: provider.name,
        icon: provider.ui?.icon || 'pi pi-music'
      })
    }
  }
  return list
}

export function buildStreamingSidebarItems({
  ncmAvailable,
  providers
}: {
  ncmAvailable: boolean
  providers: StreamingNavigationProvider[]
}): StreamingSidebarItem[] {
  const items: StreamingSidebarItem[] = []
  if (getStreamingHomeProviders({ ncmAvailable, providers }).length > 0) {
    items.push({
      key: 'home',
      provider: SHARED_SURFACE_PROVIDER_ID,
      label: '主页',
      icon: 'pi pi-sparkles',
      tab: 'home'
    })
  }
  if (getStreamingDiscoveryProviders({ ncmAvailable, providers }).length > 0) {
    items.push({
      key: 'discover',
      provider: SHARED_SURFACE_PROVIDER_ID,
      label: '发现歌单',
      icon: 'pi pi-th-large',
      tab: 'discover'
    })
  }
  if (getUnifiedLibraryProviders({ ncmAvailable, providers }).length > 0) {
    items.push({
      key: 'library',
      provider: NCM_PROVIDER_ID,
      label: '音乐库',
      icon: 'pi pi-heart',
      tab: 'library'
    })
    if (ncmAvailable) {
      items.push({
        key: 'cloud',
        provider: NCM_PROVIDER_ID,
        label: '音乐云盘',
        icon: 'pi pi-cloud',
        tab: 'cloud'
      })
    }
    items.push({
      key: 'recent',
      provider: NCM_PROVIDER_ID,
      label: '最近播放',
      icon: 'pi pi-history',
      tab: 'recent'
    })
  }
  for (const provider of providers) {
    if (provider.id === NCM_PROVIDER_ID) continue
    if (
      provider.capabilities.includes('library') &&
      provider.ui?.unifiedLibrary !== true &&
      provider.ui?.streamingLibraryTab !== false
    ) {
      items.push({
        key: `${provider.id}-library`,
        provider: provider.id,
        label: provider.name,
        icon: provider.ui?.icon || 'pi pi-music'
      })
    }
  }
  return items
}

export function getFirstVisibleStreamingTab(items: StreamingSidebarItem[]): StreamingTabKey | null {
  return items.find((item) => item.tab)?.tab ?? null
}

export function hasStreamingSidebarEntries(items: StreamingSidebarItem[]): boolean {
  return items.length > 0
}

export function isSidebarItemActiveForProvider({
  itemProvider,
  itemKey,
  activeProvider,
  activeTab
}: {
  itemProvider: string
  itemKey: string
  activeProvider: string
  activeTab: string
}): boolean {
  if (itemProvider === SHARED_SURFACE_PROVIDER_ID) return activeTab === itemKey
  if (itemProvider === 'ncm') {
    return activeProvider === 'ncm' && activeTab === itemKey
  }
  return activeProvider === itemProvider
}
