import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { isTelemetryBatchRequest, type TelemetryBatchRequest } from '../../shared/telemetry.ts'

export const TELEMETRY_MOCK_PATH = '/v1/events'

export interface TelemetryMockServer {
  url: string
  received: TelemetryBatchRequest[]
  close(): Promise<void>
}

export async function startTelemetryMockServer(port = 0): Promise<TelemetryMockServer> {
  const received: TelemetryBatchRequest[] = []
  const server: Server = createServer((request, response) => {
    handleRequest(request, response, received)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const bound = server.address()
  if (!bound || typeof bound === 'string') {
    throw new Error('Telemetry mock server did not bind to a TCP address')
  }
  return {
    url: `http://127.0.0.1:${bound.port}${TELEMETRY_MOCK_PATH}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  received: TelemetryBatchRequest[]
): void {
  if (request.method !== 'POST' || request.url !== TELEMETRY_MOCK_PATH) {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'not-found' }))
    return
  }
  const chunks: Buffer[] = []
  let totalBytes = 0
  request.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > 1024 * 1024) {
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    } catch {
      respondJson(response, 400, { error: 'invalid-json' })
      return
    }
    if (!isTelemetryBatchRequest(parsed)) {
      respondJson(response, 400, { error: 'invalid-batch' })
      return
    }
    received.push(parsed)
    const counts = new Map<string, number>()
    for (const event of parsed.events) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    }
    console.log(
      `[telemetry-mock] received ${parsed.events.length} event(s):`,
      [...counts.entries()].map(([type, count]) => `${type}=${count}`).join(' ')
    )
    respondJson(response, 200, { received: parsed.events.length })
  })
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const portArgumentIndex = process.argv.indexOf('--port')
  const requestedPort =
    portArgumentIndex >= 0 && process.argv[portArgumentIndex + 1]
      ? Number(process.argv[portArgumentIndex + 1])
      : 8787
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    console.error(`Invalid --port value: ${process.argv[portArgumentIndex + 1]}`)
    process.exit(1)
  }
  startTelemetryMockServer(requestedPort)
    .then((server) => {
      console.log(`Telemetry mock server listening on ${server.url}`)
      console.log('Set TWILIGHT_TELEMETRY_ENDPOINT_URL to this URL and start the app.')
    })
    .catch((error) => {
      console.error('Failed to start telemetry mock server:', error)
      process.exit(1)
    })
}
