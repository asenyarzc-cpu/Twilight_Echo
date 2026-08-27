import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNetworkProfileStore, type CredentialCodec } from './profileStore.ts'
import type { NetworkSourceProfileInput } from './profileStore.ts'

/** 测试用 codec：base64 即可，验证接缝行为而非真实加密。 */
const fakeCodec: CredentialCodec = {
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (encrypted) => Buffer.from(encrypted, 'base64').toString('utf8').replace(/^enc:/, '')
}

function makeInput(overrides: Partial<NetworkSourceProfileInput> = {}): NetworkSourceProfileInput {
  return {
    protocol: 'webdav',
    name: 'NAS',
    host: 'nas.local',
    port: null,
    rootPath: '/music',
    username: 'alice',
    auth: { kind: 'password', password: 's3cret' },
    ...overrides
  }
}

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'network-profiles-'))
  const store = createNetworkProfileStore({
    filePath: join(dir, 'profiles.json'),
    codec: fakeCodec
  })
  return { dir, store }
}

test('profile store persists create/list/update/delete across reloads', async () => {
  const { dir, store } = await makeStore()
  try {
    const created = await store.createProfile(makeInput())
    assert.equal(created.name, 'NAS')
    assert.equal(created.credentialKind, 'password')

    const reloaded = createNetworkProfileStore({
      filePath: join(dir, 'profiles.json'),
      codec: fakeCodec
    })
    const listed = await reloaded.listProfiles()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, created.id)

    const updated = await reloaded.updateProfile(created.id, { name: 'NAS 2' })
    assert.equal(updated.name, 'NAS 2')

    await reloaded.deleteProfile(created.id)
    assert.equal((await reloaded.listProfiles()).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('credentials are encrypted on disk and never leak into summaries', async () => {
  const { dir, store } = await makeStore()
  try {
    const created = await store.createProfile(makeInput())
    const disk = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'profiles.json'), 'utf8')
    )
    assert.equal(disk.includes('s3cret'), false)
    assert.match(disk, /encryptedId/, '凭据引用应落盘')

    const summary = (await store.listProfiles())[0]
    assert.equal(summary.id, created.id)
    assert.equal(JSON.stringify(summary).includes('s3cret'), false)
    assert.equal(JSON.stringify(summary).includes('enc:'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveAuth decrypts credentials for the main process only', async () => {
  const { dir, store } = await makeStore()
  try {
    const created = await store.createProfile(makeInput())
    const auth = await store.resolveAuth(created.id)
    assert.deepEqual(auth, { kind: 'password', username: 'alice', password: 's3cret' })
    const anonymous = await store.createProfile(makeInput({ auth: { kind: 'anonymous' } }))
    assert.deepEqual(await store.resolveAuth(anonymous.id), { kind: 'anonymous' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('profile input validation rejects malformed profiles', async () => {
  const { dir, store } = await makeStore()
  try {
    await assert.rejects(() =>
      store.createProfile(makeInput({ protocol: 'carrier-pigeon' as never }))
    )
    await assert.rejects(() => store.createProfile(makeInput({ host: '' })))
    await assert.rejects(() => store.createProfile(makeInput({ rootPath: '/music/../secret' })))
    await assert.rejects(() => store.createProfile(makeInput({ port: 70000 })))
    await assert.rejects(() => store.createProfile(makeInput({ name: '' })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('profile store fails closed on deeply nested or structurally invalid persisted data', async () => {
  const { dir, store } = await makeStore()
  const filePath = join(dir, 'profiles.json')
  try {
    const nested = `${'['.repeat(128)}0${']'.repeat(128)}`
    await writeFile(filePath, `{"profiles":${nested}}`, 'utf8')
    await assert.rejects(() => store.listProfiles())

    await writeFile(filePath, JSON.stringify({ profiles: [{ id: 'malformed' }] }), 'utf8')
    await assert.rejects(() => store.listProfiles())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('privateKey auth stores key path plainly and passphrase encrypted', async () => {
  const { dir, store } = await makeStore()
  try {
    const created = await store.createProfile(
      makeInput({
        auth: { kind: 'privateKey', keyPath: 'C:/keys/id_ed25519', passphrase: 'pp-secret' }
      })
    )
    const disk = await readFile(join(dir, 'profiles.json'), 'utf8')
    assert.equal(disk.includes('pp-secret'), false)
    assert.ok(disk.includes('id_ed25519'))
    const auth = await store.resolveAuth(created.id)
    assert.deepEqual(auth, {
      kind: 'privateKey',
      username: 'alice',
      keyPath: 'C:/keys/id_ed25519',
      passphrase: 'pp-secret'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('WebDAV profiles preserve HTTPS selected by an entered URL', async () => {
  const { dir, store } = await makeStore()
  try {
    const created = await store.createProfile(makeInput({ host: 'https://nas.example.test' }))
    assert.equal(created.host, 'nas.example.test')
    assert.equal(created.webdavScheme, 'https')
    const persisted = await store.getProfile(created.id)
    assert.equal(persisted.webdavScheme, 'https')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
