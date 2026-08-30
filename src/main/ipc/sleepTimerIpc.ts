import { isSleepTimerState, type SleepTimerState } from '../../shared/sleepTimer.ts'

export interface SleepTimerIpcMain<Event = unknown> {
  handle: (channel: string, listener: (event: Event, payload?: unknown) => unknown) => void
}

export interface SleepTimerIpcService {
  configure: (state: SleepTimerState) => SleepTimerState
  cancel: () => SleepTimerState | null
  snapshot: () => SleepTimerState | null
  boundary: (boundary: 'trackEnd' | 'queueEnd') => SleepTimerState | null
}

export function registerSleepTimerIpc<Event>(
  ipc: SleepTimerIpcMain<Event>,
  sleepTimer: SleepTimerIpcService,
  assertTrusted: (event: Event, scope: string) => void
): void {
  ipc.handle('sleepTimer:configure', (event, state) => {
    assertTrusted(event, 'sleep timer IPC')
    if (!isSleepTimerState(state)) throw new Error('Invalid sleep timer state')
    return sleepTimer.configure(state)
  })
  ipc.handle('sleepTimer:cancel', (event) => {
    assertTrusted(event, 'sleep timer IPC')
    return sleepTimer.cancel()
  })
  ipc.handle('sleepTimer:getState', (event) => {
    assertTrusted(event, 'sleep timer IPC')
    return sleepTimer.snapshot()
  })
  ipc.handle('sleepTimer:boundary', (event, boundary) => {
    assertTrusted(event, 'sleep timer IPC')
    if (boundary !== 'trackEnd' && boundary !== 'queueEnd')
      throw new Error('Invalid sleep timer boundary')
    return sleepTimer.boundary(boundary)
  })
}
