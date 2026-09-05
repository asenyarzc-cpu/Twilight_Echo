const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// Hardware surfaces must pass with artifacts for coverage.complete.
const REQUIRED_SURFACES = [
  'WASAPI Exclusive',
  'ASIO PCM',
  'DoP DAC',
  'Native DSD',
  'SACD ISO',
  'CoreAudio Hog',
  'ALSA hw:'
]

// Product honesty surfaces: always listed; default not-run until maintainer records evidence.
// They do NOT gate coverage.complete (still 7/7 hardware surfaces).
const OPTIONAL_PRODUCT_SURFACES = ['Loudnorm', 'Gapless Album', 'Unity Volume']

const ALL_REPORTED_SURFACES = [...REQUIRED_SURFACES, ...OPTIONAL_PRODUCT_SURFACES]

const OPERATIONAL_SCENARIOS = [
  {
    id: 'track-switch-loop-30m',
    label: '30-minute track-switch loop',
    minimumPlaybackDurationSeconds: 1800,
    expectedState: 'No unreported interruption, device loss, underrun, or silent fallback.'
  },
  {
    id: 'soak-2h',
    label: '2-hour playback soak',
    minimumPlaybackDurationSeconds: 7200,
    expectedState:
      'Playback remains observable and diagnostics report all recovery or failure facts.'
  },
  {
    id: 'sleep-wake',
    label: 'Sleep/wake recovery',
    minimumPlaybackDurationSeconds: 0,
    expectedState:
      'Wake either resumes through a reported recovery or stops with a reported failure.'
  },
  {
    id: 'hotplug',
    label: 'Hot-plug/device-loss recovery',
    minimumPlaybackDurationSeconds: 0,
    expectedState:
      'Device loss and recovery/failure are reported without a silent backend or format switch.'
  },
  {
    id: 'explicit-disappearance',
    label: 'Controlled explicit endpoint disappearance',
    minimumPlaybackDurationSeconds: 0,
    expectedState:
      'A missing explicit endpoint fails or stops without falling back to the system default, then recovers after an explicit reopen.'
  }
]

const SURFACE_COLLECTION_GUIDES = {
  'WASAPI Exclusive': {
    command:
      'pnpm run smoke:wasapi -- --device "<wasapi-endpoint>" --buffer 256 --format-matrix --json > artifacts/wasapi-exclusive-raw.json',
    artifact: 'artifacts/wasapi-exclusive-raw.json',
    evidence:
      'actualBackend=wasapi-exclusive, exclusive=true, actual output format facts, and outputPerfect/perfectReason for every probed PCM format'
  },
  'ASIO PCM': {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend asio --device "<asio-driver>" --json > artifacts/asio-pcm-raw.json',
    artifact: 'artifacts/asio-pcm-raw.json',
    evidence:
      'actualBackend=asio, selected driver/device, actual output format facts, and explicit pass/fail reason'
  },
  'DoP DAC': {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<dsd-fixtures>" --playback --backend wasapi-exclusive --device "<dop-capable-dac>" --json > artifacts/dop-dac-raw.json',
    artifact: 'artifacts/dop-dac-raw.json',
    evidence:
      'dsdMode=dop, carrier sample rate, actual output format facts, and fallback reason when the DAC rejects DoP'
  },
  'Native DSD': {
    command:
      'pnpm run smoke:asio-native-dsd -- --device "<native-dsd-asio-driver>" --fixture-dir "<dsd-fixtures>" --json > artifacts/native-dsd-raw.json',
    artifact: 'artifacts/native-dsd-raw.json',
    evidence:
      'nativeDsdRuntimeState=proven for at least one DSD rate, plus explicit driver/device and fallback reason for unsupported rates'
  },
  'SACD ISO': {
    command:
      'pnpm run smoke:audio-format-matrix -- --manifest "<sacd-iso-matrix.json>" --playback --backend wasapi-exclusive --device "<dac>" --json > artifacts/sacd-iso-raw.json',
    artifact: 'artifacts/sacd-iso-raw.json',
    evidence:
      'SACD ISO source metadata, selected track/area, dsdMode/native-or-dop-or-pcm result, and explicit DST/provider reason when applicable'
  },
  'CoreAudio Hog': {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-fixtures>" --playback --backend coreaudio-exclusive --device "<hog-device>" --json > artifacts/coreaudio-hog-raw.json',
    artifact: 'artifacts/coreaudio-hog-raw.json',
    evidence:
      'actualBackend=coreaudio-exclusive, accessMode=hog, selected device, actual PCM output format, and explicit pass/fail reason; Native DSD is not valid on CoreAudio'
  },
  'ALSA hw:': {
    command:
      'pnpm run smoke:audio-format-matrix -- --fixture-dir "<pcm-or-dsd-fixtures>" --playback --backend alsa --device "hw:<card>,<device>" --json > artifacts/alsa-hw-raw.json',
    artifact: 'artifacts/alsa-hw-raw.json',
    evidence:
      'actualBackend=alsa, devicePathKind=hw, selected ALSA device, actual output format, and native DSD runtime facts when native DSD is attempted'
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
  if (text.includes('coreaudio') || text.includes('core audio') || text.includes('hog')) {
    return 'CoreAudio Hog'
  }
  if (text.includes('alsa') || text.includes('hw:')) return 'ALSA hw:'
  if (text.includes('asio')) return 'ASIO PCM'
  if (text.includes('wasapi') || text.includes('exclusive')) return 'WASAPI Exclusive'
  return 'Unmapped'
}

function normalizeEntry(entry) {
  return {
    surface: inferSurface(entry),
    id: String(entry && entry.id ? entry.id : 'unknown'),
    label: String(entry && entry.label ? entry.label : 'Unknown smoke surface'),
    status:
      entry && ['pass', 'fail', 'not-run', 'skip', 'invalid-artifact'].includes(entry.status)
        ? entry.status
        : 'not-run',
    command: String(entry && entry.command ? entry.command : ''),
    artifact: String(entry && entry.artifact ? entry.artifact : ''),
    artifactSha256: String(entry && entry.artifactSha256 ? entry.artifactSha256 : ''),
    capturedAt: String(entry && entry.capturedAt ? entry.capturedAt : ''),
    inputCommand: String(entry && entry.inputCommand ? entry.inputCommand : ''),
    device: String(entry && entry.device ? entry.device : ''),
    driver: String(entry && entry.driver ? entry.driver : ''),
    format: String(entry && entry.format ? entry.format : ''),
    bufferFrames: Number(entry && entry.bufferFrames ? entry.bufferFrames : 0),
    playbackDurationSeconds: Number(
      entry && entry.playbackDurationSeconds ? entry.playbackDurationSeconds : 0
    ),
    expectedState: entry && entry.expectedState ? entry.expectedState : null,
    evidenceKind:
      entry && ['real-device', 'mock', 'software-only'].includes(entry.evidenceKind)
        ? entry.evidenceKind
        : 'unknown',
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function isIsoTimestamp(value) {
  return Boolean(value) && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
}

function expectedStateIncludes(expectedState, tokens) {
  const text =
    typeof expectedState === 'string' ? expectedState : JSON.stringify(expectedState || {})
  return tokens.every((token) => text.includes(token))
}

function inspectEvidenceEntry(entry, options = {}) {
  const normalized = normalizeEntry(entry)
  const missingFields = []
  const requiredFields = [
    ['device', normalized.device],
    ['driver', normalized.driver],
    ['format', normalized.format],
    ['bufferFrames', normalized.bufferFrames > 0],
    ['playbackDurationSeconds', normalized.playbackDurationSeconds > 0],
    ['expectedState', normalized.expectedState],
    ['artifact', normalized.artifact],
    ['artifactSha256', normalized.artifactSha256],
    ['capturedAt', isIsoTimestamp(normalized.capturedAt)],
    ['inputCommand', normalized.inputCommand]
  ]
  for (const [name, value] of requiredFields) {
    if (!value) missingFields.push(name)
  }
  if (normalized.status !== 'pass') {
    return { valid: true, reason: '', missingFields: [], artifactStatus: 'not-required' }
  }
  if (normalized.evidenceKind !== 'real-device') {
    return {
      valid: false,
      reason:
        normalized.evidenceKind === 'mock'
          ? 'mock-not-hardware-evidence'
          : normalized.evidenceKind === 'software-only'
            ? 'software-only-not-hardware-evidence'
            : 'unknown-evidence-kind',
      missingFields,
      artifactStatus: 'not-hardware-evidence'
    }
  }
  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `missing-required-fields:${missingFields.join(',')}`,
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  if (
    normalized.surface === 'CoreAudio Hog' &&
    !expectedStateIncludes(normalized.expectedState, [
      'actualBackend=coreaudio-exclusive',
      'accessMode=hog'
    ])
  ) {
    return {
      valid: false,
      reason: 'coreaudio-hog-expected-state-missing',
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(normalized.artifactSha256)) {
    return {
      valid: false,
      reason: 'invalid-sha256',
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  if (isRemoteArtifact(normalized.artifact)) {
    return {
      valid: false,
      reason: 'remote-artifact-not-hash-verifiable',
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  const artifactPath = resolveLocalArtifactPath(normalized.artifact, options.artifactBaseDir)
  if (!artifactExists(normalized.artifact, options.artifactBaseDir)) {
    return {
      valid: false,
      reason: 'artifact-missing',
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  if (sha256File(artifactPath).toLowerCase() !== normalized.artifactSha256.toLowerCase()) {
    return {
      valid: false,
      reason: 'artifact-sha256-mismatch',
      missingFields,
      artifactStatus: 'invalid-artifact'
    }
  }
  return { valid: true, reason: '', missingFields, artifactStatus: 'valid' }
}

function passHasUsableArtifact(entry, options = {}) {
  const artifact = String(entry && entry.artifact ? entry.artifact : '').trim()
  if (!artifact) return false
  if (options.verifyArtifacts !== true) return entry.evidenceKind === 'real-device'
  return inspectEvidenceEntry(entry, options).valid
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
  const nonHardwareEvidenceSurfaces = []

  for (const surface of REQUIRED_SURFACES) {
    const rows = required.filter((entry) => entry.surface === surface)
    const passRows = rows.filter((entry) => entry.status === 'pass')
    const hardwarePassRows = passRows.filter((entry) => entry.evidenceKind === 'real-device')
    const artifactPassRows = passRows.filter((entry) => entry.artifact.trim().length > 0)
    const backedPassRows = passRows.filter((entry) => passHasUsableArtifact(entry, options))
    if (backedPassRows.length > 0) {
      passedSurfaces.push(surface)
    } else if (hardwarePassRows.length === 0 && passRows.length > 0) {
      nonHardwareEvidenceSurfaces.push(surface)
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
    nonHardwareEvidenceCount: nonHardwareEvidenceSurfaces.length,
    passedSurfaces,
    failedSurfaces,
    missingSurfaces,
    skippedSurfaces,
    unbackedPassSurfaces,
    missingArtifactSurfaces,
    nonHardwareEvidenceSurfaces
  }
}

function buildCollectionActionPlan(coverage) {
  const surfaces = [
    ...coverage.failedSurfaces.map((surface) => ({ surface, status: 'fail' })),
    ...coverage.unbackedPassSurfaces.map((surface) => ({
      surface,
      status: 'insufficient-evidence'
    })),
    ...coverage.nonHardwareEvidenceSurfaces.map((surface) => ({
      surface,
      status: 'not-real-device'
    })),
    ...coverage.missingArtifactSurfaces.map((surface) => ({
      surface,
      status: 'invalid-artifact'
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

function normalizeOperationalResult(result) {
  const scenarioId = String(result && result.scenario ? result.scenario : '')
  const scenario = OPERATIONAL_SCENARIOS.find((item) => item.id === scenarioId)
  return {
    scenario: scenarioId,
    label: scenario
      ? scenario.label
      : String(result && result.label ? result.label : 'Unknown scenario'),
    status:
      result && ['pass', 'fail', 'not-run', 'skip', 'invalid-artifact'].includes(result.status)
        ? result.status
        : 'not-run',
    surface: String(result && result.surface ? result.surface : ''),
    device: String(result && result.device ? result.device : ''),
    driver: String(result && result.driver ? result.driver : ''),
    format: String(result && result.format ? result.format : ''),
    bufferFrames: Number(result && result.bufferFrames ? result.bufferFrames : 0),
    playbackDurationSeconds: Number(
      result && result.playbackDurationSeconds ? result.playbackDurationSeconds : 0
    ),
    expectedState:
      result && result.expectedState ? result.expectedState : scenario?.expectedState || '',
    observedState: result && result.observedState ? result.observedState : '',
    artifact: String(result && result.artifact ? result.artifact : ''),
    artifactSha256: String(result && result.artifactSha256 ? result.artifactSha256 : ''),
    capturedAt: String(result && result.capturedAt ? result.capturedAt : ''),
    inputCommand: String(result && result.inputCommand ? result.inputCommand : ''),
    evidenceKind:
      result && ['real-device', 'mock', 'software-only'].includes(result.evidenceKind)
        ? result.evidenceKind
        : 'unknown',
    switchCount: Number(result && result.switchCount ? result.switchCount : 0),
    underrunCount: Number(result && result.underrunCount ? result.underrunCount : 0),
    deviceLostCount: Number(result && result.deviceLostCount ? result.deviceLostCount : 0),
    recoveryCount: Number(result && result.recoveryCount ? result.recoveryCount : 0),
    notes: String(result && result.notes ? result.notes : '')
  }
}

function withFallbackOperationalArtifact(result, artifact) {
  const normalized = normalizeOperationalResult(result)
  if (normalized.artifact || !artifact) return normalized
  return {
    ...normalized,
    artifact
  }
}

function inspectOperationalResult(result, options = {}) {
  const normalized = normalizeOperationalResult(result)
  const scenario = OPERATIONAL_SCENARIOS.find((item) => item.id === normalized.scenario)
  if (normalized.status !== 'pass') {
    return { valid: true, status: normalized.status, reason: '', artifactStatus: 'not-required' }
  }
  if (!scenario) {
    return {
      valid: false,
      status: 'invalid-artifact',
      reason: 'unknown-operational-scenario',
      artifactStatus: 'invalid-artifact'
    }
  }
  if (normalized.evidenceKind !== 'real-device') {
    return {
      valid: false,
      status: 'not-real-device',
      reason:
        normalized.evidenceKind === 'mock'
          ? 'mock-not-hardware-evidence'
          : normalized.evidenceKind === 'software-only'
            ? 'software-only-not-hardware-evidence'
            : 'unknown-evidence-kind',
      artifactStatus: 'not-hardware-evidence'
    }
  }
  const requiredFields = [
    ['surface', normalized.surface],
    ['device', normalized.device],
    ['driver', normalized.driver],
    ['format', normalized.format],
    ['bufferFrames', normalized.bufferFrames > 0],
    ['playbackDurationSeconds', normalized.playbackDurationSeconds > 0],
    ['expectedState', normalized.expectedState],
    ['observedState', normalized.observedState],
    ['artifact', normalized.artifact],
    ['artifactSha256', normalized.artifactSha256],
    ['capturedAt', isIsoTimestamp(normalized.capturedAt)],
    ['inputCommand', normalized.inputCommand]
  ]
  const missingFields = requiredFields.filter(([, value]) => !value).map(([name]) => name)
  if (missingFields.length > 0) {
    return {
      valid: false,
      status: 'invalid-artifact',
      reason: `missing-required-fields:${missingFields.join(',')}`,
      artifactStatus: 'invalid-artifact'
    }
  }
  if (normalized.playbackDurationSeconds < scenario.minimumPlaybackDurationSeconds) {
    return {
      valid: false,
      status: 'insufficient-duration',
      reason: `minimum-playback-duration=${scenario.minimumPlaybackDurationSeconds}`,
      artifactStatus: 'valid'
    }
  }
  const artifactValidation = inspectEvidenceEntry(normalized, options)
  if (!artifactValidation.valid) {
    return {
      valid: false,
      status:
        artifactValidation.artifactStatus === 'not-hardware-evidence'
          ? 'not-real-device'
          : 'invalid-artifact',
      reason: artifactValidation.reason,
      artifactStatus: artifactValidation.artifactStatus
    }
  }
  return { valid: true, status: 'pass', reason: '', artifactStatus: 'valid' }
}

function materializeOperationalScenarioRows(results, options = {}) {
  const byScenario = new Map(results.map((result) => [result.scenario, result]))
  return OPERATIONAL_SCENARIOS.map((scenario) => {
    const result = byScenario.get(scenario.id)
    if (result) {
      const normalized = normalizeOperationalResult(result)
      const validation = inspectOperationalResult(normalized, options)
      return { ...normalized, status: validation.status, validation }
    }
    return normalizeOperationalResult({
      scenario: scenario.id,
      status: 'not-run',
      expectedState: scenario.expectedState,
      notes: 'No opt-in real-device operational evidence recorded yet.'
    })
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
      device: deviceLabel,
      driver: String(device.driver || device.name || device.label || ''),
      format: compactSmokeInfo(result.info),
      bufferFrames: Number(summary?.options?.buffer || result?.info?.bufferSizeFrames || 0),
      playbackDurationSeconds: Number(summary?.options?.durationMs || 0) / 1000,
      inputCommand: command,
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
  const operationalResults = Array.isArray(options.operationalResults)
    ? options.operationalResults.map(normalizeOperationalResult)
    : []
  const surfaceRows = materializeRequiredSurfaceRows(entries)
  const coverage = buildCoverageSummary(surfaceRows, { verifyArtifacts, artifactBaseDir })
  const actionPlan = buildCollectionActionPlan(coverage)
  const json = {
    schemaVersion: 2,
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
    surfaceRows,
    operationalScenarioSchema: OPERATIONAL_SCENARIOS,
    operationalScenarioRows: materializeOperationalScenarioRows(operationalResults, {
      artifactBaseDir
    })
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
    '| Surface | Status | Evidence kind | Artifact validation | Command | Artifact | Notes |',
    '|---|---|---|---|---|---|---|'
  ]

  for (const entry of surfaceRows) {
    lines.push(
      `| ${markdownEscape(entry.surface)} | ${markdownEscape(entry.status)} | ${markdownEscape(
        entry.evidenceKind
      )} | ${markdownEscape(inspectEvidenceEntry(entry, { artifactBaseDir }).artifactStatus)} | ${markdownEscape(
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
        ? 'A required surface only counts as passed when at least one `pass` row is marked `real-device`, includes all required collection metadata, and has an existing local artifact whose SHA-256 matches.'
        : 'A required surface only counts as passed when at least one `pass` row is marked `real-device` and includes an artifact path.',
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

  lines.push(
    '',
    '## Operational Scenario Results',
    '',
    '| Scenario | Status | Surface | Duration | Switches | Underruns | Device lost | Recoveries | Artifact | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|'
  )
  for (const result of json.operationalScenarioRows) {
    lines.push(
      `| ${markdownEscape(result.label)} | ${markdownEscape(result.status)} | ${markdownEscape(
        result.surface
      )} | ${markdownEscape(result.playbackDurationSeconds)}s | ${markdownEscape(
        result.switchCount
      )} | ${markdownEscape(result.underrunCount)} | ${markdownEscape(
        result.deviceLostCount
      )} | ${markdownEscape(result.recoveryCount)} | ${markdownEscape(result.artifact)} | ${markdownEscape(
        result.notes
      )} |`
    )
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

function readEvidenceInput(filePath) {
  if (!filePath) return { entries: [], operationalResults: [] }
  const raw = readJsonText(filePath)
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) {
    return {
      entries: parsed.map((entry) => withFallbackArtifact(entry, filePath)),
      operationalResults: []
    }
  }
  if (Array.isArray(parsed.entries) || Array.isArray(parsed.operationalResults)) {
    return {
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => withFallbackArtifact(entry, filePath))
        : [],
      operationalResults: Array.isArray(parsed.operationalResults)
        ? parsed.operationalResults.map((result) =>
            withFallbackOperationalArtifact(result, filePath)
          )
        : []
    }
  }
  return { entries: buildEntriesFromSmokeSummary(parsed, filePath), operationalResults: [] }
}

function readEntriesFromInputs(filePaths) {
  return filePaths.flatMap((filePath) => readEvidenceInput(filePath).entries)
}

function readEvidenceInputs(filePaths) {
  const entries = []
  const operationalResults = []
  for (const filePath of filePaths) {
    const input = readEvidenceInput(filePath)
    entries.push(...input.entries)
    operationalResults.push(...input.operationalResults)
  }
  return { entries, operationalResults }
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
  const input = readEvidenceInputs(inputFiles)
  const report = buildAudioSmokeEvidenceReport({
    ...input,
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
      ...report.json.coverage.nonHardwareEvidenceSurfaces.map(
        (surface) => `${surface}=not-real-device`
      ),
      ...report.json.coverage.missingArtifactSurfaces.map(
        (surface) => `${surface}=invalid-artifact`
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
  OPERATIONAL_SCENARIOS,
  buildAudioSmokeEvidenceReport,
  buildCollectionActionPlan,
  buildEntriesFromSmokeSummary,
  buildCoverageSummary,
  readEntriesFromInputs,
  readEvidenceInputs,
  inspectEvidenceEntry,
  inspectOperationalResult
}
