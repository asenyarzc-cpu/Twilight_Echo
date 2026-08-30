import {
  AUDIO_ANALYSIS_PROTOCOL_VERSION,
  type AudioAnalysisWorkerMessage,
  type AudioAnalysisWorkerRequest
} from '../shared/audioAnalysisContract.ts'
import {
  describeNativeBindingFailure,
  loadNativeBindingWithDiagnostics
} from './audio/nativeBinding.ts'
import type { NativeAudioBinding } from './audio/audioEngineTypes.ts'

type ParentPort = {
  postMessage: (message: AudioAnalysisWorkerMessage) => void
  on: (event: 'message', listener: (message: AudioAnalysisWorkerRequest) => void) => void
}

type ElectronParentPort = {
  postMessage: ParentPort['postMessage']
  on: (event: 'message', listener: (event: { data: AudioAnalysisWorkerRequest }) => void) => void
}

type NodeIpcProcess = {
  send?: ParentPort['postMessage']
  on?: (event: 'message', listener: (message: AudioAnalysisWorkerRequest) => void) => void
}

const electronParentPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort
const nodeIpc = process as unknown as NodeIpcProcess
const parentPort: ParentPort | null = electronParentPort
  ? {
      postMessage: (message) => electronParentPort.postMessage(message),
      on: (_event, listener) => electronParentPort.on('message', (event) => listener(event.data))
    }
  : typeof nodeIpc.send === 'function' && typeof nodeIpc.on === 'function'
    ? {
        postMessage: (message) => nodeIpc.send?.(message),
        on: (_event, listener) => nodeIpc.on?.('message', listener)
      }
    : null

if (!parentPort) {
  throw new Error('Twilight audio analysis service requires Electron parentPort or Node IPC')
}

const servicePort = parentPort
const nativeLoad = loadNativeBindingWithDiagnostics()
const native = nativeLoad.binding
const missingMethods = (['AnalyzeBpm', 'AnalyzeLoudness'] as const).filter(
  (method) => typeof native?.[method] !== 'function'
)
const startupError = !native
  ? describeNativeBindingFailure(nativeLoad)
  : missingMethods.length > 0
    ? `native audio analysis binding is missing methods: ${missingMethods.join(', ')}`
    : ''

if (startupError) {
  servicePort.postMessage({ kind: 'fatal', error: startupError })
} else {
  servicePort.postMessage({
    kind: 'ready',
    protocolVersion: AUDIO_ANALYSIS_PROTOCOL_VERSION,
    analyses: ['bpm', 'loudness']
  })
}

servicePort.on('message', (message) => {
  if (message.kind !== 'request') return
  handleRequest(message)
})

function handleRequest(message: AudioAnalysisWorkerRequest): void {
  if (!native || startupError) {
    servicePort.postMessage({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: startupError || 'native audio analysis binding unavailable'
    })
    return
  }
  try {
    const method: keyof NativeAudioBinding =
      message.analysis === 'bpm' ? 'AnalyzeBpm' : 'AnalyzeLoudness'
    const target = native[method]
    if (typeof target !== 'function') throw new Error(`native method unavailable: ${method}`)
    const value = (target as (source: string, optionsJson: string) => unknown)(
      message.source,
      message.optionsJson
    )
    servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
  } catch (error) {
    servicePort.postMessage({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
