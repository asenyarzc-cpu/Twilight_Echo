import assert from 'node:assert/strict'
import test from 'node:test'
import type { AudioDiagnosticReport } from './audioDiagnostics.ts'
import {
  collectReportReasons,
  renderAudioDiagnosticMarkdown,
  selectTimelineEvents
} from './diagnosticReport.ts'

function buildReport(
  overrides: {
    diagnosis?: unknown
    playback?: unknown
    events?: AudioDiagnosticReport['events']
  } = {}
): AudioDiagnosticReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-23T12:00:00.000Z',
    sessionId: 'session-under-test',
    privacy: {
      audioPayloadCaptured: false,
      fullLocalPathsCaptured: false,
      urlQueryCaptured: false,
      note: 'redacted'
    },
    environment: {
      appName: 'TwilightEcho',
      appVersion: '1.1.4',
      packaged: true,
      platform: 'win32',
      architecture: 'x64',
      osRelease: '10.0.26200',
      locale: 'zh-CN',
      processVersions: { electron: '33.2.0', chrome: '130', node: '20.18.0', modules: '130' }
    },
    snapshot: {
      playback: overrides.playback ?? {
        codec: 'FLAC',
        sourceExact: false,
        outputPerfect: false,
        sourceFormat: { sampleRate: 96000, bitDepth: 24, channels: 2, dsd: false },
        actualOutput: { backend: 'wasapi-exclusive', format: 'int32', sampleRate: 96000 }
      },
      outputState: {},
      outputConfig: {},
      effectiveOutputConfig: {},
      outputConfigApplyStatus: {},
      configuredProcessing: {},
      effectiveProcessing: {},
      engineProcessing: {},
      headphoneCompensation: {},
      dspSceneState: {},
      dspGraphStatus: {},
      diagnosis: overrides.diagnosis ?? {}
    },
    events: overrides.events ?? []
  }
}

test('merges the engine headline reason with the app blocker list, without repeating', () => {
  const reasons = collectReportReasons('zh-CN', {
    perfectReasonCode: 'volume_not_unity',
    blockers: [
      // Same code the engine already reported: must not produce two sections.
      { code: 'volume_not_unity', value: 0.7, origin: 'player' },
      { code: 'eq_active', origin: 'processing' }
    ]
  })
  const codes = reasons.map((reason) => reason.code)
  assert.deepEqual(codes.filter((code) => code === 'volume_not_unity').length, 1)
  assert.ok(codes.includes('eq_active'))
})

test('orders reasons by severity so blockers lead', () => {
  const reasons = collectReportReasons('zh-CN', {
    blockers: [
      { code: 'source_lossy', origin: 'source' }, // info
      { code: 'dsd_processing_pcm_fallback', origin: 'processing' }, // degraded
      { code: 'eq_active', origin: 'processing' } // blocking
    ]
  })
  assert.deepEqual(
    reasons.map((reason) => reason.severity),
    ['blocking', 'degraded', 'info']
  )
})

test('a bit-perfect chain reports a clean verdict', () => {
  const report = buildReport({
    playback: { codec: 'FLAC', sourceExact: true, outputPerfect: true },
    diagnosis: { blockers: [] }
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /已验证为逐位直通/)
  assert.doesNotMatch(markdown, /不是\*\*逐位直通/)
})

test('a non-perfect chain leads with the verdict and counts the reasons', () => {
  const report = buildReport({
    diagnosis: {
      perfectReasonCode: 'shared_mixer',
      blockers: [{ code: 'volume_not_unity', value: 0.7, origin: 'player' }]
    }
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /共 2 项原因/)
  // The verdict must precede the detail: a reader who stops after one line
  // should still learn the outcome.
  assert.ok(markdown.indexOf('## 结论') < markdown.indexOf('## 原因逐条说明'))
})

test('every reason section carries what-happens and what-to-do', () => {
  const report = buildReport({
    diagnosis: { blockers: [{ code: 'volume_not_unity', value: 0.7, origin: 'player' }] }
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /\*\*发生了什么\*\*/)
  assert.match(markdown, /\*\*怎么办\*\*/)
  // The machine code stays visible for bug reports.
  assert.match(markdown, /`volume_not_unity`/)
})

test('a reason with no user-actionable fix says so instead of leaving a blank', () => {
  const report = buildReport({
    diagnosis: { blockers: [{ code: 'source_lossy', origin: 'source' }] }
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /这一项不需要也无法由用户处理/)
  // Never an empty bullet where copy should be.
  assert.doesNotMatch(markdown, /\*\*怎么办\*\*：\s*\n/)
})

test('renders in English without leaking Chinese punctuation', () => {
  const report = buildReport({
    diagnosis: { blockers: [{ code: 'volume_not_unity', value: 0.7, origin: 'player' }] }
  })
  const markdown = renderAudioDiagnosticMarkdown('en-US', report)
  assert.match(markdown, /What happens/)
  assert.match(markdown, /What to do/)
  assert.match(markdown, /Software volume is not 100%/)
  // The separator after a bold label must be an ASCII colon in English.
  assert.match(markdown, /\*\*What happens\*\*: /)
  assert.doesNotMatch(markdown, /\*\*What happens\*\*：/)
})

test('an unknown code still produces a searchable section rather than a blank', () => {
  const report = buildReport({
    diagnosis: { perfectReasonCode: 'brand_new_engine_reason' }
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /brand_new_engine_reason/)
  assert.match(markdown, /未收录的原因代码/)
})

test('a snapshot with no playback says so instead of claiming success', () => {
  const report = buildReport({ playback: null, diagnosis: { unavailable: true } })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /没有正在播放/)
  assert.doesNotMatch(markdown, /已验证为逐位直通/)
})

test('the raw JSON is embedded for developers and the event count reported', () => {
  const report = buildReport({
    events: [
      {
        timestamp: '2026-08-23T12:00:00.000Z',
        sessionId: 'session-under-test',
        sequence: 1,
        level: 'warning',
        event: 'playback-state',
        details: {}
      }
    ]
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /共 1 条事件记录/)
  assert.match(markdown, /```json/)
  assert.match(markdown, /session-under-test/)
})

test('the timeline keeps warnings/errors and DSD route decisions, dropping info noise', () => {
  const event = (
    sequence: number,
    level: 'info' | 'warning' | 'error',
    event: string,
    details: Record<string, unknown> = {}
  ) => ({
    timestamp: `2026-08-23T12:00:0${sequence}.000Z`,
    sessionId: 'session-under-test',
    sequence,
    level,
    event,
    details
  })
  const selected = selectTimelineEvents([
    event(1, 'info', 'engine-ready'),
    event(2, 'info', 'playback-state', { source: 'app' }),
    event(3, 'info', 'dsd_route_decision', {
      source: 'engine',
      message: 'backend=asio dsdRate=64'
    }),
    event(4, 'warning', 'dsd_pcm_fallback', { source: 'engine', message: 'probe failed' }),
    event(5, 'info', 'loudnorm-status')
  ])
  assert.deepEqual(
    selected.map((entry) => entry.event),
    ['dsd_route_decision', 'dsd_pcm_fallback']
  )

  // Capped to the newest entries.
  const many = Array.from({ length: 60 }, (_, index) =>
    event(index + 1, 'warning', `warn-${index + 1}`)
  )
  assert.equal(selectTimelineEvents(many).length, 40)
  assert.equal(selectTimelineEvents(many).at(-1)?.event, 'warn-60')
})

test('the rendered report carries an event timeline with clock, level and origin', () => {
  const report = buildReport({
    events: [
      {
        timestamp: '2026-08-23T12:00:01.500Z',
        sessionId: 'session-under-test',
        sequence: 1,
        level: 'warning',
        event: 'dsd_pcm_fallback',
        details: { source: 'engine', message: 'Current output backend cannot carry DSD or DoP' }
      }
    ]
  })
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', report)
  assert.match(markdown, /事件时间线/)
  assert.match(markdown, /`08-23 12:00:01.500` \[warning\] \(engine\) `dsd_pcm_fallback`/)
  assert.match(markdown, /Current output backend cannot carry DSD or DoP/)
})

test('an empty timeline says so instead of rendering a bare heading', () => {
  const markdown = renderAudioDiagnosticMarkdown('zh-CN', buildReport())
  assert.match(markdown, /事件时间线/)
  assert.match(markdown, /时间线中没有警告或错误事件/)
})

test('malformed diagnosis shapes degrade instead of throwing', () => {
  for (const diagnosis of [
    null,
    undefined,
    0,
    'text',
    [],
    { blockers: 'nope' },
    { blockers: [1, null] }
  ]) {
    assert.doesNotThrow(() => collectReportReasons('zh-CN', diagnosis))
    assert.doesNotThrow(() => renderAudioDiagnosticMarkdown('zh-CN', buildReport({ diagnosis })))
  }
})
