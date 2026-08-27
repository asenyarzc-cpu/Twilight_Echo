import assert from 'node:assert/strict'
import test from 'node:test'

const {
  RemoteMediaGrantService,
  createRemoteMediaRequestHandler,
  protectProviderMedia,
  grantRemoteImageUrl
} = (await import(
  new URL('./remoteMediaGrants.ts', import.meta.url).href
)) as typeof import('./remoteMediaGrants')

test('remote media grants expose an opaque URL and expire after inactivity', () => {
  let now = 1_000
  const grants = new RemoteMediaGrantService({ now: () => now, createToken: () => 'opaque-token' })
  const granted = grants.grant('https://media.example/track.flac?secret=abc', 'audio')

  assert.equal(granted, 'twilight-media://audio/opaque-token')
  assert.doesNotMatch(granted, /media\.example|secret/)
  assert.deepEqual(grants.resolve(granted, 'audio'), {
    source: 'https://media.example/track.flac?secret=abc',
    kind: 'audio'
  })

  now += 30 * 60 * 1000 + 1
  assert.throws(() => grants.resolve(granted, 'audio'), /expired/)
})

test('provider media results replace only approved remote media fields with grants', () => {
  const grants = new RemoteMediaGrantService({
    createToken: (() => {
      let index = 0
      return () => `token-${++index}`
    })()
  })

  const protectedTracks = protectProviderMedia(
    [
      {
        title: 'Song',
        cover: 'http://cover.example/art.jpg',
        streamUrl: 'https://media.example/song.flac',
        homepage: 'https://provider.example/song'
      }
    ],
    'searchSongs',
    grants
  ) as Array<Record<string, string>>

  assert.equal(protectedTracks[0].cover, 'twilight-media://image/token-1')
  assert.equal(protectedTracks[0].coverSource, 'http://cover.example/art.jpg')
  assert.equal(protectedTracks[0].streamUrl, 'twilight-media://audio/token-2')
  assert.equal(protectedTracks[0].homepage, 'https://provider.example/song')
  assert.equal(
    protectProviderMedia('https://media.example/stream.flac', 'getPlaybackUrl', grants),
    'twilight-media://audio/token-3'
  )
})

test('provider artist and playlist artwork fields use image grants', () => {
  const grants = new RemoteMediaGrantService({
    createToken: (() => {
      let index = 0
      return () => `artwork-${++index}`
    })()
  })

  const protectedMedia = protectProviderMedia(
    {
      picUrl: 'https://cover.example/artist.jpg',
      avatarUrl: 'https://cover.example/avatar.jpg',
      coverImgUrl: 'https://cover.example/playlist.jpg',
      blurPicUrl: 'https://cover.example/album.jpg'
    },
    'searchArtists',
    grants
  ) as Record<string, string>

  assert.deepEqual(protectedMedia, {
    picUrl: 'twilight-media://image/artwork-1',
    picUrlSource: 'https://cover.example/artist.jpg',
    avatarUrl: 'twilight-media://image/artwork-2',
    avatarUrlSource: 'https://cover.example/avatar.jpg',
    coverImgUrl: 'twilight-media://image/artwork-3',
    blurPicUrl: 'twilight-media://image/artwork-4'
  })
})

test('remote media grants reject credentials, wrong kinds, and malformed tokens', () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'cover-token' })
  assert.throws(
    () => grants.grant('https://user:secret@media.example/file', 'audio'),
    /credentials/
  )

  const granted = grants.grant('https://cover.example/art.jpg', 'image')
  assert.throws(() => grants.resolve(granted, 'audio'), /kind/)
  assert.throws(() => grants.resolve('twilight-media://image/not-issued', 'image'), /unknown/)
})

test('remote media proxy forwards only valid range requests without credentials', async () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'audio-token' })
  const granted = grants.grant('https://media.example/private.flac', 'audio')
  const requests: Array<{ source: string; init: RequestInit }> = []
  const handler = createRemoteMediaRequestHandler({
    grants,
    fetch: async (source, init) => {
      requests.push({ source, init })
      return new Response('audio', {
        headers: { 'content-type': 'audio/flac', 'content-length': '5' }
      })
    }
  })

  const response = await handler(new Request(granted, { headers: { Range: 'bytes=0-4' } }))

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'audio')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].source, 'https://media.example/private.flac')
  const requestHeaders = new Headers(requests[0].init.headers)
  assert.equal(requestHeaders.get('range'), 'bytes=0-4')
  assert.match(requestHeaders.get('user-agent') ?? '', /Mozilla\/5\.0/)
  assert.equal(requests[0].init.credentials, 'omit')
  assert.equal(requests[0].init.redirect, 'manual')
  // Canvas cover-theme sampling loads grants with crossOrigin=anonymous.
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD')
  const invalidRange = await handler(new Request(granted, { headers: { Range: 'bytes=0-1,3-4' } }))
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('access-control-allow-origin'), '*')
})

test('remote media proxy follows same-policy CDN redirects for cover images', async () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'cover-token' })
  const granted = grants.grant('https://p1.music.126.net/album.jpg', 'image')
  const requests: Array<{ source: string; referer: string | null }> = []
  const handler = createRemoteMediaRequestHandler({
    grants,
    fetch: async (source, init) => {
      requests.push({
        source,
        referer: new Headers(init.headers).get('referer')
      })
      if (source === 'https://p1.music.126.net/album.jpg') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://p2.music.126.net/edge/album.jpg' }
        })
      }
      return new Response('jpeg-bytes', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '10' }
      })
    }
  })

  const response = await handler(new Request(granted))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'jpeg-bytes')
  assert.deepEqual(
    requests.map((entry) => entry.source),
    ['https://p1.music.126.net/album.jpg', 'https://p2.music.126.net/edge/album.jpg']
  )
  // NetEase CDN hosts need a music.163.com Referer or they return 403 HTML.
  assert.ok(requests.every((entry) => entry.referer === 'https://music.163.com/'))
})

test('remote media audio proxy accepts missing or generic CDN content types', async () => {
  const grants = new RemoteMediaGrantService({
    createToken: (() => {
      let index = 0
      return () => `audio-ct-${++index}`
    })()
  })
  const cases: Array<{ contentType?: string | null; body: string }> = [
    // Explicit empty content-type (string body would otherwise default to text/plain).
    { contentType: '', body: 'flac-bytes' },
    { contentType: 'application/octet-stream', body: 'mp3-bytes' },
    { contentType: 'video/mp4', body: 'm4a-bytes' }
  ]
  for (const entry of cases) {
    const granted = grants.grant(`https://m701.music.126.net/${entry.body}`, 'audio')
    const handler = createRemoteMediaRequestHandler({
      grants,
      fetch: async (_source, init) => {
        const headers = new Headers(init.headers)
        assert.match(headers.get('user-agent') ?? '', /Mozilla\/5\.0/)
        assert.equal(headers.get('referer'), 'https://music.163.com/')
        const responseHeaders = new Headers({
          'content-length': String(entry.body.length)
        })
        if (entry.contentType != null) {
          responseHeaders.set('content-type', entry.contentType)
        }
        return new Response(new TextEncoder().encode(entry.body), {
          status: 200,
          headers: responseHeaders
        })
      }
    })
    const response = await handler(new Request(granted))
    assert.equal(response.status, 200, entry.contentType || 'missing content-type')
    assert.equal(await response.text(), entry.body)
  }
})

test('provider media grants accept protocol-relative image URLs', () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'proto-token' })
  const protectedTrack = protectProviderMedia(
    { cover: '//p3.music.126.net/cover.jpg' },
    'searchSongs',
    grants
  ) as Record<string, string>
  assert.equal(protectedTrack.cover, 'twilight-media://image/proto-token')
  assert.equal(protectedTrack.coverSource, 'https://p3.music.126.net/cover.jpg')
  assert.deepEqual(grants.resolve(protectedTrack.cover, 'image'), {
    source: 'https://p3.music.126.net/cover.jpg',
    kind: 'image'
  })
})

test('grantRemoteImageUrl reissues an opaque image grant for durable cover origins', () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'regrant-token' })
  const granted = grantRemoteImageUrl('//p1.music.126.net/cover.jpg', grants)
  assert.equal(granted, 'twilight-media://image/regrant-token')
  assert.deepEqual(grants.resolve(granted, 'image'), {
    source: 'https://p1.music.126.net/cover.jpg',
    kind: 'image'
  })
})

test('default image grants are deterministic but still require an issued token', () => {
  const grants = new RemoteMediaGrantService()
  const first = grants.grant('https://cover.example/art.jpg', 'image')
  const second = grants.grant('https://cover.example/art.jpg', 'image')
  assert.equal(first, second)
  assert.deepEqual(grants.resolve(first, 'image'), {
    source: 'https://cover.example/art.jpg',
    kind: 'image'
  })
  assert.throws(() => grants.resolve('twilight-media://image/img-not-issued', 'image'), /unknown/)
})

test('remote media proxy refuses credentialed redirect targets and oversized responses without exposing origins', async () => {
  const grants = new RemoteMediaGrantService({ createToken: () => 'cover-token' })
  const granted = grants.grant('https://cover.example/secret-art.jpg', 'image')
  const redirectHandler = createRemoteMediaRequestHandler({
    grants,
    fetch: async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://user:secret@evil.example/steal' }
      })
  })
  const redirected = await redirectHandler(new Request(granted))
  assert.equal(redirected.status, 502)
  assert.doesNotMatch(await redirected.text(), /cover\.example|evil\.example|secret/)

  const oversizedHandler = createRemoteMediaRequestHandler({
    grants,
    fetch: async () =>
      new Response('too large', {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(25 * 1024 * 1024 + 1) }
      })
  })
  const oversized = await oversizedHandler(new Request(granted))
  assert.equal(oversized.status, 413)
})
