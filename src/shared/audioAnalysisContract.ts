export const AUDIO_ANALYSIS_PROTOCOL_VERSION = 1

export type AudioAnalysisKind = 'bpm' | 'loudness'

export interface AudioAnalysisWorkerRequest {
  kind: 'request'
  requestId: string
  analysis: AudioAnalysisKind
  source: string
  optionsJson: string
}

export interface AudioAnalysisWorkerResponse {
  kind: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: string
}

export type AudioAnalysisWorkerEvent =
  | {
      kind: 'ready'
      protocolVersion: number
      analyses: AudioAnalysisKind[]
    }
  | { kind: 'fatal'; error: string }

export type AudioAnalysisWorkerMessage = AudioAnalysisWorkerResponse | AudioAnalysisWorkerEvent
