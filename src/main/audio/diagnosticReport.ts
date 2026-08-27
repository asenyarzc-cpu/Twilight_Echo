/**
 * Turns an audio diagnostic snapshot into a report a person can read.
 *
 * The JSON export answers "what is the machine state"; it does not answer the
 * question users actually have, which is "why is my audio not bit-perfect and
 * what do I change". This module answers that second question in the user's
 * language, leading with a verdict and then one section per reason, each with
 * what is happening and what to do about it.
 *
 * Markdown, not HTML: it pastes into a GitHub issue, a forum post or a chat
 * window without losing structure, which is where these reports actually go.
 */
import {
  resolveReasonCode,
  sortReasonsBySeverity,
  type ResolvedReason
} from '../../shared/audio/reasonCodes.ts'
import type { AppLocale } from '../../shared/i18n/locale.ts'
import { translate, type MessageParams } from '../../shared/i18n/translate.ts'
import type {
  AudioDiagnosticBlocker,
  AudioDiagnosticEvent,
  AudioDiagnosticReport
} from './audioDiagnostics.ts'

const TIMELINE_EVENT_LIMIT = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: unknown, key: string): string {
  if (!isRecord(source)) return ''
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source: unknown, key: string): number {
  if (!isRecord(source)) return 0
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readBoolean(source: unknown, key: string): boolean {
  return isRecord(source) && source[key] === true
}

/** Blockers as stored in the snapshot, tolerating a shape that predates this. */
function readBlockers(diagnosis: unknown): AudioDiagnosticBlocker[] {
  if (!isRecord(diagnosis)) return []
  const raw = diagnosis.blockers
  if (!Array.isArray(raw)) return []
  const blockers: AudioDiagnosticBlocker[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const code = typeof item.code === 'string' ? item.code : ''
    if (!code) continue
    blockers.push({
      code,
      value: item.value,
      origin: (item.origin as AudioDiagnosticBlocker['origin']) ?? 'output'
    })
  }
  return blockers
}

/** A blocker's `value` becomes the `{value}` placeholder in its copy. */
function reasonParams(value: unknown): MessageParams {
  if (value === undefined || value === null) return {}
  if (typeof value === 'number') {
    // Volume and rate read as percentages/multipliers, not raw floats.
    return { value: Number.isInteger(value) ? value : Number(value.toFixed(3)) }
  }
  if (typeof value === 'string' || typeof value === 'boolean') return { value }
  return {}
}

function formatHz(rate: number): string {
  if (rate <= 0) return '—'
  return rate >= 1000 ? `${Math.round(rate / 100) / 10} kHz` : `${rate} Hz`
}

/**
 * Every reason the report should explain, most severe first.
 *
 * `perfectReasonCode` is the engine's single headline reason; `blockers` is the
 * app's own list. They overlap (both may report `volume_not_unity`), so they are
 * merged by code — a user should never read the same explanation twice.
 */
export function collectReportReasons(locale: AppLocale, diagnosis: unknown): ResolvedReason[] {
  const seen = new Set<string>()
  const reasons: ResolvedReason[] = []

  const push = (code: string, value?: unknown): void => {
    const trimmed = code.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    reasons.push(resolveReasonCode(locale, trimmed, reasonParams(value)))
  }

  push(readString(diagnosis, 'perfectReasonCode'))
  for (const blocker of readBlockers(diagnosis)) push(blocker.code, blocker.value)

  return sortReasonsBySeverity(reasons)
}

/**
 * The events array carries both app-side records and drained engine ring
 * entries (source: "engine"). A raw dump is noise; the timeline keeps the
 * entries that explain a non-perfect state — every warning/error plus the
 * engine's DSD route decisions — capped to the newest ones.
 */
export function selectTimelineEvents(events: AudioDiagnosticEvent[]): AudioDiagnosticEvent[] {
  const selected = events.filter(
    (event) =>
      event.level !== 'info' ||
      (typeof event.event === 'string' && event.event.startsWith('dsd_route'))
  )
  return selected.slice(-TIMELINE_EVENT_LIMIT)
}

/** "2026-08-27T12:34:56.789Z" -> "08-27 12:34:56.789"; non-ISO strings pass through. */
function timelineClock(timestamp: string): string {
  const match = /^(\d{4})-(\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(timestamp)
  return match ? `${match[2]} ${match[3]}` : timestamp
}

function renderTimelineSection(
  locale: AppLocale,
  events: AudioDiagnosticEvent[],
  lines: string[]
): void {
  const t = (key: string, params?: MessageParams): string => translate(locale, key, params)
  const timeline = selectTimelineEvents(events)
  lines.push(`## ${t('diagnostics.export.timelineHeading')}`, '')
  if (timeline.length === 0) {
    lines.push(t('diagnostics.export.timelineEmpty'), '')
    return
  }
  for (const event of timeline) {
    const details = isRecord(event.details) ? event.details : {}
    const message = typeof details.message === 'string' ? details.message.trim() : ''
    const origin = details.source === 'engine' ? 'engine' : 'app'
    const clock = timelineClock(event.timestamp)
    const suffix = message && message !== event.event ? `：${message}` : ''
    lines.push(`- \`${clock}\` [${event.level}] (${origin}) \`${event.event}\`${suffix}`)
  }
  lines.push('')
}

function renderPlaybackSection(locale: AppLocale, playback: unknown, lines: string[]): void {
  if (!isRecord(playback)) return
  const t = (key: string, params?: MessageParams): string => translate(locale, key, params)

  const sourceFormat = playback.sourceFormat
  const actual = playback.actualOutput
  const sourceParts = [
    readString(playback, 'codec'),
    formatHz(readNumber(sourceFormat, 'sampleRate')),
    readNumber(sourceFormat, 'bitDepth') > 0 ? `${readNumber(sourceFormat, 'bitDepth')}bit` : '',
    readNumber(sourceFormat, 'channels') > 0 ? `${readNumber(sourceFormat, 'channels')}ch` : '',
    readBoolean(sourceFormat, 'dsd') ? 'DSD' : ''
  ].filter(Boolean)

  const actualParts = [
    readString(actual, 'backend'),
    readString(actual, 'format'),
    formatHz(readNumber(actual, 'sampleRate')),
    readNumber(actual, 'bitDepth') > 0 ? `${readNumber(actual, 'bitDepth')}bit` : '',
    readNumber(actual, 'channels') > 0 ? `${readNumber(actual, 'channels')}ch` : ''
  ].filter(Boolean)

  lines.push(`## ${t('diagnostics.export.currentPlayback')}`, '')
  if (sourceParts.length > 0) {
    lines.push(`- **${t('diagnostics.export.sourceFormat')}**: ${sourceParts.join(' · ')}`)
  }
  if (actualParts.length > 0) {
    lines.push(`- **${t('diagnostics.export.actualOutput')}**: ${actualParts.join(' · ')}`)
  }
  const driver = readString(actual, 'driverName')
  if (driver) lines.push(`- **Driver**: ${driver} ${readString(actual, 'driverVersion')}`.trim())
  lines.push('')
}

/**
 * Render the whole report.
 *
 * Kept pure and synchronous so it can be tested without touching the filesystem
 * or an audio device.
 */
export function renderAudioDiagnosticMarkdown(
  locale: AppLocale,
  report: AudioDiagnosticReport
): string {
  const t = (key: string, params?: MessageParams): string => translate(locale, key, params)
  const lines: string[] = []
  const { snapshot, environment } = report

  // `engineIpc` writes `diagnosis: { unavailable: true }` when playback info
  // could not be read, and `captureDiagnosticValue` turns a failed read into
  // `{ error }`. Both are records, so the authoritative signal is the diagnosis
  // flag — not the shape of `snapshot.playback`.
  const playbackUnavailable =
    readBoolean(snapshot.diagnosis, 'unavailable') ||
    !isRecord(snapshot.playback) ||
    readString(snapshot.playback, 'error') !== ''
  const reasons = collectReportReasons(locale, snapshot.diagnosis)
  const sourceExact = readBoolean(snapshot.playback, 'sourceExact')
  const outputPerfect = readBoolean(snapshot.playback, 'outputPerfect')
  const isPerfect = sourceExact && outputPerfect && reasons.length === 0

  lines.push(`# ${t('diagnostics.export.reportTitle')}`, '')
  lines.push(`- **${t('diagnostics.export.generatedAt')}**: ${report.generatedAt}`)
  lines.push(`- **Session**: \`${report.sessionId}\``)
  lines.push('')

  // ── Verdict first: it is the only line some readers will read. ─────────────
  lines.push(`## ${t('diagnostics.export.conclusion')}`, '')
  if (playbackUnavailable) {
    lines.push(t('diagnostics.export.conclusionNoPlayback'))
  } else if (isPerfect) {
    lines.push(t('diagnostics.export.conclusionPerfect'))
  } else {
    lines.push(t('diagnostics.export.conclusionNotPerfect', { count: reasons.length }))
  }
  lines.push('')

  renderPlaybackSection(locale, snapshot.playback, lines)

  if (reasons.length > 0) {
    lines.push(`## ${t('diagnostics.export.reasonsHeading')}`, '')
    reasons.forEach((reason, index) => {
      const severity = t(`diagnostics.severity.${reason.severity}`)
      const origin = t(`diagnostics.origin.${reason.origin}`)
      lines.push(`### ${index + 1}. ${reason.label}`, '')
      lines.push(`\`${reason.code}\` · ${severity} · ${origin}`, '')
      // The separator is locale copy too: a fullwidth colon is correct in
      // Chinese and wrong in English.
      const sep = t('punct.labelSeparator')
      if (reason.explain) {
        lines.push(`**${t('diagnostics.export.whatHappens')}**${sep}${reason.explain}`, '')
      }
      lines.push(
        `**${t('diagnostics.export.whatToDo')}**${sep}${
          reason.fix || t('diagnostics.export.noActionNeeded')
        }`,
        ''
      )
    })
  }

  lines.push(`## ${t('diagnostics.export.environment')}`, '')
  lines.push(`- ${environment.appName} ${environment.appVersion}`)
  lines.push(`- ${environment.platform} ${environment.architecture} (${environment.osRelease})`)
  lines.push(`- Electron ${environment.processVersions.electron ?? '—'}`)
  lines.push(`- Node ${environment.processVersions.node}`)
  lines.push(`- Locale: ${environment.locale}`)
  lines.push(`- Packaged: ${environment.packaged ? 'yes' : 'no'}`)
  lines.push('')

  renderTimelineSection(locale, report.events, lines)

  lines.push(`## ${t('diagnostics.export.privacyHeading')}`, '')
  lines.push(t('diagnostics.export.privacyNote'), '')

  lines.push(`## ${t('diagnostics.export.rawHeading')}`, '')
  lines.push(t('diagnostics.export.eventCount', { count: report.events.length }), '')
  lines.push('<details>', '')
  lines.push('```json')
  lines.push(JSON.stringify(report, null, 2))
  lines.push('```', '')
  lines.push('</details>', '')

  return lines.join('\n')
}
