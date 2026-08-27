const fs = require('node:fs')
const path = require('node:path')

// Hardware surfaces must pass with artifacts for coverage.complete.
const REQUIRED_SURFACES = ['WASAPI Exclusive', 'ASIO', 'DoP DAC', 'Native DSD', 'SACD ISO']

// Product honesty surfaces: always listed; default not-run until maintainer records evidence.
// They do NOT gate coverage.complete (still 5/5 hardware surfaces).
const OPTIONAL_PRODUCT_SURFACES = ['Loudnorm', 'Gapless Album', 'Unity Volume']

const ALL_REPORTED_SURFACES = [...REQUIRED_SURFACES, ...OPTIONAL_PRODUCT_SURFACES]

const SURFACE_COLLECTION_GUIDES = {
  'WASAPI Exclusive': {
    command:
      'pnpm run smoke:wasapi -- --device "<wasapi-endpoint>" --buffer 256 --format-matrix --json > output/audio-smoke-evidence/wasapi-exclusive.json',
    artifact: 'output/audio-smoke-evidence/wasapi-exclusive.json',
    evidence:
      'actualBackend=wasapi-exclusive, exclusive=true, actual output format facts, and outputPerfect/perfectReason for every probed PCM format'
  },
  ASIO: {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend asio --device "<asio-driver>" --json > output/audio-smoke-evidence/asio-pcm.json',
    artifact: 'output/audio-smoke-evidence/asio-pcm.json',
    evidence:
      'actualBackend=asio, selected driver/device, actual output format facts, and explicit pass/fail reason'
  },
  'DoP DAC': {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<dsd-fixtures>" --playback --backend wasapi-exclusive --device "<dop-capable-dac>" --json > output/audio-smoke-evidence/dop-dac.json',
    artifact: 'output/audio-smoke-evidence/dop-dac.json',
    evidence:
      'dsdMode=dop, carrier sample rate, actual output format facts, and fallback reason when the DAC rejects DoP'
  },
  'Native DSD': {
    command:
      'pnpm run smoke:asio-native-dsd -- --device "<native-dsd-asio-driver>" --fixture-dir "<dsd-fixtures>" --json > output/audio-smoke-evidence/native-dsd.json',
    artifact: 'output/audio-smoke-evidence/native-dsd.json',
    evidence:
      'nativeDsdRuntimeState=proven for at least one DSD rate, plus explicit driver/device and fallback reason for unsupported rates'
  },
  'SACD ISO': {
    command:
      'pnpm run smoke:audio-format-matrix -- --manifest "<sacd-iso-matrix.json>" --playback --backend wasapi-exclusive --device "<dac>" --json > output/audio-smoke-evidence/sacd-iso.json',
    artifact: 'output/audio-smoke-evidence/sacd-iso.json',
    evidence:
      'SACD ISO source metadata, selected track/area, dsdMode/native-or-dop-or-pcm result, and explicit DST/provider reason when applicable'
  },
  Loudnorm: {
    command:
      'Manual HiFi checklist: untagged FLAC → volumeNormalization=loudnorm → first play status measuring/fallback, perfectReasonCode=loudnorm_active; second play cache hit; record notes in output/audio-smoke-evidence/loudnorm.json',
    artifact: 'output/audio-smoke-evidence/loudnorm.json',
    evidence:
      'mode=loudnorm (never track alias), loudnormActive=true, perfectReasonCode=loudnorm_active, status measuring|cached|fallback|unavailable; no fake success without ebur128'
  },
  'Gapless Album': {
    command:
      'Manual HiFi checklist: same-format album queue, gapless ON, crossfade OFF → observe gaplessActive/preloadReady and seamless promote without device stop; record output/audio-smoke-evidence/gapless-album.json',
    artifact: 'output/audio-smoke-evidence/gapless-album.json',
    evidence:
      'gapless intent ON, gaplessActive/preloadReady observed on same-format neighbors; gaplessBlockedReason empty or documented; format_mismatch/crossfade/dsd_path when blocked'
  },
  'Unity Volume': {
    command:
      'Manual HiFi checklist: default volume 0.7 exclusive bypass → perfectReasonCode=volume_not_unity + Unity CTA; setVolume(1) restores path when other conditions allow; record output/audio-smoke-evidence/unity-volume.json',
    artifact: 'output/audio-smoke-evidence/unity-volume.json',
    evidence:
      'default volume remains 0.7; volume_not_unity reason + Unity CTA; Unity sets volume=1.0 without silent default change'
  }
}

function inferSurface(entry) {
  const explicit = entry && entry.surface ? String(entry.surface) : ''
  if (ALL_REPORTED_SURFACES.includes(explicit)) return explicit

  const text = [
    entry && entry.id,
    entry && entry.label,
    entry && entry.command,
    entry && entry.notes
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (text.includes('loudnorm') || text.includes('r128') || text.includes('lufs')) return 'Loudnorm'
  if (text.includes('gapless')) return 'Gapless Album'
  if (
    text.includes('unity') ||
    text.includes('volume_not_unity') ||
    text.includes('volume-not-unity')
  ) {
    return 'Unity Volume'
  }
  if (text.includes('sacd') || text.includes('iso')) return 'SACD ISO'
  if (text.includes('native dsd') || text.includes('native-dsd')) return 'Native DSD'
  if (text.includes('dop')) return 'DoP DAC'
  if (text.includes('asio')) return 'ASIO'
  if (text.includes('wasapi') || text.includes('exclusive')) return 'WASAPI Exclusive'
  return 'Unmapped'
}

function normalizeEntry(entry) {
  return {
    surface: inferSurface(entry),
    id: String(entry && entry.id ? entry.id : 'unknown'),
    label: String(entry && entry.label ? entry.label : 'Unknown smoke surface'),
    status:
      entry && ['pass', 'fail', 'not-run', 'skip'].includes(entry.status)
        ? entry.status
        : 'not-run',
    command: String(entry && entry.command ? entry.command : ''),
    artifact: String(entry && entry.artifact ? entry.artifact : ''),
    notes: String(entry && entry.notes ? entry.notes : '')
  }
}

function withFallbackArtifact(entry, artifact) {
  const normalized = normalizeEntry(entry)
  if (normalized.artifact || !artifact) return normalized
  return {
    ...normalized,
    artifact
  }
}

function markdownEscape(value) {
  return String(value || '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>')
}

function isRemoteArtifact(artifact) {
  return /^https?:\/\//i.test(String(artifact || ''))
}

function resolveLocalArtifactPath(artifact, baseDir = process.cwd()) {
  if (!artifact || isRemoteArtifact(artifact)) return ''
  return path.isAbsolute(artifact) ? artifact : path.resolve(baseDir, artifact)
}

function artifactExists(artifact, baseDir = process.cwd()) {
  if (!artifact) return false
  if (isRemoteArtifact(artifact)) return true
  return fs.existsSync(resolveLocalArtifactPath(artifact, baseDir))
}

function passHasUsableArtifact(entry, options = {}) {
  const artifact = String(entry && entry.artifact ? entry.artifact : '').trim()
  if (!artifact) return false
  if (options.verifyArtifacts !== true) return true
  return artifactExists(artifact, options.artifactBaseDir)
}

function materializeRequiredSurfaceRows(entries) {
  const rows = []
  const grouped = new Map()
  for (const entry of entries) {
    const surface = entry.surface || inferSurface(entry)
    const list = grouped.get(surface) || []
    list.push(entry)
    grouped.set(surface, list)
  }

  for (const surface of ALL_REPORTED_SURFACES) {
    const surfaceEntries = grouped.get(surface) || []
    if (surfaceEntries.length === 0) {
      const isProduct = OPTIONAL_PRODUCT_SURFACES.includes(surface)
      rows.push(
        normalizeEntry({
          surface,
          id: surface.toLowerCase().replaceAll(' ', '-'),
          label: surface,
          status: 'not-run',
          notes: isProduct
            ? 'No product honesty smoke evidence recorded yet (defaults to not-run).'
            : 'No opt-in real-device smoke evidence recorded yet.'
        })
      )
      continue
    }
    rows.push(...surfaceEntries)
  }

  for (const [surface, surfaceEntries] of grouped.entries()) {
    if (!ALL_REPORTED_SURFACES.includes(surface)) rows.push(...surfaceEntries)
  }
  return rows
}

function buildCoverageSummary(surfaceRows, options = {}) {
  const required = surfaceRows.filter((entry) => REQUIRED_SURFACES.includes(entry.surface))
  const passedSurfaces = []
  const failedSurfaces = []
  const missingSurfaces = []
  const skippedSurfaces = []
  const unbackedPassSurfaces = []
  const missingArtifactSurfaces = []

  for (const surface of REQUIRED_SURFACES) {
    const rows = required.filter((entry) => entry.surface === surface)
    const passRows = rows.filter((entry) => entry.status === 'pass')
    const artifactPassRows = passRows.filter((entry) => entry.artifact.trim().length > 0)
    const backedPassRows = passRows.filter((entry) => passHasUsableArtifact(entry, options))
    if (backedPassRows.length > 0) {
      passedSurfaces.push(surface)
    } else if (artifactPassRows.length > 0) {
      missingArtifactSurfaces.push(surface)
    } else if (passRows.length > 0) {
      unbackedPassSurfaces.push(surface)
    } else if (rows.some((entry) => entry.status === 'fail')) {
      failedSurfaces.push(surface)
    } else if (rows.some((entry) => entry.status === 'skip')) {
      skippedSurfaces.push(surface)
    } else {
      missingSurfaces.push(surface)
    }
  }

  return {
    complete: passedSurfaces.length === REQUIRED_SURFACES.length,
    requiredCount: REQUIRED_SURFACES.length,
    passCount: passedSurfaces.length,
    failCount: failedSurfaces.length,
    missingCount: missingSurfaces.length,
    skipCount: skippedSurfaces.length,
    unbackedPassCount: unbackedPassSurfaces.length,
    missingArtifactCount: missingArtifactSurfaces.length,
    passedSurfaces,
    failedSurfaces,
    missingSurfaces,
    skippedSurfaces,
    unbackedPassSurfaces,
    missingArtifactSurfaces
  }
}

function buildCollectionActionPlan(coverage) {
  const surfaces = [
    ...coverage.failedSurfaces.map((surface) => ({ surface, status: 'fail' })),
    ...coverage.unbackedPassSurfaces.map((surface) => ({
      surface,
      status: 'insufficient-evidence'
    })),
    ...coverage.missingArtifactSurfaces.map((surface) => ({
      surface,
      status: 'missing-artifact'
    })),
    ...coverage.missingSurfaces.map((surface) => ({ surface, status: 'not-run' })),
    ...coverage.skippedSurfaces.map((surface) => ({ surface, status: 'skip' }))
  ]
  return surfaces.map(({ surface, status }) => {
    const guide = SURFACE_COLLECTION_GUIDES[surface] || {}
    return {
      surface,
      status,
      command: guide.command || '',
      artifact: guide.artifact || '',
      requiredEvidence: guide.evidence || ''
    }
  })
}

function compactSmokeInfo(info) {
  if (!info || typeof info !== 'object') return ''
  const parts = []
  if (info.actualOutputFormat || info.actualSampleRate || info.actualChannels) {
    parts.push(
      [
        info.actualOutputFormat,
        info.actualSampleRate ? `${info.actualSampleRate}Hz` : '',
        info.actualChannels ? `${info.actualChannels}ch` : ''
      ]
        .filter(Boolean)
        .join('/')
    )
  }
  if (typeof info.outputPerfect === 'boolean') parts.push(`outputPerfect=${info.outputPerfect}`)
  if (info.nativeDsdRuntimeState) parts.push(`nativeDsd=${info.nativeDsdRuntimeState}`)
  if (info.dsdMode) parts.push(`dsdMode=${info.dsdMode}`)
  return parts.filter(Boolean).join('; ')
}

function buildEntriesFromSmokeSummary(summary, artifact = '', command = '') {
  const results = Array.isArray(summary && summary.results) ? summary.results : []
  const device = summary && summary.device ? summary.device : {}
  const deviceLabel = device.label || device.name || device.id || summary.deviceSelector || ''
  return results.map((result, index) => {
    const infoNotes = compactSmokeInfo(result.info)
    return normalizeEntry({
      id: result.id || `${String(result.backend || 'audio-smoke')}-${index + 1}`,
      label: result.label || `${result.backend || 'Audio'} smoke`,
      status: result.ok === true ? 'pass' : result.ok === false ? 'fail' : 'not-run',
      command,
      artifact,
      notes: [
        deviceLabel ? `device=${deviceLabel}` : '',
        infoNotes,
        result.error || result.notes || ''
      ]
        .filter(Boolean)
        .join('; ')
    })
  })
}

function buildAudioSmokeEvidenceReport(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const platform = options.platform || process.platform
  const verifyArtifacts = options.verifyArtifacts === true
  const artifactBaseDir = options.artifactBaseDir || process.cwd()
  const entries = Array.isArray(options.entries) ? options.entries.map(normalizeEntry) : []
  const surfaceRows = materializeRequiredSurfaceRows(entries)
  const coverage = buildCoverageSummary(surfaceRows, { verifyArtifacts, artifactBaseDir })
  const actionPlan = buildCollectionActionPlan(coverage)
  const json = {
    schemaVersion: 1,
    generatedAt,
    platform,
    requiredSurfaces: [...REQUIRED_SURFACES],
    optionalProductSurfaces: [...OPTIONAL_PRODUCT_SURFACES],
    artifactVerification: {
      enabled: verifyArtifacts,
      baseDir: artifactBaseDir
    },
    coverage,
    actionPlan,
    entries,
    surfaceRows
  }

  const lines = [
    '# Twilight Audio Real-Device Smoke Evidence',
    '',
    `Generated: ${generatedAt}`,
    `Platform: ${platform}`,
    `Coverage: ${coverage.passCount}/${coverage.requiredCount} required surfaces passed`,
    `Complete: ${coverage.complete ? 'yes' : 'no'}`,
    '',
    'Required opt-in surfaces (gate `coverage.complete`):',
    ...REQUIRED_SURFACES.map((surface) => `- ${surface}`),
    '',
    'Optional product honesty surfaces (default `not-run`; do not gate complete):',
    ...OPTIONAL_PRODUCT_SURFACES.map((surface) => `- ${surface}`),
    '',
    '| Surface | Status | Command | Artifact | Notes |',
    '|---|---|---|---|---|'
  ]

  for (const entry of surfaceRows) {
    lines.push(
      `| ${markdownEscape(entry.surface)} | ${markdownEscape(entry.status)} | ${markdownEscape(
        entry.command
      )} | ${markdownEscape(entry.artifact)} | ${markdownEscape(
        entry.label === entry.surface
          ? entry.notes
          : `${entry.label}; ${entry.notes}`.replace(/; $/, '')
      )} |`
    )
  }

  if (actionPlan.length > 0) {
    lines.push(
      '',
      verifyArtifacts
        ? 'A required surface only counts as passed when at least one `pass` row includes an existing local artifact path or a remote artifact URL.'
        : 'A required surface only counts as passed when at least one `pass` row includes an artifact path.',
      '',
      '## Collection Action Plan',
      '',
      '| Surface | Current status | Suggested command | Artifact | Required evidence |',
      '|---|---|---|---|---|'
    )
    for (const item of actionPlan) {
      lines.push(
        `| ${markdownEscape(item.surface)} | ${markdownEscape(item.status)} | ${markdownEscape(
          item.command
        )} | ${markdownEscape(item.artifact)} | ${markdownEscape(item.requiredEvidence)} |`
      )
    }
  }

  return {
    json,
    markdown: `${lines.join('\n')}\n`
  }
}

function readJsonText(filePath) {
  const bytes = fs.readFileSync(filePath)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes
      .subarray(2)
      .toString('utf16le')
      .replace(/^\uFEFF/, '')
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const payload = Buffer.from(bytes.subarray(2))
    return payload
      .swap16()
      .toString('utf16le')
      .replace(/^\uFEFF/, '')
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

function readEntries(filePath) {
  if (!filePath) return []
  const raw = readJsonText(filePath)
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed.map((entry) => withFallbackArtifact(entry, filePath))
  if (Array.isArray(parsed.entries)) {
    return parsed.entries.map((entry) => withFallbackArtifact(entry, filePath))
  }
  return buildEntriesFromSmokeSummary(parsed, filePath)
}

function readEntriesFromInputs(filePaths) {
  return filePaths.flatMap((filePath) => readEntries(filePath))
}

function argValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return ''
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function argValues(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`)
    }
    values.push(value)
    index += 1
  }
  return values
}

function collectInputFiles(args) {
  const inputFiles = argValues(args, '--input')
  const inputDirs = argValues(args, '--input-dir')
  for (const inputDir of inputDirs) {
    const entries = fs
      .readdirSync(inputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => path.join(inputDir, entry.name))
      .sort((left, right) => left.localeCompare(right))
    inputFiles.push(...entries)
  }
  return inputFiles
}

function main() {
  const args = process.argv.slice(2)
  const inputFiles = collectInputFiles(args)
  const requireComplete = args.includes('--require-complete')
  const outputDir = args.includes('--output-dir')
    ? argValue(args, '--output-dir')
    : path.join(process.cwd(), 'output', 'audio-smoke-evidence')
  const report = buildAudioSmokeEvidenceReport({
    entries: readEntriesFromInputs(inputFiles),
    verifyArtifacts: true,
    artifactBaseDir: process.cwd()
  })

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'audio-smoke-evidence.md'), report.markdown)
  fs.writeFileSync(
    path.join(outputDir, 'audio-smoke-evidence.json'),
    `${JSON.stringify(report.json, null, 2)}\n`
  )
  console.log(path.join(outputDir, 'audio-smoke-evidence.md'))
  if (requireComplete && !report.json.coverage.complete) {
    const missing = [
      ...report.json.coverage.failedSurfaces.map((surface) => `${surface}=fail`),
      ...report.json.coverage.unbackedPassSurfaces.map(
        (surface) => `${surface}=insufficient-evidence`
      ),
      ...report.json.coverage.missingArtifactSurfaces.map(
        (surface) => `${surface}=missing-artifact`
      ),
      ...report.json.coverage.missingSurfaces.map((surface) => `${surface}=not-run`),
      ...report.json.coverage.skippedSurfaces.map((surface) => `${surface}=skip`)
    ].join(', ')
    console.error(`Audio smoke evidence incomplete: ${missing}`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  REQUIRED_SURFACES,
  OPTIONAL_PRODUCT_SURFACES,
  ALL_REPORTED_SURFACES,
  buildAudioSmokeEvidenceReport,
  buildCollectionActionPlan,
  buildEntriesFromSmokeSummary,
  buildCoverageSummary,
  readEntriesFromInputs
}
