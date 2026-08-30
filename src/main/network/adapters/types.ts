import type {
  NetworkEntry,
  NetworkProtocol,
  NetworkSourceProfile
} from '../../../shared/networkSources.ts'

/** 主进程内存中的已解密凭据，绝不进入渲染层与磁盘。 */
export type NetworkAuth =
  | { kind: 'anonymous' }
  | { kind: 'password'; username?: string; password: string }
  | { kind: 'privateKey'; username?: string; keyPath: string; passphrase?: string }

/** 一个已建立的协议会话（HTTP 类协议为无状态，仍保持同一 seam）。 */
export interface NetworkSourceSession {
  protocol: NetworkProtocol
  list(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry[]>
  stat(remotePath: string, signal?: AbortSignal): Promise<NetworkEntry | null>
  readStream(
    remotePath: string,
    signal?: AbortSignal,
    options?: { start?: number }
  ): Promise<NodeJS.ReadableStream>
  /**
   * 返回可直接交给播放内核的 URL；需要认证或协议不支持 URL 播放时返回 null
   * （此时由 sourcesManager 下载到本地缓存再播）。
   */
  resolvePlaybackUrl(remotePath: string, signal?: AbortSignal): Promise<string | null>
  close(): Promise<void>
}

/** 协议适配器 seam：一个协议一个 adapter。 */
export interface NetworkSourceAdapter {
  protocol: NetworkProtocol
  createSession(profile: NetworkSourceProfile, auth: NetworkAuth): Promise<NetworkSourceSession>
}
