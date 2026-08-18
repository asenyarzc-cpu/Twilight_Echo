import type { DspChannelLayout, DspGraphNode, DspNodeType } from '../../../shared/dspGraph.ts'
import { channelMatrixPresetMatrix } from './channelMatrixPresets.ts'

export const nodeCatalog: Array<{
  type: DspNodeType
  label: string
  icon: string
  params: Record<string, unknown>
}> = [
  {
    type: 'replayGain',
    label: 'ReplayGain',
    icon: 'pi pi-volume-up',
    params: { mode: 'track', preampDb: 0, fallbackDb: 0, clip: true }
  },
  {
    type: 'equalizer',
    label: '参数均衡器',
    icon: 'pi pi-sliders-h',
    params: { mode: 'parametric', preampDb: 0, bands: [] }
  },
  { type: 'dynamicEqualizer', label: 'Dynamic EQ', icon: 'pi pi-sliders-h', params: { bands: [] } },
  {
    type: 'convolver',
    label: '卷积',
    icon: 'pi pi-wave-pulse',
    params: { impulseResponsePath: '', wet: 1, dry: 0 }
  },
  {
    type: 'crossfeed',
    label: 'Crossfeed',
    icon: 'pi pi-headphones',
    params: { algorithm: 'custom', strength: 0.35, delayMs: 0.35, cutoffHz: 700 }
  },
  {
    type: 'channelMatrix',
    label: '声道矩阵',
    icon: 'pi pi-share-alt',
    params: { layout: 'stereo', matrix: [] }
  },
  {
    type: 'channelStrip',
    label: 'Channel Strip',
    icon: 'pi pi-sliders-v',
    params: { channels: [] }
  },
  {
    type: 'bassManagement',
    label: '低频管理',
    icon: 'pi pi-filter',
    params: { crossoverHz: 80, lfeGainDb: 0 }
  },
  {
    type: 'gate',
    label: 'Gate',
    icon: 'pi pi-minus-circle',
    params: { thresholdDb: -60, attackMs: 2, releaseMs: 120 }
  },
  {
    type: 'compressor',
    label: 'Compressor',
    icon: 'pi pi-chart-line',
    params: { thresholdDb: -18, ratio: 2, attackMs: 15, releaseMs: 180, makeupDb: 0 }
  },
  {
    type: 'multibandCompressor',
    label: 'Multiband Compressor',
    icon: 'pi pi-chart-line',
    params: {
      crossoversHz: [240],
      bands: [
        { thresholdDb: -18, ratio: 2, attackMs: 15, releaseMs: 180, makeupDb: 0, enabled: true },
        { thresholdDb: -18, ratio: 2, attackMs: 15, releaseMs: 180, makeupDb: 0, enabled: true }
      ]
    }
  },
  {
    type: 'stereoField',
    label: 'Stereo Field',
    icon: 'pi pi-arrows-h',
    params: { width: 1, balance: 0, midGainDb: 0, sideGainDb: 0 }
  },
  {
    type: 'loudnessContour',
    label: 'Loudness Contour',
    icon: 'pi pi-volume-down',
    params: { amount: 0, referenceVolume: 0.75 }
  },
  {
    type: 'truePeakLimiter',
    label: 'True-Peak Limiter',
    icon: 'pi pi-shield',
    params: { ceilingDb: -0.1, attackMs: 0.2, releaseMs: 80, lookaheadMs: 1 }
  },
  { type: 'meter', label: 'R128 Meter', icon: 'pi pi-chart-bar', params: {} },
  { type: 'nativePlugin', label: 'Native DSP v2', icon: 'pi pi-box', params: {} },
  { type: 'vst3Plugin', label: 'VST3 Effect', icon: 'pi pi-box', params: {} }
]

export const channelLayouts: DspChannelLayout[] = ['mono', 'stereo', '5.1', '7.1']
export const channelLabels: Record<DspChannelLayout, string[]> = {
  mono: ['M'],
  stereo: ['L', 'R'],
  '5.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '7.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs']
}
export const defaultMultibandCrossovers = [240, 1800, 6000]
export type ConvolverRoutingMode = 'diagonal' | 'monoToMany' | 'matrix'
export const singletonNodeTypes = new Set<DspNodeType>([
  'replayGain',
  'equalizer',
  'dynamicEqualizer',
  'convolver',
  'crossfeed',
  'channelMatrix',
  'channelStrip',
  'bassManagement',
  'gate',
  'compressor',
  'multibandCompressor',
  'stereoField',
  'loudnessContour',
  'truePeakLimiter',
  'meter'
])

export function cloneNodeParams(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>
}

export function nodeLabel(type: DspNodeType): string {
  return nodeCatalog.find((item) => item.type === type)?.label ?? type
}

export function numberParam(node: DspGraphNode, key: string, fallback: number): number {
  const value = node.params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function stringParam(node: DspGraphNode, key: string, fallback = ''): string {
  const value = node.params[key]
  return typeof value === 'string' ? value : fallback
}

export function booleanParam(node: DspGraphNode, key: string, fallback = false): boolean {
  const value = node.params[key]
  return typeof value === 'boolean' ? value : fallback
}

export function setNumberParam(node: DspGraphNode, key: string, value: string | number): void {
  const number = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(number)) node.params[key] = number
}

export function setStringParam(node: DspGraphNode, key: string, value: string): void {
  node.params[key] = value
}

export function setBooleanParam(node: DspGraphNode, key: string, value: boolean): void {
  node.params[key] = value
}

export function objectArrayParam(node: DspGraphNode, key: string): Array<Record<string, unknown>> {
  const raw = node.params[key]
  const entries = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry)
      )
    : []
  if (!Array.isArray(raw) || entries.length !== raw.length) node.params[key] = entries
  return entries
}

export function bandsFor(node: DspGraphNode): Array<Record<string, unknown>> {
  return objectArrayParam(node, 'bands')
}

export function layoutForNode(node: DspGraphNode): DspChannelLayout {
  const layout = stringParam(node, 'layout', 'stereo')
  return channelLayouts.includes(layout as DspChannelLayout)
    ? (layout as DspChannelLayout)
    : 'stereo'
}

export function channelLabelsForNode(node: DspGraphNode): string[] {
  return channelLabels[layoutForNode(node)]
}

export function matrixChannelCount(node: DspGraphNode): number {
  return channelLabelsForNode(node).length
}

export function identityMatrix(channelCount: number): number[] {
  return Array.from({ length: channelCount * channelCount }, (_, index) =>
    index % (channelCount + 1) === 0 ? 1 : 0
  )
}

export function matrixForNode(node: DspGraphNode): number[] {
  const expectedLength = matrixChannelCount(node) ** 2
  const raw = node.params.matrix
  if (
    Array.isArray(raw) &&
    raw.length === expectedLength &&
    raw.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return raw as number[]
  }
  const matrix = identityMatrix(matrixChannelCount(node))
  node.params.matrix = matrix
  return matrix
}

export function matrixValue(node: DspGraphNode, output: number, input: number): number {
  const channelCount = matrixChannelCount(node)
  return matrixForNode(node)[output * channelCount + input] ?? 0
}

export function setMatrixValue(
  node: DspGraphNode,
  output: number,
  input: number,
  value: string | number
): void {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return
  const channelCount = matrixChannelCount(node)
  const matrix = matrixForNode(node)
  matrix[output * channelCount + input] = Math.max(-4, Math.min(4, next))
  node.params.matrix = matrix
}

export function resetMatrix(node: DspGraphNode): void {
  node.params.matrix = identityMatrix(matrixChannelCount(node))
}

export function applyMatrixPreset(node: DspGraphNode, event: Event): void {
  const select = event.target as HTMLSelectElement
  const matrix = channelMatrixPresetMatrix(select.value, layoutForNode(node))
  if (matrix) node.params.matrix = matrix
  select.value = ''
}

export function channelStripRows(node: DspGraphNode): Array<Record<string, unknown>> {
  const rows = objectArrayParam(node, 'channels')
  const expected = matrixChannelCount(node)
  while (rows.length < expected) {
    rows.push({ gainDb: 0, delayMs: 0, polarityInverted: false, muted: false })
  }
  if (rows.length > expected) rows.splice(expected)
  node.params.channels = rows
  return rows
}

export function setNodeLayout(node: DspGraphNode, value: string): void {
  if (!channelLayouts.includes(value as DspChannelLayout)) return
  node.params.layout = value
  if (node.type === 'channelMatrix') resetMatrix(node)
  if (node.type === 'channelStrip') channelStripRows(node)
}

export function convolverRoutingMode(node: DspGraphNode): ConvolverRoutingMode {
  const mode = node.params.routingMode
  if (mode === 'monoToMany' || mode === 'matrix' || mode === 'diagonal') return mode
  const matrix = node.params.matrix
  if (!Array.isArray(matrix)) return 'diagonal'
  if (matrix.length === matrixChannelCount(node)) return 'monoToMany'
  if (matrix.length === matrixChannelCount(node) ** 2) return 'matrix'
  return 'diagonal'
}

export function resetConvolverRouting(node: DspGraphNode): void {
  const mode = convolverRoutingMode(node)
  const channelCount = matrixChannelCount(node)
  node.params.matrix =
    mode === 'diagonal'
      ? []
      : mode === 'monoToMany'
        ? Array.from({ length: channelCount }, () => 1)
        : identityMatrix(channelCount)
}

export function convolverRoutingMatrix(node: DspGraphNode): number[] {
  const mode = convolverRoutingMode(node)
  if (mode === 'diagonal') return []
  const expectedLength =
    mode === 'monoToMany' ? matrixChannelCount(node) : matrixChannelCount(node) ** 2
  const raw = node.params.matrix
  if (
    Array.isArray(raw) &&
    raw.length === expectedLength &&
    raw.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return raw as number[]
  }
  resetConvolverRouting(node)
  return node.params.matrix as number[]
}

export function convolverRoutingValue(node: DspGraphNode, output: number, input = 0): number {
  const matrix = convolverRoutingMatrix(node)
  if (convolverRoutingMode(node) === 'monoToMany') return matrix[output] ?? 0
  return matrix[output * matrixChannelCount(node) + input] ?? 0
}

export function setConvolverRoutingValue(
  node: DspGraphNode,
  output: number,
  input: number,
  value: string | number
): void {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return
  const matrix = convolverRoutingMatrix(node)
  const index =
    convolverRoutingMode(node) === 'monoToMany' ? output : output * matrixChannelCount(node) + input
  matrix[index] = Math.max(-4, Math.min(4, next))
  node.params.matrix = matrix
}

export function setConvolverRoutingMode(node: DspGraphNode, value: string): void {
  if (value !== 'diagonal' && value !== 'monoToMany' && value !== 'matrix') return
  node.params.routingMode = value
  resetConvolverRouting(node)
}

export function setConvolverRoutingLayout(node: DspGraphNode, value: string): void {
  if (!channelLayouts.includes(value as DspChannelLayout)) return
  node.params.layout = value
  resetConvolverRouting(node)
}

export function numberArrayParam(node: DspGraphNode, key: string): number[] {
  const raw = node.params[key]
  const values = Array.isArray(raw)
    ? raw.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : []
  if (!Array.isArray(raw) || values.length !== raw.length) node.params[key] = values
  return values
}

export function normalizeMultibandCrossovers(node: DspGraphNode): number[] {
  const bandCount = bandsFor(node).length
  if (bandCount < 2) {
    node.params.crossoversHz = []
    return []
  }
  const source = numberArrayParam(node, 'crossoversHz')
  const crossovers: number[] = []
  let previous = 20
  for (let index = 0; index < bandCount - 1; index += 1) {
    const fallback = defaultMultibandCrossovers[index] ?? previous * 2
    const requested = source[index] ?? fallback
    const value = Math.max(previous + 1, Math.min(24000, requested))
    crossovers.push(value)
    previous = value
  }
  node.params.crossoversHz = crossovers
  return crossovers
}

export function setMultibandCrossover(
  node: DspGraphNode,
  index: number,
  value: string | number
): void {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return
  const crossovers = normalizeMultibandCrossovers(node)
  crossovers[index] = next
  node.params.crossoversHz = crossovers
  normalizeMultibandCrossovers(node)
}

export function addDynamicEqBand(node: DspGraphNode): void {
  const bands = bandsFor(node)
  if (bands.length >= 8) return
  bands.push({
    frequency: 1000,
    gainDb: 0,
    q: 1,
    thresholdDb: -24,
    ratio: 2,
    rangeDb: -6,
    attackMs: 15,
    releaseMs: 180,
    filterType: 'peak',
    enabled: true
  })
}

export function addMultibandBand(node: DspGraphNode): void {
  const bands = bandsFor(node)
  if (bands.length >= 4) return
  const createBand = () => ({
    thresholdDb: -18,
    ratio: 2,
    attackMs: 15,
    releaseMs: 180,
    makeupDb: 0,
    enabled: true
  })
  if (bands.length === 0) {
    bands.push(createBand(), createBand())
  } else {
    bands.push(createBand())
  }
  normalizeMultibandCrossovers(node)
}

export function removeBand(node: DspGraphNode, index: number): void {
  const bands = bandsFor(node)
  bands.splice(index, 1)
}

export function removeMultibandBand(node: DspGraphNode, index: number): void {
  const bands = bandsFor(node)
  if (bands.length <= 2) return
  bands.splice(index, 1)
  normalizeMultibandCrossovers(node)
}

export function setBandNumber(
  band: Record<string, unknown>,
  key: string,
  value: string | number
): void {
  const number = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(number)) band[key] = number
}

export function bandNumber(band: Record<string, unknown>, key: string, fallback: number): number {
  const value = band[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function bandString(band: Record<string, unknown>, key: string, fallback: string): string {
  return typeof band[key] === 'string' ? (band[key] as string) : fallback
}

export function bandBoolean(
  band: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  return typeof band[key] === 'boolean' ? (band[key] as boolean) : fallback
}

export function setBandBoolean(band: Record<string, unknown>, key: string, value: boolean): void {
  band[key] = value
}

export function setBandString(band: Record<string, unknown>, key: string, value: string): void {
  band[key] = value
}

export function vst3ParameterValue(node: DspGraphNode, id: number, fallback: number): number {
  const parameters = node.params.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return fallback
  const value = (parameters as Record<string, unknown>)[String(id)]
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

export function setVst3Parameter(node: DspGraphNode, id: number, value: string | number): void {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return
  const current =
    node.params.parameters &&
    typeof node.params.parameters === 'object' &&
    !Array.isArray(node.params.parameters)
      ? (node.params.parameters as Record<string, unknown>)
      : {}
  node.params.parameters = { ...current, [String(id)]: Math.max(0, Math.min(1, number)) }
}

export function vst3ParameterStep(stepCount: number): number {
  return stepCount > 0 ? 1 / stepCount : 0.001
}

export function isReadOnlyVst3Parameter(flags: number): boolean {
  return (flags & 2) !== 0 || (flags & 16) !== 0
}

export function normalizeNodeEditorParams(node: DspGraphNode): void {
  if (node.type === 'channelMatrix') {
    if (!channelLayouts.includes(stringParam(node, 'layout', 'stereo') as DspChannelLayout)) {
      node.params.layout = 'stereo'
    }
    matrixForNode(node)
  } else if (node.type === 'channelStrip') {
    if (!channelLayouts.includes(stringParam(node, 'layout', 'stereo') as DspChannelLayout)) {
      node.params.layout = 'stereo'
    }
    channelStripRows(node)
  } else if (node.type === 'convolver') {
    if (!channelLayouts.includes(stringParam(node, 'layout', 'stereo') as DspChannelLayout)) {
      node.params.layout = 'stereo'
    }
    convolverRoutingMatrix(node)
  } else if (node.type === 'multibandCompressor') {
    normalizeMultibandCrossovers(node)
  }
}
