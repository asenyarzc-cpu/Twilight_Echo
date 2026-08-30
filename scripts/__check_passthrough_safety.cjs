'use strict'
// Scratch: make sure no already-localized catalog string is accidentally
// reclassified by presentError's platform-English heuristics. A false positive
// would replace correct copy with a generic "network failed" message.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

const NETWORK =
  /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|timed? ?out/i
const UNAUTH = /\b(?:401|403)\b|unauthoriz|forbidden|need login|not login/i
const RATE = /\b429\b|too many requests/i
const HAS_CJK = /[一-鿿]/

function parse(file) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const out = {}
  const re =
    /^\s*'([^']+)':\s*$|^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$|^\s*'((?:[^'\\]|\\.)*)',?\s*$/gm
  let pending = null
  for (const line of src.split(/\r?\n/)) {
    const keyOnly = /^\s*'([^']+)':\s*$/.exec(line)
    if (keyOnly) {
      pending = keyOnly[1]
      continue
    }
    const kv = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(line)
    if (kv) {
      out[kv[1]] = kv[2]
      pending = null
      continue
    }
    if (pending) {
      const v = /^\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(line)
      if (v) {
        out[pending] = v[1]
        pending = null
      }
    }
  }
  void re
  return out
}

const en = parse('src/shared/i18n/messages/en-US.ts')
const zh = parse('src/shared/i18n/messages/zh-CN.ts')

// Only entries that can reach setAudioEngineError as a finished sentence matter.
const REACHABLE = Object.keys(en).filter((k) => k.startsWith('error.'))

const collisions = []
for (const key of REACHABLE) {
  const value = en[key]
  if (typeof value !== 'string') continue
  const hits = []
  // The intentional network/auth/rate entries are supposed to match themselves.
  if (key.startsWith('error.network.')) continue
  if (NETWORK.test(value)) hits.push('NETWORK')
  if (UNAUTH.test(value)) hits.push('UNAUTHORIZED')
  if (RATE.test(value)) hits.push('RATE_LIMIT')
  if (hits.length > 0) collisions.push(`${key} -> ${hits.join(',')}  "${value}"`)
}

console.log('English error.* entries checked:', REACHABLE.length)
console.log('\nAccidental platform-pattern collisions (would be misclassified):')
if (collisions.length === 0) console.log('  none')
else for (const c of collisions) console.log('  ' + c)

// zh-CN entries all contain CJK, so they short-circuit on HAS_CJK before ever
// reaching the platform patterns. Confirm that assumption holds.
const zhNoCjk = Object.entries(zh)
  .filter(([k]) => k.startsWith('error.'))
  .filter(([, v]) => typeof v === 'string' && v.trim() && !HAS_CJK.test(v))
console.log('\nzh-CN error.* entries WITHOUT any CJK (would fall through to heuristics):')
if (zhNoCjk.length === 0) console.log('  none')
else for (const [k, v] of zhNoCjk) console.log(`  ${k} = "${v}"`)
