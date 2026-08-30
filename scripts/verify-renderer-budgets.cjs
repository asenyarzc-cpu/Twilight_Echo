'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// fonts: MiSans SC subsets + Latin UI fonts
// cssChunk: the index chunk carries all six preset layout sheets (~11 kB each
// minified); the Solstice Ledger redesign pushed it past 400 kB.
const BUDGETS = Object.freeze({
  jsChunk: 900 * 1024,
  cssChunk: 448 * 1024,
  fonts: 32 * 1024 * 1024
})

function parseArgs(argv) {
  const index = argv.indexOf('--renderer-dir')
  if (index < 0 || !argv[index + 1]) throw new Error('--renderer-dir is required')
  return { rendererDir: path.resolve(argv[index + 1]) }
}

function filesAt(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(root, entry.name)
    return entry.isDirectory() ? filesAt(filePath) : [filePath]
  })
}

function assertRendererBudgets(rendererDir) {
  assert.ok(fs.existsSync(rendererDir), `Renderer directory does not exist: ${rendererDir}`)
  const files = filesAt(rendererDir)
  const assets = files.filter((file) => /[\\/]assets[\\/]/.test(file))
  const indexPath = path.join(rendererDir, 'index.html')
  assert.ok(fs.existsSync(indexPath), `Missing renderer entrypoint: ${indexPath}`)
  const manifest = files.find((file) => /[\\/]\.vite[\\/]manifest\.json$/i.test(file))
  assert.ok(manifest, 'Missing Vite manifest output evidence')
  const manifestValue = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  assert.ok(
    manifestValue && typeof manifestValue === 'object' && Object.keys(manifestValue).length > 0,
    'Vite manifest is empty'
  )
  const jsAssets = assets.filter((file) => /\.js$/i.test(file))
  const cssAssets = assets.filter((file) => /\.css$/i.test(file))
  assert.ok(jsAssets.length > 0, 'Renderer output has no JavaScript assets')
  assert.ok(cssAssets.length > 0, 'Renderer output has no CSS assets')
  for (const file of jsAssets) {
    assert.ok(
      fs.statSync(file).size <= BUDGETS.jsChunk,
      `${path.basename(file)} exceeds JS chunk budget`
    )
  }
  for (const file of cssAssets) {
    assert.ok(
      fs.statSync(file).size <= BUDGETS.cssChunk,
      `${path.basename(file)} exceeds CSS chunk budget`
    )
  }
  const fontBytes = files
    .filter((file) => /\.(woff2?|ttf|otf)$/i.test(file))
    .reduce((total, file) => total + fs.statSync(file).size, 0)
  assert.ok(
    fontBytes <= BUDGETS.fonts,
    `Renderer fonts are ${fontBytes} bytes; budget is ${BUDGETS.fonts}`
  )
  assert.equal(
    files.some((file) => /[\\/]Phosphor-.*\.(woff|ttf)$/i.test(file)),
    false,
    'Renderer retains non-WOFF2 Phosphor fallback fonts'
  )
  assert.equal(
    files.some((file) => /[\\/]Outfit-.*\.woff2$/i.test(file)),
    false,
    'Renderer retains unused Outfit font'
  )
  const publicFontFiles = files.filter((file) => /[\\/]font[\\/]/i.test(file))
  for (const file of publicFontFiles) {
    const rel = path.relative(path.join(rendererDir, 'font'), file).replace(/\\/g, '/')
    const ok =
      /^(Inter|PlusJakartaSans)-latin(-ext)?-wght-normal\.woff2$/i.test(rel) ||
      /^(Lora|JetBrainsMono|SpaceGrotesk)-latin-wght-normal\.woff2$/i.test(rel) ||
      /^OFL-(Inter|PlusJakartaSans|Lora|JetBrainsMono|SpaceGrotesk)\.txt$/i.test(rel) ||
      /^misans\/(MiSans-(Regular|Medium|Bold|Heavy)\.[\w-]+\.woff2|misans\.css|LICENSE)$/i.test(rel)
    assert.ok(ok, `Unexpected public font asset: ${rel}`)
  }
  return { files: files.length, fontBytes, manifest, budgets: BUDGETS }
}

if (require.main === module) {
  try {
    const result = assertRendererBudgets(parseArgs(process.argv.slice(2)).rendererDir)
    console.log(`Renderer budgets verified: ${result.files} files, fonts=${result.fontBytes}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { BUDGETS, assertRendererBudgets, parseArgs }
