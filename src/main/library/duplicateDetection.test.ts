import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  contentHash,
  createDuplicateActionPlans,
  detectDuplicates,
  groupDuplicates,
  type DuplicateCandidate
} from './duplicateDetection.ts'

const HASHES = Object.fromEntries(
  Array.from({ length: 24 }, (_, index) => [
    `E:/music/${index}.wav`,
    index.toString(16).padStart(64, '0')
  ])
)

test('detects independent path, hash, acoustic, metadata, and logical-track evidence layers', async () => {
  const candidates: DuplicateCandidate[] = [
    item('path-a', { filePath: 'E:/music/path/shared.wav', duration: 101, size: 101 }),
    item('path-b', { filePath: 'E:/music/path/SHARED.wav', duration: 102, size: 102 }),
    item('hash-a', { filePath: 'E:/music/0.wav', duration: 201, size: 200 }),
    item('hash-b', { filePath: 'E:/music/1.wav', duration: 202, size: 200 }),
    item('acoustic-a', {
      filePath: 'E:/music/2.wav',
      duration: 301,
      size: 301,
      audioFingerprint: {
        algorithm: 'chromaprint-v1',
        value: 'AQID',
        evidence: 'verifiedAcoustic'
      }
    }),
    item('acoustic-b', {
      filePath: 'E:/music/3.wav',
      duration: 302,
      size: 302,
      audioFingerprint: {
        algorithm: 'chromaprint-v1',
        value: 'AQID',
        evidence: 'verifiedAcoustic'
      }
    }),
    item('metadata-a', { filePath: 'E:/music/4.wav', duration: 401, size: 400 }),
    item('metadata-b', { filePath: 'E:/music/5.wav', duration: 401, size: 400 }),
    item('logical-a', {
      filePath: 'E:/music/6.wav',
      title: 'Same Song',
      artist: 'Same Artist',
      album: 'Same Album',
      duration: 501,
      size: 501,
      sampleRate: 44_100,
      bitrate: 1_001
    }),
    item('logical-b', {
      filePath: 'E:/music/7.wav',
      title: ' same  song ',
      artist: 'SAME artist',
      album: 'same album',
      duration: 501.1,
      size: 502,
      sampleRate: 48_000,
      bitrate: 1_002
    })
  ]

  const result = await detectDuplicates(candidates, {
    contentHashForPath: async (filePath) =>
      filePath.endsWith('/0.wav') || filePath.endsWith('/1.wav') ? 'a'.repeat(64) : HASHES[filePath]
  })

  assert.deepEqual(
    result.groups.map((group) => group.kind),
    ['path', 'contentHash', 'audioFingerprint', 'metadataCandidate', 'logicalTrack']
  )
  assert.deepEqual(
    result.groups.map((group) => group.items.map((item) => item.id).sort()),
    [
      ['path-a', 'path-b'],
      ['hash-a', 'hash-b'],
      ['acoustic-a', 'acoustic-b'],
      ['metadata-a', 'metadata-b'],
      ['logical-a', 'logical-b']
    ]
  )
  assert.deepEqual(
    result.suggestions.map((suggestion) => suggestion.action),
    ['mergeSuggestion', 'mergeSuggestion', 'mark', 'mark', 'mark']
  )
  assert.ok(
    result.suggestions.every(
      (suggestion) =>
        suggestion.keepId === null &&
        suggestion.affectedIds.length === 0 &&
        suggestion.requiresConfirmation &&
        !suggestion.destructive
    )
  )
  assert.deepEqual(result.contentHashUnavailableIds, [])
})

test('never turns matching technical metadata, missing fields, or logical metadata into a merge plan', () => {
  const groups = groupDuplicates([
    item('metadata-a', { filePath: 'E:/music/8.wav', duration: 180, size: 42 }),
    item('metadata-b', { filePath: 'E:/music/9.wav', duration: 180, size: 42 }),
    item('missing-a', {
      filePath: 'E:/music/10.wav',
      title: '',
      artist: '',
      album: '',
      duration: 0,
      size: 0,
      sampleRate: undefined,
      bitrate: undefined,
      format: undefined
    }),
    item('missing-b', {
      filePath: 'E:/music/11.wav',
      title: '',
      artist: '',
      album: '',
      duration: 0,
      size: 0,
      sampleRate: undefined,
      bitrate: undefined,
      format: undefined
    })
  ])

  assert.deepEqual(
    groups.map((group) => group.kind),
    ['metadataCandidate']
  )
  assert.equal(groups[0]?.confidence, 'possible')
  const plans = createDuplicateActionPlans(groups)
  assert.deepEqual(
    plans.map((plan) => plan.action),
    ['mark']
  )
  assert.equal(plans[0]?.keepId, null)
})

test('treats an unverifiable fingerprint collision as a review-only metadata candidate', async () => {
  const result = await detectDuplicates([
    item('legacy-fingerprint-a', {
      filePath: 'E:/music/legacy-fingerprint-a.wav',
      size: 701,
      duration: 180,
      audioFingerprint: { algorithm: 'chromaprint-v1', value: 'shared-but-unverified' }
    }),
    item('legacy-fingerprint-b', {
      filePath: 'E:/music/legacy-fingerprint-b.wav',
      size: 702,
      duration: 181,
      audioFingerprint: { algorithm: 'chromaprint-v1', value: 'shared-but-unverified' }
    })
  ])

  assert.deepEqual(
    result.groups.map((group) => group.kind),
    ['metadataCandidate']
  )
  assert.equal(result.groups[0]?.confidence, 'possible')
  assert.deepEqual(
    result.suggestions.map((suggestion) => suggestion.action),
    ['mark']
  )
  assert.ok(result.suggestions.every((suggestion) => suggestion.keepId === null))
})

test('keeps detecting when authorized full-file hashing cannot read a collision candidate', async () => {
  const result = await detectDuplicates(
    [
      item('unreadable-a', { filePath: 'E:/music/12.wav', size: 900, duration: 901 }),
      item('unreadable-b', { filePath: 'E:/music/13.wav', size: 900, duration: 902 })
    ],
    {
      contentHashForPath: async () => null
    }
  )

  assert.deepEqual(result.groups, [])
  assert.deepEqual(result.contentHashUnavailableIds, ['unreadable-a', 'unreadable-b'])
})

test('streamed content hashing preserves a fixed fixture and groups identical media by its known digest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-duplicate-hash-'))
  const filePath = join(directory, 'fixture.wav')
  const identicalFilePath = join(directory, 'fixture-copy.wav')
  const original = Buffer.from('RIFF fixture bytes that are only read')
  const expectedDigest = 'd62db43d6e1ec6ee807ee68e54b1fa4a5c753930e7eac4c9e1013671e51c16ea'
  try {
    writeFileSync(filePath, original)
    writeFileSync(identicalFilePath, original)
    const digest = await contentHash(filePath)
    const identicalDigest = await contentHash(identicalFilePath)
    assert.equal(digest, expectedDigest)
    assert.equal(identicalDigest, expectedDigest)
    assert.deepEqual(readFileSync(filePath), original)
    assert.deepEqual(readFileSync(identicalFilePath), original)

    const result = await detectDuplicates(
      [
        item('fixture-a', {
          filePath,
          size: original.length,
          duration: 120
        }),
        item('fixture-b', {
          filePath: identicalFilePath,
          size: original.length,
          duration: 120
        })
      ],
      { contentHashForPath: contentHash }
    )
    assert.deepEqual(
      result.groups.map((group) => group.kind),
      ['contentHash']
    )
    assert.deepEqual(result.groups[0]?.items.map((candidate) => candidate.id).sort(), [
      'fixture-a',
      'fixture-b'
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function item(id: string, overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id,
    filePath: `E:/music/${id}.wav`,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    duration: 120,
    size: 1,
    sampleRate: 44_100,
    bitrate: 1_000,
    format: 'wav',
    ...overrides
  }
}
