import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Vst3CatalogService } from './vst3Catalog.ts'

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

test(
  'resolves only an available catalog-owned VST3 module',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'twilight-vst3-catalog-'))
    try {
      const modules = join(root, 'modules')
      const modulePath = join(modules, 'fixture.vst3')
      await mkdir(modulePath, { recursive: true })
      let scanCalls = 0
      const catalog = new Vst3CatalogService(
        join(root, 'catalog'),
        {
          scan: async () => {
            scanCalls += 1
            return {
              classId: '0123456789ABCDEF0123456789ABCDEF',
              name: 'Fixture',
              vendor: 'Twilight Echo',
              version: '1.0',
              supportedLayouts: ['stereo'],
              parameters: []
            }
          }
        },
        [modules]
      )
      await catalog.initialize()
      const state = await catalog.scan()
      const entry = state.entries[0]
      assert.ok(entry)

      const resolved = catalog.resolveAvailableModule(entry.id, entry.classId.toLowerCase())
      assert.equal(resolved.modulePath, modulePath)
      assert.equal(resolved.classId, entry.classId)
      assert.equal(resolved.reason, '')

      const mismatched = catalog.resolveAvailableModule(entry.id, 'F'.repeat(32))
      assert.equal(mismatched.modulePath, null)
      assert.match(mismatched.reason, /class ID/i)

      await catalog.quarantine(entry.id, 'fixture crash')
      const quarantined = catalog.resolveAvailableModule(entry.id, entry.classId)
      assert.equal(quarantined.modulePath, null)
      assert.equal(quarantined.reason, 'fixture crash')

      await catalog.clearQuarantine(entry.id)
      const rescanned = await catalog.scan()
      assert.equal(rescanned.entries[0]?.status, 'available')
      assert.equal(scanCalls, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('rejects an excessively nested persisted VST3 catalog on every platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-vst3-catalog-deep-'))
  try {
    await writeFile(
      join(root, 'vst3-catalog.json'),
      JSON.stringify({
        enabled: true,
        searchPaths: [],
        entries: [
          {
            id: 'fixture',
            modulePath: 'C:\\fixtures\\fixture.vst3',
            moduleFingerprint: 'fixture-fingerprint',
            classId: '0123456789ABCDEF0123456789ABCDEF',
            name: 'Fixture',
            vendor: 'Twilight Echo',
            version: '1.0.0',
            category: 'Fx',
            supportedLayouts: ['stereo'],
            parameters: [],
            status: 'available',
            error: null,
            scannedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        padding: deeplyNestedValue()
      }),
      'utf-8'
    )

    const catalog = new Vst3CatalogService(
      root,
      {
        scan: async () => ({
          classId: '0123456789ABCDEF0123456789ABCDEF',
          name: 'Unused fixture',
          vendor: 'Twilight Echo',
          version: '1.0.0'
        })
      },
      []
    )
    assert.deepEqual((await catalog.getState()).entries, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
