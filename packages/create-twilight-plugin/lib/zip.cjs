const fs = require('node:fs/promises')
const path = require('node:path')

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache', '.vite'])
const EXCLUDED_SUFFIXES = ['.tsbuildinfo', '.log', '.tmp', '.temp']

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUInt16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

function msDosDateTime(date) {
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosDate, dosTime }
}

async function collectFiles(root) {
  const files = []

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute)
      const parts = relative.split(path.sep)
      if (parts.some((part) => EXCLUDED_DIRS.has(part))) continue
      if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        files.push({ absolute, relative: relative.split(path.sep).join('/') })
      }
    }
  }

  await walk(root)
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

async function createZip(root, outputFile) {
  const files = await collectFiles(root)
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const data = await fs.readFile(file.absolute)
    const stat = await fs.stat(file.absolute)
    const name = Buffer.from(file.relative, 'utf-8')
    const checksum = crc32(data)
    const { dosDate, dosTime } = msDosDateTime(stat.mtime)
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(data.length),
      writeUInt32(data.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name
    ])
    chunks.push(localHeader, data)
    central.push(
      Buffer.concat([
        writeUInt32(0x02014b50),
        writeUInt16(20),
        writeUInt16(20),
        writeUInt16(0x0800),
        writeUInt16(0),
        writeUInt16(dosTime),
        writeUInt16(dosDate),
        writeUInt32(checksum),
        writeUInt32(data.length),
        writeUInt32(data.length),
        writeUInt16(name.length),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(0),
        writeUInt32(offset),
        name
      ])
    )
    offset += localHeader.length + data.length
  }

  const centralOffset = offset
  const centralDirectory = Buffer.concat(central)
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(files.length),
    writeUInt16(files.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(centralOffset),
    writeUInt16(0)
  ])
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, Buffer.concat([...chunks, centralDirectory, end]))
  return { fileCount: files.length, outputFile }
}

module.exports = { createZip, collectFiles }
