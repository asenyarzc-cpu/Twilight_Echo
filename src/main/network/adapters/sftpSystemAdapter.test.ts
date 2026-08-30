import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSftpSystemAdapter,
  parseLsOutput,
  type SftpBatchRunner
} from './sftpSystemAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const LS_OUTPUT = [
  'total 4',
  'drwxr-xr-x   2 alice group 4096 Jan 01 12:00 album',
  '-rw-r--r--   1 alice group 1024 Jan 01 12:00 a.flac'
].join('\n')

function makeProfile(): NetworkSourceProfile {
  return {
    id: 'sftp1',
    protocol: 'sftp',
    name: 'SSH NAS',
    host: 'nas.local',
    port: 22,
    rootPath: '/music',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519',
    credential: { kind: 'privateKey', encryptedId: '' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 30_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null
  }
}

function makeRunner(overrides: { failAuth?: boolean; notFound?: boolean } = {}): SftpBatchRunner & {
  calls: Array<{ batch: string; keyPath: string; username: string }>
} {
  const calls: Array<{ batch: string; keyPath: string; username: string }> = []
  const runner: SftpBatchRunner = async (batch, deps) => {
    calls.push({ batch, keyPath: deps.keyPath, username: deps.username })
    if (batch.includes('get ')) {
      const match = batch.match(/get\s+(.+?)\s+"([^"]+)"/)
      if (match) await writeFile(match[2], 'SFTP-SYSTEM-DATA')
      return { stdout: '', stderr: '', code: 0 }
    }
    if (overrides.failAuth) return { stdout: '', stderr: 'Permission denied (publickey).', code: 1 }
    if (overrides.notFound) return { stdout: '', stderr: 'No such file or directory', code: 1 }
    return { stdout: LS_OUTPUT, stderr: '', code: 0 }
  }
  return Object.assign(runner, { calls })
}

test('parseLsOutput extracts directory and audio entries', () => {
  const items = parseLsOutput(LS_OUTPUT)
  assert.equal(items.length, 2)
  assert.equal(items[0].name, 'album')
  assert.equal(items[0].directory, true)
  assert.equal(items[1].name, 'a.flac')
  assert.equal(items[1].directory, false)
  assert.equal(items[1].size, 1024)
})

test('system sftp list maps ls output into network entries', async () => {
  const runner = makeRunner()
  const adapter = createSftpSystemAdapter({
    runBatch: runner,
    tempDir: await mkdtemp(join(tmpdir(), 'sftp-'))
  })
  const session = await adapter.createSession(makeProfile(), {
    kind: 'privateKey',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519'
  })
  const entries = await session.list('/music')
  assert.equal(entries.length, 2)
  const album = entries.find((entry) => entry.name === 'album')
  const track = entries.find((entry) => entry.name === 'a.flac')
  assert.ok(album)
  assert.ok(track)
  assert.equal(album.kind, 'directory')
  assert.equal(track.kind, 'audio')
  assert.equal(track.path, '/music/a.flac')
  assert.equal(track.sizeBytes, 1024)
  assert.match(track.id, /^[0-9a-f]{64}$/)
  assert.match(runner.calls[0].batch, /ls -l "/)
  assert.equal(runner.calls[0].keyPath, 'C:/keys/id_ed25519')
  await session.close()
})

test('system sftp rejects password auth and streams downloads to temp files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'sftp-'))
  const runner = makeRunner()
  const adapter = createSftpSystemAdapter({ runBatch: runner, tempDir })
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

  const session = await adapter.createSession(makeProfile(), {
    kind: 'privateKey',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519'
  })
  const stream = await session.readStream('/music/a.flac')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).toString(), 'SFTP-SYSTEM-DATA')
  assert.equal(await session.resolvePlaybackUrl('/music/a.flac'), null)
  await session.close()
})

test('system sftp readStream honors a start offset', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'sftp-'))
  const adapter = createSftpSystemAdapter({ runBatch: makeRunner(), tempDir })
  const session = await adapter.createSession(makeProfile(), {
    kind: 'privateKey',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519'
  })
  const stream = await session.readStream('/music/a.flac', undefined, { start: 5 })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).toString(), 'SFTP-SYSTEM-DATA'.slice(5))
  await session.close()
})

test('system sftp maps permission and missing-path errors', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'sftp-'))
  const authSession = await createSftpSystemAdapter({
    runBatch: makeRunner({ failAuth: true }),
    tempDir
  }).createSession(makeProfile(), {
    kind: 'privateKey',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519'
  })
  await assert.rejects(
    async () => authSession.list('/music'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'auth')
      return true
    }
  )

  const missingSession = await createSftpSystemAdapter({
    runBatch: makeRunner({ notFound: true }),
    tempDir
  }).createSession(makeProfile(), {
    kind: 'privateKey',
    username: 'alice',
    keyPath: 'C:/keys/id_ed25519'
  })
  await assert.rejects(
    async () => missingSession.stat('/music/nope.flac'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'notFound')
      return true
    }
  )
})
