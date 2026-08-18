import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readCachedProtocolFile,
  resetProtocolAssetCacheForTests,
  setProtocolAssetCacheMaxBytesForTests
} from './protocolAssetCache.ts'

beforeEach(() => {
  resetProtocolAssetCacheForTests()
})

test('serves repeated reads from the in-memory cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    const filePath = join(dir, 'a.jpg')
    writeFileSync(filePath, Buffer.from([1, 2, 3]))
    const first = await readCachedProtocolFile(filePath)
    assert.deepEqual(first, Buffer.from([1, 2, 3]))
    rmSync(filePath)
    const second = await readCachedProtocolFile(filePath)
    assert.deepEqual(second, Buffer.from([1, 2, 3]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to later paths when earlier ones are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    const missing = join(dir, 'missing.jpg')
    const existing = join(dir, 'existing.jpg')
    writeFileSync(existing, Buffer.from([9]))
    const data = await readCachedProtocolFile(missing, existing)
    assert.deepEqual(data, Buffer.from([9]))
    assert.equal(await readCachedProtocolFile(missing), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evicts oldest entries beyond the byte budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-asset-cache-'))
  try {
    setProtocolAssetCacheMaxBytesForTests(1)
    const firstPath = join(dir, 'first.jpg')
    const secondPath = join(dir, 'second.jpg')
    writeFileSync(firstPath, Buffer.from([1]))
    writeFileSync(secondPath, Buffer.from([2]))
    await readCachedProtocolFile(firstPath)
    await readCachedProtocolFile(secondPath)
    rmSync(firstPath)
    rmSync(secondPath)
    assert.equal(await readCachedProtocolFile(firstPath), null)
    assert.deepEqual(await readCachedProtocolFile(secondPath), Buffer.from([2]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
