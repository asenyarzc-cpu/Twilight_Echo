import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { OpraCatalog, parseOpraCatalogForTest } = (await import(
  new URL('./opraCatalog.ts', import.meta.url).href
)) as typeof import('./opraCatalog.ts')

const SAMPLE_CATALOG = [
  {
    type: 'eq',
    id: 'acme:monitor::author_good',
    data: {
      author: 'Profile Author',
      details: 'Measured by Test Rig',
      link: 'https://example.com/profile',
      type: 'parametric_eq',
      parameters: {
        gain_db: -5.5,
        bands: [
          { type: 'peak_dip', frequency: 120, gain_db: -3, q: 0.8 },
          { type: 'low_shelf', frequency: 80, gain_db: 2.5, q: 0.7 },
          { type: 'high_shelf', frequency: 10000, gain_db: -1, q: 0.9 }
        ]
      },
      product_id: 'acme::monitor'
    }
  },
  {
    type: 'eq',
    id: 'acme:monitor::author_bad',
    data: {
      author: 'Unsupported Author',
      details: 'Contains unsupported filter',
      type: 'parametric_eq',
      parameters: {
        gain_db: -2,
        bands: [{ type: 'low_pass', frequency: 8000, gain_db: 0, q: 0.7 }]
      },
      product_id: 'acme::monitor'
    }
  },
  {
    type: 'product',
    id: 'acme::monitor',
    data: { name: 'Reference Monitor', type: 'headphones', vendor_id: 'acme' }
  },
  { type: 'vendor', id: 'acme', data: { name: 'ACME Audio' } }
]
  .map((line) => JSON.stringify(line))
  .join('\n')

test('OPRA catalog links vendor, product and EQ profiles for search', async () => {
  const catalog = parseOpraCatalogForTest(SAMPLE_CATALOG)
  const results = await catalog.search('acme monitor')

  assert.equal(results.length, 2)
  assert.equal(results[0].vendorName, 'ACME Audio')
  assert.equal(results[0].productName, 'Reference Monitor')
  assert.equal(results[0].author, 'Profile Author')
  assert.equal(results[0].preampDb, -5.5)
})

test('OPRA cache loading is single-flight for concurrent first searches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-opra-cache-'))
  const cachePath = join(directory, 'database.jsonl')
  try {
    await writeFile(cachePath, SAMPLE_CATALOG, 'utf8')
    const catalog = new OpraCatalog(cachePath)
    const [first, second] = await Promise.all([
      catalog.search('acme monitor'),
      catalog.getProfile('acme:monitor::author_good')
    ])

    assert.equal(first.length, 2)
    assert.equal(second?.eqId, 'acme:monitor::author_good')
    assert.equal(catalog.getStatus().loading, false)
    assert.equal(catalog.getStatus().source, 'cache')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('OPRA parser maps supported bands and rejects unsupported filters', async () => {
  const catalog = parseOpraCatalogForTest(SAMPLE_CATALOG)
  const profile = await catalog.getProfile('acme:monitor::author_good')
  const unsupported = await catalog.getProfile('acme:monitor::author_bad')

  assert.ok(profile)
  assert.equal(profile.applicable, true)
  assert.deepEqual(
    profile.bands.map((band) => band.filterType),
    ['peak', 'lowShelf', 'highShelf']
  )

  assert.ok(unsupported)
  assert.equal(unsupported.applicable, false)
  assert.deepEqual(unsupported.unsupportedBandTypes, ['low_pass'])
})
