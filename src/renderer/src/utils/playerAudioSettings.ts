import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import type { AudioProcessingSettings } from '../types/settings.ts'

export function cloneAudioProcessingSettings(
  settings: AudioProcessingSettings
): AudioProcessingSettings {
  return {
    ...settings,
    dsdRoute: { ...settings.dsdRoute },
    eqBands: settings.eqBands.map((band) => ({ ...band }))
  }
}

export function clampSoftwareVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SOFTWARE_VOLUME
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))
}
