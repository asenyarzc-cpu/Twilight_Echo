import assert from 'node:assert/strict'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import test from 'node:test'
import { createFtpAdapter } from './ftpAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const FLAC_BYTES = Buffer.from('FTP-DATA-0123456789')
const USERNAME = 'alice'
const PASSWORD = 's3cret'

const LISTING = [
  'drwxr-xr-x 1 owner group 0 Jan 01 2025 album',
  '-rw-r--r-- 1 owner group 22 Jan 01 2025 a.flac'
].join('\r\n')

function makeProfile(
  port: number,
  overrides: Partial<NetworkSourceProfile> = {}
): NetworkSourceProfile {
  return {
    id: 'ftp1',
    protocol: 'ftp',
    name: 'FTP NAS',
    host: '127.0.0.1',
    port,
    rootPath: '/',
    username: USERNAME,
    credential: { kind: 'password', encryptedId: 'enc:x' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 10_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

interface TestFtpServer {
  port: number
  close: () => Promise<void>
}

async function startFtpServer(): Promise<TestFtpServer> {
  let dataSocket: Socket | null = null
  let dataServer: NetServer | null = null
  const controlSockets = new Set<Socket>()
  const servers = new Set<NetServer>()

  const control = createServer((socket) => {
    socket.setEncoding('utf8')
    controlSockets.add(socket)
    socket.on('close', () => controlSockets.delete(socket))
    socket.on('error', () => undefined)
    socket.write('220 test ftp ready\r\n')
    let buffer = ''
    let restartAt = 0

    function reply(line: string): void {
      socket.write(`${line}\r\n`)
    }

    function openPassive(replyPrefix: string): void {
      dataServer = createServer((data) => {
        data.on('error', () => undefined)
        dataSocket = data
      })
      servers.add(dataServer)
      dataServer.on('error', () => undefined)
      dataServer.listen(0, '127.0.0.1', () => {
        const address = dataServer?.address()
        if (!address || typeof address === 'string') return
        if (replyPrefix === 'EPSV') {
          reply(`229 Entering Extended Passive Mode (|||${address.port}|)`)
        } else {
          const p1 = Math.floor(address.port / 256)
          const p2 = address.port % 256
          reply(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`)
        }
      })
    }

    async function withData(fn: (socket: Socket) => void): Promise<void> {
      reply('150 opening data connection')
      if (!dataSocket) {
        const deadline = Date.now() + 1000
        while (!dataSocket && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (!dataSocket) {
        reply('425 cannot open data connection')
        return
      }
      const target = dataSocket
      dataSocket = null
      try {
        fn(target)
      } finally {
        // 等客户端挂好数据读取器再关闭，避免竞态丢数据。
        await new Promise((resolve) => setTimeout(resolve, 150))
        target.end()
        dataServer?.close()
        dataServer = null
      }
      reply('226 transfer complete')
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\r\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const [command, ...args] = line.trim().split(' ')
        const argument = args.join(' ')
        switch (command.toUpperCase()) {
          case 'USER':
            reply('331 password required')
            break
          case 'PASS':
            reply(argument === PASSWORD ? '230 logged in' : '530 login incorrect')
            break
          case 'REST':
            restartAt = Number(argument) || 0
            reply(`350 Restarting at ${restartAt}`)
            break
          case 'TYPE':
            reply('200 type set')
            break
          case 'OPTS':
            reply('200 ok')
            break
          case 'SYST':
            reply('215 UNIX Type: L8')
            break
          case 'FEAT':
            reply('211 features')
            reply('211 end')
            break
          case 'PWD':
            reply('257 "/"')
            break
          case 'CWD':
            reply('250 ok')
            break
          case 'PASV':
            openPassive('PASV')
            break
          case 'EPSV':
            openPassive('EPSV')
            break
          case 'LIST':
            void withData((socket) => socket.write(LISTING))
            break
          case 'RETR':
            if (argument.endsWith('a.flac')) {
              const offset = restartAt
              restartAt = 0
              void withData((socket) => socket.write(FLAC_BYTES.subarray(offset).toString()))
            } else {
              reply('550 no such file')
            }
            break
          case 'SIZE':
            reply(argument.endsWith('a.flac') ? `213 ${FLAC_BYTES.length}` : '550 no such file')
            break
          case 'NOOP':
            reply('200 ok')
            break
          case 'QUIT':
            reply('221 bye')
            socket.end()
            break
          default:
            reply('500 unknown command')
        }
      }
    })
  })

  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve))
  servers.add(control)
  const port = (control.address() as { port: number }).port
  return {
    port,
    close: async () => {
      for (const socket of controlSockets) socket.destroy()
      dataSocket?.destroy()
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }
}

let server: TestFtpServer

test.before(async () => {
  server = await startFtpServer()
})

test.after(async () => {
  await server.close()
})

test('ftp list parses directory and audio entries with stable ids', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
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
  await session.close()
})

test('ftp readStream downloads file bytes', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const stream = await session.readStream('/a.flac')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
  await session.close()
})

test('ftp stat resolves size for files and rejects missing paths', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const entry = await session.stat('/a.flac')
  assert.equal(entry?.name, 'a.flac')
  assert.equal(entry?.sizeBytes, FLAC_BYTES.length)
  await assert.rejects(
    async () => session.stat('/missing.flac'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'notFound')
      return true
    }
  )
  await session.close()
})

test('ftp rejects wrong credentials with auth error and never allows direct urls', async () => {
  const bad = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: 'wrong'
  })
  await assert.rejects(
    async () => bad.list('/'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'auth')
      return true
    }
  )
  await bad.close()

  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  assert.equal(await session.resolvePlaybackUrl('/a.flac'), null)
  await session.close()
})

test('ftp readStream honors a restart offset', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const stream = await session.readStream('/a.flac', undefined, { start: 4 })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES.subarray(4))
  await session.close()
})
