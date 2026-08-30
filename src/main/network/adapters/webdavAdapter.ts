import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { buildNetworkEntryId, normalizeRemotePath } from '../networkPath.ts'
import { NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'

function isCollectionBlock(block: string): boolean {
  return /<(?:\w+:)?collection\s*\/?\s*>/i.test(block)
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(String.raw`<(?:\w+:)?${tag}[^>]*>([^<]*)<`, 'i'))
  return match ? match[1].trim() : null
}

function parseMultistatus(
  xml: string
): Array<{ href: string; directory: boolean; size?: number; mime?: string; mtimeMs?: number }> {
  const blocks: string[] = []
  const pattern = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) blocks.push(match[1])

  return blocks
    .map((block) => {
      const href = extractTag(block, 'href')
      if (!href) return null
      const sizeText = extractTag(block, 'getcontentlength')
      const size = sizeText ? Number.parseInt(sizeText, 10) : undefined
      const mime = extractTag(block, 'getcontenttype') ?? undefined
      const mtimeText = extractTag(block, 'getlastmodified')
      const mtimeMs = mtimeText ? Date.parse(mtimeText) : undefined
      return {
        href: decodeURIComponent(href),
        directory: isCollectionBlock(block),
        size: Number.isFinite(size) ? size : undefined,
        mime,
        mtimeMs: Number.isFinite(mtimeMs as number) ? mtimeMs : undefined
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

function nameOf(path: string): string {
  const cleaned = normalizeRemotePath(path)
  if (cleaned === '/') return '/'
  return cleaned.split('/').pop() ?? ''
}

function authHeader(auth: NetworkAuth): string | undefined {
  if (auth.kind !== 'password' || !auth.username || !auth.password) return undefined
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!signal) return AbortSignal.timeout(timeoutMs)
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

export function createWebDavAdapter(): NetworkSourceAdapter {
  return {
    protocol: 'webdav',
    async createSession(
      profile: NetworkSourceProfile,
      auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      const scheme = profile.webdavScheme ?? (profile.port === 443 ? 'https' : 'http')
      const port = profile.port ?? (scheme === 'https' ? 443 : 80)
      const cleanHost = profile.host.replace(/^https?:\/\//i, '')
      const authorization = authHeader(auth)

      const timeoutMs = profile.options.transferTimeoutMs

      function buildUrl(remotePath: string): string {
        const path = normalizeRemotePath(remotePath).replace(/^\//, '')
        return `${scheme}://${cleanHost}${port ? `:${port}` : ''}/${encodeURI(path)}`
      }

      function perform(
        method: string,
        remotePath: string,
        headers: Record<string, string>,
        signal?: AbortSignal,
        body?: string
      ): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
          const url = buildUrl(remotePath)
          const requestFn = scheme === 'https' ? httpsRequest : httpRequest
          const req = requestFn(
            url,
            {
              method,
              headers: { ...(authorization ? { Authorization: authorization } : {}), ...headers },
              signal: mergeSignal(signal, timeoutMs)
            },
            (res) => resolve(res)
          )
          req.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
              reject(new NetworkSourceFailure('timeout', '网络请求超时'))
            } else {
              reject(new NetworkSourceFailure('network', `网络请求失败：${err.message}`))
            }
          })
          if (body) req.write(body)
          req.end()
        })
      }

      function throwForStatus(status: number | undefined, remotePath: string): void {
        if (!status || (status >= 200 && status < 300)) return
        if (status === 401) throw new NetworkSourceFailure('auth', '认证失败，请检查用户名或密码')
        if (status === 403) throw new NetworkSourceFailure('denied', '没有权限访问该目录')
        if (status === 404)
          throw new NetworkSourceFailure('notFound', `远程路径不存在：${remotePath}`)
        throw new NetworkSourceFailure('network', `远程服务器返回错误状态 ${status}`)
      }

      async function collectBody(
        res: IncomingMessage,
        limitBytes = 8 * 1024 * 1024
      ): Promise<string> {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of res) {
          const buffer = Buffer.from(chunk)
          total += buffer.length
          if (total > limitBytes) throw new NetworkSourceFailure('network', '目录响应过大')
          chunks.push(buffer)
        }
        return Buffer.concat(chunks).toString('utf8')
      }

      function entriesFromMultistatus(
        xml: string,
        requestedPath: string,
        includeSelf = false
      ): NetworkEntry[] {
        const requested = normalizeRemotePath(requestedPath)
        return parseMultistatus(xml)
          .filter((item) => includeSelf || normalizeRemotePath(item.href) !== requested)
          .map((item) => {
            const path = normalizeRemotePath(item.href)
            return {
              id: buildNetworkEntryId(profile.protocol, profile.id, path),
              profileId: profile.id,
              name: nameOf(path),
              kind: entryKind(nameOf(path), { mime: item.mime, directory: item.directory }),
              path,
              sizeBytes: item.size,
              mtimeMs: item.mtimeMs,
              mimeType: item.mime
            }
          })
      }

      const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          const res = await perform(
            'PROPFIND',
            remotePath,
            { Depth: '1', 'Content-Type': 'application/xml' },
            signal,
            propfindBody
          )
          throwForStatus(res.statusCode, remotePath)
          return entriesFromMultistatus(await collectBody(res), remotePath)
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          const res = await perform(
            'PROPFIND',
            remotePath,
            { Depth: '0', 'Content-Type': 'application/xml' },
            signal,
            propfindBody
          )
          throwForStatus(res.statusCode, remotePath)
          const entries = entriesFromMultistatus(await collectBody(res), remotePath, true)
          const requested = normalizeRemotePath(remotePath)
          return entries.find((entry) => entry.path === requested) ?? entries[0] ?? null
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          const headers: Record<string, string> =
            options?.start != null && options.start > 0 ? { Range: `bytes=${options.start}-` } : {}
          const res = await perform('GET', remotePath, headers, signal)
          throwForStatus(res.statusCode, remotePath)
          return res
        },
        async resolvePlaybackUrl(remotePath: string): Promise<string | null> {
          // 匿名 WebDAV 可直接 URL 播放；带认证时 URL 无法携带凭据，必须走缓存下载。
          if (auth.kind !== 'anonymous') return null
          return buildUrl(remotePath)
        },
        async close(): Promise<void> {
          // HTTP 无状态会话，无需清理。
        }
      }
    }
  }
}
