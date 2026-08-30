import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  OFFICIAL_PLUGIN_INDEX_URL,
  createPluginIndexEntryFingerprint,
  createPluginIndexSignaturePayload,
  createTrustedPluginPublisherRegistry,
  loadTrustedPluginPublisherRegistry,
  verifyPluginIndexEntry,
  type PluginIndexTrustContext,
  type TrustedPluginPublisherRegistry
} from './indexTrust.ts'
import { validatePluginManifest } from './manifest.ts'

const NOW = new Date('2026-07-16T08:00:00.000Z')
const baseEntry: Record<string, unknown> = {
  id: 'com.example.signed-tool',
  name: 'Signed Tool',
  version: '1.0.0',
  description: 'Signed test plugin',
  author: 'Example Publisher',
  license: 'Apache-2.0',
  type: ['tool'],
  main: 'index.mjs',
  engines: { twilightEcho: '>=0.20.0' },
  apiVersion: 1,
  permissions: ['player:observe'],
  repository: 'https://example.test/repository',
  homepage: 'https://example.test/plugin',
  sourceUrl: 'packages/com.example.signed-tool-1.0.0.tep',
  checksumSha256: 'a'.repeat(64),
  tags: ['test'],
  verified: true
}

test('trusted publisher registry fails closed before parsing oversized or deeply nested files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-trusted-registry-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const registryPath = join(directory, 'trusted-publishers.json')

  await writeFile(registryPath, `${'['.repeat(128)}0${']'.repeat(128)}`, 'utf8')
  assert.match(loadTrustedPluginPublisherRegistry(registryPath).error ?? '', /too deeply nested/)

  await writeFile(registryPath, 'x'.repeat(512 * 1024 + 1), 'utf8')
  assert.match(loadTrustedPluginPublisherRegistry(registryPath).error ?? '', /too large/)
})

test('custom verified:true is only an index claim without a trusted signature', () => {
  const result = verifyPluginIndexEntry(
    baseEntry,
    context('https://evil.example/plugins.json'),
    emptyRegistry(),
    NOW
  )

  assert.equal(result.verification.level, 'index-declared')
  assert.equal(result.verification.indexClaimed, true)
  assert.equal(result.verification.signatureStatus, 'missing')
  assert.equal(result.verification.official, false)
})

test('official verification requires the exact origin and a valid active Ed25519 key', () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = registryFor(keys.publicKey)
  const entry = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  const result = verifyPluginIndexEntry(entry, context(OFFICIAL_PLUGIN_INDEX_URL), registry, NOW)

  assert.equal(result.verification.level, 'official')
  assert.equal(result.verification.official, true)
  assert.equal(result.verification.signatureStatus, 'valid')
  assert.equal(result.verification.keyId, 'release-2026')
  assert.match(result.verification.keyFingerprintSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(result.verification.revalidateAt, '2027-01-01T00:00:00.000Z')
})

test('official-lookalike and changed entry fields cannot reuse an official signature', () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = registryFor(keys.publicKey)
  const signed = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  const lookalike = verifyPluginIndexEntry(
    signed,
    context(`${OFFICIAL_PLUGIN_INDEX_URL}.evil.example/plugins.json`),
    registry,
    NOW
  )
  assert.equal(lookalike.verification.signatureStatus, 'invalid')
  assert.equal(lookalike.verification.official, false)

  for (const mutation of [
    { checksumSha256: 'b'.repeat(64) },
    { sourceUrl: 'packages/replaced.tep' },
    { name: 'Replaced Tool' },
    { verified: false }
  ]) {
    const result = verifyPluginIndexEntry(
      { ...signed, ...mutation },
      context(OFFICIAL_PLUGIN_INDEX_URL),
      registry,
      NOW
    )
    assert.equal(result.verification.signatureStatus, 'invalid')
    assert.equal(result.verification.official, false)
  }
})

test('entry fingerprint binds origin, complete metadata, and publisher signature', () => {
  const keys = generateKeyPairSync('ed25519')
  const signed = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  const fingerprint = createPluginIndexEntryFingerprint(signed, OFFICIAL_PLUGIN_INDEX_URL)
  assert.match(fingerprint, /^[a-f0-9]{64}$/)

  const mutations = [
    { ...signed, description: 'changed description' },
    { ...signed, tags: ['changed'] },
    {
      ...signed,
      publisherSignature: {
        ...(signed.publisherSignature as Record<string, unknown>),
        value: Buffer.alloc(64, 2).toString('base64')
      }
    }
  ]
  for (const mutation of mutations) {
    assert.notEqual(
      createPluginIndexEntryFingerprint(mutation, OFFICIAL_PLUGIN_INDEX_URL),
      fingerprint
    )
  }
  assert.notEqual(
    createPluginIndexEntryFingerprint(signed, 'https://mirror.example/plugins.json'),
    fingerprint
  )
})

test('POSIX manifest path normalization produces one signing vector and detects nested-path tampering', () => {
  const manifestBase = {
    id: 'com.example.cross-platform-signed',
    name: 'Cross Platform Signed',
    version: '1.0.0',
    description: 'Cross-platform signature vector',
    author: 'Example Publisher',
    license: 'Apache-2.0',
    type: ['tool', 'dsp'],
    engines: { twilightEcho: '>=0.20.0' },
    apiVersion: 1,
    permissions: ['dsp:native']
  }
  const windowsManifestInput = {
    ...manifestBase,
    main: 'dist\\generated\\..\\index.mjs',
    icon: 'assets\\icons\\plugin.png',
    binary: {
      'win32-x64': 'native\\win32\\plugin.dll',
      'linux-x64': 'native\\linux\\libplugin.so'
    }
  }
  const posixManifestInput = {
    ...manifestBase,
    main: 'dist/index.mjs',
    icon: 'assets/icons/plugin.png',
    binary: {
      'win32-x64': 'native/win32/plugin.dll',
      'linux-x64': 'native/linux/libplugin.so'
    }
  }
  const windowsManifest = validatePluginManifest(windowsManifestInput)
  const posixManifest = validatePluginManifest(posixManifestInput)
  const windowsEntry: Record<string, unknown> = {
    ...windowsManifestInput,
    sourceUrl: 'packages/com.example.cross-platform-signed-1.0.0.tep',
    checksumSha256: 'a'.repeat(64),
    tags: ['golden'],
    verified: true
  }
  const posixEntry: Record<string, unknown> = {
    ...posixManifestInput,
    sourceUrl: 'packages/com.example.cross-platform-signed-1.0.0.tep',
    checksumSha256: 'a'.repeat(64),
    tags: ['golden'],
    verified: true
  }
  const payload = createPluginIndexSignaturePayload(windowsEntry, OFFICIAL_PLUGIN_INDEX_URL)
  const expectedPayload =
    '{"entry":{"apiVersion":1,"author":"Example Publisher","binary":{"linux-x64":"native/linux/libplugin.so","win32-x64":"native/win32/plugin.dll"},"checksumSha256":"' +
    'a'.repeat(64) +
    '","description":"Cross-platform signature vector","engines":{"twilightEcho":">=0.20.0"},"icon":"assets/icons/plugin.png","id":"com.example.cross-platform-signed","license":"Apache-2.0","main":"dist/index.mjs","name":"Cross Platform Signed","permissions":["dsp:native"],"sourceUrl":"packages/com.example.cross-platform-signed-1.0.0.tep","tags":["golden"],"type":["tool","dsp"],"verified":true,"version":"1.0.0"},"indexOrigin":"' +
    OFFICIAL_PLUGIN_INDEX_URL +
    '","schemaVersion":1}'

  assert.deepEqual(windowsManifest, posixManifest)
  assert.equal(payload.toString('utf-8'), expectedPayload)
  assert.deepEqual(
    payload,
    createPluginIndexSignaturePayload(posixEntry, OFFICIAL_PLUGIN_INDEX_URL)
  )

  const keys = generateKeyPairSync('ed25519')
  const registry = registryFor(keys.publicKey)
  const signed = signEntry(windowsEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  assert.equal(
    verifyPluginIndexEntry(signed, context(OFFICIAL_PLUGIN_INDEX_URL), registry, NOW).verification
      .signatureStatus,
    'valid'
  )
  for (const mutation of [
    { main: 'dist/other.mjs' },
    { icon: 'assets/icons/other.png' },
    {
      binary: {
        ...(posixManifest.binary ?? {}),
        'win32-x64': 'native/win32/replaced.dll'
      }
    }
  ]) {
    assert.equal(
      verifyPluginIndexEntry(
        { ...signed, ...mutation },
        context(OFFICIAL_PLUGIN_INDEX_URL),
        registry,
        NOW
      ).verification.signatureStatus,
      'invalid'
    )
  }
})

test('cache, stale, expired, and unverified origins always downgrade a valid signature', () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = registryFor(keys.publicKey)
  const signed = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  const contexts: PluginIndexTrustContext[] = [
    { ...context(OFFICIAL_PLUGIN_INDEX_URL), loadedFrom: 'cache' },
    { ...context(OFFICIAL_PLUGIN_INDEX_URL), stale: true },
    { ...context(OFFICIAL_PLUGIN_INDEX_URL), expired: true },
    { ...context(OFFICIAL_PLUGIN_INDEX_URL), originVerified: false }
  ]

  for (const trustContext of contexts) {
    const result = verifyPluginIndexEntry(signed, trustContext, registry, NOW)
    assert.equal(result.verification.signatureStatus, 'valid')
    assert.equal(result.verification.level, 'publisher-signed')
    assert.equal(result.verification.official, false)
  }
})

test('missing, malformed, unknown, revoked, and out-of-window signatures fail closed', () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = registryFor(keys.publicKey)
  const signed = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)

  assert.equal(
    verifyPluginIndexEntry(baseEntry, context(OFFICIAL_PLUGIN_INDEX_URL), registry, NOW)
      .verification.signatureStatus,
    'missing'
  )
  assert.equal(
    verifyPluginIndexEntry(
      {
        ...baseEntry,
        publisherSignature: {
          schemaVersion: 1,
          algorithm: 'ed25519',
          keyId: 'release-2026',
          value: 'not-base64'
        }
      },
      context(OFFICIAL_PLUGIN_INDEX_URL),
      registry,
      NOW
    ).verification.signatureStatus,
    'malformed'
  )
  assert.equal(
    verifyPluginIndexEntry(
      {
        ...signed,
        publisherSignature: {
          ...(signed.publisherSignature as Record<string, unknown>),
          keyId: 'unknown-key'
        }
      },
      context(OFFICIAL_PLUGIN_INDEX_URL),
      registry,
      NOW
    ).verification.signatureStatus,
    'unknown-key'
  )

  const revokedRegistry = registryFor(keys.publicKey, 'revoked')
  assert.equal(
    verifyPluginIndexEntry(signed, context(OFFICIAL_PLUGIN_INDEX_URL), revokedRegistry, NOW)
      .verification.signatureStatus,
    'revoked-key'
  )
  assert.equal(
    verifyPluginIndexEntry(
      signed,
      context(OFFICIAL_PLUGIN_INDEX_URL),
      registryFor(keys.publicKey, 'active', {
        notBefore: '2026-07-17T00:00:00.000Z',
        notAfter: '2027-01-01T00:00:00.000Z'
      }),
      NOW
    ).verification.signatureStatus,
    'key-not-yet-valid'
  )
  assert.equal(
    verifyPluginIndexEntry(
      signed,
      context(OFFICIAL_PLUGIN_INDEX_URL),
      registryFor(keys.publicKey, 'active', {
        notBefore: '2025-01-01T00:00:00.000Z',
        notAfter: '2026-07-16T08:00:00.000Z'
      }),
      NOW
    ).verification.signatureStatus,
    'key-expired'
  )
})

test('unknown trusted-key status invalidates the whole registry', () => {
  const keys = generateKeyPairSync('ed25519')
  const registry = createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [
      {
        keyId: 'release-2026',
        publisher: 'Example Publisher',
        algorithm: 'ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status: 'actve'
      }
    ]
  })
  const signed = signEntry(baseEntry, OFFICIAL_PLUGIN_INDEX_URL, keys.privateKey)
  const result = verifyPluginIndexEntry(signed, context(OFFICIAL_PLUGIN_INDEX_URL), registry, NOW)

  assert.match(registry.error ?? '', /invalid status/)
  assert.equal(result.verification.signatureStatus, 'trust-store-error')
  assert.equal(result.verification.official, false)

  const nullStatusRegistry = createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [
      {
        keyId: 'release-2026',
        publisher: 'Example Publisher',
        algorithm: 'ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status: null
      }
    ]
  })
  assert.match(nullStatusRegistry.error ?? '', /invalid status/)

  const malformedRevocationRegistry = createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [],
    revokedKeyIds: 'release-2026'
  })
  assert.match(malformedRevocationRegistry.error ?? '', /revokedKeyIds must be an array/)
})

function signEntry(
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

function registryFor(
  publicKey: KeyObject,
  status: 'active' | 'revoked' = 'active',
  validity: { notBefore: string; notAfter: string } = {
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z'
  }
): TrustedPluginPublisherRegistry {
  return createTrustedPluginPublisherRegistry({
    schemaVersion: 1,
    keys: [
      {
        keyId: 'release-2026',
        publisher: 'Example Publisher',
        algorithm: 'ed25519',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status,
        notBefore: validity.notBefore,
        notAfter: validity.notAfter
      }
    ],
    revokedKeyIds: []
  })
}

function emptyRegistry(): TrustedPluginPublisherRegistry {
  return createTrustedPluginPublisherRegistry({ schemaVersion: 1, keys: [] })
}

function context(indexOrigin: string): PluginIndexTrustContext {
  return {
    indexOrigin,
    loadedFrom: 'remote',
    stale: false,
    expired: false,
    originVerified: true
  }
}
