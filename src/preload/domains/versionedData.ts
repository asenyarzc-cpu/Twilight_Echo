import { ipcRenderer } from 'electron'
import type { VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import {
  isPersistentDataRevisionConflictResponse,
  isVersionedDataEnvelope,
  persistentDataRevisionConflictFromResponse
} from '../../shared/versionedPersistence.ts'

export async function invokeVersionedDataWrite<T>(
  channel: string,
  args: unknown[],
  isData: (value: unknown) => value is T
): Promise<VersionedDataEnvelope<T>> {
  const response: unknown = await ipcRenderer.invoke(channel, ...args)
  if (isPersistentDataRevisionConflictResponse(response, isData)) {
    throw persistentDataRevisionConflictFromResponse(response)
  }
  if (!isVersionedDataEnvelope(response, isData)) {
    throw new Error(`${channel} returned an invalid persistence response`)
  }
  return response
}

export async function invokeOptionalVersionedDataWrite<T>(
  channel: string,
  args: unknown[],
  isData: (value: unknown) => value is T
): Promise<VersionedDataEnvelope<T> | null> {
  const response: unknown = await ipcRenderer.invoke(channel, ...args)
  if (response === null) return null
  if (isPersistentDataRevisionConflictResponse(response, isData)) {
    throw persistentDataRevisionConflictFromResponse(response)
  }
  if (!isVersionedDataEnvelope(response, isData)) {
    throw new Error(`${channel} returned an invalid persistence response`)
  }
  return response
}
