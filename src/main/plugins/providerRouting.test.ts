import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const {
  dedupeProviderRegistrations,
  findProviderRoute,
  getProviderCallTimeoutMs,
  getProviderMethodStats,
  normalizeProviderHealth,
  normalizeProviderUi,
  providerSupportsMethod
} = (await import(
  new URL('./providerRouting.ts', import.meta.url).href
)) as typeof import('./providerRouting')
const { isRecoverableBundledPluginFailure } = (await import(
  new URL('./stateRecovery.ts', import.meta.url).href
)) as typeof import('./stateRecovery')

type TestRunningProvider = {
  pluginId: string
  providers: Array<{
    id: string
    name: string
    capabilities: Array<
      'search' | 'playbackUrl' | 'lyrics' | 'cover' | 'playlist' | 'library' | 'login' | 'download'
    >
  }>
}

const skeleton: TestRunningProvider = {
  pluginId: 'com.test.bili-provider-basic',
  providers: [
    {
      id: 'bili',
      name: 'Bilibili Basic Provider',
      capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist']
    }
  ]
}

const fullProvider: TestRunningProvider = {
  pluginId: 'com.twilightecho.provider.bilibili',
  providers: [
    {
      id: 'bili',
      name: 'Bilibili',
      capabilities: ['login', 'playlist', 'library', 'playbackUrl', 'cover']
    }
  ]
}

test('routes provider calls to a plugin that declares the required method capability', () => {
  assert.equal(providerSupportsMethod(skeleton.providers[0], 'getQrLogin'), false)
  assert.equal(providerSupportsMethod(fullProvider.providers[0], 'getQrLogin'), true)

  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'getQrLogin')?.pluginId,
    fullProvider.pluginId
  )
  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'searchSongs')?.pluginId,
    skeleton.pluginId
  )
})

test('routes download lifecycle calls only to providers declaring download capability', () => {
  const downloadProvider: TestRunningProvider = {
    pluginId: 'com.test.download-provider',
    providers: [
      {
        id: 'am',
        name: 'Apple Music',
        capabilities: ['search', 'playbackUrl', 'download']
      }
    ]
  }

  for (const method of [
    'createDownload',
    'getDownloadStatus',
    'getDownloadFile',
    'cancelDownload'
  ] as const) {
    assert.equal(providerSupportsMethod(downloadProvider.providers[0], method), true)
    assert.equal(providerSupportsMethod(skeleton.providers[0], method), false)
    assert.equal(
      findProviderRoute([skeleton, downloadProvider], 'am', method)?.pluginId,
      downloadProvider.pluginId
    )
  }
})

test('prefers the latest registration when multiple plugins expose the same provider id', () => {
  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'getPlaybackUrl')?.pluginId,
    fullProvider.pluginId
  )
  assert.deepEqual(dedupeProviderRegistrations([skeleton, fullProvider]), fullProvider.providers)
})

test('classifies provider call timeouts by method latency class', () => {
  assert.equal(getProviderCallTimeoutMs('fetchPlaylistTracks'), 120_000)
  assert.equal(getProviderCallTimeoutMs('getPlaybackUrl'), 30_000)
  assert.equal(getProviderCallTimeoutMs('likeTrack'), 15_000)
})

test('normalizes provider health records from plugin registration metadata', () => {
  const health = normalizeProviderHealth(
    {
      totalCalls: 3.9,
      successfulCalls: 2,
      failedCalls: -1,
      lastError: '  transient failure  ',
      methodStats: {
        getPlaybackUrl: { totalCalls: 1, successfulCalls: 1, failedCalls: 0, lastError: null },
        unknownMethod: { totalCalls: 1, successfulCalls: 1, failedCalls: 0 },
        getLyrics: 'invalid'
      }
    },
    'ncm',
    'com.twilightecho.provider.ncm'
  )

  assert.deepEqual(health, {
    providerId: 'ncm',
    pluginId: 'com.twilightecho.provider.ncm',
    totalCalls: 3,
    successfulCalls: 2,
    failedCalls: 0,
    methodStats: {
      getPlaybackUrl: {
        totalCalls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        lastError: null,
        lastCheckedAt: null
      }
    },
    lastError: 'transient failure',
    lastCheckedAt: null
  })
  assert.equal(normalizeProviderHealth(null, 'ncm', 'plugin'), null)
})

test('normalizes provider UI metadata defaults and filters malformed sections', () => {
  const ui = normalizeProviderUi({
    icon: 'pi pi-cloud',
    authType: 'browser',
    qrStatusCodes: { waiting: 1, scanned: 2, expired: 3, denied: 4, success: 5 },
    streamingSections: [
      { id: 'weekly', title: 'Weekly', method: 'fetchRecommendSongs' },
      { title: 'Missing Method' }
    ],
    loginExtraActions: [{ label: 'Open Web', method: 'openOfficialLogin' }, { method: 'missing' }]
  })

  assert.deepEqual(ui, {
    icon: 'pi pi-cloud',
    color: undefined,
    description: undefined,
    authType: 'qr',
    loginInstructions: undefined,
    qrStatusCodes: { waiting: 1, scanned: 2, expired: 3, denied: 4, success: 5 },
    showBrowserButton: undefined,
    loginExtraActions: [
      { label: 'Open Web', icon: 'pi pi-external-link', method: 'openOfficialLogin' }
    ],
    streamingSections: [
      {
        id: 'weekly',
        title: 'Weekly',
        icon: 'pi pi-music',
        method: 'fetchRecommendSongs',
        args: undefined
      }
    ],
    streamingLibraryTab: undefined,
    streamingSearch: undefined,
    unifiedLibrary: undefined
  })
  assert.equal(normalizeProviderUi(undefined), undefined)
})

test('derives provider method health success rates without mutating records', () => {
  const stats = getProviderMethodStats({
    providerId: 'ncm',
    pluginId: 'plugin',
    totalCalls: 2,
    successfulCalls: 1,
    failedCalls: 1,
    methodStats: {
      getPlaybackUrl: {
        totalCalls: 2,
        successfulCalls: 1,
        failedCalls: 1,
        lastError: 'timeout',
        lastCheckedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    lastError: 'timeout',
    lastCheckedAt: '2026-01-01T00:00:00.000Z'
  })

  assert.deepEqual(stats.getPlaybackUrl, {
    totalCalls: 2,
    successfulCalls: 1,
    failedCalls: 1,
    successRate: 0.5,
    lastError: 'timeout',
    lastCheckedAt: '2026-01-01T00:00:00.000Z'
  })
  assert.deepEqual(getProviderMethodStats(undefined), {})
})

test('treats bundled plugin host-exit failures as recoverable startup state', () => {
  assert.equal(isRecoverableBundledPluginFailure('插件宿主进程退出：18446744073709552000'), true)
  assert.equal(isRecoverableBundledPluginFailure('Invalid value for env'), true)
  assert.equal(isRecoverableBundledPluginFailure('Provider 调用超时：ncm.getPlaybackUrl'), false)
  assert.equal(isRecoverableBundledPluginFailure(undefined), false)
})

test('omits utility process env option when no proxy env is configured', () => {
  const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')

  assert.match(source, /\.\.\.\(Object\.keys\(proxyEnv\)\.length > 0 \? \{ env:/)
  assert.equal(
    /const env = Object\.keys\(proxyEnv\)\.length > 0[\s\S]*utilityProcess\.fork[\s\S]*\benv\b/.test(
      source
    ),
    false,
    'Electron utilityProcess.fork rejects an explicit env: undefined option'
  )
})

test('bundled provider missing-method errors mention restarting the app', () => {
  const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')

  assert.match(source, /内置音源插件尚未加载最新代码，请重启应用/)
})

test('plugin host exposes account login provider methods', () => {
  const source = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')

  assert.match(source, /'sendCaptcha'/)
  assert.match(source, /'loginByPhonePassword'/)
  assert.match(source, /'loginByPhoneCaptcha'/)
  assert.match(source, /'loginByEmailPassword'/)
})
