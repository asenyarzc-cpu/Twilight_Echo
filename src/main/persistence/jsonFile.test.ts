import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const {
  PersistentJsonFileError,
  backupPathFor,
  corruptPathFor,
  loadJsonFileWithBackup,
  writeJsonFileAtomic
} = (await import(new URL('./jsonFile.ts', import.meta.url).href)) as typeof import('./jsonFile')

type TestData = { version: number; value: string }

const options = {
  label: 'test data',
  maxBytes: 1024,
  validate: (value: unknown): value is TestData => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return typeof record.version === 'number' && typeof record.value === 'string'
  }
}

test('atomic JSON writes retain the previous valid version and recover corrupt primary data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-file-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'data.json')

  writeJsonFileAtomic(filePath, JSON.stringify({ version: 1, value: 'first' }), options)
  writeJsonFileAtomic(filePath, JSON.stringify({ version: 2, value: 'second' }), options)
  assert.deepEqual(JSON.parse(await readFile(backupPathFor(filePath), 'utf8')), {
    version: 1,
    value: 'first'
  })

  await writeFile(filePath, '{broken json', 'utf8')
  const loaded = loadJsonFileWithBackup(filePath, options)

  assert.equal(loaded.status, 'recovered')
  if (loaded.status !== 'recovered') return
  assert.deepEqual(loaded.value, { version: 1, value: 'first' })
  assert.equal(loaded.restoreError, null)
  assert.equal(await readFile(corruptPathFor(filePath), 'utf8'), '{broken json')
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), loaded.value)
})

test('JSON loading reports corruption when neither primary nor backup is valid', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-corrupt-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'data.json')
  await writeFile(filePath, '{broken', 'utf8')
  await writeFile(backupPathFor(filePath), '[]', 'utf8')

  let error: InstanceType<typeof PersistentJsonFileError> | null = null
  try {
    loadJsonFileWithBackup(filePath, options)
  } catch (caught) {
    assert.ok(caught instanceof PersistentJsonFileError)
    error = caught
  }

  assert.ok(error)
  assert.equal(error.code, 'ERR_PERSISTENT_JSON_CORRUPT')
  assert.equal(error.corruptCopyPath, corruptPathFor(filePath))
  assert.equal(error.corruptBackupCopyPath, corruptPathFor(backupPathFor(filePath)))
  assert.equal(await readFile(error.corruptCopyPath!, 'utf8'), '{broken')
  assert.equal(await readFile(error.corruptBackupCopyPath!, 'utf8'), '[]')
})

test('JSON loading distinguishes a genuinely missing file from corruption', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-missing-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  assert.deepEqual(loadJsonFileWithBackup(join(directory, 'missing.json'), options), {
    status: 'missing'
  })
})

test('rejects over-nested persisted JSON before accepting or recovering it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-nesting-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'data.json')
  const deeplyNested = `${'['.repeat(128)}0${']'.repeat(128)}`
  await writeFile(filePath, deeplyNested, 'utf8')

  let error: InstanceType<typeof PersistentJsonFileError> | null = null
  try {
    loadJsonFileWithBackup(filePath, options)
  } catch (caught) {
    assert.ok(caught instanceof PersistentJsonFileError)
    error = caught
  }

  assert.ok(error)
  assert.equal(error.primaryError, 'JSON is too deeply nested')
  assert.equal(error.backupError, 'file is missing')
  assert.equal(await readFile(error.corruptCopyPath!, 'utf8'), deeplyNested)

  await writeFile(filePath, JSON.stringify({ version: 1, value: '['.repeat(128) }), 'utf8')
  assert.deepEqual(loadJsonFileWithBackup(filePath, options), {
    status: 'loaded',
    value: { version: 1, value: '['.repeat(128) }
  })
})

test('atomic JSON writes reject over-nested input before parsing or writing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-write-nesting-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'data.json')
  const deeplyNested = `${'['.repeat(128)}0${']'.repeat(128)}`
  const permissiveOptions = {
    label: 'nested test data',
    maxBytes: 1024,
    validate: (_value: unknown): _value is unknown => true
  }

  assert.throws(
    () => writeJsonFileAtomic(filePath, deeplyNested, permissiveOptions, { bypass: true }),
    /too deeply nested/
  )
  assert.deepEqual(loadJsonFileWithBackup(filePath, permissiveOptions), { status: 'missing' })
})

test('saving over a corrupt primary preserves an existing valid backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-json-preserve-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'data.json')
  const first = { version: 1, value: 'recoverable' }
  const replacement = { version: 2, value: 'replacement' }
  writeJsonFileAtomic(filePath, JSON.stringify(first), options)
  await writeFile(filePath, '{broken before save', 'utf8')

  writeJsonFileAtomic(filePath, JSON.stringify(replacement), options)

  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), replacement)
  assert.deepEqual(JSON.parse(await readFile(backupPathFor(filePath), 'utf8')), first)
  assert.equal(await readFile(corruptPathFor(filePath), 'utf8'), '{broken before save')
})
