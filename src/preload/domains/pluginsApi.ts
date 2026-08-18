import { ipcRenderer } from 'electron'
import { ProviderWriteIdempotencyCoordinator } from '../../shared/providerWriteIdempotency.ts'
import { PROVIDER_DOWNLOAD_CHANGED_CHANNEL } from '../../shared/providerDownloads.ts'
import type {
  ProviderDownloadTaskSnapshot,
  ProviderDownloadCreateInput,
  TwilightPluginDescriptor,
  TwilightPluginExtensionContribution,
  TwilightPluginIndexEntry,
  TwilightPluginIndexStatus,
  TwilightPluginInstallResult,
  TwilightMediaProviderMethod,
  TwilightMediaProviderRegistration
} from '../types'

const pluginChangedCallbacks = new Set<() => void>()
const providerDownloadChangedCallbacks = new Set<
  (tasks: ProviderDownloadTaskSnapshot[]) => void
>()
const providerWriteIdempotency = new ProviderWriteIdempotencyCoordinator()

export function bindPluginsIpcEvents(): void {
  ipcRenderer.on('plugins:changed', () => {
    for (const cb of pluginChangedCallbacks) {
      cb()
    }
  })

  ipcRenderer.on(
    PROVIDER_DOWNLOAD_CHANGED_CHANNEL,
    (_event, tasks: ProviderDownloadTaskSnapshot[]) => {
      for (const cb of providerDownloadChangedCallbacks) {
        cb(tasks)
      }
    }
  )
}

export const pluginsApi = {
  plugins: {
    list: (): Promise<TwilightPluginDescriptor[]> => ipcRenderer.invoke('plugins:list'),
    installFromPath: (path: string): Promise<TwilightPluginInstallResult> =>
      ipcRenderer.invoke('plugins:installFromPath', path),
    chooseAndInstall: (): Promise<TwilightPluginInstallResult | null> =>
      ipcRenderer.invoke('plugins:chooseAndInstall'),
    enable: (id: string): Promise<TwilightPluginDescriptor> =>
      ipcRenderer.invoke('plugins:enable', id),
    disable: (id: string): Promise<TwilightPluginDescriptor> =>
      ipcRenderer.invoke('plugins:disable', id),
    uninstall: (id: string, options?: { removeData?: boolean }): Promise<void> =>
      ipcRenderer.invoke('plugins:uninstall', id, options),
    openLog: (id: string): Promise<void> => ipcRenderer.invoke('plugins:openLog', id),
    getLog: (id: string): Promise<string> => ipcRenderer.invoke('plugins:getLog', id),
    listIndex: (): Promise<TwilightPluginIndexEntry[]> => ipcRenderer.invoke('plugins:listIndex'),
    refreshIndex: (): Promise<TwilightPluginIndexEntry[]> =>
      ipcRenderer.invoke('plugins:refreshIndex'),
    getIndexStatus: (): Promise<TwilightPluginIndexStatus> =>
      ipcRenderer.invoke('plugins:getIndexStatus'),
    installFromIndex: (id: string): Promise<TwilightPluginInstallResult> =>
      ipcRenderer.invoke('plugins:installFromIndex', id),
    setNativeDspParameters: (
      id: string,
      parameters: Record<string, number>
    ): Promise<TwilightPluginDescriptor> =>
      ipcRenderer.invoke('plugins:setNativeDspParameters', id, parameters),
    onChanged: (cb: () => void): (() => void) => {
      pluginChangedCallbacks.add(cb)
      return () => pluginChangedCallbacks.delete(cb)
    }
  },
  providers: {
    list: (): Promise<TwilightMediaProviderRegistration[]> => ipcRenderer.invoke('providers:list'),
    call: async (
      providerId: string,
      method: TwilightMediaProviderMethod,
      args: unknown[],
      options?: { idempotencyKey?: string; requestId?: string }
    ): Promise<unknown> => {
      const ipcOptions = {
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options?.requestId ? { requestId: options.requestId } : {})
      }
      const lease = providerWriteIdempotency.begin(
        providerId,
        method,
        args,
        options?.idempotencyKey
      )
      try {
        const value = await ipcRenderer.invoke('providers:call', providerId, method, args, {
          ...ipcOptions,
          ...(lease.idempotencyKey ? { idempotencyKey: lease.idempotencyKey } : {})
        })
        lease.settle(true)
        return value
      } catch (error) {
        lease.settle(false)
        throw error
      }
    },
    cancel: (requestId: string): void => {
      ipcRenderer.send('providers:cancel', requestId)
    }
  },
  providerDownloads: {
    list: (): Promise<ProviderDownloadTaskSnapshot[]> =>
      ipcRenderer.invoke('providerDownloads:list'),
    create: (input: ProviderDownloadCreateInput): Promise<ProviderDownloadTaskSnapshot> =>
      ipcRenderer.invoke('providerDownloads:create', input),
    cancel: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('providerDownloads:cancel', taskId),
    retry: (taskId: string): Promise<ProviderDownloadTaskSnapshot> =>
      ipcRenderer.invoke('providerDownloads:retry', taskId),
    onChanged: (cb: (tasks: ProviderDownloadTaskSnapshot[]) => void): (() => void) => {
      providerDownloadChangedCallbacks.add(cb)
      return () => providerDownloadChangedCallbacks.delete(cb)
    }
  },
  extensions: {
    list: (): Promise<TwilightPluginExtensionContribution[]> =>
      ipcRenderer.invoke('extensions:list'),
    executeCommand: (command: string, args?: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke('extensions:executeCommand', command, args),
    readThemeStylesheet: (stylesheetPath: string): Promise<string> =>
      ipcRenderer.invoke('extensions:readThemeStylesheet', stylesheetPath)
  },
  debug: {
    appendNativeTrace: (message: string): Promise<void> =>
      ipcRenderer.invoke('debug:appendNativeTrace', message)
  }
}
