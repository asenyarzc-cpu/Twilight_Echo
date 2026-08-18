import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderDownloadTaskSnapshot } from '../../../../shared/providerDownloads.ts'

const { downloadStatusLabel, filterActiveDownloadTasks, formatDownloadProgress } = (await import(
  new URL('./streamingDownloads.ts', import.meta.url).href
)) as typeof import('./streamingDownloads.ts')

function createTask(
  id: string,
  status: ProviderDownloadTaskSnapshot['status'],
  overrides: Partial<ProviderDownloadTaskSnapshot> = {}
): ProviderDownloadTaskSnapshot {
  return {
    id,
    providerId: 'ncm',
    providerJobId: `job-${id}`,
    track: { id, title: `Track ${id}`, artist: 'Artist' },
    requestedQuality: 'lossless',
    actualQuality: null,
    status,
    progress: 0,
    queuePosition: null,
    targetPath: null,
    fileSize: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

test('active download tasks exclude completed and cancelled snapshots', () => {
  const tasks = [
    createTask('queued', 'queued'),
    createTask('preparing', 'preparing'),
    createTask('downloading', 'downloading'),
    createTask('completed', 'completed'),
    createTask('failed', 'failed'),
    createTask('cancelled', 'cancelled')
  ]

  assert.deepEqual(
    filterActiveDownloadTasks(tasks).map((task) => task.id),
    ['queued', 'preparing', 'downloading', 'failed']
  )
})

test('download progress formatting rounds to a whole percentage', () => {
  assert.equal(formatDownloadProgress(0), '0%')
  assert.equal(formatDownloadProgress(0.334), '33%')
  assert.equal(formatDownloadProgress(1), '100%')
})

test('download status labels preserve queue position and live progress', () => {
  assert.equal(downloadStatusLabel(createTask('q1', 'queued')), '排队中')
  assert.equal(downloadStatusLabel(createTask('q2', 'queued', { queuePosition: 3 })), '排队中 #3')
  assert.equal(downloadStatusLabel(createTask('preparing', 'preparing')), '准备中')
  assert.equal(
    downloadStatusLabel(createTask('downloading', 'downloading', { progress: 0.5 })),
    '下载中 50%'
  )
  assert.equal(downloadStatusLabel(createTask('done', 'completed')), '已完成')
  assert.equal(downloadStatusLabel(createTask('failed', 'failed')), '失败')
  assert.equal(downloadStatusLabel(createTask('cancelled', 'cancelled')), '已取消')
})
