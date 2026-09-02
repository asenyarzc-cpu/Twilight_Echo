/**
 * One registry for every audio reason code the app can show a user.
 *
 * Three code namespaces used to drift apart independently:
 *
 * - `perfectReasonCode` / `capabilityReason`, emitted by the native engine
 *   (`audio-engine/**` C++) and carried on `PlaybackInfo`.
 * - The display labels that lived inline in `PlayerBar.vue`, reachable from
 *   nowhere else — so Settings and the diagnostics export could not reuse them.
 * - `blockers[].code` from `collectAudioBlockers`, computed on every playback
 *   event and, until now, only ever written to the JSON export.
 *
 * They are unified here because they answer the same user question — "why is my
 * audio not bit-perfect, and what do I do about it?" A code carries three
 * message keys instead of one label:
 *
 * - `label`   — the short chip/row text.
 * - `explain` — what is actually happening to the samples.
 * - `fix`     — the concrete next action, or '' when nothing is actionable
 *               (a hardware limit is not a user error).
 *
 * `scripts/audio-reason-code-coverage.test.cjs` greps the C++ sources for
 * `perfectReasonCode = "..."` and fails when a code is missing from here, so a
 * new native reason can no longer reach the UI as a bare English identifier.
 */

import type { AppLocale } from '../i18n/locale.ts'
import { t, type MessageParams } from '../i18n/translate.ts'

/** How much the code should alarm the user. */
export type ReasonSeverity =
  | 'blocking' // Samples are being altered, or output failed outright.
  | 'degraded' // Playing, but not the transport the user asked for.
  | 'info' // Worth surfacing; not a problem.

/** Which layer decided this, i.e. where the user should go to change it. */
export type ReasonOrigin =
  | 'player' // Transport controls: volume, rate.
  | 'processing' // Audio processing settings.
  | 'dsp-scene' // The DSP graph / output stage.
  | 'output' // Device, backend, routing.
  | 'source' // The file itself.
  | 'engine' // Native engine or driver fault.

export interface ReasonCodeEntry {
  severity: ReasonSeverity
  origin: ReasonOrigin
  /**
   * Settings section id to deep-link to, when the user can act on it in-app.
   * Matches the `id` attributes the settings sections already declare.
   */
  settingsAnchor?: string
}

/**
 * Every code the app may display. Keys double as the i18n key suffix:
 * `audio.reason.<code>.label` / `.explain` / `.fix`.
 */
export const AUDIO_REASON_CODES: Record<string, ReasonCodeEntry> = {
  // ── Transport controls ────────────────────────────────────────────────────
  volume_not_unity: { severity: 'blocking', origin: 'player', settingsAnchor: 'playback' },
  playback_rate_not_unity: { severity: 'blocking', origin: 'player', settingsAnchor: 'playback' },

  // ── Processing chain ─────────────────────────────────────────────────────
  processing_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'playback' },
  replaygain_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'playback' },
  loudnorm_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'playback' },
  eq_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'dsp' },
  convolver_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'dsp' },
  crossfeed_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'dsp' },
  crossfade_active: { severity: 'blocking', origin: 'processing', settingsAnchor: 'playback' },
  dsd_output_mode_pcm: { severity: 'degraded', origin: 'processing', settingsAnchor: 'playback' },

  // ── DSP scene / output stage ─────────────────────────────────────────────
  dsp_scene_requires_pcm: { severity: 'degraded', origin: 'dsp-scene', settingsAnchor: 'dsp' },
  output_sample_rate_locked: { severity: 'blocking', origin: 'dsp-scene', settingsAnchor: 'dsp' },
  output_resampler_active: { severity: 'blocking', origin: 'dsp-scene', settingsAnchor: 'dsp' },
  output_dither_active: { severity: 'blocking', origin: 'dsp-scene', settingsAnchor: 'dsp' },

  // ── Output routing / device ──────────────────────────────────────────────
  shared_mixer: { severity: 'blocking', origin: 'output', settingsAnchor: 'playback' },
  routing_not_auto: { severity: 'blocking', origin: 'output', settingsAnchor: 'playback' },
  routing_changes_semantics: { severity: 'blocking', origin: 'output', settingsAnchor: 'dsp' },
  plugin_path: { severity: 'blocking', origin: 'output', settingsAnchor: 'playback' },
  hog_mode_failed: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  sample_rate_unsupported: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  device_not_found: { severity: 'blocking', origin: 'output', settingsAnchor: 'playback' },
  format_not_supported: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  pcm_converted: { severity: 'blocking', origin: 'output' },
  integer_passthrough_unavailable: { severity: 'degraded', origin: 'output' },
  backend_not_output_perfect: { severity: 'info', origin: 'output', settingsAnchor: 'playback' },
  output_not_perfect: { severity: 'info', origin: 'output' },

  // ── Source properties ────────────────────────────────────────────────────
  source_lossy: { severity: 'info', origin: 'source' },
  source_format_differs: { severity: 'degraded', origin: 'source' },

  // ── DSD transport ────────────────────────────────────────────────────────
  dsd_dop: { severity: 'info', origin: 'output' },
  dsd_processing_pcm_fallback: {
    severity: 'degraded',
    origin: 'processing',
    settingsAnchor: 'dsp'
  },
  // Non-unity software volume forces a DSD source through PCM. It is its own
  // code because the fix is the opposite of the DSP-chain one: direct mode does
  // not clear it, so pointing the listener at the DSP rack sends them nowhere.
  dsd_volume_pcm_fallback: {
    severity: 'degraded',
    origin: 'player',
    settingsAnchor: 'playback'
  },
  dsd_high_rate_pcm_fallback: {
    severity: 'degraded',
    origin: 'output',
    settingsAnchor: 'playback'
  },
  dsd_downrated: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  dsd_converted_to_pcm: { severity: 'degraded', origin: 'processing', settingsAnchor: 'playback' },
  dsd_probe_failed: { severity: 'degraded', origin: 'source', settingsAnchor: 'playback' },
  dsd_backend_cannot_carry: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  dsd_source_unsupported: { severity: 'degraded', origin: 'source' },
  dop_carrier_mismatch: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  dop_passthrough_unproven: { severity: 'info', origin: 'output' },
  dop_marker_mismatch: { severity: 'degraded', origin: 'output', settingsAnchor: 'playback' },
  native_dsd_runtime_unproven: { severity: 'info', origin: 'output' },
  native_dsd_typed_callback_missing: { severity: 'degraded', origin: 'engine' },
  native_dsd_buffer_unit_mismatch: { severity: 'degraded', origin: 'engine' },
  dsd_mute_lock_timeout: { severity: 'blocking', origin: 'engine', settingsAnchor: 'playback' },
  sacd_iso_unsupported: { severity: 'degraded', origin: 'source' },
  dst_dsd_provider_unavailable: { severity: 'degraded', origin: 'source' },
  dst_dsd_provider_failed: { severity: 'degraded', origin: 'source' },

  // ── Engine / driver faults ───────────────────────────────────────────────
  backend_open_failure: { severity: 'blocking', origin: 'engine', settingsAnchor: 'playback' },
  backend_start_failure: { severity: 'blocking', origin: 'engine', settingsAnchor: 'playback' },
  buffer_failure: { severity: 'blocking', origin: 'engine', settingsAnchor: 'playback' },
  device_lost: { severity: 'blocking', origin: 'engine' },
  driver_restart: { severity: 'degraded', origin: 'engine' },
  unsupported_asio_sample_type: { severity: 'degraded', origin: 'engine' },
  asio_helper_launch_failed: { severity: 'blocking', origin: 'engine', settingsAnchor: 'playback' },
  asio_helper_protocol_error: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_control_timeout: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_process_exited: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_callback_stalled: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_device_rejected: {
    severity: 'degraded',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_format_restore_failed: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  asio_helper_command_failed: {
    severity: 'blocking',
    origin: 'engine',
    settingsAnchor: 'playback'
  },
  topology_rollback_failed: { severity: 'blocking', origin: 'engine' },

  // ── Misc ─────────────────────────────────────────────────────────────────
  visualization_inactive: { severity: 'info', origin: 'engine' }
}

/**
 * `collectAudioBlockers` emits one code per enabled DSP node as
 * `dsp_node_<type>`. Rendering each of those as its own catalog entry would
 * duplicate the node names the DSP UI already owns, so they resolve through a
 * shared template plus the node-type name.
 */
const DSP_NODE_CODE_PREFIX = 'dsp_node_'

export function isDspNodeReasonCode(code: string): boolean {
  return code.startsWith(DSP_NODE_CODE_PREFIX)
}

export function dspNodeTypeFromReasonCode(code: string): string {
  return isDspNodeReasonCode(code) ? code.slice(DSP_NODE_CODE_PREFIX.length) : ''
}

export interface ResolvedReason {
  code: string
  severity: ReasonSeverity
  origin: ReasonOrigin
  label: string
  explain: string
  /** Empty when the situation is not something the user can act on. */
  fix: string
  settingsAnchor?: string
  /** False when the code has no catalog entry, so callers can log the gap. */
  known: boolean
}

/**
 * Turn a raw code into displayable copy. Unknown codes still produce a usable
 * row — the code itself as the label — because showing "why not bit-perfect: (
 * blank )" is worse than showing an identifier a user can search or report.
 */
export function resolveReasonCode(
  locale: AppLocale,
  code: string,
  params: MessageParams = {}
): ResolvedReason {
  const trimmed = code.trim()
  if (!trimmed) {
    return {
      code: '',
      severity: 'info',
      origin: 'engine',
      label: '',
      explain: '',
      fix: '',
      known: false
    }
  }

  if (isDspNodeReasonCode(trimmed)) {
    const nodeType = dspNodeTypeFromReasonCode(trimmed)
    const nodeName = t(locale, `audio.dspNode.${nodeType}`, {}, nodeType)
    return {
      code: trimmed,
      severity: 'blocking',
      origin: 'dsp-scene',
      label: t(locale, 'audio.reason.dsp_node.label', { node: nodeName }),
      explain: t(locale, 'audio.reason.dsp_node.explain', { node: nodeName }),
      fix: t(locale, 'audio.reason.dsp_node.fix', { node: nodeName }),
      settingsAnchor: 'dsp',
      known: true
    }
  }

  const entry = AUDIO_REASON_CODES[trimmed]
  if (!entry) {
    return {
      code: trimmed,
      severity: 'info',
      origin: 'engine',
      label: trimmed,
      explain: t(locale, 'audio.reason.unknown.explain', { code: trimmed }),
      fix: '',
      known: false
    }
  }

  return {
    code: trimmed,
    severity: entry.severity,
    origin: entry.origin,
    label: t(locale, `audio.reason.${trimmed}.label`, params),
    explain: t(locale, `audio.reason.${trimmed}.explain`, params),
    fix: t(locale, `audio.reason.${trimmed}.fix`, params, ''),
    settingsAnchor: entry.settingsAnchor,
    known: true
  }
}

const SEVERITY_ORDER: Record<ReasonSeverity, number> = {
  blocking: 0,
  degraded: 1,
  info: 2
}

/** Most alarming first, so a long list still leads with what matters. */
export function sortReasonsBySeverity<T extends { severity: ReasonSeverity }>(reasons: T[]): T[] {
  return [...reasons].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
