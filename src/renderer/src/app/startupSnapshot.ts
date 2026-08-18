import type { AppStartupSnapshot } from '../../../shared/appStartup.ts'

let startupSnapshotPromise: Promise<AppStartupSnapshot | null> | null = null

export function beginStartupSnapshot(): Promise<AppStartupSnapshot | null> {
  if (!startupSnapshotPromise) {
    startupSnapshotPromise = window.api.app.getStartupSnapshot().catch(() => null)
  }
  return startupSnapshotPromise
}

export function getStartupSnapshot(): Promise<AppStartupSnapshot | null> {
  return beginStartupSnapshot()
}
