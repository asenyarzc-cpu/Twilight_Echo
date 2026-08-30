const assert = require('node:assert/strict')
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
  assert.equal(report.json.schemaVersion, 1)
  assert.equal(report.json.requiredSurfaces.includes('DoP DAC'), true)
  assert.equal(report.json.requiredSurfaces.includes('SACD ISO'), true)
  assert.equal(report.json.entries[0].status, 'pass')
  assert.equal(report.json.entries[1].status, 'not-run')
  assert.equal(report.json.coverage.complete, false)
  assert.equal(report.json.actionPlan.length, 4)
  assert.equal(
    report.json.actionPlan.some(
      (item) => item.surface === 'SACD ISO' && item.artifact.endsWith('sacd-iso.json')
    ),
    true
  )
  assert.deepEqual(report.json.coverage.missingSurfaces, [
    'ASIO',
    'DoP DAC',
    'Native DSD',
    'SACD ISO'
  ])
  // 5 required hardware + 3 product honesty surfaces
  assert.equal(report.json.surfaceRows.length, 8)
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
  assert.match(report.markdown, /Coverage: 1\/5 required surfaces passed/)
  assert.match(report.markdown, /Complete: no/)
  assert.match(report.markdown, /Optional product honesty surfaces/)
  assert.match(report.markdown, /## Collection Action Plan/)
  assert.match(report.markdown, /pnpm run smoke:asio-native-dsd/)
  assert.match(report.markdown, /output\/audio-smoke-evidence\/sacd-iso\.json/)
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
      'ASIO',
      'DoP DAC',
      'Native DSD',
      'SACD ISO',
      'Loudnorm',
      'Gapless Album',
      'Unity Volume'
    ]
  )
  assert.equal(report.json.surfaceRows[0].status, 'pass')
  assert.equal(report.json.surfaceRows[1].status, 'not-run')
  assert.match(report.markdown, /\| ASIO \| not-run \|/)
  assert.match(report.markdown, /\| DoP DAC \| not-run \|/)
})

test('audio smoke evidence coverage is complete only when every required surface passes', () => {
  const coverage = buildCoverageSummary(
    ['WASAPI Exclusive', 'ASIO', 'DoP DAC', 'Native DSD', 'SACD ISO'].map((surface) => ({
      surface,
      status: 'pass',
      artifact: `output/audio-smoke-evidence/${surface.toLowerCase().replaceAll(' ', '-')}.json`
    }))
  )

  assert.equal(coverage.complete, true)
  assert.equal(coverage.passCount, 5)
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
    entries: ['WASAPI Exclusive', 'ASIO', 'DoP DAC', 'Native DSD', 'SACD ISO'].map((surface) => ({
      surface,
      id: surface.toLowerCase().replaceAll(' ', '-'),
      label: surface,
      status: 'pass',
      artifact: `output/audio-smoke-evidence/${surface.toLowerCase().replaceAll(' ', '-')}.json`
    }))
  })

  assert.equal(report.json.coverage.complete, true)
  assert.equal(report.json.coverage.passCount, 5)
  assert.equal(report.json.surfaceRows.length, 8)
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
    /only counts as passed when at least one `pass` row includes an artifact path/
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
          artifact: artifactPath
        },
        {
          surface: 'ASIO',
          status: 'pass',
          artifact: path.join(dir, 'missing-asio.json')
        }
      ],
      { verifyArtifacts: true }
    )

    assert.deepEqual(coverage.passedSurfaces, ['WASAPI Exclusive'])
    assert.deepEqual(coverage.missingArtifactSurfaces, ['ASIO'])
    const actionPlan = buildCollectionActionPlan(coverage)
    assert.equal(actionPlan[0].surface, 'ASIO')
    assert.equal(actionPlan[0].status, 'missing-artifact')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('audio smoke evidence action plan lists only unresolved required surfaces', () => {
  const coverage = buildCoverageSummary([
    {
      surface: 'WASAPI Exclusive',
      status: 'pass',
      artifact: 'output/audio-smoke-evidence/wasapi-exclusive.json'
    },
    { surface: 'ASIO', status: 'fail' },
    { surface: 'DoP DAC', status: 'skip' },
    { surface: 'Native DSD', status: 'not-run' },
    {
      surface: 'SACD ISO',
      status: 'pass',
      artifact: 'output/audio-smoke-evidence/sacd-iso.json'
    }
  ])

  const actionPlan = buildCollectionActionPlan(coverage)
  assert.deepEqual(
    actionPlan.map((item) => `${item.surface}:${item.status}`),
    ['ASIO:fail', 'Native DSD:not-run', 'DoP DAC:skip']
  )
  assert.match(actionPlan[0].command, /smoke:audio-format-matrix/)
  assert.match(actionPlan[1].command, /smoke:asio-native-dsd/)
  assert.match(actionPlan[2].requiredEvidence, /dsdMode=dop/)
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
    assert.match(report.markdown, /\| ASIO \| fail \|/)
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
    assert.equal(entries[0].surface, 'ASIO')
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
    assert.deepEqual(report.json.coverage.passedSurfaces, ['WASAPI Exclusive'])
    assert.deepEqual(report.json.coverage.unbackedPassSurfaces, [])
    assert.deepEqual(report.json.coverage.missingArtifactSurfaces, [])
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
          artifact: 'missing-wasapi.json'
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
    assert.match(result.stderr, /WASAPI Exclusive=missing-artifact/)
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
    assert.match(result.stderr, /ASIO=not-run/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
