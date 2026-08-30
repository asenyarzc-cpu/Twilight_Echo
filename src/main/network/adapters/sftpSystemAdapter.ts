import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNetworkEntryId, normalizeRemotePath } from '../networkPath.ts'
import { NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'

export interface SftpLsItem {
  name: string
  directory: boolean
  size: number
}

export interface SftpBatchResult {
  stdout: string
  stderr: string
  code: number
}

export type SftpBatchRunner = (
  batch: string,
  deps: { host: string; port: number; username: string; keyPath: string },
  signal?: AbortSignal
) => Promise<SftpBatchResult>

const LS_LINE =
  /^([-dl])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/

/** 解析 OpenSSH `sftp ls -l` 输出（与 Unix `ls -l` 同格式）。 */
export function parseLsOutput(output: string): SftpLsItem[] {
  const items: SftpLsItem[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('total') || line.startsWith('sftp>')) continue
    const match = LS_LINE.exec(line)
    if (!match) continue
    items.push({
      name: match[4],
      directory: match[1] === 'd',
      size: Number.parseInt(match[3], 10) || 0
    })
  }
  return items
}

function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function defaultRunBatch(
  batch: string,
  deps: { host: string; port: number; username: string; keyPath: string },
  signal?: AbortSignal
): Promise<SftpBatchResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'sftp',
      ['-b', '-', '-i', deps.keyPath, '-P', String(deps.port), `${deps.username}@${deps.host}`],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code:
            typeof error === 'object' && error !== null
              ? ((error as { code?: number }).code ?? 1)
              : 0
        })
      }
    )
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', onAbort))
    child.stdin?.write(batch)
    child.stdin?.end()
  })
}

/**
 * 系统 OpenSSH `sftp` 命令适配器：零新依赖，仅支持密钥认证。
 * 口令认证无法非交互完成，带口令私钥请改用 ssh-agent 或无口令密钥。
 */
export function createSftpSystemAdapter(deps?: {
  runBatch?: SftpBatchRunner
  tempDir?: string
}): NetworkSourceAdapter {
  const runBatch = deps?.runBatch ?? defaultRunBatch
  const tempRoot = deps?.tempDir ?? tmpdir()

  return {
    protocol: 'sftp',
    async createSession(
      profile: NetworkSourceProfile,
      auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      if (auth.kind !== 'privateKey') {
        throw new NetworkSourceFailure('auth', '系统 sftp 仅支持密钥认证，请使用私钥')
      }
      if (auth.passphrase) {
        throw new NetworkSourceFailure(
          'auth',
          '系统 sftp 暂不支持带口令的私钥，请使用无口令密钥或 ssh-agent'
        )
      }
      const username = auth.username ?? profile.username ?? ''
      const keyPath = auth.keyPath.trim()
      if (!username || !keyPath) {
        throw new NetworkSourceFailure('auth', 'SFTP 需要用户名与私钥路径')
      }

      async function run(commands: string, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
        const result = await runBatch(
          commands,
          {
            host: profile.host,
            port: profile.port ?? 22,
            username,
            keyPath
          },
          signal
        )
        if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
        const stderr = result.stderr
        if (/permission denied|authentication|publickey/i.test(stderr)) {
          throw new NetworkSourceFailure('auth', 'SSH 认证失败，请检查私钥与用户名')
        }
        if (/no such file|does not exist/i.test(stderr)) {
          throw new NetworkSourceFailure('notFound', '远程路径不存在')
        }
        if (result.code !== 0) {
          throw new NetworkSourceFailure('network', `sftp 命令失败：${stderr.trim() || '未知错误'}`)
        }
        return result.stdout
      }

      function toEntry(parentPath: string, item: SftpLsItem): NetworkEntry {
        const path = normalizeRemotePath(
          parentPath === '/' ? `/${item.name}` : `${parentPath}/${item.name}`
        )
        return {
          id: buildNetworkEntryId(profile.protocol, profile.id, path),
          profileId: profile.id,
          name: item.name,
          kind: entryKind(item.name, { directory: item.directory }),
          path,
          sizeBytes: item.directory ? undefined : item.size
        }
      }

      let tempCounter = 0

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          const parent = normalizeRemotePath(remotePath)
          const stdout = await run(`ls -l ${quote(parent)}\n`, signal)
          return parseLsOutput(stdout).map((item) => toEntry(parent, item))
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          const path = normalizeRemotePath(remotePath)
          const stdout = await run(`ls -l ${quote(path)}\n`, signal)
          const first = parseLsOutput(stdout)[0]
          if (!first) return null
          return {
            id: buildNetworkEntryId(profile.protocol, profile.id, path),
            profileId: profile.id,
            name: first.name,
            kind: entryKind(first.name, { directory: first.directory }),
            path,
            sizeBytes: first.directory ? undefined : first.size
          }
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          const path = normalizeRemotePath(remotePath)
          const local = join(tempRoot, `sftp-${Date.now()}-${tempCounter++}.tmp`)
          await run(`get ${quote(path)} ${quote(local)}\n`, signal)
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络文件读取已取消')
          const stream = createReadStream(local, { start: options?.start ?? 0 })
          stream.on('close', () => {
            void unlink(local).catch(() => undefined)
          })
          return stream
        },
        async resolvePlaybackUrl(): Promise<string | null> {
          return null
        },
        async close(): Promise<void> {
          // 无状态命令执行，无需清理。
        }
      }
    }
  }
}
