import type {
  AudioCapabilitySupportState,
  AudioDeviceOption,
  AudioOutputId,
  AudioOutputOption
} from '../../types/settings'

export const FALLBACK_AUDIO_OUTPUT_OPTIONS: AudioOutputOption[] = [
  {
    id: 'wasapi',
    label: 'WASAPI',
    description: 'Windows 原生音频输出',
    platform: 'win32',
    supportsExclusive: true
  },
  {
    id: 'asio',
    label: 'ASIO',
    description: '专业声卡驱动输出',
    platform: 'win32',
    supportsExclusive: true
  },
  {
    id: 'coreaudio',
    label: 'CoreAudio',
    description: 'macOS 原生音频输出',
    platform: 'darwin',
    supportsExclusive: true
  },
  {
    id: 'alsa',
    label: 'ALSA',
    description: 'Linux 原生音频输出',
    platform: 'linux',
    supportsExclusive: false
  }
]

export const DEFAULT_AUDIO_DEVICE_OPTION: AudioDeviceOption = {
  id: 'auto',
  label: '系统默认',
  isDefault: true,
  dopSupportState: 'runtime-probed',
  nativeDsdSupportState: 'unsupported'
}

export function getRendererPlatform(): NodeJS.Platform {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'darwin'
  if (platform.includes('linux')) return 'linux'
  return 'win32'
}

export function getFallbackAudioOutputOptions(): AudioOutputOption[] {
  return FALLBACK_AUDIO_OUTPUT_OPTIONS.filter((option) => option.platform === getRendererPlatform())
}

export function getFallbackAudioOutput(): AudioOutputId {
  return getFallbackAudioOutputOptions()[0]?.id ?? 'alsa'
}

export function formatAudioDeviceLabel(device: string): string {
  return device === 'auto' ? DEFAULT_AUDIO_DEVICE_OPTION.label : device
}

export function normalizeAudioCapabilitySupportState(
  value: unknown
): AudioCapabilitySupportState | null {
  return value === 'verified' ||
    value === 'runtime-probed' ||
    value === 'unsupported' ||
    value === 'unknown'
    ? value
    : null
}

export function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

export function getDeviceBackend(option: Partial<AudioDeviceOption>): string {
  const id = String(option.id || '').toLowerCase()
  const raw =
    option.backend ||
    (id.startsWith('asio:')
      ? 'asio'
      : id.startsWith('wasapi:')
        ? 'wasapi'
        : id.startsWith('coreaudio:')
          ? 'coreaudio'
          : id.startsWith('alsa:') || id.startsWith('hw:') || id.startsWith('plughw:')
            ? 'alsa'
            : '')
  return String(raw || '').toLowerCase()
}

export function getDevicePathKind(option: Partial<AudioDeviceOption>): string {
  const explicit = String(option.pathKind || '').toLowerCase()
  if (explicit) return explicit
  const id = String(option.id || '').toLowerCase()
  if (id === 'auto' || id === 'default') return 'default'
  if (id.startsWith('hw:') || id.startsWith('alsa:hw:')) return 'hw'
  if (id.startsWith('plughw:') || id.startsWith('alsa:plughw:')) return 'plughw'
  if (id.startsWith('wasapi:')) return 'endpoint'
  if (id.startsWith('coreaudio:')) return 'hal'
  if (id.startsWith('asio:')) return 'asio'
  return ''
}

export function deriveDopSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.dopSupportState)
  if (explicit) return explicit
  if (
    option.supportsDop === true ||
    hasNonEmptyArray(option.dopCarrierSampleRates) ||
    hasNonEmptyArray(option.dopCarrierFormats)
  ) {
    return 'verified'
  }
  if (option.supportsDop === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    option.isDefault === true ||
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'default' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'runtime-probed'
  }
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  return 'unknown'
}

export function deriveNativeDsdSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.nativeDsdSupportState)
  if (explicit) return explicit
  if (
    option.supportsNativeDsd === true ||
    hasNonEmptyArray(option.nativeDsdSampleRates) ||
    hasNonEmptyArray(option.nativeDsdSampleFormats) ||
    hasNonEmptyArray(option.supportedDsdRates)
  ) {
    return 'verified'
  }
  if (option.supportsNativeDsd === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'unsupported'
  }
  if (backend === 'alsa' && pathKind === 'hw') return 'runtime-probed'
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  if (option.isDefault === true || pathKind === 'default') return 'unsupported'
  return 'unknown'
}

export function withAudioCapabilitySupportStates(
  option: AudioDeviceOption,
  fallbackBackend: AudioOutputId | '' = ''
): AudioDeviceOption {
  const contextualOption =
    fallbackBackend && !option.backend ? { ...option, backend: fallbackBackend } : option
  return {
    ...option,
    dopSupportState: deriveDopSupportState(contextualOption),
    nativeDsdSupportState: deriveNativeDsdSupportState(contextualOption)
  }
}

export function normalizeAudioOutputOptions(
  options: AudioOutputOption[],
  selectedOutput: AudioOutputId
): AudioOutputOption[] {
  const fallbackOptions = getFallbackAudioOutputOptions()
  const sourceOptions = Array.isArray(options) && options.length > 0 ? options : fallbackOptions
  const fallbackById = new Map(fallbackOptions.map((option) => [option.id, option]))
  const normalized = sourceOptions
    .filter((option) => option?.id && option?.label)
    .map((option) => ({
      ...option,
      description: fallbackById.get(option.id)?.description ?? option.description
    }))

  if (!normalized.some((option) => option.id === selectedOutput)) {
    const fallback = fallbackOptions.find((option) => option.id === selectedOutput)
    if (fallback) normalized.push(fallback)
  }

  return normalized.length > 0 ? normalized : fallbackOptions
}

export function normalizeAudioDeviceOptions(
  options: AudioDeviceOption[],
  _selectedDevice: string,
  selectedOutput: AudioOutputId | '' = ''
): AudioDeviceOption[] {
  const normalized: AudioDeviceOption[] = []
  const seen = new Set<string>()

  function addOption(option: unknown): void {
    if (typeof option === 'string') {
      const id = option.trim()
      if (!id || seen.has(id)) return
      seen.add(id)
      normalized.push(
        withAudioCapabilitySupportStates(
          {
            id,
            label: formatAudioDeviceLabel(id),
            isDefault: id === 'auto'
          },
          selectedOutput
        )
      )
      return
    }

    if (!option || typeof option !== 'object') return
    const record = option as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) return
    const rawLabel = typeof record.label === 'string' ? record.label.trim() : ''
    const rawName = typeof record.name === 'string' ? record.name.trim() : ''
    seen.add(id)
    normalized.push(
      withAudioCapabilitySupportStates(
        {
          ...(record as Partial<AudioDeviceOption>),
          id,
          label: id === 'auto' ? DEFAULT_AUDIO_DEVICE_OPTION.label : rawLabel || rawName || id,
          isDefault: record.isDefault === true
        },
        selectedOutput
      )
    )
  }

  const sourceOptions = Array.isArray(options) ? (options as unknown[]) : []
  for (const option of sourceOptions) {
    addOption(option)
  }

  if (!seen.has(DEFAULT_AUDIO_DEVICE_OPTION.id)) {
    normalized.unshift(DEFAULT_AUDIO_DEVICE_OPTION)
    seen.add(DEFAULT_AUDIO_DEVICE_OPTION.id)
  }

  return normalized
}
