import DiscordRPC from 'discord-rpc'
import { runtime, type DiscordActivityData } from '../core/runtime'

export const DISCORD_CLIENT_ID = '1390521943809896488' // Twilight Echo application ID

export type DiscordRpcStatus = {
  enabled: boolean
  connected: boolean
  lastError: string | null
}

export function getDiscordRpcStatus(): DiscordRpcStatus {
  return {
    enabled: runtime.appSettings.discordRpcEnabled === true,
    connected: runtime.discordConnected === true,
    lastError: runtime.discordLastError
  }
}

export function connectDiscord(): void {
  if (runtime.discordConnectAttempted || runtime.discordConnected) return
  runtime.discordConnectAttempted = true
  try {
    runtime.discordClient = new DiscordRPC.Client({ transport: 'ipc' })
    runtime.discordClient.once('connected', () => {
      runtime.discordConnected = true
      runtime.discordLastError = null
      if (runtime.lastDiscordActivity) updateDiscordActivity(runtime.lastDiscordActivity)
    })
    runtime.discordClient.once('disconnected', () => {
      runtime.discordConnected = false
      runtime.discordLastError = 'Discord 连接已断开，将自动重试'
      runtime.discordClient = null
      if (runtime.discordReconnectTimer) clearTimeout(runtime.discordReconnectTimer)
      runtime.discordReconnectTimer = setTimeout(() => {
        runtime.discordConnectAttempted = false
        if (runtime.appSettings.discordRpcEnabled) connectDiscord()
      }, 15000)
    })
    void runtime.discordClient.login({ clientId: DISCORD_CLIENT_ID }).catch((error) => {
      runtime.discordConnected = false
      runtime.discordClient = null
      runtime.discordLastError =
        error instanceof Error ? error.message : 'Discord 未运行或 IPC 不可用'
      if (runtime.discordReconnectTimer) clearTimeout(runtime.discordReconnectTimer)
      runtime.discordReconnectTimer = setTimeout(() => {
        runtime.discordConnectAttempted = false
        if (runtime.appSettings.discordRpcEnabled) connectDiscord()
      }, 30000)
    })
  } catch (error) {
    runtime.discordConnectAttempted = false
    runtime.discordLastError = error instanceof Error ? error.message : 'Discord 连接失败'
  }
}

export function disconnectDiscord(): void {
  if (runtime.discordReconnectTimer) {
    clearTimeout(runtime.discordReconnectTimer)
    runtime.discordReconnectTimer = null
  }
  if (runtime.discordClient) {
    try {
      void runtime.discordClient.destroy()
    } catch {
      /* ignore */
    }
    runtime.discordClient = null
  }
  runtime.discordConnected = false
  runtime.discordConnectAttempted = false
  runtime.discordLastError = null
}

export function updateDiscordActivity(data: DiscordActivityData): void {
  runtime.lastDiscordActivity = data
  if (!runtime.discordConnected || !runtime.discordClient) return
  const activity: DiscordRPC.Presence = {
    details: data.title || 'Unknown track',
    state: data.artist ? `by ${data.artist}` : '',
    instance: false
  }
  if (data.playing && data.startTime) {
    activity.startTimestamp = data.startTime
    activity.type = 2 // ActivityType.Listening
  }
  try {
    void runtime.discordClient.setActivity(activity)
  } catch {
    // ignore transient errors
  }
}

export function clearDiscordActivity(): void {
  runtime.lastDiscordActivity = null
  if (!runtime.discordConnected || !runtime.discordClient) return
  try {
    void runtime.discordClient.clearActivity()
  } catch {
    /* ignore */
  }
}

export function applyDiscordRpcSetting(enabled: boolean): void {
  if (enabled) {
    connectDiscord()
  } else {
    clearDiscordActivity()
    disconnectDiscord()
  }
}
