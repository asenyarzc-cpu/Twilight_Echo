// Minimal PE builder for tests that exercise the release gate and audio-engine
// staging. Both now parse import tables, so fixtures have to be real PE files
// rather than placeholder text.

const PE_OFFSET = 0x80
const OPTIONAL_HEADER_SIZE = 0xf0
const SECTION_RVA = 0x1000
const SECTION_RAW_OFFSET = 0x400

/**
 * @param {object} options
 * @param {string[]} [options.imports] DLL names to expose in the import directory.
 * @param {number} [options.machine] COFF machine type; defaults to AMD64.
 * @param {string} [options.trailer] Text appended after the PE payload so a test
 *   can assert which fixture a file was copied from.
 */
function createMinimalPe(options = {}) {
  const imports = options.imports ?? []
  const trailer = options.trailer ?? ''
  const descriptorBytes = imports.length > 0 ? (imports.length + 1) * 20 : 0
  const nameBytes = imports.reduce((total, name) => total + Buffer.byteLength(name) + 1, 0)
  const payloadEnd = SECTION_RAW_OFFSET + descriptorBytes + nameBytes
  const size = Math.max(0x200, Math.ceil((payloadEnd + Buffer.byteLength(trailer)) / 0x200) * 0x200)
  const buffer = Buffer.alloc(size)
  buffer.write('MZ')
  buffer.writeUInt32LE(PE_OFFSET, 0x3c)
  buffer.write('PE\0\0', PE_OFFSET)

  const coff = PE_OFFSET + 4
  buffer.writeUInt16LE(options.machine ?? 0x8664, coff)
  buffer.writeUInt16LE(imports.length > 0 ? 1 : 0, coff + 2)
  buffer.writeUInt32LE(options.symbolTableOffset || 0, coff + 8)
  buffer.writeUInt32LE(options.symbolCount || 0, coff + 12)
  buffer.writeUInt16LE(OPTIONAL_HEADER_SIZE, coff + 16)

  const optional = coff + 20
  buffer.writeUInt16LE(0x20b, optional)
  const dataDirectory = optional + 112
  buffer.writeUInt32LE(options.debugDirectoryRva || 0, dataDirectory + 8 * 6)
  buffer.writeUInt32LE(options.debugDirectorySize || 0, dataDirectory + 8 * 6 + 4)

  if (imports.length > 0) {
    buffer.writeUInt32LE(SECTION_RVA, dataDirectory + 8)
    buffer.writeUInt32LE(descriptorBytes, dataDirectory + 8 + 4)

    const sectionHeader = optional + OPTIONAL_HEADER_SIZE
    buffer.write('.rdata', sectionHeader)
    buffer.writeUInt32LE(descriptorBytes + nameBytes, sectionHeader + 8)
    buffer.writeUInt32LE(SECTION_RVA, sectionHeader + 12)
    buffer.writeUInt32LE(descriptorBytes + nameBytes, sectionHeader + 16)
    buffer.writeUInt32LE(SECTION_RAW_OFFSET, sectionHeader + 20)

    let nameOffset = SECTION_RAW_OFFSET + descriptorBytes
    imports.forEach((name, index) => {
      const descriptor = SECTION_RAW_OFFSET + index * 20
      buffer.writeUInt32LE(SECTION_RVA + 0x100000, descriptor) // non-zero OriginalFirstThunk
      buffer.writeUInt32LE(SECTION_RVA + (nameOffset - SECTION_RAW_OFFSET), descriptor + 12)
      buffer.writeUInt32LE(SECTION_RVA + 0x200000, descriptor + 16) // non-zero FirstThunk
      buffer.write(name, nameOffset, 'latin1')
      nameOffset += Buffer.byteLength(name) + 1
    })
  }

  if (trailer) buffer.write(trailer, payloadEnd, 'latin1')
  return buffer
}

module.exports = { createMinimalPe }
