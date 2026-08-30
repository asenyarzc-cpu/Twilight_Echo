import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNetworkEntryId, normalizeRemotePath, redactProfile } from './networkPath.ts'
import type { NetworkCredentialKind, NetworkSourceProfile } from '../../shared/networkSources.ts'

function makeProfile(overrides: Partial<NetworkSourceProfile> = {}): NetworkSourceProfile {
  return {
    id: 'p1',
    protocol: 'webdav',
    name: 'NAS',
    host: 'nas.local',
    port: null,
    rootPath: '/music',
    username: 'alice',
    credential: { kind: 'password', encryptedId: 'enc:secret' },
    options: {
      readOnly: true,
      connectTimeoutMs: 10_000,
      transferTimeoutMs: 60_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

test('normalizeRemotePath collapses slashes and trims dot segments', () => {
  assert.equal(normalizeRemotePath(''), '/')
  assert.equal(normalizeRemotePath(' /music//album/ '), '/music/album')
  assert.equal(normalizeRemotePath('/music/./album/'), '/music/album')
  assert.equal(normalizeRemotePath('music'), '/music')
})

test('normalizeRemotePath rejects traversal, control characters and overlong paths', () => {
  assert.throws(() => normalizeRemotePath('/music/../secret'))
  assert.throws(() => normalizeRemotePath('..'))
  assert.throws(() => normalizeRemotePath('/a/\u0000/b'))
  assert.throws(() => normalizeRemotePath('/a/\r/b'))
  assert.throws(() => normalizeRemotePath(`/${'x'.repeat(5000)}`))
})

test('buildNetworkEntryId is deterministic and scoped by protocol/profile/path', () => {
  const a = buildNetworkEntryId('webdav', 'p1', '/music/a.flac')
  assert.equal(a, buildNetworkEntryId('webdav', 'p1', '/music/a.flac'))
  assert.notEqual(a, buildNetworkEntryId('webdav', 'p1', '/music/b.flac'))
  assert.notEqual(a, buildNetworkEntryId('webdav', 'p2', '/music/a.flac'))
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('redactProfile removes credential envelope but keeps display fields', () => {
  const summary = redactProfile(makeProfile())
  assert.equal(summary.id, 'p1')
  assert.equal(summary.name, 'NAS')
  assert.equal(summary.host, 'nas.local')
  assert.equal(summary.username, 'alice')
  assert.equal(summary.credentialKind, 'password' as NetworkCredentialKind)
  assert.equal('credential' in summary, false)
  assert.equal(JSON.stringify(summary).includes('enc:secret'), false)
})
