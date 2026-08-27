import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect, type AddressInfo, type Server, type Socket } from 'node:net'
import test from 'node:test'
import {
  buildPluginProxyEnv,
  createSecureProxyFetch,
  installProxyFetch,
  type ProxyFetchTransport
} from './proxyBootstrap.ts'

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDbnTHFqhL8JhZEjbK5IqB+o8QY
I0LBby+qWcNrTdWW4bSF40IbRcqIpK77YSi23Ytr/pQFHZr7fVsMSmNeUk4JUFz6YzJWkAQVtFJe
QOA2ZUUsEZ78VCgbNPJ8lz+Ly0TzfBHFWnTnxbjl1Sk67u6hV3+f2Uqm++v5Ghb9Tcxdts2mtmLn
yrbIT7vin4N03zApH6koXh6jFdfS2OTozeQdWE7mkGlHpcl5Ga4cf1CH/ybqjqjel/xxHGZX/m5N
M1Sp7kTw+hYjBkIBaxDCAdWzynAGXhMyYGdk7w1UBlC7uFKAaoOY9kikxQe0xRBNyiosHpVWBIUJ
AMu9Xkh8oqntAgMBAAECggEAEL6yndSy7+Djj8SSHQWj4SQRfpmprGAS7VU8zkC4CXIaNp82Wif/
Il4ULXyiAxdvWwOlO6KfP4+2UoCVhQqXgqRLAphvrSP7+7+tDBy8O8mK9ao+ShUMnc5yssdBhCIy
lrIeFMMp6MYtq/CN3T18mna2d3S0+Xh57Jttp1C4RWjXpzaA5iLJ2gFXDuQvFScEmyQsVX1NXwuf
/DHgPsRvIhUCiet3z5OqANwoWtvtFAcKzY3NQ+bWKd77ahM3SSDEeIWxPUCT22cKpmNJ9SM7khrh
S2yuFQ+CFSgvUQwyCzQwNI5aBlXYjKbo2QptOOmb9hqw7o69/tXKWVWu5hmFDQKBgQDz0fNlgc+0
/GUeqznPrybJJDmjabUQMIVG1x0cpSJdZ/K3Lq3G9ID54CNvqLgih8/DhVMly6CLMVyFvRZFfNpY
UqjxewFXOLhfGxPJmJWHsC2BWplmA7o3isVZiaMWCppY+AMjxt+YC3mQgW7b3PuEbMsC6mXQ/A4Z
wC5nSUxugwKBgQDmlbBI7lJOCdg4EzdJ3HYsZyue5Aa2nsbrq8T7NLohzw5duoyHbSUJkFjNBsu+
EF4rrVWZBBq8rPdLXfYTYbza31TPVu9qigwAO6SrgD/Z9Y19y0bGz5X9nKwci6erOa+0icItOIFo
zI2hUJNPRKeq1XnW5zSGX9mva8rkVjQazwKBgB7j15Fhq94DKBCFovJj/2b2VvMUHmNpskjyUfbi
GQN6eu6oVE3jhj+iHPs1hfah/DmKN6mPLczUuSMcfKjbE5KjDlJhwh65yeoKtSwST8d8E5fS0aJy
EHKe+zfHz0iomTtyWHt847EQqxsaut/SFG+HlQTOi425kVPD3F0rlSpfAoGAGMwwUSeQImRcpGss
nvzemJff0Q6kyi75JY8rd/iLq+cgnGPbiRTrzsN/SU1Zy+7msbvKYNJYLcJMNga82AjCzqcF7+Zh
iQufjsbbRrZcJ4yI0uZxjh/0+XlH6Sn7tiZWBwxpnYNeJ28YLCkGLpgrj+u1Vq82rtzQBFWLVFMQ
93ECgYBLrm706nXs8WtxSVBTHdE012NAhlvhJ5xAXQrRIiaFOWth6niHrJ/SUSVOLGavPNjG/DbF
GU5dtJcfexJgQnHBG/rkpwjaec8o0ZaoxSFWkQvHgIk5avezwm0mlOxcgz4Sw9oJJ9pY01t9fLw+
qRvAMGdTug+ET14UkQXq7e7POQ==
-----END PRIVATE KEY-----`

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIC2DCCAcCgAwIBAgIJAJ5pwP/0/Rh9MA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAMTEHNlbGYt
c2lnbmVkLnRlc3QwHhcNMjAwMTAxMDAwMDAwWhcNNDAwMTAxMDAwMDAwWjAbMRkwFwYDVQQDExBz
ZWxmLXNpZ25lZC50ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA250xxaoS/CYW
RI2yuSKgfqPEGCNCwW8vqlnDa03VluG0heNCG0XKiKSu+2Eott2La/6UBR2a+31bDEpjXlJOCVBc
+mMyVpAEFbRSXkDgNmVFLBGe/FQoGzTyfJc/i8tE83wRxVp058W45dUpOu7uoVd/n9lKpvvr+RoW
/U3MXbbNprZi58q2yE+74p+DdN8wKR+pKF4eoxXX0tjk6M3kHVhO5pBpR6XJeRmuHH9Qh/8m6o6o
3pf8cRxmV/5uTTNUqe5E8PoWIwZCAWsQwgHVs8pwBl4TMmBnZO8NVAZQu7hSgGqDmPZIpMUHtMUQ
TcoqLB6VVgSFCQDLvV5IfKKp7QIDAQABox8wHTAbBgNVHREEFDASghBzZWxmLXNpZ25lZC50ZXN0
MA0GCSqGSIb3DQEBCwUAA4IBAQAvD5Mh9klFmgbM/uaTjnPeipsBgaZmKCcoUnQlZGgO7s+00AGf
EIX6f4WBOODO5fjg8cxSbfxlWKsXxjluBYtWfL+g0cfkuXZo3zo6PFEiILwroSVv2QHysCwUNI3L
oFvWUfy1gmPpp79gIZwkGIrR9F7rQAFbkdncwTuDNtJyePoeofO4gck4nhIAT+ua3Qzfi267MJC2
sEbGLQZNmVBO/i0VWdVan7qceAt22a1F/h/COKqSn2pJGsDKpIYeblp4RkGDco5KSrYylBq9/iIT
X3sqEjrD0Yiy097nrilBF/LCvP35V0R7EJaU6YfK/8cxY4hZorI5ehMNr3aEw0MN
-----END CERTIFICATE-----`

test('off mode clears inherited proxy variables for the entire plugin process', () => {
  const inherited = {
    HTTPS_PROXY: 'http://parent-proxy:8080',
    https_proxy: 'http://parent-proxy:8080',
    HTTP_PROXY: 'http://parent-proxy:8080',
    http_proxy: 'http://parent-proxy:8080',
    ALL_PROXY: 'http://parent-proxy:8080',
    all_proxy: 'http://parent-proxy:8080'
  }
  const childEnv: Record<string, string> = {
    ...inherited,
    ...buildPluginProxyEnv({
      proxyMode: 'off',
      proxyHost: '',
      proxyPort: 0,
      proxyAllowDirectFallback: false
    })
  }

  assert.equal(childEnv.TWILIGHT_PLUGIN_PROXY_MODE, 'off')
  for (const key of Object.keys(inherited)) assert.equal(childEnv[key], '')
})

test('custom mode gives global fetch and plugin HTTP clients the same proxy choice', () => {
  const childEnv = buildPluginProxyEnv({
    proxyMode: 'custom',
    proxyHost: '127.0.0.1',
    proxyPort: 7897,
    proxyAllowDirectFallback: true
  })

  assert.equal(childEnv.TWILIGHT_PLUGIN_PROXY_URL, 'http://127.0.0.1:7897/')
  assert.equal(childEnv.HTTPS_PROXY, childEnv.TWILIGHT_PLUGIN_PROXY_URL)
  assert.equal(childEnv.HTTP_PROXY, childEnv.TWILIGHT_PLUGIN_PROXY_URL)
  assert.equal(childEnv.ALL_PROXY, childEnv.TWILIGHT_PLUGIN_PROXY_URL)
  assert.equal(childEnv.TWILIGHT_PLUGIN_PROXY_ALLOW_DIRECT_FALLBACK, '1')
})

test('rejects a self-signed target certificate through the production proxy dispatcher', async () => {
  const sockets = new Set<Socket>()
  const target = createHttpsServer(
    { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
    (_req, res) => {
      res.end('unexpected success')
    }
  )
  trackConnections(target, sockets)
  const targetPort = await listen(target)
  const proxy = createHttpServer()
  trackConnections(proxy, sockets)
  proxy.on('connect', (_request, client, head) => {
    const upstream = netConnect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
  const proxyPort = await listen(proxy)
  let directRequests = 0
  const directFetch = async (): Promise<Response> => {
    directRequests += 1
    return new Response('direct')
  }
  const installed = installProxyFetch(`http://127.0.0.1:${proxyPort}`, directFetch as typeof fetch)

  try {
    await assert.rejects(
      () => installed.fetch(`https://self-signed.test:${targetPort}/audio`),
      (error: unknown) => {
        assert.equal(findErrorCode(error), 'DEPTH_ZERO_SELF_SIGNED_CERT')
        return true
      }
    )
    assert.equal(directRequests, 0)
  } finally {
    for (const socket of sockets) socket.destroy()
    await installed.close()
    await closeServer(proxy)
    await closeServer(target)
  }
})

test('blocks HTTPS to remote HTTP redirect downgrade before a second request', async () => {
  let proxyRequests = 0
  let directRequests = 0
  const proxyRequest: ProxyFetchTransport = async () => {
    proxyRequests += 1
    return new Response(null, {
      status: 302,
      headers: { location: 'http://remote.test/plaintext' }
    })
  }
  const fetchWithProxy = policyFetch(proxyRequest, async () => {
    directRequests += 1
    return new Response('direct')
  })

  await assert.rejects(() => fetchWithProxy('https://origin.test/start'), /redirect downgrade/)
  assert.equal(proxyRequests, 1)
  assert.equal(directRequests, 0)
})

test('strips credentials on cross-origin redirect while retaining ordinary headers', async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const proxyRequest: ProxyFetchTransport = async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) })
    return requests.length === 1
      ? new Response(null, {
          status: 307,
          headers: { location: 'https://other.test/final' }
        })
      : new Response('ok')
  }
  const fetchWithProxy = policyFetch(proxyRequest)

  const response = await fetchWithProxy('https://origin.test/start', {
    headers: {
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
      'Proxy-Authorization': 'Basic secret',
      'X-Request-Id': 'trace-1'
    }
  })

  assert.equal(await response.text(), 'ok')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].headers.get('authorization'), 'Bearer secret')
  assert.equal(requests[1].headers.has('authorization'), false)
  assert.equal(requests[1].headers.has('cookie'), false)
  assert.equal(requests[1].headers.has('proxy-authorization'), false)
  assert.equal(requests[1].headers.get('x-request-id'), 'trace-1')
})

test('enforces the redirect hop limit', async () => {
  let calls = 0
  const fetchWithProxy = policyFetch(
    async () => {
      calls += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://origin.test/hop-${calls}` }
      })
    },
    undefined,
    { maxRedirects: 2 }
  )

  await assert.rejects(() => fetchWithProxy('https://origin.test/start'), /2-redirect limit/)
  assert.equal(calls, 3)
})

test('proxy failure is fail-closed unless direct fallback is explicitly enabled', async () => {
  const proxyError = Object.assign(new Error('proxy unavailable'), { code: 'ECONNREFUSED' })
  const proxyRequest: ProxyFetchTransport = async () => {
    throw proxyError
  }
  let directRequests = 0
  const directRequest: ProxyFetchTransport = async (_url, init) => {
    directRequests += 1
    assert.equal(init.redirect, 'manual')
    return new Response('direct result')
  }

  const failClosed = policyFetch(proxyRequest, directRequest)
  await assert.rejects(() => failClosed('https://origin.test/data'), /ECONNREFUSED.*disabled/)
  assert.equal(directRequests, 0)

  const fallbackEnabled = policyFetch(proxyRequest, directRequest, {
    allowDirectFallback: true
  })
  const response = await fallbackEnabled('https://origin.test/data')
  assert.equal(await response.text(), 'direct result')
  assert.equal(directRequests, 1)
})

test('a pre-aborted request does not enter either network transport', async () => {
  const controller = new AbortController()
  controller.abort()
  let proxyRequests = 0
  let directRequests = 0
  const fetchWithProxy = policyFetch(
    async () => {
      proxyRequests += 1
      return new Response('proxy')
    },
    async () => {
      directRequests += 1
      return new Response('direct')
    },
    { allowDirectFallback: true }
  )

  await assert.rejects(
    () => fetchWithProxy('https://origin.test/already-aborted', { signal: controller.signal }),
    (error: unknown) => {
      assert.equal((error as Error).name, 'AbortError')
      return true
    }
  )
  assert.equal(proxyRequests, 0)
  assert.equal(directRequests, 0)
})

test('an aborted proxy request never starts direct fallback', async () => {
  const controller = new AbortController()
  let directRequests = 0
  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const proxyRequest: ProxyFetchTransport = async (_url, init) => {
    markStarted?.()
    return await new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  }
  const fetchWithProxy = policyFetch(
    proxyRequest,
    async () => {
      directRequests += 1
      return new Response('direct')
    },
    { allowDirectFallback: true }
  )

  const pending = fetchWithProxy('https://origin.test/slow', { signal: controller.signal })
  await started
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
  assert.equal(directRequests, 0)
})

function policyFetch(
  proxyRequest: ProxyFetchTransport,
  directRequest: ProxyFetchTransport = async () => new Response('direct'),
  overrides: { allowDirectFallback?: boolean; maxRedirects?: number } = {}
): typeof fetch {
  return createSecureProxyFetch({
    proxyRequest,
    directRequest,
    passthroughFetch: directRequest as typeof fetch,
    ...overrides
  })
}

function trackConnections(server: Server, sockets: Set<Socket>): void {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
}

function findErrorCode(error: unknown): string | null {
  const visited = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    if ('code' in current && typeof current.code === 'string') return current.code
    current = 'cause' in current ? current.cause : null
  }
  return null
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
