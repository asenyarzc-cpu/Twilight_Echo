import { ipcRenderer } from 'electron'
import {
  isThemeLibraryDocument,
  type ThemeAssetReference,
  type ThemeAssetType,
  type ThemeBootstrap,
  type ThemeLibrarySnapshot,
  type ThemeProfileV2,
  type ThemeSelection,
  type ThemeTone,
  type ThemeWindowInheritance
} from '../../shared/theme.ts'
import { invokeOptionalVersionedDataWrite, invokeVersionedDataWrite } from './versionedData.ts'

const themeChangedCallbacks = new Set<(snapshot: ThemeLibrarySnapshot) => void>()
const systemThemeChangedCallbacks = new Set<(tone: ThemeTone) => void>()

export function bindThemesIpcEvents(): void {
  ipcRenderer.on('themes:changed', (_event, snapshot: ThemeLibrarySnapshot) => {
    for (const cb of themeChangedCallbacks) cb(snapshot)
  })

  ipcRenderer.on('themes:systemToneChanged', (_event, tone: ThemeTone) => {
    if (tone !== 'dark' && tone !== 'pureWhite') return
    for (const cb of systemThemeChangedCallbacks) cb(tone)
  })
}

export const themesApi = {
  getSystemTone: (): Promise<ThemeTone> => ipcRenderer.invoke('themes:getSystemTone'),
  getBootstrap: (): Promise<ThemeBootstrap> => ipcRenderer.invoke('themes:getBootstrap'),
  list: (): Promise<ThemeLibrarySnapshot> => ipcRenderer.invoke('themes:list'),
  save: (profile: ThemeProfileV2, expectedRevision: number): Promise<ThemeLibrarySnapshot> =>
    invokeVersionedDataWrite('themes:save', [profile, expectedRevision], isThemeLibraryDocument),
  delete: (profileId: string, expectedRevision: number): Promise<ThemeLibrarySnapshot> =>
    invokeVersionedDataWrite(
      'themes:delete',
      [profileId, expectedRevision],
      isThemeLibraryDocument
    ),
  setActive: (selection: ThemeSelection, expectedRevision: number): Promise<ThemeLibrarySnapshot> =>
    invokeVersionedDataWrite(
      'themes:setActive',
      [selection, expectedRevision],
      isThemeLibraryDocument
    ),
  setWindowInheritance: (
    inheritance: ThemeWindowInheritance,
    expectedRevision: number
  ): Promise<ThemeLibrarySnapshot> =>
    invokeVersionedDataWrite(
      'themes:setWindowInheritance',
      [inheritance, expectedRevision],
      isThemeLibraryDocument
    ),
  importTheme: (expectedRevision: number): Promise<ThemeLibrarySnapshot | null> =>
    invokeOptionalVersionedDataWrite('themes:import', [expectedRevision], isThemeLibraryDocument),
  exportTheme: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke('themes:export', profileId),
  importAsset: (profileId: string, type: ThemeAssetType): Promise<ThemeAssetReference | null> =>
    ipcRenderer.invoke('themes:importAsset', profileId, type),
  validateAssets: (profileId: string, assets: ThemeAssetReference[]): Promise<boolean> =>
    ipcRenderer.invoke('themes:validateAssets', profileId, assets),
  copyAssets: (sourceProfileId: string, targetProfileId: string): Promise<void> =>
    ipcRenderer.invoke('themes:copyAssets', sourceProfileId, targetProfileId),
  onChanged: (cb: (snapshot: ThemeLibrarySnapshot) => void): (() => void) => {
    themeChangedCallbacks.add(cb)
    return () => themeChangedCallbacks.delete(cb)
  },
  onSystemToneChanged: (cb: (tone: ThemeTone) => void): (() => void) => {
    systemThemeChangedCallbacks.add(cb)
    return () => systemThemeChangedCallbacks.delete(cb)
  }
}
