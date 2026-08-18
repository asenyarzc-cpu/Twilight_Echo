import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  assertPluginTreeSafe,
  extractPluginPackage,
  isInsidePath,
  MAX_PLUGIN_ENTRY_BYTES,
  resolvePluginFile
} from './packageSecurity.ts'

const require = createRequire(import.meta.url)
const { createZip } = require('../../../packages/create-twilight-plugin/lib/zip.cjs') as {
  createZip: (
    root: string,
    outputFile: string
  ) => Promise<{ fileCount: number; outputFile: string }>
}

test('isInsidePath rejects sibling and absolute relative escapes', () => {
  assert.equal(isInsidePath(join('C:', 'plugin', 'index.mjs'), join('C:', 'plugin')), true)
  assert.equal(isInsidePath(join('C:', 'plugin', '..', 'escape.mjs'), join('C:', 'plugin')), false)
  assert.equal(isInsidePath(join('C:', 'outside.mjs'), join('C:', 'plugin')), false)
})

test('resolvePluginFile only accepts existing files below the plugin root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-resolve-'))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const nested = join(root, 'nested')
  await mkdir(nested, { recursive: true })
  const filePath = join(nested, 'file.txt')
  await writeFile(filePath, 'content', 'utf-8')

  assert.equal(resolvePluginFile(filePath, root), filePath)
  assert.equal(resolvePluginFile(join(root, 'missing.txt'), root), null)
  assert.equal(resolvePluginFile(join(root, '..', 'outside.txt'), root), null)
})

test('extractPluginPackage accepts bounded plugin packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-safe-'))
  const pluginRoot = join(root, 'plugin')
  const packagePath = join(root, 'plugin.tep')
  const extractRoot = join(root, 'extract')
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      id: 'com.example.safe',
      name: 'Safe',
      version: '1.0.0',
      description: 'safe plugin',
      author: 'Example',
      license: 'Apache-2.0',
      type: ['tool'],
      main: 'index.mjs',
      engines: { twilightEcho: '*' },
      apiVersion: 1,
      permissions: []
    }),
    'utf-8'
  )
  await writeFile(join(pluginRoot, 'index.mjs'), 'export function activate() {}', 'utf-8')
  await createZip(pluginRoot, packagePath)

  await extractPluginPackage(packagePath, extractRoot)
  assert.match(await readFile(join(extractRoot, 'plugin.json'), 'utf-8'), /com\.example\.safe/)
})

test('extractPluginPackage rejects zip path traversal before extraction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-zip-slip-'))
  const packagePath = join(root, 'bad.tep')
  await writeFile(packagePath, createStoredZip('../evil.txt', Buffer.from('evil')))

  await assert.rejects(
    () => extractPluginPackage(packagePath, join(root, 'extract')),
    /越界|非法路径|invalid relative path/
  )
})

test('extractPluginPackage rejects oversized declared uncompressed entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-zip-size-'))
  const packagePath = join(root, 'large.tep')
  await writeFile(
    packagePath,
    createStoredZip('plugin.json', Buffer.from('{}'), MAX_PLUGIN_ENTRY_BYTES + 1)
  )

  await assert.rejects(() => extractPluginPackage(packagePath, join(root, 'extract')), /过大/)
})

test('assertPluginTreeSafe rejects symlinks in directory installs', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires elevated privileges in many environments')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-symlink-'))
  await writeFile(join(root, 'plugin.json'), '{}', 'utf-8')
  await import('node:fs/promises').then(({ symlink }) => symlink('/tmp', join(root, 'escape-link')))

  await assert.rejects(() => assertPluginTreeSafe(root), /符号链接/)
})

function createStoredZip(
  fileName: string,
  data: Buffer,
  declaredUncompressedSize = data.byteLength
): Buffer {
  const name = Buffer.from(fileName, 'utf-8')
  const crc = crc32(data)
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0, 6)
  localHeader.writeUInt16LE(0, 8)
  localHeader.writeUInt32LE(0, 10)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(data.byteLength, 18)
  localHeader.writeUInt32LE(declaredUncompressedSize, 22)
  localHeader.writeUInt16LE(name.byteLength, 26)
  localHeader.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(0, 12)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.byteLength, 20)
  central.writeUInt32LE(declaredUncompressedSize, 24)
  central.writeUInt16LE(name.byteLength, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42)

  const centralOffset = localHeader.byteLength + name.byteLength + data.byteLength
  const centralSize = central.byteLength + name.byteLength
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([localHeader, name, data, central, name, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
