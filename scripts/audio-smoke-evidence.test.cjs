const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  buildAudioSmokeEvidenceReport,
  buildCollectionActionPlan,
  buildEntriesFromSmokeSummary,
  buildCoverageSummary,
  readEntriesFromInputs
} = require('./audio-smoke-evidence.cjs')

test('audio smoke evidence report records opt-in real-device surfaces', () => {
  const report = buildAudioSmokeEvidenceReport({
    generatedAt: '2026-07-05T00:00:00.000Z',
    platform: 'win32',
    entries: [
      {
        id: 'wasapi-exclusive-pcm',
        label: 'WASAPI Exclusive PCM',
        status: 'pass',
        command: 'pnpm run smoke:wasapi -- --device "Desk DAC" --format-matrix',
        artifact: 'output/audio-smoke-evidence/wasapi-exclusive-pcm.json',
        notes: '24-bit PCM path matched actual output format'
      },
      {
        id: 'asio-native-dsd',
        label: 'ASIO Native DSD',
        status: 'not-run',
        command: 'pnpm run smoke:asio-native-dsd -- --driver "Studio ASIO"',
        artifact: '',
        notes: 'No ASIO driver attached on this machine'
      }
    ]
  })

  assert.match(report.markdown, /# Twilight Audio Real-Device Smoke Evidence/)
  assert.match(report.markdown, /WASAPI Exclusive PCM/)
  assert.match(report.markdown, /ASIO Native DSD/)
  assert.match(report.markdown, /pnpm run smoke:wasapi/)
  assert.match(report.markdown, /output\/audio-smoke-evidence\/wasapi-exclusive-pcm\.json/)
  assert.equal(report.json.schemaVersion, 2)
  assert.equal(report.json.requiredSurfaces.includes('DoP DAC'), true)
  assert.equal(report.json.requiredSurfaces.includes('SACD ISO'), true)
  assert.equal(report.json.entries[0].status, 'pass')
  assert.equal(report.json.entries[1].status, 'not-run')
  assert.equal(report.json.coverage.complete, false)
  assert.equal(report.json.actionPlan.length, 7)
  assert.equal(
    report.json.actionPlan.some(
      (item) => item.surface === 'SACD ISO' && item.artifact.endsWith('sacd-iso-raw.json')
    ),
    true
  )
  assert.deepEqual(report.json.coverage.missingSurfaces, [
    'ASIO PCM',
    'DoP DAC',
    'Native DSD',
    'SACD ISO',
    'CoreAudio Hog',
    'ALSA hw:'
  ])
  // 7 required hardware + 3 product honesty surfaces
  assert.equal(report.json.surfaceRows.length, 10)
  assert.deepEqual(report.json.optionalProductSurfaces, [
    'Loudnorm',
    'Gapless Album',
    'Unity Volume'
  ])
  assert.equal(
    report.json.surfaceRows.some(
      (entry) => entry.surface === 'SACD ISO' && entry.status === 'not-run'
    ),
    true
  )
  assert.equal(
    report.json.surfaceRows.some(
      (entry) => entry.surface === 'Loudnorm' && entry.status === 'not-run'
    ),
    true
  )
  assert.equal(
    report.json.surfaceRows.some(
      (entry) => entry.surface === 'Gapless Album' && entry.status === 'not-run'
    ),
    true
  )
  assert.equal(
    report.json.surfaceRows.some(
      (entry) => entry.surface === 'Unity Volume' && entry.status === 'not-run'
    ),
    true
  )
  assert.match(report.markdown, /\| SACD ISO \| not-run \|/)
  assert.match(report.markdown, /\| Loudnorm \| not-run \|/)
  assert.match(report.markdown, /\| Gapless Album \| not-run \|/)
  assert.match(report.markdown, /\| Unity Volume \| not-run \|/)
  assert.match(report.markdown, /Coverage: 0\/7 required surfaces passed/)
  assert.match(report.markdown, /Complete: no/)
  assert.match(report.markdown, /Optional product honesty surfaces/)
  assert.match(report.markdown, /## Collection Action Plan/)
  assert.match(report.markdown, /pnpm run smoke:asio-native-dsd/)
  assert.match(report.markdown, /artifacts\/sacd-iso-raw\.json/)
})

test('audio smoke evidence report can derive entries from smoke JSON summaries', () => {
  const entries = buildEntriesFromSmokeSummary(
    {
      device: { label: 'Desk DAC' },
      results: [
        {
          ok: true,
          label: 'WASAPI Exclusive hardware smoke',
          backend: 'wasapi-exclusive',
          info: { actualOutputFormat: 'int24-in32', actualSampleRate: 192000, outputPerfect: true }
        },
        {
          ok: false,
          label: 'ASIO Native DSD 2822400Hz',
          backend: 'asio',
          error: 'Driver rejected Native DSD',
          info: { nativeDsdRuntimeState: 'unproven' }
        }
      ]
    },
    'output/audio-smoke-evidence/desk-dac.json',
    'pnpm run smoke:wasapi -- --device "Desk DAC" --json'
  )

  assert.equal(entries.length, 2)
  assert.equal(entries[0].status, 'pass')
  assert.equal(entries[0].artifact, 'output/audio-smoke-evidence/desk-dac.json')
  assert.match(entries[0].notes, /Desk DAC/)
  assert.match(entries[0].notes, /int24-in32/)
  assert.equal(entries[1].status, 'fail')
  assert.match(entries[1].notes, /Driver rejected Native DSD/)
})

test('audio smoke evidence report expands missing required surfaces as not-run', () => {
  const report = buildAudioSmokeEvidenceReport({
    generatedAt: '2026-07-05T00:00:00.000Z',
    platform: 'win32',
    entries: [
      {
        id: 'wasapi-exclusive-pcm',
        label: 'WASAPI Exclusive hardware smoke',
        status: 'pass'
      }
    ]
  })

  assert.deepEqual(
    report.json.surfaceRows.map((entry) => entry.surface),
    [
      'WASAPI Exclusive',
      'ASIO PCM',
      'DoP DAC',
      'Native DSD',
      'SACD ISO',
      'CoreAudio Hog',
      'ALSA hw:',
      'Loudnorm',
      'Gapless Album',
      'Unity Volume'
    ]
  )
  assert.equal(report.json.surfaceRows[0].status, 'pass')
  assert.equal(report.json.surfaceRows[1].status, 'not-run')
  assert.match(report.markdown, /\| ASIO PCM \| not-run \|/)
  assert.match(report.markdown, /\| DoP DAC \| not-run \|/)
})

test('audio smoke evidence coverage is complete only when every required surface passes', () => {
  const coverage = buildCoverageSummary(
    [
      'WASAPI Exclusive',
      'ASIO PCM',
      'DoP DAC',
      'Native DSD',
      'SACD ISO',
      'CoreAudio Hog',
      'ALSA hw:'
    ].map((surface) => ({
      surface,
      status: 'pass',
      artifact: `output/audio-smoke-evidence/${surface.toLowerCase().replaceAll(' ', '-')}.json`,
      evidenceKind: 'real-device'
    }))
  )

  assert.equal(coverage.complete, true)
  assert.equal(coverage.passCount, 7)
  assert.deepEqual(coverage.missingSurfaces, [])
  assert.deepEqual(coverage.failedSurfaces, [])
  assert.deepEqual(coverage.unbackedPassSurfaces, [])
  assert.deepEqual(coverage.missingArtifactSurfaces, [])
  assert.deepEqual(buildCollectionActionPlan(coverage), [])
})

test('product honesty surfaces default not-run and do not gate coverage.complete', () => {
  const report = buildAudioSmokeEvidenceReport({
    generatedAt: '2026-07-15T00:00:00.000Z',
    platform: 'win32',
    entries: [
      'WASAPI Exclusive',
      'ASIO PCM',
      'DoP DAC',
      'Native DSD',
      'SACD ISO',
      'CoreAudio Hog',
      'ALSA hw:'
    ].map((surface) => ({
      surface,
      id: surface.toLowerCase().replaceAll(' ', '-'),
      label: surface,
      status: 'pass',
      artifact: `output/audio-smoke-evidence/${surface.toLowerCase().replaceAll(' ', '-')}.json`,
      evidenceKind: 'real-device'
    }))
  })

  assert.equal(report.json.coverage.complete, true)
  assert.equal(report.json.coverage.passCount, 7)
  assert.equal(report.json.surfaceRows.length, 10)
  for (const surface of ['Loudnorm', 'Gapless Album', 'Unity Volume']) {
    const row = report.json.surfaceRows.find((entry) => entry.surface === surface)
    assert.equal(row?.status, 'not-run')
  }
  // Product surfaces never appear in actionPlan (only required hardware gaps).
  assert.equal(
    report.json.actionPlan.some((item) =>
      ['Loudnorm', 'Gapless Album', 'Unity Volume'].includes(item.surface)
    ),
    false
  )

  const withLoudnorm = buildAudioSmokeEvidenceReport({
    generatedAt: '2026-07-15T00:00:00.000Z',
    platform: 'win32',
    entries: [
      {
        surface: 'Loudnorm',
        id: 'loudnorm-manual',
        label: 'Loudnorm EBU R128 path',
        status: 'pass',
        artifact: 'output/audio-smoke-evidence/loudnorm.json',
        notes: 'measuring then cached; perfectReasonCode=loudnorm_active'
      }
    ]
  })
  assert.equal(
    withLoudnorm.json.surfaceRows.some(
      (entry) => entry.surface === 'Loudnorm' && entry.status === 'pass'
    ),
    true
  )
  assert.equal(withLoudnorm.json.coverage.complete, false)
  assert.match(withLoudnorm.markdown, /loudnorm_active/)
})

test('audio smoke evidence does not count pass rows without artifacts as complete evidence', () => {
  const report = buildAudioSmokeEvidenceReport({
    generatedAt: '2026-07-05T00:00:00.000Z',
    platform: 'win32',
    entries: [
      {
        surface: 'WASAPI Exclusive',
        id: 'wasapi-exclusive-no-artifact',
        label: 'WASAPI Exclusive hardware smoke',
        status: 'pass',
        evidenceKind: 'real-device',
        notes: 'This pass row is missing its JSON artifact'
      }
    ]
  })

  assert.equal(report.json.coverage.complete, false)
  assert.equal(report.json.coverage.passCount, 0)
  assert.deepEqual(report.json.coverage.unbackedPassSurfaces, ['WASAPI Exclusive'])
  assert.equal(report.json.coverage.unbackedPassCount, 1)
  assert.deepEqual(report.json.coverage.missingArtifactSurfaces, [])
  assert.equal(report.json.actionPlan[0].surface, 'WASAPI Exclusive')
  assert.equal(report.json.actionPlan[0].status, 'insufficient-evidence')
  assert.match(
    report.markdown,
    /only counts as passed when at least one `pass` row is marked `real-device` and includes an artifact path/
  )
})

test('audio smoke evidence can require local pass artifacts to exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-artifact-test-'))
  try {
    const artifactPath = path.join(dir, 'wasapi-exclusive.json')
    fs.writeFileSync(artifactPath, '{}')
    const coverage = buildCoverageSummary(
      [
        {
          surface: 'WASAPI Exclusive',
          status: 'pass',
          artifact: artifactPath,
          evidenceKind: 'real-device'
        },
        {
          surface: 'ASIO PCM',
          status: 'pass',
          artifact: path.join(dir, 'missing-asio.json'),
          evidenceKind: 'real-device'
        }
      ],
      { verifyArtifacts: true }
    )

    assert.deepEqual(coverage.passedSurfaces, [])
    assert.deepEqual(coverage.missingArtifactSurfaces, ['WASAPI Exclusive', 'ASIO PCM'])
    const actionPlan = buildCollectionActionPlan(coverage)
    assert.equal(actionPlan[0].surface, 'WASAPI Exclusive')
    assert.equal(actionPlan[0].status, 'invalid-artifact')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence action plan lists only unresolved required surfaces', () => {
  const coverage = buildCoverageSummary([
    {
      surface: 'WASAPI Exclusive',
      status: 'pass',
      artifact: 'output/audio-smoke-evidence/wasapi-exclusive.json',
      evidenceKind: 'real-device'
    },
    { surface: 'ASIO PCM', status: 'fail' },
    { surface: 'DoP DAC', status: 'skip' },
    { surface: 'Native DSD', status: 'not-run' },
    {
      surface: 'SACD ISO',
      status: 'pass',
      artifact: 'output/audio-smoke-evidence/sacd-iso.json',
      evidenceKind: 'real-device'
    }
  ])

  const actionPlan = buildCollectionActionPlan(coverage)
  assert.deepEqual(
    actionPlan.map((item) => `${item.surface}:${item.status}`),
    [
      'ASIO PCM:fail',
      'Native DSD:not-run',
      'CoreAudio Hog:not-run',
      'ALSA hw::not-run',
      'DoP DAC:skip'
    ]
  )
  assert.match(actionPlan[0].command, /smoke:audio-format-matrix/)
  assert.match(actionPlan[1].command, /smoke:asio-native-dsd/)
  assert.match(
    actionPlan.find((item) => item.surface === 'DoP DAC').requiredEvidence,
    /dsdMode=dop/
  )
})

test('real-device pass requires complete collection metadata and a matching artifact SHA-256', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-contract-test-'))
  try {
    const artifact = path.join(dir, 'wasapi-raw.json')
    fs.writeFileSync(artifact, '{"result":"real device capture"}\n')
    const artifactSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifact))
      .digest('hex')
    const entry = {
      surface: 'WASAPI Exclusive',
      status: 'pass',
      evidenceKind: 'real-device',
      device: 'USB DAC endpoint',
      driver: 'USB Audio 3.2.1',
      format: 'int24-in32/192000Hz/2ch',
      bufferFrames: 256,
      playbackDurationSeconds: 1800,
      expectedState: 'actualBackend=wasapi-exclusive; exclusive=true',
      artifact,
      artifactSha256,
      capturedAt: '2026-08-31T12:00:00.000Z',
      inputCommand: 'pnpm run smoke:wasapi -- --device "USB DAC endpoint" --buffer 256 --json'
    }
    const valid = buildAudioSmokeEvidenceReport({
      entries: [entry],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.deepEqual(valid.json.coverage.passedSurfaces, ['WASAPI Exclusive'])
    assert.equal(valid.json.surfaceRows[0].status, 'pass')

    fs.writeFileSync(artifact, '{"result":"tampered"}\n')
    const invalid = buildAudioSmokeEvidenceReport({
      entries: [entry],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.deepEqual(invalid.json.coverage.missingArtifactSurfaces, ['WASAPI Exclusive'])
    assert.equal(invalid.json.actionPlan[0].status, 'invalid-artifact')
    assert.match(invalid.markdown, /artifact-sha256-mismatch|invalid-artifact/)

    const mock = buildAudioSmokeEvidenceReport({
      entries: [{ ...entry, evidenceKind: 'mock' }],
      operationalResults: [
        { scenario: 'soak-2h', status: 'not-run', notes: 'No attached device.' }
      ],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.deepEqual(mock.json.coverage.nonHardwareEvidenceSurfaces, ['WASAPI Exclusive'])
    assert.equal(mock.json.actionPlan[0].status, 'not-real-device')
    assert.equal(
      mock.json.operationalScenarioRows.find((item) => item.scenario === 'soak-2h').status,
      'not-run'
    )
    assert.equal(mock.json.operationalScenarioRows.length, 5)

    const softwareOnly = buildAudioSmokeEvidenceReport({
      entries: [{ ...entry, evidenceKind: 'software-only' }],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.deepEqual(softwareOnly.json.coverage.nonHardwareEvidenceSurfaces, ['WASAPI Exclusive'])
    assert.match(
      softwareOnly.markdown,
      /\| WASAPI Exclusive \| pass \| software-only \| not-hardware-evidence \|/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('operational evidence preserves envelope fields and rejects mock, incomplete, and short passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-operational-evidence-test-'))
  try {
    const artifact = path.join(dir, 'track-switch-raw.json')
    fs.writeFileSync(artifact, '{"result":"captured"}\n')
    const artifactSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifact))
      .digest('hex')
    const operationalResult = {
      scenario: 'track-switch-loop-30m',
      status: 'pass',
      surface: 'WASAPI Exclusive',
      device: 'USB DAC endpoint',
      driver: 'USB Audio 3.2.1',
      format: 'int24-in32/192000Hz/2ch',
      bufferFrames: 256,
      playbackDurationSeconds: 1800,
      expectedState: 'actualBackend=wasapi-exclusive; exclusive=true',
      observedState: 'switches=600; no silent fallback',
      artifact,
      artifactSha256,
      capturedAt: '2026-08-31T12:00:00.000Z',
      inputCommand: 'pnpm run smoke:wasapi -- --device "USB DAC endpoint" --json',
      evidenceKind: 'real-device',
      switchCount: 600,
      underrunCount: 0,
      deviceLostCount: 0,
      recoveryCount: 0
    }
    const envelopePath = path.join(dir, 'envelope.json')
    fs.writeFileSync(envelopePath, JSON.stringify({ operationalResults: [operationalResult] }))
    const outputDir = path.join(dir, 'out')
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'audio-smoke-evidence.cjs'),
        '--input',
        envelopePath,
        '--output-dir',
        outputDir
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0)
    const report = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'audio-smoke-evidence.json'), 'utf8')
    )
    const row = report.operationalScenarioRows.find(
      (item) => item.scenario === 'track-switch-loop-30m'
    )
    assert.equal(row.status, 'pass')
    assert.equal(row.observedState, operationalResult.observedState)
    assert.equal(row.switchCount, 600)
    assert.equal(row.underrunCount, 0)
    assert.equal(row.deviceLostCount, 0)
    assert.equal(row.recoveryCount, 0)

    const fallbackEnvelopePath = path.join(dir, 'fallback-envelope.json')
    fs.writeFileSync(
      fallbackEnvelopePath,
      JSON.stringify({
        operationalResults: [
          {
            ...operationalResult,
            status: 'not-run',
            artifact: '',
            artifactSha256: ''
          }
        ]
      })
    )
    const fallbackOutputDir = path.join(dir, 'fallback-out')
    const fallback = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'audio-smoke-evidence.cjs'),
        '--input',
        fallbackEnvelopePath,
        '--output-dir',
        fallbackOutputDir
      ],
      { encoding: 'utf8' }
    )
    assert.equal(fallback.status, 0)
    const fallbackReport = JSON.parse(
      fs.readFileSync(path.join(fallbackOutputDir, 'audio-smoke-evidence.json'), 'utf8')
    )
    const fallbackRow = fallbackReport.operationalScenarioRows.find(
      (item) => item.scenario === 'track-switch-loop-30m'
    )
    assert.equal(fallbackRow.artifact, fallbackEnvelopePath)
    assert.equal(fallbackRow.observedState, operationalResult.observedState)
    assert.equal(fallbackRow.switchCount, 600)
    assert.equal(fallbackRow.underrunCount, 0)
    assert.equal(fallbackRow.deviceLostCount, 0)
    assert.equal(fallbackRow.recoveryCount, 0)

    const insufficientDuration = buildAudioSmokeEvidenceReport({
      operationalResults: [{ ...operationalResult, playbackDurationSeconds: 120 }],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.equal(
      insufficientDuration.json.operationalScenarioRows.find(
        (item) => item.scenario === 'track-switch-loop-30m'
      ).status,
      'insufficient-duration'
    )

    const mock = buildAudioSmokeEvidenceReport({
      operationalResults: [{ ...operationalResult, evidenceKind: 'mock' }],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.equal(
      mock.json.operationalScenarioRows.find((item) => item.scenario === 'track-switch-loop-30m')
        .status,
      'not-real-device'
    )

    const incomplete = buildAudioSmokeEvidenceReport({
      operationalResults: [{ scenario: 'track-switch-loop-30m', status: 'pass' }],
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.equal(
      incomplete.json.operationalScenarioRows.find(
        (item) => item.scenario === 'track-switch-loop-30m'
      ).status,
      'not-real-device'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('operational evidence registers controlled explicit endpoint disappearance', () => {
  const report = buildAudioSmokeEvidenceReport({
    operationalResults: [
      {
        scenario: 'explicit-disappearance',
        status: 'pass',
        evidenceKind: 'software-only',
        observedState:
          'hidden endpoint stopped without default fallback; explicit reopen recovered',
        notes: 'Controlled visibility hide/show; not physical USB unplug/replug.'
      }
    ]
  })
  const row = report.json.operationalScenarioRows.find(
    (item) => item.scenario === 'explicit-disappearance'
  )
  assert.equal(row.label, 'Controlled explicit endpoint disappearance')
  assert.equal(row.status, 'not-real-device')
  assert.equal(row.expectedState.includes('without falling back'), true)
  assert.equal(report.json.operationalScenarioSchema.length, 5)
})

test('CoreAudio Hog action plan requires the exclusive backend and hog expected state', () => {
  const coverage = buildCoverageSummary([])
  const coreAudioGuide = buildCollectionActionPlan(coverage).find(
    (item) => item.surface === 'CoreAudio Hog'
  )
  assert.match(coreAudioGuide.command, /--backend coreaudio-exclusive/)
  assert.match(coreAudioGuide.requiredEvidence, /accessMode=hog/)

  const report = buildAudioSmokeEvidenceReport({
    entries: [
      {
        surface: 'CoreAudio Hog',
        status: 'pass',
        evidenceKind: 'real-device',
        device: 'Mac DAC',
        driver: 'CoreAudio',
        format: 'int24/192000Hz/2ch',
        bufferFrames: 256,
        playbackDurationSeconds: 1800,
        expectedState: 'actualBackend=coreaudio; accessMode=shared',
        artifact: 'artifact.json',
        artifactSha256: 'a'.repeat(64),
        capturedAt: '2026-08-31T12:00:00.000Z',
        inputCommand: 'pnpm run smoke:audio-format-matrix -- --backend coreaudio-exclusive'
      }
    ],
    verifyArtifacts: true
  })
  assert.deepEqual(report.json.coverage.missingArtifactSurfaces, ['CoreAudio Hog'])
  assert.equal(report.json.actionPlan[0].surface, 'CoreAudio Hog')
  assert.equal(report.json.actionPlan[0].status, 'invalid-artifact')
})

test('audio smoke evidence CLI rejects missing flag values', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'audio-smoke-evidence.cjs'), '--input', '--output-dir', 'unused'],
    { encoding: 'utf8' }
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--input requires a value/)
})

test('audio smoke evidence CLI accepts UTF-8 BOM JSON from Windows tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-test-'))
  try {
    const inputPath = path.join(dir, 'summary.json')
    fs.writeFileSync(
      inputPath,
      `\uFEFF${JSON.stringify({
        device: { label: 'Desk DAC' },
        results: [
          { ok: true, label: 'WASAPI Exclusive hardware smoke', backend: 'wasapi-exclusive' }
        ]
      })}`
    )
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'audio-smoke-evidence.cjs'), '--input', inputPath, '--output-dir', dir],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 0)
    assert.match(
      fs.readFileSync(path.join(dir, 'audio-smoke-evidence.md'), 'utf8'),
      /\| WASAPI Exclusive \| pass \|/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence can merge multiple smoke summary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-merge-test-'))
  try {
    const wasapiPath = path.join(dir, 'wasapi.json')
    const asioPath = path.join(dir, 'asio.json')
    fs.writeFileSync(
      wasapiPath,
      JSON.stringify({
        device: { label: 'Desk DAC' },
        results: [
          { ok: true, label: 'WASAPI Exclusive hardware smoke', backend: 'wasapi-exclusive' }
        ]
      })
    )
    fs.writeFileSync(
      asioPath,
      JSON.stringify({
        device: { label: 'Studio ASIO' },
        results: [
          { ok: false, label: 'ASIO PCM smoke', backend: 'asio', error: 'Driver rejected PCM open' }
        ]
      })
    )

    const entries = readEntriesFromInputs([wasapiPath, asioPath])
    const report = buildAudioSmokeEvidenceReport({ entries })

    assert.equal(entries.length, 2)
    assert.match(report.markdown, /\| WASAPI Exclusive \| pass \|/)
    assert.match(report.markdown, /\| ASIO PCM \| fail \|/)
    assert.match(report.markdown, /Driver rejected PCM open/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence accepts UTF-16 LE smoke JSON from Windows PowerShell redirection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-utf16-test-'))
  try {
    const inputPath = path.join(dir, 'asio.json')
    const json = JSON.stringify({
      device: { name: 'Studio ASIO' },
      results: [{ ok: true, label: 'ASIO PCM smoke', backend: 'asio' }]
    })
    fs.writeFileSync(
      inputPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
    )

    const entries = readEntriesFromInputs([inputPath])

    assert.equal(entries.length, 1)
    assert.equal(entries[0].surface, 'ASIO PCM')
    assert.equal(entries[0].status, 'pass')
    assert.equal(entries[0].artifact, inputPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence CLI can read a directory of smoke JSON summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-dir-test-'))
  const outputDir = path.join(dir, 'out')
  try {
    fs.writeFileSync(
      path.join(dir, 'dop.json'),
      JSON.stringify({
        device: { label: 'DoP DAC' },
        results: [
          {
            ok: true,
            label: 'DoP DAC carrier smoke',
            backend: 'wasapi-exclusive',
            info: { dsdMode: 'dop' }
          }
        ]
      })
    )
    fs.writeFileSync(
      path.join(dir, 'sacd.json'),
      JSON.stringify({
        device: { label: 'SACD ISO fixture' },
        results: [{ ok: true, label: 'SACD ISO playback smoke', backend: 'wasapi-exclusive' }]
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'audio-smoke-evidence.cjs'),
        '--input-dir',
        dir,
        '--output-dir',
        outputDir
      ],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 0)
    const markdown = fs.readFileSync(path.join(outputDir, 'audio-smoke-evidence.md'), 'utf8')
    assert.match(markdown, /\| DoP DAC \| pass \|/)
    assert.match(markdown, /\| SACD ISO \| pass \|/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence CLI treats an input entries file as the fallback artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-entry-artifact-test-'))
  try {
    const inputPath = path.join(dir, 'entries.json')
    fs.writeFileSync(
      inputPath,
      JSON.stringify([
        {
          surface: 'WASAPI Exclusive',
          id: 'wasapi-entry-pass',
          label: 'WASAPI Exclusive entry smoke',
          status: 'pass'
        }
      ])
    )

    const entries = readEntriesFromInputs([inputPath])
    assert.equal(entries[0].artifact, inputPath)
    const report = buildAudioSmokeEvidenceReport({
      entries,
      verifyArtifacts: true,
      artifactBaseDir: dir
    })
    assert.deepEqual(report.json.coverage.passedSurfaces, [])
    assert.deepEqual(report.json.coverage.unbackedPassSurfaces, [])
    assert.deepEqual(report.json.coverage.nonHardwareEvidenceSurfaces, ['WASAPI Exclusive'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence CLI reports missing artifact paths as incomplete evidence', () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'twilight-audio-evidence-missing-artifact-test-')
  )
  try {
    const inputPath = path.join(dir, 'entries.json')
    fs.writeFileSync(
      inputPath,
      JSON.stringify([
        {
          surface: 'WASAPI Exclusive',
          id: 'wasapi-missing-artifact',
          label: 'WASAPI Exclusive missing artifact smoke',
          status: 'pass',
          artifact: 'missing-wasapi.json',
          evidenceKind: 'real-device'
        }
      ])
    )
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'audio-smoke-evidence.cjs'),
        '--input',
        inputPath,
        '--output-dir',
        dir,
        '--require-complete'
      ],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /WASAPI Exclusive=invalid-artifact/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence CLI can fail when required surface evidence is incomplete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-evidence-strict-test-'))
  try {
    const inputPath = path.join(dir, 'wasapi.json')
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        device: { label: 'Desk DAC' },
        results: [
          { ok: true, label: 'WASAPI Exclusive hardware smoke', backend: 'wasapi-exclusive' }
        ]
      })
    )
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'audio-smoke-evidence.cjs'),
        '--input',
        inputPath,
        '--output-dir',
        dir,
        '--require-complete'
      ],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Audio smoke evidence incomplete/)
    assert.match(result.stderr, /ASIO PCM=not-run/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
