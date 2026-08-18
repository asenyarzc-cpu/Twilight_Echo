import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cloneStateRecord,
  PluginStatePersistence,
  pluginStateBackupPath,
  pluginStateCorruptPath
} from './statePersistence.ts'
import type { PluginStateFile } from './statePersistence.ts'

function state(activeVersion: string): PluginStateFile {
  return {
    'com.example.transactional': {
      enabled: true,
      installedAt: '2026-07-16T08:00:00.000Z',
      updatedAt: '2026-07-16T08:00:00.000Z',
      source: 'tep',
      activeVersion
    }
  }
}

test('cloneStateRecord copies native DSP parameters without sharing mutation', () => {
  const record = state('1.0.0')['com.example.transactional']
  record.nativeDspParameters = { gain: 1 }
  const cloned = cloneStateRecord(record)
  assert.deepEqual(cloned, {
    enabled: true,
    installedAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    source: 'tep',
    activeVersion: '1.0.0',
    nativeDspParameters: { gain: 1 }
  })
  cloned.nativeDspParameters!.gain = 2
  assert.equal(record.nativeDspParameters.gain, 1)
  assert.equal(cloneStateRecord(undefined), undefined)
})

test('plugin state writes serialize snapshots and retain a durable previous version', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-state-queue-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'plugin-state.json')
  const persistence = new PluginStatePersistence(filePath)
  const first = state('1.0.0')
  const second = state('2.0.0')

  const firstWrite = persistence.save(first)
  first['com.example.transactional'].activeVersion = 'mutated-after-queue'
  const secondWrite = persistence.save(second)
  await Promise.all([firstWrite, secondWrite])

  const primary = JSON.parse(await readFile(filePath, 'utf-8')) as PluginStateFile
  const backup = JSON.parse(
    await readFile(pluginStateBackupPath(filePath), 'utf-8')
  ) as PluginStateFile
  assert.equal(primary['com.example.transactional'].activeVersion, '2.0.0')
  assert.equal(backup['com.example.transactional'].activeVersion, '1.0.0')
})

test('plugin state flush waits for every queued durable snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-state-flush-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'plugin-state.json')
  const persistence = new PluginStatePersistence(filePath)

  void persistence.save(state('1.0.0'))
  void persistence.save(state('2.0.0'))
  await persistence.flush()

  const primary = JSON.parse(await readFile(filePath, 'utf-8')) as PluginStateFile
  assert.equal(primary['com.example.transactional'].activeVersion, '2.0.0')
})

test('plugin state restores a corrupt primary from backup and returns an observable warning', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-state-recovery-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'plugin-state.json')
  const persistence = new PluginStatePersistence(filePath)
  await persistence.save(state('1.0.0'))
  await persistence.save(state('2.0.0'))
  await writeFile(filePath, '{not-json', 'utf-8')

  const recovered = await new PluginStatePersistence(filePath).load()
  assert.equal(recovered.status, 'recovered')
  if (recovered.status !== 'recovered') return
  assert.match(recovered.warning, /restored from/)
  assert.equal(recovered.state['com.example.transactional'].activeVersion, '1.0.0')
  assert.equal(
    (JSON.parse(await readFile(filePath, 'utf-8')) as PluginStateFile)['com.example.transactional']
      .activeVersion,
    '1.0.0'
  )
  assert.equal(await readFile(pluginStateCorruptPath(filePath), 'utf-8'), '{not-json')
})

test('plugin state recovers from a deeply nested primary file before parsing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-state-depth-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'plugin-state.json')
  const persistence = new PluginStatePersistence(filePath)
  await persistence.save(state('1.0.0'))
  await persistence.save(state('2.0.0'))
  const nested = `${'['.repeat(128)}0${']'.repeat(128)}`
  await writeFile(filePath, nested, 'utf-8')

  const recovered = await new PluginStatePersistence(filePath).load()
  assert.equal(recovered.status, 'recovered')
  if (recovered.status !== 'recovered') return
  assert.match(recovered.warning, /too deeply nested/)
  assert.equal(recovered.state['com.example.transactional'].activeVersion, '1.0.0')
})

test('plugin state corruption without a valid backup is visible instead of silently clearing state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-state-unrecoverable-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'plugin-state.json')
  await writeFile(filePath, '{not-json', 'utf-8')
  await writeFile(pluginStateBackupPath(filePath), '[]', 'utf-8')

  const loaded = await new PluginStatePersistence(filePath).load()
  assert.equal(loaded.status, 'unrecoverable')
  if (loaded.status !== 'unrecoverable') return
  assert.deepEqual(loaded.state, {})
  assert.match(loaded.warning, /no valid backup/i)
  assert.deepEqual(
    loaded.corruptCopyPaths.sort(),
    [
      pluginStateCorruptPath(filePath),
      pluginStateCorruptPath(pluginStateBackupPath(filePath))
    ].sort()
  )
  assert.equal(await readFile(pluginStateCorruptPath(filePath), 'utf-8'), '{not-json')
  assert.equal(
    await readFile(pluginStateCorruptPath(pluginStateBackupPath(filePath)), 'utf-8'),
    '[]'
  )
})
