'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** Top-level files allowed under out/renderer/font after packaging. */
const ALLOWED_PUBLIC_FONTS = new Set([
  'Inter-latin-wght-normal.woff2',
  'Inter-latin-ext-wght-normal.woff2',
  'PlusJakartaSans-latin-wght-normal.woff2',
  'PlusJakartaSans-latin-ext-wght-normal.woff2',
  'Lora-latin-wght-normal.woff2',
  'JetBrainsMono-latin-wght-normal.woff2',
  'SpaceGrotesk-latin-wght-normal.woff2',
  'OFL-Inter.txt',
  'OFL-PlusJakartaSans.txt',
  'OFL-Lora.txt',
  'OFL-JetBrainsMono.txt',
  'OFL-SpaceGrotesk.txt'
])

// Numeric CJK chunks + named script subsets (latin/cyrillic/vietnamese/...).
const MISANS_FILE_RE = /^(MiSans-(Regular|Medium|Bold|Heavy)\.[\w-]+\.woff2|misans\.css|LICENSE)$/i
// Optional full faces + docs under font/misans/full/
const MISANS_FULL_FILE_RE =
  /^(MiSans-(Regular|Medium|Bold|Heavy)\.woff2|misans-full\.css|README\.md)$/i

function stripRendererFontAssets(rendererDir) {
  const assets = path.join(rendererDir, 'assets')
  if (fs.existsSync(assets)) {
    for (const name of fs.readdirSync(assets)) {
      // Drop unused historical Outfit/Nunito embeds and non-WOFF2 Phosphor fallbacks.
      if (
        /^Outfit-.*\.woff2$/i.test(name) ||
        /^Nunito.*\.woff2$/i.test(name) ||
        /^Phosphor-.*\.(woff|ttf)$/i.test(name)
      ) {
        fs.rmSync(path.join(assets, name), { force: true })
      }
    }
  }

  const publicFontDir = path.join(rendererDir, 'font')
  if (!fs.existsSync(publicFontDir)) return

  // Remove legacy public fonts if still copied from resources.
  for (const legacy of [
    'Outfit-VariableFont_wght.woff2',
    'Nunito-latin-wght-normal.woff2',
    'Nunito-latin-ext-wght-normal.woff2',
    'NunitoSans-latin-wght-normal.woff2',
    'NunitoSans-latin-ext-wght-normal.woff2',
    'OFL-Nunito.txt',
    'OFL-NunitoSans.txt'
  ]) {
    fs.rmSync(path.join(publicFontDir, legacy), { force: true })
  }

  for (const name of fs.readdirSync(publicFontDir)) {
    const full = path.join(publicFontDir, name)
    const stat = fs.statSync(full)
    if (name === 'misans' && stat.isDirectory()) {
      for (const child of fs.readdirSync(full)) {
        const childPath = path.join(full, child)
        if (child === 'full' && fs.statSync(childPath).isDirectory()) {
          for (const fullChild of fs.readdirSync(childPath)) {
            if (!MISANS_FULL_FILE_RE.test(fullChild)) {
              fs.rmSync(path.join(childPath, fullChild), { force: true, recursive: true })
            }
          }
          continue
        }
        if (!MISANS_FILE_RE.test(child)) {
          fs.rmSync(childPath, { force: true, recursive: true })
        }
      }
      continue
    }
    if (!ALLOWED_PUBLIC_FONTS.has(name)) {
      fs.rmSync(full, { force: true, recursive: true })
    }
  }
}

if (require.main === module) stripRendererFontAssets(process.argv[2] || 'out/renderer')
module.exports = {
  stripRendererFontAssets,
  ALLOWED_PUBLIC_FONTS,
  MISANS_FILE_RE,
  MISANS_FULL_FILE_RE
}
