import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNetworkEntryId, normalizeRemotePath } from '../networkPath.ts'
import { NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'

export interface MountCommandResult {
  code: number
  stdout: string
  stderr: string
}

export type MountCommandRunner = (command: string, args: string[]) => Promise<MountCommandResult>

interface MountAdapterDeps {
  platform?: NodeJS.Platform
  runCommand?: MountCommandRunner
  /** 挂载键（UNC / gvfs URI / NFS 挂载点）→ 本地路径映射，测试可注入。 */
  localMap?: (mountKey: string, remotePath: string) => string
  mountBaseDir?: string
  gvfsRoot?: string
  findGvfsMount?: (profile: NetworkSourceProfile) => Promise<string | null>
}

/**
 * SMB 系统挂载 adapter（B 方案）：
 * - Windows：`net use \\host\share [password] /user:user`，本地路径为 UNC；
 * - Linux：`gio mount smb://host/share`（仅匿名/已缓存凭据，非交互式不支持口令）；
 * - 挂载后按本地文件读取；close 时卸载。
 * NFS 需要 root 权限的 mount，另行评估（见施工文档 §10）。
 */
export function createSmbMountAdapter(deps: MountAdapterDeps = {}): NetworkSourceAdapter {
  return createMountAdapterForProtocol('smb', deps)
}

/**
 * NFS 系统挂载 adapter（仅 Linux，需要 root 权限执行 mount -t nfs）。
 * 挂载点临时目录在会话内创建，close 时 umount 并清理。
 */
export function createNfsMountAdapter(deps: MountAdapterDeps = {}): NetworkSourceAdapter {
  return createMountAdapterForProtocol('nfs', deps)
}

function createMountAdapterForProtocol(
  protocol: 'smb' | 'nfs',
  deps: MountAdapterDeps
): NetworkSourceAdapter {
  const platform = deps.platform ?? process.platform
  const runCommand = deps.runCommand ?? defaultRunCommand
  const mountBaseDir = deps.mountBaseDir ?? tmpdir()

  function shareName(profile: NetworkSourceProfile): string {
    return normalizeRemotePath(profile.rootPath).replace(/^\//, '')
  }

  function uncFor(profile: NetworkSourceProfile): string {
    return `\\\\${profile.host}\\${shareName(profile)}`
  }

  function gioUri(profile: NetworkSourceProfile, username?: string): string {
    const user = username ? `${username}@` : ''
    return `smb://${user}${profile.host}/${shareName(profile)}`
  }

  function defaultLocalMap(mountKey: string): (remotePath: string) => string {
    return (remotePath) => join(mountKey, remotePath.replace(/^\//, ''))
  }

  async function findGvfsMount(profile: NetworkSourceProfile): Promise<string | null> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid == null ? null : `/run/user/${uid}`)
    const gvfsDir = deps.gvfsRoot ?? (runtimeDir ? join(runtimeDir, 'gvfs') : null)
    if (!gvfsDir) return null
    const expected = `smb-share:server=${profile.host.toLowerCase()},share=${shareName(profile).toLowerCase()}`
    try {
      const entries = await readdir(gvfsDir, { withFileTypes: true })
      const mount = entries.find(
        (entry) => entry.isDirectory() && entry.name.toLowerCase() === expected
      )
      return mount ? join(gvfsDir, mount.name) : null
    } catch {
      return null
    }
  }

  function throwForMountResult(result: MountCommandResult, action: string): void {
    if (result.code === 0) return
    const stderr = result.stderr
    if (/access denied|access is denied|logon failure|invalid username/i.test(stderr)) {
      throw new NetworkSourceFailure('auth', 'SMB 认证失败，请检查用户名或密码')
    }
    if (/network name cannot be found|not found|no such/i.test(stderr)) {
      throw new NetworkSourceFailure('notFound', 'SMB 共享不存在')
    }
    throw new NetworkSourceFailure(
      'network',
      `SMB ${action} 失败：${stderr.trim() || `exit ${result.code}`}`
    )
  }

  return {
    protocol,
    async createSession(
      profile: NetworkSourceProfile,
      auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      if (protocol === 'smb') {
        if (platform !== 'win32' && platform !== 'linux') {
          throw new NetworkSourceFailure('unsupportedProtocol', '当前系统不支持 SMB 系统挂载')
        }
        if (platform === 'linux' && auth.kind === 'password') {
          throw new NetworkSourceFailure(
            'auth',
            'Linux 系统挂载仅支持匿名或已缓存凭据，请先在文件管理器连接该共享'
          )
        }
      } else {
        if (platform !== 'linux') {
          throw new NetworkSourceFailure('unsupportedProtocol', 'NFS 系统挂载仅支持 Linux')
        }
        if (auth.kind !== 'anonymous') {
          throw new NetworkSourceFailure('auth', 'NFS 无需认证')
        }
      }

      let mountPoint: string | null = null
      const localMap = deps.localMap
        ? (remotePath: string) => {
            const key =
              protocol === 'nfs'
                ? (mountPoint ?? '')
                : platform === 'win32'
                  ? uncFor(profile)
                  : (mountPoint ?? gioUri(profile))
            return deps.localMap!(key, remotePath)
          }
        : (remotePath: string) => {
            const key =
              protocol === 'nfs'
                ? (mountPoint ?? '')
                : platform === 'win32'
                  ? uncFor(profile)
                  : (mountPoint ?? gioUri(profile))
            return defaultLocalMap(key)(remotePath)
          }

      let mounted = false

      async function ensureMounted(): Promise<void> {
        if (mounted) return
        if (protocol === 'nfs') {
          mountPoint = await mkdtemp(join(mountBaseDir, 'twilight-nfs-'))
          await mkdir(mountPoint, { recursive: true })
          const exportPath = normalizeRemotePath(profile.rootPath)
          const result = await runCommand('mount', [
            '-t',
            'nfs',
            `${profile.host}:${exportPath}`,
            mountPoint
          ])
          try {
            throwForMountResult(result, '挂载')
          } catch (err) {
            await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
            mountPoint = null
            throw err
          }
        } else if (platform === 'win32') {
          const unc = uncFor(profile)
          const password = auth.kind === 'password' ? auth.password : ''
          const user =
            auth.kind === 'password' ? (auth.username ?? profile.username ?? 'guest') : 'guest'
          const result = await runCommand('net', ['use', unc, password, `/user:${user}`])
          throwForMountResult(result, '挂载')
        } else {
          const result = await runCommand('gio', ['mount', gioUri(profile)])
          throwForMountResult(result, '挂载')
        }
        if (protocol === 'smb' && platform === 'linux' && !deps.localMap) {
          mountPoint = await (deps.findGvfsMount ?? findGvfsMount)(profile)
          if (!mountPoint) {
            throw new NetworkSourceFailure(
              'notFound',
              'SMB 已挂载但未找到 GVFS 本地挂载点，请确认桌面会话已启用 GVFS'
            )
          }
        }
        mounted = true
      }

      function toEntry(remotePath: string, isDirectory: boolean, size: number): NetworkEntry {
        const path = normalizeRemotePath(remotePath)
        const name = path === '/' ? '/' : (path.split('/').pop() ?? path)
        return {
          id: buildNetworkEntryId(profile.protocol, profile.id, path),
          profileId: profile.id,
          name,
          kind: entryKind(name, { directory: isDirectory }),
          path,
          sizeBytes: isDirectory ? undefined : size
        }
      }

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
          await ensureMounted()
          const parent = normalizeRemotePath(remotePath)
          const local = localMap(parent)
          let dirents
          try {
            dirents = await readdir(local, { withFileTypes: true })
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new NetworkSourceFailure('notFound', '远程路径不存在')
            }
            throw new NetworkSourceFailure('network', `SMB 列目录失败：${(err as Error).message}`)
          }
          const entries: NetworkEntry[] = []
          for (const dirent of dirents) {
            const childPath = parent === '/' ? `/${dirent.name}` : `${parent}/${dirent.name}`
            const size = dirent.isDirectory()
              ? undefined
              : (await stat(localMap(childPath)).catch(() => undefined))?.size
            entries.push(toEntry(childPath, dirent.isDirectory(), size ?? 0))
          }
          return entries
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
          await ensureMounted()
          const path = normalizeRemotePath(remotePath)
          try {
            const info = await stat(localMap(path))
            return toEntry(path, info.isDirectory(), info.size)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new NetworkSourceFailure('notFound', '远程路径不存在')
            }
            throw new NetworkSourceFailure('network', `SMB stat 失败：${(err as Error).message}`)
          }
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          await ensureMounted()
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络文件读取已取消')
          const stream = createReadStream(localMap(normalizeRemotePath(remotePath)), {
            start: options?.start ?? 0
          })
          signal?.addEventListener('abort', () => stream.destroy(new Error('read aborted')), {
            once: true
          })
          return stream
        },
        async resolvePlaybackUrl(): Promise<string | null> {
          return null
        },
        async close(): Promise<void> {
          if (!mounted) return
          if (protocol === 'nfs') {
            if (mountPoint) {
              await runCommand('umount', [mountPoint]).catch(() => undefined)
              await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
              mountPoint = null
            }
          } else if (platform === 'win32') {
            await runCommand('net', ['use', uncFor(profile), '/delete', '/y']).catch(
              () => undefined
            )
          } else {
            await runCommand('gio', ['mount', '-u', gioUri(profile)]).catch(() => undefined)
          }
          mounted = false
        }
      }
    }
  }
}

async function defaultRunCommand(command: string, args: string[]): Promise<MountCommandResult> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
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
  })
}
