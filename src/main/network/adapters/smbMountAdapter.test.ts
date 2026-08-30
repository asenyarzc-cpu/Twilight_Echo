import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSmbMountAdapter, type MountCommandRunner } from './smbMountAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const FLAC_BYTES = Buffer.from('SMB-MOUNT-DATA')

function makeProfile(overrides: Partial<NetworkSourceProfile> = {}): NetworkSourceProfile {
  return {
    id: 'smb1',
    protocol: 'smb',
    name: 'SMB NAS',
    host: 'nas.local',
    port: null,
    rootPath: '/music',
    username: 'alice',
    credential: { kind: 'password', encryptedId: 'enc:x' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 30_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

function makeRunner(
  overrides: { failAuth?: boolean; notFound?: boolean } = {}
): MountCommandRunner & {
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const runner: MountCommandRunner = async (command, args) => {
    calls.push({ command, args })
    if (overrides.failAuth) {
      return { code: 2, stdout: '', stderr: 'System error 5.\r\nAccess is denied.' }
    }
    if (overrides.notFound) {
      return {
        code: 2,
        stdout: '',
        stderr: 'System error 67.\r\nThe network name cannot be found.'
      }
    }
    return { code: 0, stdout: 'The command completed successfully.', stderr: '' }
  }
  return Object.assign(runner, { calls })
}

async function makeShareRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'smb-share-'))
  await mkdir(join(root, 'album'))
  await writeFile(join(root, 'a.flac'), FLAC_BYTES)
  return root
}

function localMapFor(root: string): (unc: string, remotePath: string) => string {
  return (_unc, remotePath) => join(root, remotePath.replace(/^\//, ''))
}

test('win32 smb mounts with net use and lists the share through the local map', async () => {
  const shareRoot = await makeShareRoot()
  try {
    const runner = makeRunner()
    const adapter = createSmbMountAdapter({
      platform: 'win32',
      runCommand: runner,
      localMap: localMapFor(shareRoot)
    })
    const session = await adapter.createSession(makeProfile(), {
      kind: 'password',
      username: 'alice',
      password: 's3cret'
    })
    const entries = await session.list('/')
    assert.equal(entries.length, 2)
    const album = entries.find((entry) => entry.name === 'album')
    const track = entries.find((entry) => entry.name === 'a.flac')
    assert.ok(album)
    assert.ok(track)
    assert.equal(album.kind, 'directory')
    assert.equal(track.kind, 'audio')
    assert.equal(track.path, '/a.flac')
    assert.match(track.id, /^[0-9a-f]{64}$/)
    assert.deepEqual(runner.calls[0], {
      command: 'net',
      args: ['use', '\\\\nas.local\\music', 's3cret', '/user:alice']
    })
    await session.close()
    assert.ok(runner.calls.some((call) => call.command === 'net' && call.args.includes('/delete')))
  } finally {
    await rm(shareRoot, { recursive: true, force: true })
  }
})

test('smb stat and readStream operate on the mounted local files', async () => {
  const shareRoot = await makeShareRoot()
  try {
    const adapter = createSmbMountAdapter({
      platform: 'win32',
      runCommand: makeRunner(),
      localMap: localMapFor(shareRoot)
    })
    const session = await adapter.createSession(makeProfile(), {
      kind: 'password',
      username: 'alice',
      password: 's3cret'
    })
    const entry = await session.stat('/a.flac')
    assert.equal(entry?.name, 'a.flac')
    assert.equal(entry?.sizeBytes, FLAC_BYTES.length)
    const stream = await session.readStream('/a.flac')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
    assert.equal(await session.resolvePlaybackUrl('/a.flac'), null)
    await session.close()
  } finally {
    await rm(shareRoot, { recursive: true, force: true })
  }
})

test('smb maps access denied and missing share errors to structured codes', async () => {
  const shareRoot = await makeShareRoot()
  try {
    const authSession = await createSmbMountAdapter({
      platform: 'win32',
      runCommand: makeRunner({ failAuth: true }),
      localMap: localMapFor(shareRoot)
    }).createSession(makeProfile(), {
      kind: 'password',
      username: 'alice',
      password: 'wrong'
    })
    await assert.rejects(
      async () => authSession.list('/'),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'auth')
        return true
      }
    )

    const missingSession = await createSmbMountAdapter({
      platform: 'win32',
      runCommand: makeRunner({ notFound: true }),
      localMap: localMapFor(shareRoot)
    }).createSession(makeProfile(), {
      kind: 'password',
      username: 'alice',
      password: 's3cret'
    })
    await assert.rejects(
      async () => missingSession.list('/'),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'notFound')
        return true
      }
    )
  } finally {
    await rm(shareRoot, { recursive: true, force: true })
  }
})

test('linux gio mount is anonymous-only and rejects password auth', async () => {
  const runner = makeRunner()
  const adapter = createSmbMountAdapter({ platform: 'linux', runCommand: runner })
  await assert.rejects(
    () =>
      adapter.createSession(makeProfile(), {
        kind: 'password',
        username: 'alice',
        password: 's3cret'
      }),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'auth')
      return true
    }
  )
  const anonymous = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  await assert.rejects(
    () => anonymous.list('/'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'notFound')
      return true
    }
  )
  assert.deepEqual(runner.calls[0], { command: 'gio', args: ['mount', 'smb://nas.local/music'] })
})

test('linux smb maps a mounted GVFS share to its local filesystem path', async () => {
  const mount = await mkdtemp(join(tmpdir(), 'gvfs-mount-'))
  try {
    await writeFile(join(mount, 'a.flac'), FLAC_BYTES)
    const session = await createSmbMountAdapter({
      platform: 'linux',
      runCommand: makeRunner(),
      findGvfsMount: async () => mount
    }).createSession(makeProfile(), { kind: 'anonymous' })
    const entries = await session.list('/')
    assert.equal(entries[0]?.name, 'a.flac')
    const stream = await session.readStream('/a.flac')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
    await session.close()
  } finally {
    await rm(mount, { recursive: true, force: true })
  }
})
