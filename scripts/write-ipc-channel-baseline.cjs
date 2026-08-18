'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { buildReport } = require('./ipc-channel-report.cjs')

const ROOT = path.join(__dirname, '..')
const OUTPUT = path.join(ROOT, 'docs', 'audit-evidence', 'ipc-channel-baseline.json')

function unique(values) {
  return [...new Set(values)].sort()
}

function buildSnapshot(report) {
  return {
    mainHandles: unique(report.mainHandles),
    mainOn: unique(report.mainOn),
    preloadInvokes: unique(report.preloadInvokes),
    preloadSends: unique(report.preloadSends),
    preloadEventListeners: unique(report.preloadEventListeners),
    rendererDomains: unique(report.summary.rendererDomains),
    rendererApiUniqueCalls: unique(
      report.rendererApiUses.map((use) => `${use.domain}.${use.action}`)
    )
  }
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, `${JSON.stringify(buildSnapshot(buildReport()), null, 2)}\n`)
console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`)
