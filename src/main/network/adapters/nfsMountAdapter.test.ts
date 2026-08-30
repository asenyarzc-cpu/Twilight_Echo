import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNfsMountAdapter, type MountCommandRunner } from './smbMountAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const FLAC_BYTES = Buffer.from('NFS-MOUNT-DATA')

function makeProfile(overrides: Partial<NetworkSourceProfile> = {}): NetworkSourceProfile {
  return {
    id: 'nfs1',
    protocol: 'nfs',
    name: 'NFS NAS',
    host: 'nas.local',
    port: null,
    rootPath: '/export/music',
    credential: { kind: 'anonymous', encryptedId: '' },
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

function makeRunner(overrides: { mountFail?: boolean } = {}): MountCommandRunner & {
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const runner: MountCommandRunner = async (command, args) => {
    calls.push({ command, args })
    if (overrides.mountFail && command === 'mount') {
      return { code: 1, stdout: '', stderr: 'mount.nfs: access denied by server' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return Object.assign(runner, { calls })
}

async function makeExportRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nfs-export-'))
  await mkdir(join(root, 'album'))
  await writeFile(join(root, 'a.flac'), FLAC_BYTES)
  return root
}

test('linux nfs mounts with mount -t nfs and lists through the mount point', async () => {
  const exportRoot = await makeExportRoot()
  const mountBase = await mkdtemp(join(tmpdir(), 'nfs-mount-'))
  try {
    const runner = makeRunner()
    const adapter = createNfsMountAdapter({
      platform: 'linux',
      runCommand: runner,
      mountBaseDir: mountBase,
      localMap: (_mountPoint, remotePath) => join(exportRoot, remotePath.replace(/^\//, ''))
    })
    const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
    const entries = await session.list('/')
    assert.equal(entries.length, 2)
    const album = entries.find((entry) => entry.name === 'album')
    const track = entries.find((entry) => entry.name === 'a.flac')
    assert.ok(album)
    assert.ok(track)
    assert.equal(album.kind, 'directory')
    assert.equal(track.kind, 'audio')
    assert.equal(track.path, '/a.flac')
    const mountCall = runner.calls.find((call) => call.command === 'mount')
    assert.ok(mountCall)
    assert.deepEqual(mountCall.args.slice(0, 3), ['-t', 'nfs', 'nas.local:/export/music'])
    assert.ok(mountCall.args[3].length > 0, '挂载点目录应存在')
    await session.close()
    assert.ok(runner.calls.some((call) => call.command === 'umount'))
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
    await rm(mountBase, { recursive: true, force: true })
  }
})

test('nfs mount maps access denied and only supports anonymous auth on linux', async () => {
  const mountBase = await mkdtemp(join(tmpdir(), 'nfs-mount-'))
  try {
    const adapter = createNfsMountAdapter({
      platform: 'linux',
      runCommand: makeRunner({ mountFail: true }),
      mountBaseDir: mountBase
    })
    const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
    await assert.rejects(
      async () => session.list('/'),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'auth')
        return true
      }
    )

    await assert.rejects(
      () =>
        adapter.createSession(makeProfile(), {
          kind: 'password',
          username: 'alice',
          password: 'x'
        }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'auth')
        return true
      }
    )

    const unsupported = createNfsMountAdapter({ platform: 'win32', runCommand: makeRunner() })
    await assert.rejects(
      () => unsupported.createSession(makeProfile(), { kind: 'anonymous' }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'unsupportedProtocol')
        return true
      }
    )
  } finally {
    await rm(mountBase, { recursive: true, force: true })
  }
})
