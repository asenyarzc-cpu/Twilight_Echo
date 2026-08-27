import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertOwnedGrant,
  cancelOwnedTransfer,
  commitDownloadedFile,
  fetchCloudDownloadResponse,
  normalizeCloudSongId,
  normalizeTransferUrl,
  reserveExclusiveResource,
  resolveCloudDownloadRedirect,
  sanitizeDownloadFileName,
  temporaryDownloadPath
} from './cloudTransferHelpers.ts'

describe('sanitizeDownloadFileName', () => {
  it('replaces Windows-illegal characters and trims trailing dots and spaces', () => {
    assert.equal(sanitizeDownloadFileName('A<B>:C"D/E\\F|G?H*.flac.  '), 'A_B__C_D_E_F_G_H_.flac')
  })

  it('replaces Windows reserved device names while preserving a safe extension', () => {
    assert.equal(sanitizeDownloadFileName('CON.mp3'), '网易云云盘歌曲.mp3')
    assert.equal(sanitizeDownloadFileName('lpt9.flac'), '网易云云盘歌曲.flac')
  })

  it('provides a fallback for blank values and limits the final name length', () => {
    assert.equal(sanitizeDownloadFileName('   ...'), '网易云云盘歌曲')
    assert.equal(sanitizeDownloadFileName(`${'a'.repeat(300)}.mp3`).length, 255)
  })
})

describe('normalizeCloudSongId', () => {
  it('accepts positive numeric and opaque printable string identifiers', () => {
    assert.equal(normalizeCloudSongId(9007199254740991), '9007199254740991')
    assert.equal(normalizeCloudSongId(' cloud-77 '), 'cloud-77')
  })

  it('rejects unsafe numeric and non-printable identifiers', () => {
    assert.throws(() => normalizeCloudSongId(0), /required/)
    assert.throws(() => normalizeCloudSongId(Number.MAX_SAFE_INTEGER + 1), /required/)
    assert.throws(() => normalizeCloudSongId('cloud\n77'), /invalid characters/)
    assert.throws(() => normalizeCloudSongId('云盘-77'), /invalid characters/)
  })
})

describe('cloud transfer ownership and exclusivity', () => {
  it('rejects missing, foreign, and expired file grants', () => {
    assert.throws(() => assertOwnedGrant(undefined, 7, 100), /凭证已失效/)
    assert.throws(() => assertOwnedGrant({ ownerId: 8, expiresAt: 200 }, 7, 100), /凭证已失效/)
    assert.throws(() => assertOwnedGrant({ ownerId: 7, expiresAt: 100 }, 7, 100), /凭证已失效/)
    assert.doesNotThrow(() => assertOwnedGrant({ ownerId: 7, expiresAt: 101 }, 7, 100))
  })

  it('holds an exclusive resource until its idempotent release', () => {
    const resources = new Set<string>()
    const release = reserveExclusiveResource(resources, 'same-file', 'duplicate')
    assert.throws(() => reserveExclusiveResource(resources, 'same-file', 'duplicate'), /duplicate/)
    release()
    release()
    assert.equal(resources.has('same-file'), false)
    assert.doesNotThrow(() => reserveExclusiveResource(resources, 'same-file', 'duplicate'))
  })

  it('only allows a transfer owner to cancel', () => {
    const reasons: unknown[] = []
    const transfer = {
      ownerId: 7,
      controller: { abort: (reason?: unknown) => reasons.push(reason) }
    }
    assert.equal(cancelOwnedTransfer(transfer, 8, new Error('foreign')), false)
    assert.equal(reasons.length, 0)
    assert.equal(cancelOwnedTransfer(transfer, 7, new Error('cancelled')), true)
    assert.equal((reasons[0] as Error).message, 'cancelled')
  })
})

describe('cloud transfer URL policy', () => {
  it('accepts HTTP(S) URLs without embedded credentials only', () => {
    assert.equal(normalizeTransferUrl('https://cdn.example/song.flac', '地址').protocol, 'https:')
    assert.throws(() => normalizeTransferUrl('file:///tmp/song.flac', '地址'), /协议无效/)
    assert.throws(
      () => normalizeTransferUrl('https://user:pass@example/song.flac', '地址'),
      /URL 凭据/
    )
  })

  it('resolves safe redirects and rejects HTTPS downgrade', () => {
    const current = new URL('https://cdn.example/path/song.flac')
    assert.equal(
      resolveCloudDownloadRedirect(current, '../edge/song.flac').toString(),
      'https://cdn.example/edge/song.flac'
    )
    assert.throws(
      () => resolveCloudDownloadRedirect(current, 'http://cdn.example/song.flac'),
      /不允许从 HTTPS 降级/
    )
  })

  it('follows a bounded credential-free redirect chain', async () => {
    const calls: Array<{ source: string; init: RequestInit }> = []
    const response = await fetchCloudDownloadResponse(
      'https://origin.example/song.flac',
      new AbortController().signal,
      async (input, init) => {
        const source = input.toString()
        calls.push({ source, init: init ?? {} })
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://edge.example/song.flac' }
          })
        }
        return new Response('audio', { status: 200 })
      }
    )
    assert.equal(response.status, 200)
    assert.deepEqual(
      calls.map((call) => call.source),
      ['https://origin.example/song.flac', 'https://edge.example/song.flac']
    )
    assert.equal(calls[0].init.redirect, 'manual')
    assert.equal(calls[0].init.credentials, 'omit')
  })

  it('rejects redirect loops and missing locations', async () => {
    await assert.rejects(
      fetchCloudDownloadResponse(
        'https://origin.example/song.flac',
        new AbortController().signal,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://origin.example/song.flac' }
          })
      ),
      /形成循环/
    )
    await assert.rejects(
      fetchCloudDownloadResponse(
        'https://origin.example/song.flac',
        new AbortController().signal,
        async () => new Response(null, { status: 302 })
      ),
      /缺少 Location/
    )
  })
})

describe('cloud download file commit', () => {
  it('places temporary files beside the final target', () => {
    assert.equal(
      temporaryDownloadPath('C:\\Music\\song.flac', 'transfer-1'),
      'C:\\Music\\.song.flac.twilight-part-transfer-1'
    )
  })

  it('commits a new file with a same-directory rename', async () => {
    const operations: string[] = []
    await commitDownloadedFile('temp', 'target', 'backup', {
      exists: async () => false,
      rename: async (source, target) => {
        operations.push(`rename:${source}:${target}`)
      },
      remove: async (path) => {
        operations.push(`remove:${path}`)
      }
    })
    assert.deepEqual(operations, ['rename:temp:target'])
  })

  it('backs up and replaces an existing target', async () => {
    const operations: string[] = []
    await commitDownloadedFile('temp', 'target', 'backup', {
      exists: async () => true,
      rename: async (source, target) => {
        operations.push(`rename:${source}:${target}`)
      },
      remove: async (path) => {
        operations.push(`remove:${path}`)
      }
    })
    assert.deepEqual(operations, ['rename:target:backup', 'rename:temp:target', 'remove:backup'])
  })

  it('restores an existing target when committing the temporary file fails', async () => {
    const operations: string[] = []
    await assert.rejects(
      commitDownloadedFile('temp', 'target', 'backup', {
        exists: async () => true,
        rename: async (source, target) => {
          operations.push(`rename:${source}:${target}`)
          if (source === 'temp') throw new Error('commit failed')
        },
        remove: async (path) => {
          operations.push(`remove:${path}`)
        }
      }),
      /commit failed/
    )
    assert.deepEqual(operations, [
      'rename:target:backup',
      'rename:temp:target',
      'rename:backup:target'
    ])
  })
})
