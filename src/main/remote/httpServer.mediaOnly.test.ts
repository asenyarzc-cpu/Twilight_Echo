import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const httpServerSource = readFileSync(new URL('./httpServer.ts', import.meta.url), 'utf8')
const remoteIpcSource = readFileSync(new URL('./remoteIpc.ts', import.meta.url), 'utf8')
const playerStoreSource = readFileSync(
  new URL('../../renderer/src/stores/usePlayerStore.ts', import.meta.url),
  'utf8'
)

test('remote HTTP server supports mediaOnly bind without full remote surface', () => {
  assert.match(httpServerSource, /mode\?: RemoteServerMode/)
  assert.match(httpServerSource, /mode === 'mediaOnly'/)
  assert.match(httpServerSource, /media_only/)
  // mediaOnly must not advertise PIN / remote URLs as "enabled".
  assert.match(httpServerSource, /enabled: this\.enabled && !mediaOnly/)
  assert.match(
    httpServerSource,
    /pin: this\.enabled && !mediaOnly \? this\.auth\.getPin\(\) : null/
  )
  // mediaOnly request path only serves /media/ tokens.
  assert.match(
    httpServerSource,
    /if \(this\.mode === 'mediaOnly'\) \{[\s\S]*\/media\/[\s\S]*media_only/
  )
  // Mode switches keep media grants (no stop/clear on applyMode).
  assert.match(httpServerSource, /applyMode\(desiredMode\)/)
  assert.match(httpServerSource, /applyMode\(desiredMode: RemoteServerMode\)/)
  assert.match(httpServerSource, /keep cast media grants|Keep cast media grants/i)
})

test('cast binds media-only when remote control is off and tears it down on stopCast', () => {
  assert.match(remoteIpcSource, /ensureCastMediaServer/)
  assert.match(remoteIpcSource, /remoteEnabled[\s\S]*mode: 'full'[\s\S]*mode: 'mediaOnly'/)
  assert.match(remoteIpcSource, /await ensureCastMediaServer\(\)/)
  assert.match(
    remoteIpcSource,
    /remote:stopCast[\s\S]*isMediaOnly\(\)[\s\S]*remoteControlEnabled !== true[\s\S]*server\.stop\(\)/
  )
  // Disabling remote keeps mediaOnly only while a cast session is active.
  assert.match(
    remoteIpcSource,
    /if \(activeCastUsn\) \{\s*await server\.start\(preferredPort, \{ mode: 'mediaOnly' \}\)/
  )
  // Failed cast releases orphan mediaOnly binds.
  assert.match(remoteIpcSource, /releaseOrphanMediaOnlyServer/)
  assert.match(remoteIpcSource, /if \(!castSucceeded\)[\s\S]*releaseOrphanMediaOnlyServer/)
  // Bare cast upstreams cannot target private/loopback hosts.
  assert.match(remoteIpcSource, /isPrivateOrLoopbackHost/)
  assert.match(remoteIpcSource, /Cast media URL host is not authorized/)
})

test('player queue skip re-casts while a cast session is active', () => {
  assert.match(playerStoreSource, /castTargetUsn/)
  assert.match(playerStoreSource, /function playQueueTrack/)
  assert.match(playerStoreSource, /if \(castTargetUsn\.value\) \{[\s\S]*castCurrentTrackToDevice/)
  assert.match(
    playerStoreSource,
    /else if \(castTargetName\.value\) \{[\s\S]*controlCast\?\.\(\{ seek: 0 \}\)/
  )
  assert.match(playerStoreSource, /!castTargetUsn\.value && nativePlaybackActive/)
})

test('remote HTTP server no longer uses CORS wildcard and caps SSE clients', () => {
  // S2: CORS 只回显同源/回环 Origin，不再无条件 `*`。
  assert.match(httpServerSource, /teCorsOrigin/)
  assert.match(httpServerSource, /resolveAllowedOrigin\(/)
  assert.doesNotMatch(httpServerSource, /'access-control-allow-origin': '\*'/)
  // S3: SSE 长连接上限。
  assert.match(httpServerSource, /sseMaxClients/)
  assert.match(httpServerSource, /too_many_event_connections/)
})
