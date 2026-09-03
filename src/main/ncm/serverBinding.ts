import type { Server } from 'node:http'

export function getListeningPort(server: Server): number {
  const address = server.address()
  if (!server.listening || !address || typeof address === 'string') {
    throw new Error('NetEase API server is not listening on a TCP port')
  }
  return address.port
}

export async function waitForListeningPort(server: Server): Promise<number> {
  if (server.listening) return getListeningPort(server)

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener('listening', handleListening)
      server.removeListener('error', handleError)
    }
    const handleListening = (): void => {
      cleanup()
      resolve()
    }
    const handleError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    server.once('listening', handleListening)
    server.once('error', handleError)
  })

  return getListeningPort(server)
}
