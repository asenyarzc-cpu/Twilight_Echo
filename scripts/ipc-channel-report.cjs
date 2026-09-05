'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

const IPC_CONSTANTS = (() => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'ipcChannels.ts'), 'utf8')
  const map = new Map()
  let domain = null
  for (const line of source.split('\n')) {
    const domainMatch = line.match(/^ {2}(\w+): \{/)
    if (domainMatch) {
      domain = domainMatch[1]
      continue
    }
    // Source files are commonly checked out with CRLF on Windows; tolerate
    // the carriage return so IPC.* references resolve consistently.
    const entry = line.match(/^ {4}(\w+): '([^']+)',?\s*$/)
    if (entry && domain) map.set(`IPC.${domain}.${entry[1]}`, entry[2])
  }
  return map
})()

function resolveChannelReference(ref) {
  if (typeof ref !== 'string') return ref
  if (!ref.startsWith('IPC.')) return ref
  const channel = IPC_CONSTANTS.get(ref)
  if (!channel) throw new Error(`Unknown IPC channel constant reference: ${ref}`)
  return channel
}

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...walk(full))
    } else if (/\.(?:ts|vue|cjs|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

function readAll(files) {
  return files.map((file) => ({ file, rel: rel(file), source: fs.readFileSync(file, 'utf8') }))
}

function lineNumber(source, matchIndex) {
  return source.slice(0, matchIndex).split('\n').length
}

function collectMain(entries) {
  const out = []
  const patterns = [
    /(?:ipcMain|\bipc)\.(handle|on)\s*\(\s*['"]\s*([^'"]+)['"]\s*,/g,
    /(?:ipcMain|\bipc)\.(handle|on)\(\s*`([^`]+)`\s*,/g,
    /(?:ipcMain|\bipc)\.(handle|on)\s*\(\s*(IPC\.[\w.]+)\s*,/g
  ]
  for (const { rel: r, source } of entries) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (source.slice(Math.max(0, match.index - 12), match.index).endsWith('ver')) continue
        const channel = resolveChannelReference(match[2] ?? match[3])
        out.push({ channel, kind: match[1], file: r, line: lineNumber(source, match.index) })
      }
    }
  }
  out.sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file))
  return out
}

function collectPreloadInvoke(entries) {
  const out = []
  const patterns = [
    /ipcRenderer\.invoke\s*\(\s*['"]\s*([^'"]+)['"]\s*[,)]/g,
    /ipcRenderer\.invoke\(\s*`([^`]+)`\s*[,)]/g,
    /invoke(?:Optional)?VersionedDataWrite\s*\(\s*['"]\s*([^'"]+)['"]\s*,/g,
    /ipcRenderer\.invoke\s*\(\s*(IPC\.[\w.]+)\s*[,)]/g
  ]
  for (const { rel: r, source } of entries) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const channel = resolveChannelReference(match[1] ?? match[2])
        if (channel) out.push({ channel, file: r, line: lineNumber(source, match.index) })
      }
    }
  }
  out.sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file))
  return out
}

function collectPreloadSend(entries) {
  const out = []
  const patterns = [
    /ipcRenderer\.send\s*\(\s*['"]\s*([^'"]+)['"]\s*,/g,
    /ipcRenderer\.send\(\s*`([^`]+)`\s*,/g,
    /ipcRenderer\.send\s*\(\s*(IPC\.[\w.]+)\s*,/g
  ]
  for (const { rel: r, source } of entries) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const channel = resolveChannelReference(match[1] ?? match[2])
        if (channel) out.push({ channel, file: r, line: lineNumber(source, match.index) })
      }
    }
  }
  out.sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file))
  return out
}

function collectPreloadEvents(entries) {
  const out = []
  const patterns = [
    /ipcRenderer\.on\s*\(\s*['"]\s*([^'"]+)['"]\s*,/g,
    /ipcRenderer\.on\(\s*`([^`]+)`\s*,/g,
    /ipcRenderer\.on\s*\(\s*(IPC\.[\w.]+)\s*,/g
  ]
  for (const { rel: r, source } of entries) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const channel = resolveChannelReference(match[1] ?? match[2])
        if (channel) out.push({ channel, file: r, line: lineNumber(source, match.index) })
      }
    }
  }
  out.sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file))
  return out
}

function collectRendererApiUses(entries) {
  const out = []
  const regex = /window\.api\.([\w]+)\.([\w]+)/g
  for (const { rel: r, source } of entries) {
    for (const match of source.matchAll(regex)) {
      out.push({
        domain: match[1],
        action: match[2],
        file: r,
        line: lineNumber(source, match.index)
      })
    }
  }
  out.sort(
    (a, b) =>
      a.domain.localeCompare(b.domain) ||
      a.action.localeCompare(b.action) ||
      a.file.localeCompare(b.file)
  )
  return out
}

function unique(items) {
  return [...new Set(items)].sort()
}

function buildReport() {
  const mainEntries = readAll(walk(path.join(ROOT, 'src', 'main')))
  const preloadEntries = readAll(walk(path.join(ROOT, 'src', 'preload')))
  const rendererEntries = readAll(walk(path.join(ROOT, 'src', 'renderer')))

  const mainItems = collectMain(mainEntries)
  const invokeItems = collectPreloadInvoke(preloadEntries)
  const sendItems = collectPreloadSend(preloadEntries)
  const eventItems = collectPreloadEvents(preloadEntries)
  const rendererUses = collectRendererApiUses(rendererEntries)

  const mainHandleSet = new Set(mainItems.filter((i) => i.kind === 'handle').map((i) => i.channel))
  const mainOnSet = new Set(mainItems.filter((i) => i.kind === 'on').map((i) => i.channel))
  const invokeChannels = unique(invokeItems.map((i) => i.channel))
  const preloadInvokeMissingMain = invokeChannels
    .filter((c) => !mainHandleSet.has(c) && !mainOnSet.has(c))
    .sort()

  const rendererDomains = unique(rendererUses.map((i) => i.domain))
  const knownPreloadDomains = [
    'sleepTimer',
    'systemMedia',
    'window',
    'dialog',
    'shell',
    'discord',
    'library',
    'fs',
    'audioEngine',
    'bpmAnalysis',
    'loudnessAnalysis',
    'opra',
    'app',
    'ncm',
    'ncmCloud',
    'radio',
    'podcast',
    'networkSources',
    'remote',
    'data',
    'settings',
    'fonts',
    'themes',
    'plugins',
    'providers',
    'providerDownloads',
    'extensions',
    'desktopLyrics',
    'miniPlayer',
    'trayPlayer',
    'debug'
  ]
  const rendererDomainsMissing = rendererDomains
    .filter((d) => !knownPreloadDomains.includes(d))
    .sort()

  return {
    summary: {
      mainHandles: mainHandleSet.size,
      mainOn: mainOnSet.size,
      preloadInvokes: invokeChannels.length,
      preloadSends: unique(sendItems.map((i) => i.channel)).length,
      preloadEventListeners: unique(eventItems.map((i) => i.channel)).length,
      rendererApiUses: rendererUses.length,
      rendererApiUniqueCalls: unique(rendererUses.map((u) => u.domain + '.' + u.action)).length,
      rendererDomains,
      rendererDomainsMissingPreload: rendererDomainsMissing,
      preloadInvokeMissingMain
    },
    mainHandles: mainItems
      .filter((i) => i.kind === 'handle')
      .map((i) => i.channel)
      .sort(),
    mainOn: mainItems
      .filter((i) => i.kind === 'on')
      .map((i) => i.channel)
      .sort(),
    preloadInvokes: invokeChannels,
    preloadSends: unique(sendItems.map((i) => i.channel)).sort(),
    preloadEventListeners: unique(eventItems.map((i) => i.channel)).sort(),
    rendererApiUses: rendererUses
  }
}

function buildDetailedReport() {
  const mainEntries = readAll(walk(path.join(ROOT, 'src', 'main')))
  const preloadEntries = readAll(walk(path.join(ROOT, 'src', 'preload')))
  const rendererEntries = readAll(walk(path.join(ROOT, 'src', 'renderer')))

  return {
    main: collectMain(mainEntries),
    preloadInvokes: collectPreloadInvoke(preloadEntries),
    preloadSends: collectPreloadSend(preloadEntries),
    preloadEvents: collectPreloadEvents(preloadEntries),
    rendererApiUses: collectRendererApiUses(rendererEntries)
  }
}

function printTables(report) {
  const line = (cells) => cells.join(' | ')
  const s = report.summary
  console.log('')
  console.log('## IPC channel report')
  console.log('')
  console.log(line(['metric', 'count']))
  console.log(line(['---', '---']))
  console.log(line(['main ipcMain.handle (incl ipc wrapper via sleepTimerIpc)', s.mainHandles]))
  console.log(line(['main ipcMain.on', s.mainOn]))
  console.log(line(['preload invoke channels', s.preloadInvokes]))
  console.log(line(['preload send channels', s.preloadSends]))
  console.log(line(['preload event listeners', s.preloadEventListeners]))
  console.log(line(['renderer window.api call sites', s.rendererApiUses]))
  console.log(line(['renderer unique domain.action', s.rendererApiUniqueCalls]))
  console.log(line(['preload invoke missing main', s.preloadInvokeMissingMain.length]))
  console.log(line(['renderer domains missing preload', s.rendererDomainsMissingPreload.length]))
  console.log('')
  if (s.preloadInvokeMissingMain.length) {
    console.log('### Preload invoke channels with no main handle/on')
    for (const c of s.preloadInvokeMissingMain) console.log('- ' + c)
  }
  if (s.rendererDomainsMissingPreload.length) {
    console.log('### Renderer domains with no preload domain')
    for (const c of s.rendererDomainsMissingPreload) console.log('- ' + c)
  }
  console.log('### Main handles')
  console.log('')
  console.log(line(['channel']))
  for (const c of report.mainHandles) console.log(line([c]))
  console.log('')
  console.log('### Preload invoke channels')
  console.log('')
  console.log(line(['channel']))
  for (const c of report.preloadInvokes) console.log(line([c]))
  console.log('')
  console.log('### Renderer domains')
  console.log('')
  console.log(line(['domain', 'actions']))
  const byDomain = new Map()
  for (const use of report.rendererApiUses) {
    if (!byDomain.has(use.domain)) byDomain.set(use.domain, new Set())
    byDomain.get(use.domain).add(use.action)
  }
  for (const domain of [...byDomain.keys()].sort()) {
    console.log(line([domain, [...byDomain.get(domain)].sort().join(', ')]))
  }
}

if (require.main === module) {
  const report = buildReport()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printTables(report)
  }
}

module.exports = { buildReport, buildDetailedReport }
