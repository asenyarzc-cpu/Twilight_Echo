import {
  normalizeAudioProcessingSettings,
  type AudioProcessingSettings,
  type EqualizerBand
} from '../audioEngineManager.ts'
import type { HeadphoneCompensationSettings } from '../../shared/audioEngineTypes.ts'

export type { HeadphoneCompensationSettings }

export const DEFAULT_HEADPHONE_COMPENSATION: HeadphoneCompensationSettings = {
  enabled: false,
  productId: '',
  productName: '',
  vendorName: '',
  eqId: '',
  author: '',
  details: '',
  link: '',
  preampDb: 0,
  bands: []
}

export function cloneEqualizerBands(bands: EqualizerBand[]): EqualizerBand[] {
  return bands.map((band) => ({ ...band }))
}

export function normalizeHeadphoneCompensationSettings(
  settings?: Partial<HeadphoneCompensationSettings>
): HeadphoneCompensationSettings {
  const rawBands = Array.isArray(settings?.bands) ? settings.bands : []
  const normalizedBands =
    rawBands.length > 0
      ? normalizeAudioProcessingSettings({
          eqMode: 'parametric',
          eqBands: rawBands
        }).eqBands
      : []

  return {
    enabled: settings?.enabled === true,
    productId: typeof settings?.productId === 'string' ? settings.productId : '',
    productName: typeof settings?.productName === 'string' ? settings.productName : '',
    vendorName: typeof settings?.vendorName === 'string' ? settings.vendorName : '',
    eqId: typeof settings?.eqId === 'string' ? settings.eqId : '',
    author: typeof settings?.author === 'string' ? settings.author : '',
    details: typeof settings?.details === 'string' ? settings.details : '',
    link: typeof settings?.link === 'string' ? settings.link : '',
    preampDb:
      typeof settings?.preampDb === 'number' && Number.isFinite(settings.preampDb)
        ? Math.min(24, Math.max(-24, settings.preampDb))
        : 0,
    bands: normalizedBands
  }
}

export function buildEffectiveAudioProcessingSettings(
  userProcessing: Partial<AudioProcessingSettings>,
  headphoneCompensation?: Partial<HeadphoneCompensationSettings>
): AudioProcessingSettings {
  const user = normalizeAudioProcessingSettings(userProcessing)
  const compensation = normalizeHeadphoneCompensationSettings(headphoneCompensation)

  // OPRA is an EQ contribution, not an independent processing module. Keep the
  // saved profile available while the equalizer is bypassed, but never let it
  // override either the DSP master switch or the equalizer switch.
  if (
    !user.dspEnabled ||
    !user.eqEnabled ||
    !compensation.enabled ||
    compensation.bands.length === 0
  ) {
    return user
  }

  return normalizeAudioProcessingSettings({
    ...user,
    eqMode: 'parametric',
    eqPreamp: user.eqPreamp + compensation.preampDb,
    eqBands: [...cloneEqualizerBands(compensation.bands), ...cloneEqualizerBands(user.eqBands)]
  })
}
