import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OFFICIAL_PLUGIN_INDEX_URL,
  pluginIndexSourceLabel,
  presentPluginTrust,
  type PluginIndexEntryTrustLike,
  type PluginIndexStatusLike
} from './pluginTrustPresentation.ts'
import { createPluginTrustRefreshController } from './pluginTrustRefresh.ts'

const PRESENTATION_NOW = Date.parse('2026-07-16T12:00:00.000Z')

const officialEntry: PluginIndexEntryTrustLike = {
  verification: {
    level: 'official',
    official: true,
    officialSource: true,
    indexClaimed: true,
    signatureStatus: 'valid',
    keyId: 'release-2026',
    keyFingerprintSha256: 'a'.repeat(64),
    revalidateAt: '2026-07-17T12:00:00.000Z',
    reason: '完整验证链'
  }
}

const officialStatus: PluginIndexStatusLike = {
  sourceUrl: OFFICIAL_PLUGIN_INDEX_URL,
  configuredSourceUrl: OFFICIAL_PLUGIN_INDEX_URL,
  loadedFrom: 'remote',
  lastFetchedAt: '2026-07-16T08:00:00.000Z',
  expiresAt: '2026-07-17T08:00:00.000Z',
  stale: false,
  expired: false,
  originVerified: true,
  officialSource: true,
  trustStoreError: null
}

test('official badge requires a fresh direct exact official chain', () => {
  assert.deepEqual(presentPluginTrust(officialEntry, officialStatus, PRESENTATION_NOW), {
    label: '官方验证',
    icon: 'pi pi-verified',
    tone: 'official',
    official: true,
    detail: [
      '完整验证链',
      '签名状态：valid',
      '密钥 ID：release-2026',
      `公钥 SHA-256：${'a'.repeat(64)}`
    ].join('\n')
  })
})

test('cache, stale, expired, custom, and trust-store failures suppress official badge', () => {
  const downgradedStatuses: PluginIndexStatusLike[] = [
    { ...officialStatus, loadedFrom: 'cache' },
    { ...officialStatus, stale: true },
    { ...officialStatus, expired: true },
    {
      ...officialStatus,
      sourceUrl: 'https://example.test/plugins.json',
      configuredSourceUrl: 'https://example.test/plugins.json',
      officialSource: false
    },
    { ...officialStatus, trustStoreError: 'registry unavailable' }
  ]

  for (const status of downgradedStatuses) {
    const presentation = presentPluginTrust(officialEntry, status, PRESENTATION_NOW)
    assert.equal(presentation.official, false)
    assert.equal(presentation.label, '发布者签名有效')
    assert.notEqual(presentation.icon, 'pi pi-verified')
  }
})

test('verified index metadata is presented only as an index claim', () => {
  const presentation = presentPluginTrust(
    {
      verification: {
        ...officialEntry.verification,
        level: 'index-declared',
        official: false,
        signatureStatus: 'missing',
        keyId: null,
        keyFingerprintSha256: null,
        revalidateAt: null,
        reason: '索引声明，签名缺失'
      }
    },
    officialStatus,
    PRESENTATION_NOW
  )

  assert.equal(presentation.label, '索引声明')
  assert.equal(presentation.official, false)
  assert.equal(presentation.icon, 'pi pi-info-circle')
})

test('bundled index is explicitly an offline discovery snapshot', () => {
  assert.equal(
    pluginIndexSourceLabel({
      ...officialStatus,
      sourceUrl: 'file:///resources/plugin-index/plugins.json',
      configuredSourceUrl: OFFICIAL_PLUGIN_INDEX_URL,
      loadedFrom: 'bundled',
      officialSource: false
    }),
    '随应用分发的离线发现快照'
  )
})

test('an unverified response at the official URL is not labeled as the fixed official index', () => {
  assert.equal(
    pluginIndexSourceLabel({ ...officialStatus, originVerified: false }),
    '官方 URL 响应（来源未验证）'
  )
  assert.equal(
    pluginIndexSourceLabel({
      ...officialStatus,
      loadedFrom: 'cache',
      originVerified: false
    }),
    '官方 URL 缓存（来源未验证）'
  )
})

test('absolute TTL and publisher-key deadlines suppress stale trust without waiting for IPC refresh', () => {
  const ttlDeadline = Date.parse(officialStatus.expiresAt!)
  const keyDeadline = Date.parse(officialEntry.verification.revalidateAt!)

  assert.equal(presentPluginTrust(officialEntry, officialStatus, ttlDeadline - 1).label, '官方验证')
  assert.equal(
    presentPluginTrust(officialEntry, officialStatus, ttlDeadline).label,
    '发布者签名有效'
  )
  assert.equal(presentPluginTrust(officialEntry, officialStatus, keyDeadline).label, '索引声明')
  assert.equal(presentPluginTrust(officialEntry, officialStatus, Number.NaN).label, '索引声明')
})

test('an open trust surface refreshes exactly at TTL and publisher-key notAfter', async () => {
  const start = Date.parse('2026-07-16T08:00:00.000Z')
  const ttlDeadline = Date.parse('2026-07-16T09:00:00.000Z')
  const keyDeadline = Date.parse('2026-07-16T10:00:00.000Z')
  const clock = createFakeClock(start)
  let entry: PluginIndexEntryTrustLike = {
    verification: {
      ...officialEntry.verification,
      revalidateAt: new Date(keyDeadline).toISOString()
    }
  }
  let status: PluginIndexStatusLike = {
    ...officialStatus,
    expiresAt: new Date(ttlDeadline).toISOString()
  }
  const controller = createPluginTrustRefreshController({
    getSnapshot: () => ({ entries: [entry], status }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    refresh: async () => {
      if (clock.now() >= ttlDeadline) {
        status = { ...status, expired: true }
        entry = {
          verification: {
            ...entry.verification,
            level: 'publisher-signed',
            official: false
          }
        }
      }
      if (clock.now() >= keyDeadline) {
        entry = {
          verification: {
            ...entry.verification,
            level: 'index-declared',
            signatureStatus: 'key-expired',
            revalidateAt: null
          }
        }
      }
    }
  })

  controller.schedule()
  assert.equal(clock.nextDeadline(), ttlDeadline)
  clock.advanceTo(ttlDeadline)
  await controller.waitForIdle()
  assert.equal(presentPluginTrust(entry, status, clock.now()).label, '发布者签名有效')
  assert.equal(clock.nextDeadline(), keyDeadline)

  clock.advanceTo(keyDeadline)
  await controller.waitForIdle()
  assert.equal(presentPluginTrust(entry, status, clock.now()).label, '索引声明')
  assert.equal(clock.nextDeadline(), null)
  controller.stop()
})

function createFakeClock(start: number): {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  nextDeadline: () => number | null
  advanceTo: (target: number) => void
} {
  let current = start
  let nextId = 1
  const timers = new Map<number, { deadline: number; callback: () => void }>()
  return {
    now: () => current,
    setTimer: (callback, delayMs) => {
      const id = nextId++
      timers.set(id, { deadline: current + delayMs, callback })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(Number(handle))
    },
    nextDeadline: () => {
      const deadlines = [...timers.values()].map((timer) => timer.deadline)
      return deadlines.length > 0 ? Math.min(...deadlines) : null
    },
    advanceTo: (target) => {
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.deadline <= target)
          .sort((left, right) => left[1].deadline - right[1].deadline)[0]
        if (!due) break
        timers.delete(due[0])
        current = due[1].deadline
        due[1].callback()
      }
      current = target
    }
  }
}
