import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { buildSoapEnvelope } from '../../remote/soap.ts'
import { buildNetworkEntryId } from '../networkPath.ts'
import { NetworkSourceFailure } from '../errors.ts'
import { entryKind } from '../entryKinds.ts'
import type { NetworkAuth, NetworkSourceAdapter, NetworkSourceSession } from './types.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../../shared/networkSources.ts'

export interface DlnaHttpResponse {
  status: number
  body: Buffer
}

export interface DlnaTransport {
  get(url: string): Promise<DlnaHttpResponse>
  post(url: string, soapAction: string, body: string): Promise<DlnaHttpResponse>
}

const CD_SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const DEFAULT_DESC_PATHS = ['/rootDesc.xml', '/description.xml', '/', '/upnp/description.xml']

interface DidlEntry {
  id: string
  title: string
  container: boolean
  audioItem: boolean
  res: string | null
}

function extractControlUrl(xml: string): string | null {
  const serviceBlocks = xml.match(/<service\b[\s\S]*?<\/service>/gi) ?? []
  for (const block of serviceBlocks) {
    const type = /<serviceType[^>]*>([\s\S]*?)<\/serviceType>/i.exec(block)?.[1] ?? ''
    const control = /<controlURL[^>]*>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1] ?? ''
    if (type.toLowerCase().includes('contentdirectory') && control.trim()) {
      return control.trim()
    }
  }
  return null
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseDidl(result: string): DidlEntry[] {
  const xml = unescapeXml(result)
  const entries: DidlEntry[] = []
  const pattern = /<(container|item)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const tag = match[1]
    const attributes = match[2]
    const body = match[3]
    const id = /id="([^"]*)"/.exec(attributes)?.[1] ?? ''
    if (!id) continue
    const title =
      /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(body)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ??
      id
    const upnpClass = /<upnp:class[^>]*>([\s\S]*?)<\/upnp:class>/i.exec(body)?.[1] ?? ''
    const res = /<res[^>]*>([\s\S]*?)<\/res>/i.exec(body)?.[1] ?? null
    entries.push({
      id,
      title: unescapeXml(title.trim()),
      container: tag === 'container',
      audioItem: upnpClass.toLowerCase().includes('audioitem'),
      res: res?.trim() ?? null
    })
  }
  return entries
}

async function defaultGet(url: string): Promise<DlnaHttpResponse> {
  return requestText('GET', url)
}

async function defaultPost(
  url: string,
  soapAction: string,
  body: string
): Promise<DlnaHttpResponse> {
  return requestText(
    'POST',
    url,
    {
      SOAPACTION: `"${soapAction}"`,
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  )
}

async function requestText(
  method: string,
  url: string,
  headers: Record<string, string | number> = {},
  body?: string
): Promise<DlnaHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requestFn(parsed, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function toEntry(profile: NetworkSourceProfile, item: DidlEntry): NetworkEntry {
  const path = `/${item.id}`
  const kind = item.container
    ? 'directory'
    : entryKind(item.title, { mime: item.audioItem ? 'audio/unknown' : undefined })
  return {
    id: buildNetworkEntryId(profile.protocol, profile.id, path),
    profileId: profile.id,
    name: item.title,
    kind,
    path,
    mimeType: item.res ?? undefined
  }
}

/**
 * DLNA / UPnP 媒体服务器浏览 adapter：SSDP 设备描述 → ContentDirectory Browse。
 * 播放走 item 的 res URL（直连），与现有 DLNA 投送（castBackend）分离。
 */
export function createDlnaAdapter(deps?: {
  transport?: DlnaTransport
  descriptionPaths?: string[]
}): NetworkSourceAdapter {
  const transport = deps?.transport ?? { get: defaultGet, post: defaultPost }
  const descriptionPaths = deps?.descriptionPaths ?? DEFAULT_DESC_PATHS

  return {
    protocol: 'dlna',
    async createSession(
      profile: NetworkSourceProfile,
      _auth: NetworkAuth
    ): Promise<NetworkSourceSession> {
      let controlUrl: string | null = null
      const baseUrl = `http://${profile.host}${profile.port ? `:${profile.port}` : ''}`

      async function ensureConnected(): Promise<void> {
        if (controlUrl) return
        for (const descPath of descriptionPaths) {
          try {
            const response = await transport.get(`${baseUrl}${descPath}`)
            if (response.status !== 200) continue
            const relative = extractControlUrl(response.body.toString('utf8'))
            if (!relative) continue
            controlUrl = new URL(relative, `${baseUrl}${descPath}`).toString()
            return
          } catch {
            // 尝试下一个描述路径
          }
        }
        throw new NetworkSourceFailure('network', '无法获取 DLNA 媒体服务器设备描述')
      }

      function throwForStatus(status: number): void {
        if (status >= 200 && status < 300) return
        if (status === 401 || status === 403) {
          throw new NetworkSourceFailure('auth', 'DLNA 服务器拒绝访问')
        }
        throw new NetworkSourceFailure('network', `DLNA 请求失败：HTTP ${status}`)
      }

      async function browse(
        objectId: string,
        flag: string,
        signal?: AbortSignal
      ): Promise<DidlEntry[]> {
        if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
        await ensureConnected()
        const response = await transport.post(
          controlUrl as string,
          `${CD_SERVICE}#Browse`,
          buildSoapEnvelope({
            serviceType: CD_SERVICE,
            action: 'Browse',
            arguments: {
              ObjectID: objectId,
              BrowseFlag: flag,
              Filter: '*',
              StartingIndex: 0,
              RequestedCount: 0,
              SortCriteria: ''
            }
          })
        )
        if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络操作已取消')
        throwForStatus(response.status)
        const body = response.body.toString('utf8')
        const result = /<Result[^>]*>([\s\S]*?)<\/Result>/i.exec(body)?.[1] ?? ''
        return parseDidl(result)
      }

      function objectIdOf(remotePath: string): string {
        const id = remotePath.replace(/^\//, '')
        return id || '0'
      }

      async function resolveUrl(remotePath: string, signal?: AbortSignal): Promise<string | null> {
        const items = await browse(objectIdOf(remotePath), 'BrowseMetadata', signal)
        return items[0]?.res ?? null
      }

      return {
        protocol: profile.protocol,
        async list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]> {
          const items = await browse(objectIdOf(remotePath), 'BrowseDirectChildren', signal)
          return items.map((item) => toEntry(profile, item))
        },
        async stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null> {
          const items = await browse(objectIdOf(remotePath), 'BrowseMetadata', signal)
          return items[0] ? toEntry(profile, items[0]) : null
        },
        async resolvePlaybackUrl(remotePath: string, signal?: AbortSignal): Promise<string | null> {
          return resolveUrl(remotePath, signal)
        },
        async readStream(
          remotePath: string,
          signal?: AbortSignal,
          options?: { start?: number }
        ): Promise<NodeJS.ReadableStream> {
          const url = await resolveUrl(remotePath, signal)
          if (!url) throw new NetworkSourceFailure('notFound', 'DLNA 条目没有可播放的媒体地址')
          const response = await transport.get(url)
          if (signal?.aborted) throw new NetworkSourceFailure('timeout', '网络文件读取已取消')
          throwForStatus(response.status)
          const start = options?.start ?? 0
          return Readable.from([response.body.subarray(start)])
        },
        async close(): Promise<void> {
          // 无状态 HTTP，无需清理。
        }
      }
    }
  }
}
