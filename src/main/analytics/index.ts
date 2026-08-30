import { app } from 'electron'
import { join } from 'node:path'
import { runtime } from '../core/runtime'
import { TelemetryClient } from './telemetryClient.ts'

export const TELEMETRY_ENDPOINT_ENV = 'TWILIGHT_TELEMETRY_ENDPOINT_URL'
// 正式上报端点（服务端部署见 server/telemetry/）。环境变量仅用于本机联调覆盖。
export const DEFAULT_TELEMETRY_ENDPOINT_URL = 'https://telemetry.aaapi.fun/v1/events'

export function resolveTelemetryEndpointUrl(override: string | undefined): string {
  const candidate = override?.trim()
  return candidate ? candidate : DEFAULT_TELEMETRY_ENDPOINT_URL
}

export function initializeTelemetry(): void {
  if (runtime.telemetry) return
  const client = new TelemetryClient({
    endpointUrl: resolveTelemetryEndpointUrl(process.env[TELEMETRY_ENDPOINT_ENV]),
    stateDir: join(app.getPath('userData'), 'telemetry'),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  })
  runtime.telemetry = client
  client.start()
}

export function destroyTelemetry(): void {
  runtime.telemetry?.dispose()
  runtime.telemetry = null
}
