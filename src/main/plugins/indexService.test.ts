import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  DEFAULT_PLUGIN_INDEX_URL,
  PluginIndexService,
  resolvePluginIndexUrl
} from './indexService.ts'
import {
  createPluginIndexSignaturePayload,
  createTrustedPluginPublisherRegistry
} from './indexTrust.ts'
import type { TwilightPluginDescriptor, TwilightPluginIndexEntry } from './types.ts'

const require = createRequire(import.meta.url)
const { createZip } = require('../../../packages/create-twilight-plugin/lib/zip.cjs') as {
  createZip: (
    root: string,
    outputFile: string
  ) => Promise<{ fileCount: number; outputFile: string }>
}

const baseManifest = {
  id: 'com.example.index-tool',
  name: 'Index Tool',
  version: '1.0.0',
  description: 'A test index plugin',
  author: 'Example',
  license: 'Apache-2.0',
  type: ['tool'],
  main: 'index.mjs',
  engines: {
    twilightEcho: '>=0.20.0'
  },
  apiVersion: 1,
  permissions: ['player:observe'],
  repository: 'https://example.test/repo',
  homepage: 'https://example.test/plugin'
}

test('loads a valid plugin index and describes install state', async () => {
  const fixture = await createIndexFixture()
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath
  })

  const entries = await service.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, baseManifest.id)
  assert.equal(service.describeInstallState(entries[0], []), 'not-installed')
  assert.equal(
    service.describeInstallState(entries[0], [descriptor({ version: '1.0.0' })]),
    'installed'
  )
  assert.equal(
    service.describeInstallState(entries[0], [descriptor({ version: '0.9.0' })]),
    'update-available'
  )
})

test('rejects invalid sourceUrl protocols and escaping paths', async () => {
  await assert.rejects(async () => {
    const fixture = await createIndexFixture({ sourceUrl: 'ftp://example.test/plugin.tep' })
    await new PluginIndexService({
      appVersion: '0.20.0',
      localIndexPath: fixture.indexPath
    }).list()
  }, /sourceUrl/)

  await assert.rejects(async () => {
    const fixture = await createIndexFixture({ sourceUrl: '../outside.tep' })
    await new PluginIndexService({
      appVersion: '0.20.0',
      localIndexPath: fixture.indexPath
    }).list()
  }, /索引目录外/)
})

test('rejects checksum mismatch during package download', async () => {
  const fixture = await createIndexFixture({ checksumSha256: '0'.repeat(64) })
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath
  })

  await assert.rejects(() => service.downloadPackage(baseManifest.id), /checksum/)
})

test('rejects index packages whose manifest does not match the index entry', async () => {
  const fixture = await createIndexFixture({
    manifest: {
      ...baseManifest,
      id: 'com.example.package-tool',
      name: 'Package Tool'
    },
    indexManifest: baseManifest
  })
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath
  })

  await assert.rejects(() => service.downloadPackage(baseManifest.id), /manifest/i)
})

test('blocks incompatible and bundled index plugins', async () => {
  const incompatible = await createIndexFixture({
    manifest: {
      ...baseManifest,
      id: 'com.example.future',
      engines: { twilightEcho: '>=9.0.0' }
    }
  })
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: incompatible.indexPath
  })
  const [entry] = await service.list()
  assert.equal(service.describeInstallState(entry, []), 'incompatible')
  await assert.rejects(() => service.downloadPackage(entry.id), /不兼容/)

  const bundled = await createIndexFixture({
    manifest: {
      ...baseManifest,
      id: 'com.twilightecho.provider.ncm',
      name: 'NCM'
    }
  })
  await assert.rejects(
    () =>
      new PluginIndexService({
        appVersion: '0.20.0',
        localIndexPath: bundled.indexPath,
        bundledPluginIds: ['com.twilightecho.provider.ncm']
      }).list(),
    /自带插件/
  )
})

test('downloads a valid package after checksum validation', async () => {
  const fixture = await createIndexFixture()
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath
  })
  const downloaded = await service.downloadPackage(baseManifest.id)
  try {
    assert.equal(downloaded.entry.id, baseManifest.id)
    assert.equal((await readFile(downloaded.packagePath)).byteLength > 0, true)
    assert.equal(downloaded.evidence.packageSha256, downloaded.entry.checksumSha256)
    assert.equal(downloaded.evidence.checksumVerified, true)
    assert.equal(downloaded.evidence.manifestVerified, true)
    assert.equal(downloaded.evidence.loadedFrom, 'bundled')
  } finally {
    await downloaded.cleanup()
  }
})

test('uses the default GitHub index URL unless an override is provided', () => {
  assert.equal(resolvePluginIndexUrl(undefined), DEFAULT_PLUGIN_INDEX_URL)
  assert.equal(resolvePluginIndexUrl('  '), DEFAULT_PLUGIN_INDEX_URL)
  assert.equal(
    resolvePluginIndexUrl('https://example.test/plugins.json'),
    'https://example.test/plugins.json'
  )
})

test('loads remote index, records source status, and writes cache', async () => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const remoteUrl =
    'https://raw.githubusercontent.com/asenyarzc-cpu/Twilight-Echo-plugins/main/plugins.json'
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    fetchImpl: createFetch({
      [remoteUrl]: await readFile(fixture.indexPath)
    })
  })

  const entries = await service.list()
  const cachedRaw = JSON.parse(await readFile(cachePath, 'utf-8')) as {
    cacheSchemaVersion: number
    origin: string
    fetchedAt: string
    expiresAt: string
    index: { plugins: unknown[] }
  }
  const status = service.getStatus()

  assert.equal(entries[0].id, baseManifest.id)
  assert.equal(cachedRaw.cacheSchemaVersion, 1)
  assert.equal(cachedRaw.origin, remoteUrl)
  assert.equal(cachedRaw.fetchedAt, '2026-07-16T08:00:00.000Z')
  assert.equal(cachedRaw.expiresAt, '2026-07-17T08:00:00.000Z')
  assert.equal(cachedRaw.index.plugins.length, 1)
  assert.equal(status.sourceUrl, remoteUrl)
  assert.equal(status.configuredSourceUrl, remoteUrl)
  assert.equal(status.sourceKind, 'github')
  assert.equal(status.loadedFrom, 'remote')
  assert.equal(status.lastFetchedAt, cachedRaw.fetchedAt)
  assert.equal(status.expiresAt, cachedRaw.expiresAt)
  assert.equal(status.stale, false)
  assert.equal(status.expired, false)
  assert.equal(status.originVerified, true)
  assert.equal(status.officialSource, true)
  assert.equal(status.cacheFormat, null)
})

test('serves fresh cache immediately and conditionally revalidates', async (t) => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const remoteUrl = DEFAULT_PLUGIN_INDEX_URL
  let now = new Date('2026-07-16T08:00:00.000Z')
  let requests = 0
  const conditionalRequest = deferred<void>()
  const conditionalRelease = deferred<void>()
  const first = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    now: () => now,
    fetchImpl: async () =>
      new Response(new Uint8Array(await readFile(fixture.indexPath)), {
        headers: { Etag: '"index-v1"' }
      })
  })
  await first.list()

  const second = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    now: () => now,
    fetchImpl: async () => {
      requests += 1
      conditionalRequest.resolve()
      await conditionalRelease.promise
      return new Response(null, { status: 304, headers: { Etag: '"index-v1"' } })
    }
  })
  const startedAt = Date.now()
  const entries = await second.list()
  assert.equal(entries[0].id, baseManifest.id)
  assert.ok(Date.now() - startedAt < 100)

  now = new Date('2026-07-16T09:00:00.000Z')
  conditionalRelease.resolve()
  await t.test('background conditional request refreshes timestamps on 304', async () => {
    await conditionalRequest.promise
    let cachedRaw: { fetchedAt: string; expiresAt: string; etag?: string } | undefined
    for (let index = 0; index < 40; index += 1) {
      cachedRaw = JSON.parse(await readFile(cachePath, 'utf-8')) as typeof cachedRaw
      if (cachedRaw?.fetchedAt === now.toISOString()) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(requests, 1)
    assert.ok(cachedRaw)
    assert.equal(cachedRaw?.fetchedAt, now.toISOString())
    assert.equal(cachedRaw?.expiresAt, '2026-07-17T09:00:00.000Z')
    assert.equal(cachedRaw?.etag, '"index-v1"')
  })
})

test('latest overlapping refresh owns memory and disk cache when an older response arrives last', async () => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const indexA = await readFile(fixture.indexPath)
  const indexB = mutateIndex(indexA, { description: 'generation B entry' })
  const started = [deferred<void>(), deferred<void>()]
  const responses = [deferred<Response>(), deferred<Response>()]
  let requestCount = 0
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    fetchImpl: async () => {
      const request = requestCount++
      started[request].resolve()
      return responses[request].promise
    }
  })

  const older = service.refresh()
  await started[0].promise
  const newer = service.refresh()
  await started[1].promise
  responses[1].resolve(new Response(new Uint8Array(indexB)))
  const newerEntries = await newer
  responses[0].resolve(new Response(new Uint8Array(indexA)))
  const olderEntries = await older

  assert.equal(newerEntries[0].description, 'generation B entry')
  assert.equal(olderEntries[0].description, 'generation B entry')
  assert.equal((await service.list())[0].description, 'generation B entry')
  assert.equal(service.getStatus().sourceUrl, remoteUrl)
  const persisted = JSON.parse(await readFile(cachePath, 'utf-8')) as {
    index: { plugins: Array<{ description: string }> }
  }
  assert.equal(persisted.index.plugins[0].description, 'generation B entry')

  const restarted = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    now: () => new Date('2026-07-16T08:30:00.000Z'),
    fetchImpl: async () => new Response('unavailable', { status: 503 })
  })
  assert.equal((await restarted.refresh())[0].description, 'generation B entry')
  assert.equal(restarted.getStatus().loadedFrom, 'cache')
})

test('separate service instances isolate list, status, and download state', async () => {
  const fixtureA = await createIndexFixture()
  const manifestB = {
    ...baseManifest,
    id: 'com.example.second-index-tool',
    name: 'Second Index Tool'
  }
  const fixtureB = await createIndexFixture({ manifest: manifestB })
  const serviceA = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixtureA.indexPath
  })
  const serviceB = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixtureB.indexPath
  })

  const [[entryA], [entryB]] = await Promise.all([serviceA.list(), serviceB.list()])
  const statusA = serviceA.getStatus()
  const statusB = serviceB.getStatus()
  assert.equal(entryA.id, baseManifest.id)
  assert.equal(entryB.id, manifestB.id)
  assert.notEqual(statusA.sourceUrl, statusB.sourceUrl)

  const [downloadA, downloadB] = await Promise.all([
    serviceA.downloadPackage(entryA.id),
    serviceB.downloadPackage(entryB.id)
  ])
  try {
    assert.equal(downloadA.entry.id, entryA.id)
    assert.equal(downloadB.entry.id, entryB.id)
    assert.equal(serviceA.getStatus().sourceUrl, statusA.sourceUrl)
    assert.equal(serviceB.getStatus().sourceUrl, statusB.sourceUrl)
  } finally {
    await Promise.all([downloadA.cleanup(), downloadB.cleanup()])
  }
})

test('valid official remote chain is official while expired cache fallback is downgraded', async () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [
      {
        keyId: 'release-2026',
        publisher: 'Example Publisher',
        algorithm: 'ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status: 'active',
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2027-01-01T00:00:00.000Z'
      }
    ]
  })
  const fixture = await createIndexFixture({
    entryTransform: (entry) => signIndexEntry(entry, DEFAULT_PLUGIN_INDEX_URL, keys.privateKey)
  })
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const remote = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    cacheIndexPath: cachePath,
    cacheTtlMs: 60 * 60 * 1000,
    now: () => new Date('2026-07-15T08:00:00.000Z'),
    trustedPublisherRegistry: registry,
    fetchImpl: createFetch({
      [DEFAULT_PLUGIN_INDEX_URL]: await readFile(fixture.indexPath)
    })
  })

  const [remoteEntry] = await remote.list()
  assert.equal(remoteEntry.verification.level, 'official')
  assert.equal(remoteEntry.verification.official, true)
  assert.equal(remote.getStatus().originVerified, true)

  const cached = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    cacheIndexPath: cachePath,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    trustedPublisherRegistry: registry,
    fetchImpl: async () => new Response('unavailable', { status: 503 })
  })
  const [cachedEntry] = await cached.refresh()
  const cachedStatus = cached.getStatus()

  assert.equal(cachedEntry.verification.signatureStatus, 'valid')
  assert.equal(cachedEntry.verification.level, 'publisher-signed')
  assert.equal(cachedEntry.verification.official, false)
  assert.equal(cachedStatus.loadedFrom, 'cache')
  assert.equal(cachedStatus.cacheFormat, 'envelope-v1')
  assert.equal(cachedStatus.originVerified, true)
  assert.equal(cachedStatus.stale, true)
  assert.equal(cachedStatus.expired, true)
})

test('resident official entries dynamically expire across TTL for list, status, and download evidence', async () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = createTestRegistry(
    keys.publicKey,
    '2026-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z'
  )
  const fixture = await createIndexFixture({
    entryTransform: (entry) => signIndexEntry(entry, DEFAULT_PLUGIN_INDEX_URL, keys.privateKey)
  })
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    DEFAULT_PLUGIN_INDEX_URL
  ).toString()
  let now = new Date('2026-07-16T08:00:00.000Z')
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    cacheTtlMs: 60 * 60 * 1000,
    now: () => now,
    trustedPublisherRegistry: registry,
    fetchImpl: createFetch({
      [DEFAULT_PLUGIN_INDEX_URL]: await readFile(fixture.indexPath),
      [packageUrl]: await readFile(fixture.packagePath)
    })
  })

  assert.equal((await service.list())[0].verification.level, 'official')
  now = new Date('2026-07-16T09:00:00.001Z')

  assert.equal(service.getStatus().expired, true)
  const [expiredEntry] = await service.list()
  assert.equal(expiredEntry.verification.signatureStatus, 'valid')
  assert.equal(expiredEntry.verification.level, 'publisher-signed')
  assert.equal(expiredEntry.verification.official, false)

  const downloaded = await service.downloadPackage(baseManifest.id)
  try {
    // Install always force-refreshes the remote index so package metadata stays current.
    assert.equal(downloaded.entry.verification.level, 'official')
    assert.equal(downloaded.evidence.expired, false)
    assert.equal(downloaded.evidence.verification?.official, true)
    assert.equal(downloaded.evidence.expectedPackageSha256, downloaded.entry.checksumSha256)
  } finally {
    await downloaded.cleanup()
  }
})

test('resident official entries dynamically lose trust when publisher key notAfter passes', async () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = createTestRegistry(
    keys.publicKey,
    '2026-01-01T00:00:00.000Z',
    '2026-07-16T09:00:00.000Z'
  )
  const fixture = await createIndexFixture({
    entryTransform: (entry) => signIndexEntry(entry, DEFAULT_PLUGIN_INDEX_URL, keys.privateKey)
  })
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    DEFAULT_PLUGIN_INDEX_URL
  ).toString()
  let now = new Date('2026-07-16T08:00:00.000Z')
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    now: () => now,
    trustedPublisherRegistry: registry,
    fetchImpl: createFetch({
      [DEFAULT_PLUGIN_INDEX_URL]: await readFile(fixture.indexPath),
      [packageUrl]: await readFile(fixture.packagePath)
    })
  })

  const [initialEntry] = await service.list()
  assert.equal(initialEntry.verification.level, 'official')
  assert.equal(initialEntry.verification.revalidateAt, '2026-07-16T09:00:00.000Z')
  now = new Date('2026-07-16T09:00:00.000Z')

  assert.equal(service.getStatus().expired, false)
  const [expiredKeyEntry] = await service.list()
  assert.equal(expiredKeyEntry.verification.signatureStatus, 'key-expired')
  assert.equal(expiredKeyEntry.verification.level, 'index-declared')
  assert.equal(expiredKeyEntry.verification.official, false)

  const downloaded = await service.downloadPackage(baseManifest.id)
  try {
    assert.equal(downloaded.evidence.expired, false)
    assert.equal(downloaded.evidence.verification?.signatureStatus, 'key-expired')
    assert.equal(downloaded.evidence.verification?.official, false)
  } finally {
    await downloaded.cleanup()
  }
})

for (const boundary of ['status', 'list', 'download'] as const) {
  test(`TTL expiry is independently revalidated at the ${boundary} boundary`, async () => {
    const harness = await createResidentOfficialHarness({
      cacheTtlMs: 60 * 60 * 1000,
      keyNotAfter: '2027-01-01T00:00:00.000Z'
    })
    harness.setNow('2026-07-16T09:00:00.001Z')

    if (boundary === 'status') {
      assert.equal(harness.service.getStatus().expired, true)
      assert.equal(residentEntries(harness.service)[0].verification.level, 'publisher-signed')
      return
    }
    if (boundary === 'list') {
      const [entry] = await harness.service.list()
      assert.equal(entry.verification.level, 'publisher-signed')
      assert.equal(harness.service.getStatus().expired, true)
      return
    }
    ;(harness.service as unknown as { indexValidatedAt: number }).indexValidatedAt = 0
    const downloaded = await harness.service.downloadPackage(baseManifest.id)
    try {
      assert.equal(downloaded.entry.verification.level, 'official')
      assert.equal(downloaded.evidence.expired, false)
    } finally {
      await downloaded.cleanup()
    }
  })

  test(`publisher key notAfter is independently revalidated at the ${boundary} boundary`, async () => {
    const harness = await createResidentOfficialHarness({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      keyNotAfter: '2026-07-16T09:00:00.000Z'
    })
    harness.setNow('2026-07-16T09:00:00.000Z')

    if (boundary === 'status') {
      assert.equal(harness.service.getStatus().expired, false)
      assert.equal(residentEntries(harness.service)[0].verification.signatureStatus, 'key-expired')
      return
    }
    if (boundary === 'list') {
      const [entry] = await harness.service.list()
      assert.equal(entry.verification.signatureStatus, 'key-expired')
      assert.equal(entry.verification.official, false)
      return
    }
    const downloaded = await harness.service.downloadPackage(baseManifest.id)
    try {
      assert.equal(downloaded.entry.verification.signatureStatus, 'key-expired')
      assert.equal(downloaded.evidence.verification?.official, false)
    } finally {
      await downloaded.cleanup()
    }
  })
}

test('download rejects when a concurrent refresh changes the expected package hash', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const indexA = await readFile(fixture.indexPath)
  const parsedIndexB = JSON.parse(indexA.toString('utf-8')) as {
    plugins: Array<Record<string, unknown>>
  }
  parsedIndexB.plugins[0].checksumSha256 = 'b'.repeat(64)
  const indexB = Buffer.from(JSON.stringify(parsedIndexB), 'utf-8')
  const packageResponse = deferred<Response>()
  const packageRequested = deferred<void>()
  let indexRequests = 0
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    fetchImpl: async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === remoteUrl) {
        // list() + downloadPackage force-refresh both pin indexA; later refresh flips to indexB.
        const body = indexRequests++ < 2 ? indexA : indexB
        return new Response(new Uint8Array(body))
      }
      if (url === packageUrl) {
        packageRequested.resolve()
        return await packageResponse.promise
      }
      return new Response('not found', { status: 404 })
    }
  })
  await service.list()
  ;(service as unknown as { indexValidatedAt: number }).indexValidatedAt = 0
  const download = service.downloadPackage(baseManifest.id)
  await packageRequested.promise
  await service.refresh()
  packageResponse.resolve(new Response(new Uint8Array(await readFile(fixture.packagePath))))

  await assert.rejects(download, /索引在下载期间发生变化/)
})

test('download binds the complete index entry fingerprint even when checksum is unchanged', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const indexA = await readFile(fixture.indexPath)
  const indexB = mutateIndex(indexA, {
    description: 'replacement metadata with the same package hash',
    sourceUrl: 'packages/rebound-source.tep',
    tags: ['replacement'],
    verified: false,
    publisherSignature: {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: 'replacement-key',
      value: Buffer.alloc(64, 1).toString('base64')
    }
  })
  const packageResponse = deferred<Response>()
  const packageRequested = deferred<void>()
  let indexRequests = 0
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    fetchImpl: async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === remoteUrl) {
        // list() + downloadPackage force-refresh both pin indexA; later refresh flips to indexB.
        return new Response(new Uint8Array(indexRequests++ < 2 ? indexA : indexB))
      }
      if (url === packageUrl) {
        packageRequested.resolve()
        return packageResponse.promise
      }
      return new Response('not found', { status: 404 })
    }
  })
  await service.list()
  ;(service as unknown as { indexValidatedAt: number }).indexValidatedAt = 0
  const download = service.downloadPackage(baseManifest.id)
  await packageRequested.promise
  await service.refresh()
  packageResponse.resolve(new Response(new Uint8Array(await readFile(fixture.packagePath))))

  await assert.rejects(download, /索引在下载期间发生变化/)
})

test('cache cannot self-assert origin verification', async () => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const configuredUrl = DEFAULT_PLUGIN_INDEX_URL
  const persistedOrigin = 'https://attacker.example/plugins.json'
  await mkdir(join(fixture.root, 'cache'), { recursive: true })
  await writeFile(
    cachePath,
    JSON.stringify({
      cacheSchemaVersion: 1,
      origin: persistedOrigin,
      fetchedAt: '2026-07-16T07:00:00.000Z',
      expiresAt: '2026-07-17T07:00:00.000Z',
      originVerified: true,
      index: JSON.parse(await readFile(fixture.indexPath, 'utf-8'))
    }),
    'utf-8'
  )
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: configuredUrl,
    cacheIndexPath: cachePath,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    fetchImpl: async () => new Response('unavailable', { status: 503 })
  })

  const [entry] = await service.refresh()
  const status = service.getStatus()

  assert.equal(status.sourceUrl, persistedOrigin)
  assert.equal(status.configuredSourceUrl, configuredUrl)
  assert.equal(status.originVerified, false)
  assert.equal(status.loadedFrom, 'cache')
  assert.equal(entry.verification.official, false)
})

test('a redirect away from the configured official URL loses official-origin status', async () => {
  const fixture = await createIndexFixture()
  const redirectUrl = 'https://mirror.example/plugins.json'
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    fetchImpl: async () =>
      ({
        ...responseFor(await readFile(fixture.indexPath)),
        url: redirectUrl
      }) as Response
  })

  const [entry] = await service.list()
  const status = service.getStatus()

  assert.equal(status.sourceUrl, redirectUrl)
  assert.equal(status.configuredSourceUrl, DEFAULT_PLUGIN_INDEX_URL)
  assert.equal(status.officialSource, false)
  assert.equal(status.originVerified, false)
  assert.equal(entry.verification.official, false)
})

test('redirected responses fail the direct-load requirement even when final URL matches', async () => {
  const fixture = await createIndexFixture()
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    fetchImpl: async () =>
      ({
        ...responseFor(await readFile(fixture.indexPath)),
        url: DEFAULT_PLUGIN_INDEX_URL,
        redirected: true
      }) as Response
  })

  const [entry] = await service.list()

  assert.equal(service.getStatus().officialSource, true)
  assert.equal(service.getStatus().originVerified, false)
  assert.equal(entry.verification.official, false)
})

test('falls back to cached remote index when refresh fails', async () => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'cache', 'plugins.json')
  const remoteUrl = 'https://example.test/plugins.json'
  await mkdir(join(fixture.root, 'cache'), { recursive: true })
  await writeFile(cachePath, await readFile(fixture.indexPath), 'utf-8')
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    fetchImpl: async () => new Response('unavailable', { status: 503 })
  })

  const entries = await service.refresh()
  const status = service.getStatus()

  assert.equal(entries[0].id, baseManifest.id)
  assert.equal(status.sourceUrl, remoteUrl)
  assert.equal(status.sourceKind, 'custom')
  assert.equal(status.loadedFrom, 'cache')
  assert.equal(status.stale, true)
  assert.equal(status.expired, true)
  assert.equal(status.originVerified, false)
  assert.equal(status.cacheFormat, 'legacy')
  assert.equal(status.lastFetchedAt, null)
  assert.equal(status.expiresAt, null)
  assert.equal(entries[0].verification.official, false)
  assert.match(status.error ?? '', /HTTP 503/)
})

test('falls back to bundled index when remote and cache fail', async () => {
  const fixture = await createIndexFixture()
  const cachePath = join(fixture.root, 'missing', 'plugins.json')
  const remoteUrl = 'https://example.test/plugins.json'
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    cacheIndexPath: cachePath,
    fetchImpl: async () => {
      throw new Error('network down')
    }
  })

  const entries = await service.refresh()
  const status = service.getStatus()

  assert.equal(entries[0].id, baseManifest.id)
  assert.equal(status.loadedFrom, 'bundled')
  assert.equal(status.sourceKind, 'bundled')
  assert.equal(status.stale, true)
  assert.equal(status.officialSource, false)
  assert.equal(entries[0].verification.official, false)
  assert.match(status.error ?? '', /network down/)
})

test('loads remote https indexes and resolves relative package URLs', async () => {
  const fixture = await createIndexFixture()
  const indexContent = await readFile(fixture.indexPath, 'utf-8')
  const packageBuffer = await readFile(fixture.packagePath)
  const requested: string[] = []
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: 'https://example.test/plugins.json',
    fetchImpl: async (url) => {
      requested.push(String(url))
      return responseFor(String(url).endsWith('/plugins.json') ? indexContent : packageBuffer)
    }
  })

  const downloaded = await service.downloadPackage(baseManifest.id)
  try {
    assert.equal(downloaded.entry.id, baseManifest.id)
    assert.deepEqual(requested, [
      'https://example.test/plugins.json',
      `https://example.test/packages/${baseManifest.id}-${baseManifest.version}.tep`
    ])
  } finally {
    await downloaded.cleanup()
  }
})

test('preflights an oversized remote index Content-Length without reading its body', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  let bodyRead = false
  let bodyCancelled = false
  let requestAborted = false
  let redirectMode: RequestRedirect | undefined
  const oversizedBody = {
    getReader() {
      bodyRead = true
      throw new Error('The body reader must not be opened after an oversized Content-Length')
    },
    cancel: async () => {
      bodyCancelled = true
    }
  } as unknown as ReadableStream<Uint8Array>
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    indexSizeLimitBytes: 1024,
    fetchImpl: async (_input, init) => {
      redirectMode = init?.redirect
      init?.signal?.addEventListener(
        'abort',
        () => {
          requestAborted = true
        },
        { once: true }
      )
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '1025' }),
        body: oversizedBody,
        url: '',
        redirected: false,
        arrayBuffer: async () => {
          throw new Error('arrayBuffer must not be used for plugin indexes')
        }
      } as unknown as Response
    }
  })

  const [entry] = await service.list()

  assert.equal(entry.id, baseManifest.id)
  assert.equal(service.getStatus().loadedFrom, 'bundled')
  assert.equal(redirectMode, 'manual')
  assert.equal(requestAborted, true)
  assert.equal(bodyCancelled, true)
  assert.equal(bodyRead, false)
  assert.match(service.getStatus().error ?? '', /Content-Length.*size limit/)
})

test('aborts a chunked oversized package and removes its partial same-volume staging file', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const stagingDir = join(fixture.root, 'same-volume-staging')
  const indexContent = await readFile(fixture.indexPath)
  let packageRequestAborted = false
  let packageBodyCancelled = false
  let packagePulls = 0
  const requestRedirectModes: Array<RequestRedirect | undefined> = []
  const chunkedPackage = {
    getReader() {
      let readIndex = 0
      return {
        read: async () => {
          packagePulls += 1
          if (readIndex++ === 0) return { done: false, value: new Uint8Array([1, 2, 3, 4]) }
          return { done: false, value: new Uint8Array([5, 6, 7, 8, 9]) }
        },
        cancel: async () => {
          packageBodyCancelled = true
        },
        releaseLock: () => undefined
      }
    },
    cancel: async () => {
      packageBodyCancelled = true
    }
  } as unknown as ReadableStream<Uint8Array>
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    packageSizeLimitBytes: 8,
    packageStagingDir: stagingDir,
    fetchImpl: async (input, init) => {
      const url = String(input)
      requestRedirectModes.push(init?.redirect)
      if (url === remoteUrl) return responseFor(indexContent)
      if (url === packageUrl) {
        init?.signal?.addEventListener(
          'abort',
          () => {
            packageRequestAborted = true
          },
          { once: true }
        )
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: chunkedPackage,
          url: '',
          redirected: false,
          arrayBuffer: async () => {
            throw new Error('arrayBuffer must not be used for plugin packages')
          }
        } as unknown as Response
      }
      return new Response('not found', { status: 404 })
    }
  })

  await assert.rejects(() => service.downloadPackage(baseManifest.id), /size limit/)

  assert.equal(packageRequestAborted, true)
  assert.equal(packageBodyCancelled, true)
  assert.equal(packagePulls, 2)
  assert.deepEqual(requestRedirectModes, ['manual', 'manual'])
  assert.deepEqual(await readdir(stagingDir), [])
})

test('streams a remote package into the configured staging volume while hashing chunks', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const stagingDir = join(fixture.root, 'same-volume-staging')
  const packageBytes = await readFile(fixture.packagePath)
  const chunks = [
    packageBytes.subarray(0, 7),
    packageBytes.subarray(7, 31),
    packageBytes.subarray(31)
  ]
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    packageStagingDir: stagingDir,
    fetchImpl: async (input) => {
      const url = String(input)
      if (url === remoteUrl) return responseFor(await readFile(fixture.indexPath))
      if (url === packageUrl) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: streamFromChunks(chunks),
          url: '',
          redirected: false,
          arrayBuffer: async () => {
            throw new Error('arrayBuffer must not be used for plugin packages')
          }
        } as unknown as Response
      }
      return new Response('not found', { status: 404 })
    }
  })

  const downloaded = await service.downloadPackage(baseManifest.id)
  try {
    assert.equal(downloaded.packagePath.startsWith(stagingDir), true)
    assert.deepEqual(await readFile(downloaded.packagePath), packageBytes)
    assert.equal(downloaded.evidence.packageSha256, downloaded.entry.checksumSha256)
    assert.equal(downloaded.evidence.checksumVerified, true)
  } finally {
    await downloaded.cleanup()
  }
  assert.deepEqual(await readdir(stagingDir), [])
})

test('stops redirect loops before issuing a repeated plugin package request', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const requested: string[] = []
  const redirectModes: Array<RequestRedirect | undefined> = []
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    fetchImpl: async (input, init) => {
      const url = String(input)
      requested.push(url)
      redirectModes.push(init?.redirect)
      if (url === remoteUrl) return responseFor(await readFile(fixture.indexPath))
      if (url === packageUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: packageUrl }
        })
      }
      return new Response('not found', { status: 404 })
    }
  })

  await assert.rejects(() => service.downloadPackage(baseManifest.id), /redirect loop/)

  assert.deepEqual(requested, [remoteUrl, packageUrl])
  assert.deepEqual(redirectModes, ['manual', 'manual'])
})

test('rechecks redirect policy at every package hop and blocks HTTPS downgrade', async () => {
  const fixture = await createIndexFixture()
  const remoteUrl = 'https://plugins.example.test/plugins.json'
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    remoteUrl
  ).toString()
  const intermediateUrl = 'https://cdn.example.test/plugins/intermediate.tep'
  const requested: string[] = []
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: remoteUrl,
    fetchImpl: async (input, init) => {
      assert.equal(init?.redirect, 'manual')
      const url = String(input)
      requested.push(url)
      if (url === remoteUrl) return responseFor(await readFile(fixture.indexPath))
      if (url === packageUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: intermediateUrl }
        })
      }
      if (url === intermediateUrl) {
        return new Response(null, {
          status: 307,
          headers: { location: 'http://example.test/plugin.tep' }
        })
      }
      return new Response('unexpected request', { status: 500 })
    }
  })

  await assert.rejects(() => service.downloadPackage(baseManifest.id), /redirect downgrade/)

  assert.deepEqual(requested, [remoteUrl, packageUrl, intermediateUrl])
})

test('allows localhost http indexes and rejects non-local http indexes', async () => {
  const fixture = await createIndexFixture()
  const indexContent = await readFile(fixture.indexPath, 'utf-8')
  const localhostService = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: 'http://127.0.0.1/plugins.json',
    fetchImpl: async () => responseFor(indexContent)
  })
  assert.equal((await localhostService.list()).length, 1)

  const externalHttpService = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: 'http://example.test/plugins.json',
    fetchImpl: async () => responseFor(indexContent)
  })
  await assert.rejects(() => externalHttpService.list(), /https|本机 http/)
})

test('bundled plugin index does not carry third-party tep packages', async () => {
  const pluginIndexRoot = new URL('../../../resources/plugin-index/', import.meta.url)
  const packageFiles = await listFiles(pluginIndexRoot)
  const tepFiles = packageFiles.filter((file) => extname(file).toLowerCase() === '.tep')

  assert.deepEqual(
    tepFiles,
    [],
    'third-party .tep packages belong in D:\\Twilight-Echo-plugins, not the app repository'
  )
})

async function createIndexFixture(
  options: {
    manifest?: typeof baseManifest
    indexManifest?: typeof baseManifest
    sourceUrl?: string
    checksumSha256?: string
    entryTransform?: (entry: Record<string, unknown>) => Record<string, unknown>
  } = {}
): Promise<{ root: string; indexPath: string; packagePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'twilight-index-test-'))
  const packageRoot = join(root, 'plugin')
  const packageDir = join(root, 'packages')
  await mkdir(packageRoot, { recursive: true })
  await mkdir(packageDir, { recursive: true })
  const manifest = options.manifest ?? baseManifest
  const indexManifest = options.indexManifest ?? manifest
  await writeFile(join(packageRoot, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  await writeFile(join(packageRoot, 'index.mjs'), 'export function activate() {}', 'utf-8')
  const packageFileName = `${manifest.id}-${manifest.version}.tep`
  const packagePath = join(packageDir, packageFileName)
  await createZip(packageRoot, packagePath)
  const buffer = await readFile(packagePath)
  const checksumSha256 = options.checksumSha256 ?? createHash('sha256').update(buffer).digest('hex')
  const indexPath = join(root, 'plugins.json')
  const indexEntry: Record<string, unknown> = {
    ...indexManifest,
    sourceUrl: options.sourceUrl ?? `packages/${packageFileName}`,
    checksumSha256,
    repository: indexManifest.repository,
    homepage: indexManifest.homepage,
    tags: ['test'],
    verified: true
  }
  await writeFile(
    indexPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        plugins: [options.entryTransform ? options.entryTransform(indexEntry) : indexEntry]
      },
      null,
      2
    ),
    'utf-8'
  )
  return { root, indexPath, packagePath }
}

function mutateIndex(index: Buffer, mutation: Record<string, unknown>): Buffer {
  const parsed = JSON.parse(index.toString('utf-8')) as {
    plugins: Array<Record<string, unknown>>
  }
  parsed.plugins[0] = { ...parsed.plugins[0], ...mutation }
  return Buffer.from(JSON.stringify(parsed), 'utf-8')
}

function createTestRegistry(publicKey: KeyObject, notBefore: string, notAfter: string) {
  return createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [
      {
        keyId: 'release-2026',
        publisher: 'Example Publisher',
        algorithm: 'ed25519',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status: 'active',
        notBefore,
        notAfter
      }
    ]
  })
}

function signIndexEntry(
  entry: Record<string, unknown>,
  origin: string,
  privateKey: KeyObject
): Record<string, unknown> {
  return {
    ...entry,
    publisherSignature: {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: 'release-2026',
      value: sign(null, createPluginIndexSignaturePayload(entry, origin), privateKey).toString(
        'base64'
      )
    }
  }
}

async function createResidentOfficialHarness(options: {
  cacheTtlMs: number
  keyNotAfter: string
}): Promise<{
  service: PluginIndexService
  setNow: (value: string) => void
}> {
  const keys = generateKeyPairSync('ed25519')
  const registry = createTestRegistry(
    keys.publicKey,
    '2026-01-01T00:00:00.000Z',
    options.keyNotAfter
  )
  const fixture = await createIndexFixture({
    entryTransform: (entry) => signIndexEntry(entry, DEFAULT_PLUGIN_INDEX_URL, keys.privateKey)
  })
  const packageUrl = new URL(
    `packages/${baseManifest.id}-${baseManifest.version}.tep`,
    DEFAULT_PLUGIN_INDEX_URL
  ).toString()
  let now = new Date('2026-07-16T08:00:00.000Z')
  const service = new PluginIndexService({
    appVersion: '0.20.0',
    localIndexPath: fixture.indexPath,
    remoteIndexUrl: DEFAULT_PLUGIN_INDEX_URL,
    cacheTtlMs: options.cacheTtlMs,
    now: () => now,
    trustedPublisherRegistry: registry,
    fetchImpl: createFetch({
      [DEFAULT_PLUGIN_INDEX_URL]: await readFile(fixture.indexPath),
      [packageUrl]: await readFile(fixture.packagePath)
    })
  })
  const [initialEntry] = await service.list()
  assert.equal(initialEntry.verification.level, 'official')
  assert.equal(initialEntry.verification.revalidateAt, options.keyNotAfter)
  return {
    service,
    setNow: (value) => {
      now = new Date(value)
    }
  }
}

function residentEntries(service: PluginIndexService): TwilightPluginIndexEntry[] {
  const entries = (service as unknown as { cachedEntries: TwilightPluginIndexEntry[] | null })
    .cachedEntries
  assert.ok(entries)
  return entries
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function responseFor(body: string | Buffer): Response {
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: streamFromChunks([buffer]),
    url: '',
    redirected: false
  } as unknown as Response
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    }
  })
}

function descriptor(overrides: Partial<TwilightPluginDescriptor> = {}): TwilightPluginDescriptor {
  return {
    ...baseManifest,
    status: 'disabled',
    enabled: false,
    builtIn: false,
    error: null,
    isDsp: false,
    source: 'index',
    installedAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
    paths: {
      root: '',
      versionRoot: '',
      manifestPath: '',
      dataDir: '',
      logPath: ''
    },
    ...overrides
  } as TwilightPluginDescriptor
}

function createFetch(responses: Record<string, Buffer>): typeof fetch {
  return async (url) => {
    const key = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const buffer = responses[key]
    if (!buffer) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(buffer))
  }
}

async function listFiles(root: URL): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, root)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(child)))
    } else {
      files.push(child.pathname)
    }
  }
  return files
}
