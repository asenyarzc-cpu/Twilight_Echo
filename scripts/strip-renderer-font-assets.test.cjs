'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { stripRendererFontAssets } = require('./strip-renderer-font-assets.cjs')

test('strips legacy Outfit/Nunito and non-WOFF2 Phosphor; keeps Inter/Jakarta + MiSans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-font-strip-'))
  try {
    const assets = path.join(root, 'assets')
    const fontDir = path.join(root, 'font')
    const misans = path.join(fontDir, 'misans')
    fs.mkdirSync(assets)
    fs.mkdirSync(misans, { recursive: true })
    for (const n of [
      'Outfit-x.woff2',
      'Nunito-x.woff2',
      'Phosphor-x.woff',
      'Phosphor-x.ttf',
      'Phosphor-x.woff2',
      'primeicons.woff2'
    ]) {
      fs.writeFileSync(path.join(assets, n), 'x')
    }
    fs.writeFileSync(path.join(fontDir, 'Outfit-VariableFont_wght.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'Nunito-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'Inter-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'PlusJakartaSans-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'Lora-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'JetBrainsMono-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'SpaceGrotesk-latin-wght-normal.woff2'), 'x')
    fs.writeFileSync(path.join(fontDir, 'OFL-Inter.txt'), 'x')
    fs.writeFileSync(path.join(fontDir, 'OFL-Lora.txt'), 'x')
    fs.writeFileSync(path.join(fontDir, 'OFL-JetBrainsMono.txt'), 'x')
    fs.writeFileSync(path.join(fontDir, 'OFL-SpaceGrotesk.txt'), 'x')
    fs.writeFileSync(path.join(fontDir, 'stray-font.woff2'), 'x')
    fs.writeFileSync(path.join(misans, 'MiSans-Regular.21.woff2'), 'x')
    fs.writeFileSync(path.join(misans, 'MiSans-Regular.latin.woff2'), 'x')
    fs.writeFileSync(path.join(misans, 'misans.css'), 'x')
    fs.writeFileSync(path.join(misans, 'LICENSE'), 'x')
    fs.writeFileSync(path.join(misans, 'junk.txt'), 'x')
    const misansFull = path.join(misans, 'full')
    fs.mkdirSync(misansFull, { recursive: true })
    fs.writeFileSync(path.join(misansFull, 'misans-full.css'), 'x')
    fs.writeFileSync(path.join(misansFull, 'MiSans-Regular.woff2'), 'x')
    fs.writeFileSync(path.join(misansFull, 'README.md'), 'x')
    fs.writeFileSync(path.join(misansFull, 'junk.bin'), 'x')

    stripRendererFontAssets(root)

    assert.deepEqual(fs.readdirSync(assets).sort(), ['Phosphor-x.woff2', 'primeicons.woff2'])
    assert.deepEqual(fs.readdirSync(fontDir).sort(), [
      'Inter-latin-wght-normal.woff2',
      'JetBrainsMono-latin-wght-normal.woff2',
      'Lora-latin-wght-normal.woff2',
      'OFL-Inter.txt',
      'OFL-JetBrainsMono.txt',
      'OFL-Lora.txt',
      'OFL-SpaceGrotesk.txt',
      'PlusJakartaSans-latin-wght-normal.woff2',
      'SpaceGrotesk-latin-wght-normal.woff2',
      'misans'
    ])
    assert.deepEqual(fs.readdirSync(misans).sort(), [
      'LICENSE',
      'MiSans-Regular.21.woff2',
      'MiSans-Regular.latin.woff2',
      'full',
      'misans.css'
    ])
    assert.deepEqual(fs.readdirSync(misansFull).sort(), [
      'MiSans-Regular.woff2',
      'README.md',
      'misans-full.css'
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
