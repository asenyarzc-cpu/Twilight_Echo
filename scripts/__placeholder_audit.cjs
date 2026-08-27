'use strict'
// Scratch: which engine-error catalog entries use {detail} vs {reason}.
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')

function entries(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const body = source.slice(source.indexOf('= {') + 3)
  const out = new Map()
  const re = /'([^']+)':\s*(?:\r?\n\s*)?((?:'(?:[^'\\]|\\.)*'\s*\+?\s*(?:\r?\n\s*)?)+)/g
  let m
  while ((m = re.exec(body))) {
    const value = m[2]
      .split(/\s*\+\s*/)
      .map((piece) => piece.trim())
      .filter((piece) => piece.startsWith("'"))
      .map((piece) => piece.slice(1, -1))
      .join('')
    out.set(m[1], value.replace(/\\'/g, "'"))
  }
  return out
}

const zh = entries('src/shared/i18n/messages/zh-CN.ts')
const en = entries('src/shared/i18n/messages/en-US.ts')

const audio = [...zh.keys()].filter((k) => k.startsWith('error.audio.'))
const usesDetail = audio.filter((k) => (zh.get(k) || '').includes('{detail}'))
const usesReason = audio.filter((k) => (zh.get(k) || '').includes('{reason}'))

console.log('error.audio.* entries: ' + audio.length)
console.log('\nusing {detail} (' + usesDetail.length + '):')
for (const k of usesDetail) console.log('  ' + k)
console.log('\nusing {reason} (' + usesReason.length + '):')
for (const k of usesReason) console.log('  ' + k)

// Cross-locale placeholder agreement for these keys.
console.log('\nplaceholder disagreement zh vs en:')
let bad = 0
for (const k of audio) {
  const ph = (s) =>
    [...(s || '').matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1])
      .sort()
      .join(',')
  if (ph(zh.get(k)) !== ph(en.get(k))) {
    console.log(`  ${k}: zh=[${ph(zh.get(k))}] en=[${ph(en.get(k))}]`)
    bad += 1
  }
}
if (bad === 0) console.log('  none')
