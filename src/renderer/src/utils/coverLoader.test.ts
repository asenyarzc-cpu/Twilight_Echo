import assert from 'node:assert/strict'
import test from 'node:test'

const {
  clearCoverCache,
  clearRemoteCoverGrantCache,
  resolveCover
} = (await import(
  new URL('./coverLoader.ts', import.meta.url).href
)) as typeof import('./coverLoader')

test('resolveCover materializes cover:// handles via getCover IPC', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string) => {
          assert.equal(handle, 'cover://abc.jpg')
          return 'data:image/jpeg;base64,abc'
        }
      }
    }
  }

  try {
    assert.equal(await resolveCover('cover://abc.jpg'), 'data:image/jpeg;base64,abc')
    // Cached — second call reuses without requiring IPC again.
    assert.equal(await resolveCover('cover://abc.jpg#t=track'), 'data:image/jpeg;base64,abc')
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover prefers local cover:// over durable coverSource', async () => {
  clearCoverCache()
  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async () => 'data:image/jpeg;base64,local',
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          return 'twilight-media://image/remote'
        }
      }
    }
  }

  try {
    assert.equal(
      await resolveCover('cover://local.jpg', 'https://p1.music.126.net/cover.jpg'),
      'data:image/jpeg;base64,local'
    )
    assert.equal(grants.length, 0)
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover prefers durable coverSource and re-grants remote origins', async () => {
  clearRemoteCoverGrantCache()
  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          return `twilight-media://image/reissued-${grants.length}`
        }
      }
    }
  }

  try {
    // Dead post-restart grant + durable origin → re-grant from origin.
    const restored = await resolveCover(
      'twilight-media://image/expired-token',
      'https://p1.music.126.net/cover.jpg'
    )
    assert.equal(restored, 'twilight-media://image/reissued-1')

    // Cached by origin.
    const again = await resolveCover(
      'twilight-media://image/other-token',
      'https://p1.music.126.net/cover.jpg'
    )
    assert.equal(again, 'twilight-media://image/reissued-1')
    assert.equal(grants.length, 1)

    // Legacy bare https cover (no coverSource) → grant for CSP.
    const bareHttps = await resolveCover('https://p1.music.126.net/legacy.jpg')
    assert.equal(bareHttps, 'twilight-media://image/reissued-2')

    // Source-only row.
    const fromSourceOnly = await resolveCover(null, 'https://p1.music.126.net/only-source.jpg')
    assert.equal(fromSourceOnly, 'twilight-media://image/reissued-3')

    // Live grant without durable origin still displays.
    assert.equal(
      await resolveCover('twilight-media://image/live-token'),
      'twilight-media://image/live-token'
    )
  } finally {
    globalRecord.window = previous
    clearRemoteCoverGrantCache()
  }
})

test('resolveCover falls back to a live handle when re-grant fails', async () => {
  clearRemoteCoverGrantCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        grantRemoteCover: async () => {
          throw new Error('ipc unavailable')
        }
      }
    }
  }

  try {
    assert.equal(
      await resolveCover(
        'twilight-media://image/still-live',
        'https://p1.music.126.net/cover.jpg'
      ),
      'twilight-media://image/still-live'
    )
  } finally {
    globalRecord.window = previous
    clearRemoteCoverGrantCache()
  }
})

test('useCover clears previous art when handle is not immediately displayable', async () => {
  clearCoverCache()
  const { useCover } = (await import(
    new URL('./coverLoader.ts', import.meta.url).href
  )) as typeof import('./coverLoader')
  const { ref, nextTick } = await import('vue')

  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return `data:image/jpeg;base64,${handle.includes('track-a') ? 'a' : 'c'}`
        },
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          await new Promise((resolve) => setTimeout(resolve, 5))
          return `twilight-media://image/new-${grants.length}`
        }
      }
    }
  }

  try {
    const handle = ref<string | null>('cover://track-a.jpg')
    const source = ref<string | null>(null)
    const resolved = useCover(handle, source)
    await nextTick()
    // Local protocol covers clear first, then materialize — never stay on cover://.
    assert.equal(resolved.value, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'data:image/jpeg;base64,a')

    // Switch to a durable-only remote cover (no live handle yet). Must not keep track A.
    handle.value = null
    source.value = 'https://p1.music.126.net/track-b.jpg'
    await nextTick()
    assert.equal(resolved.value, null)

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'twilight-media://image/new-1')

    // Switch to another local handle — previous remote art must not stick.
    handle.value = 'cover://track-c.jpg'
    source.value = null
    await nextTick()
    assert.equal(resolved.value, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'data:image/jpeg;base64,c')
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})
