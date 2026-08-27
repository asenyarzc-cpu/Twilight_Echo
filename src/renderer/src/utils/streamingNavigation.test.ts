import assert from 'node:assert/strict'
import test from 'node:test'

const {
  buildStreamingSidebarItems,
  getFirstVisibleStreamingTab,
  hasStreamingSidebarEntries,
  isSidebarItemActiveForProvider
} = (await import(
  new URL('./streamingNavigation.ts', import.meta.url).href
)) as typeof import('./streamingNavigation')

test('provider sidebar active state is provider driven without dedicated provider pages', () => {
  assert.equal(
    isSidebarItemActiveForProvider({
      itemProvider: 'ncm',
      itemKey: 'home',
      activeProvider: 'ncm',
      activeTab: 'home'
    }),
    true
  )
  assert.equal(
    isSidebarItemActiveForProvider({
      itemProvider: 'bili',
      itemKey: 'bili-library',
      activeProvider: 'bili',
      activeTab: 'library'
    }),
    true
  )
  assert.equal(
    isSidebarItemActiveForProvider({
      itemProvider: 'ncm',
      itemKey: 'home',
      activeProvider: 'bili',
      activeTab: 'library'
    }),
    false
  )
})

test('keeps shared music library visible when a unified provider is enabled without NetEase', () => {
  const items = buildStreamingSidebarItems({
    ncmAvailable: false,
    providers: [
      {
        id: 'ytmusic',
        name: 'YouTube Music',
        capabilities: ['library'],
        ui: { icon: 'pi pi-youtube', unifiedLibrary: true }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      key: 'library',
      provider: 'ncm',
      label: '音乐库',
      icon: 'pi pi-heart',
      tab: 'library'
    },
    {
      key: 'recent',
      provider: 'ncm',
      label: '最近播放',
      icon: 'pi pi-history',
      tab: 'recent'
    }
  ])
  assert.equal(getFirstVisibleStreamingTab(items), 'library')
  assert.equal(
    items.some((item) => item.tab === 'cloud'),
    false
  )
  assert.equal(hasStreamingSidebarEntries(items), true)
})

test('shows the NetEase discover entry right after home when NetEase is available', () => {
  const items = buildStreamingSidebarItems({
    ncmAvailable: true,
    providers: []
  })

  assert.deepEqual(items, [
    {
      key: 'home',
      provider: 'ncm',
      label: '主页',
      icon: 'pi pi-sparkles',
      tab: 'home'
    },
    {
      key: 'discover',
      provider: 'ncm',
      label: '发现歌单',
      icon: 'pi pi-th-large',
      tab: 'discover'
    },
    {
      key: 'library',
      provider: 'ncm',
      label: '音乐库',
      icon: 'pi pi-heart',
      tab: 'library'
    },
    {
      key: 'cloud',
      provider: 'ncm',
      label: '音乐云盘',
      icon: 'pi pi-cloud',
      tab: 'cloud'
    },
    {
      key: 'recent',
      provider: 'ncm',
      label: '最近播放',
      icon: 'pi pi-history',
      tab: 'recent'
    }
  ])
  assert.equal(getFirstVisibleStreamingTab(items), 'home')
  assert.equal(
    isSidebarItemActiveForProvider({
      itemProvider: 'ncm',
      itemKey: 'discover',
      activeProvider: 'ncm',
      activeTab: 'discover'
    }),
    true
  )
  assert.equal(
    isSidebarItemActiveForProvider({
      itemProvider: 'ncm',
      itemKey: 'cloud',
      activeProvider: 'ncm',
      activeTab: 'cloud'
    }),
    true
  )
})

test('hides shared home and library when no enabled provider can back them', () => {
  const items = buildStreamingSidebarItems({
    ncmAvailable: false,
    providers: []
  })

  assert.deepEqual(items, [])
  assert.equal(getFirstVisibleStreamingTab(items), null)
  assert.equal(hasStreamingSidebarEntries(items), false)
})

test('keeps independent provider library entries outside the unified library', () => {
  const items = buildStreamingSidebarItems({
    ncmAvailable: false,
    providers: [
      {
        id: 'bili',
        name: 'Bilibili',
        capabilities: ['library'],
        ui: { icon: 'pi pi-video' }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      key: 'bili-library',
      provider: 'bili',
      label: 'Bilibili',
      icon: 'pi pi-video'
    }
  ])
  assert.equal(getFirstVisibleStreamingTab(items), null)
  assert.equal(hasStreamingSidebarEntries(items), true)
})
