import { app, dialog, shell, utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { cp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import { EventEmitter } from 'events'
import { planPluginStartup } from './dependencies'
import {
  compareSemver,
  isCompatibleTwilightRange,
  toManifest,
  validatePluginManifest
} from './manifest'
import {
  dedupeProviderRegistrations,
  findProviderRoute,
  getProviderCallTimeoutMs,
  getProviderMethodStats,
  normalizeProviderHealth,
  normalizeProviderUi,
  type ProviderHealthRecord,
  type ProviderMethodHealthRecord
} from './providerRouting'
import { isRecoverableBundledPluginFailure } from './stateRecovery'
import { PluginOperationQueue } from './operationQueue.ts'
import {
  normalizeInternalNcmRequestOptions,
  PluginRpcCoordinator,
  resolveProviderIdempotencyKey
} from './rpcCoordinator.ts'
import { trialStagedPluginCandidate } from './trialActivation.ts'
import {
  cloneStateRecord,
  PluginStatePersistence,
  type PluginStateFile
} from './statePersistence.ts'
import {
  PluginUpdateRollbackError,
  commitStagedPluginUpdate,
  type StagedPluginUpdateOptions
} from './updateTransaction.ts'
import {
  bindFinalPluginPackageEvidence,
  buildPluginInstallConfirmationDetail,
  confirmPluginInstallWithFreshEvidence,
  runFinalPluginPackageTrustBoundary
} from './installTrust.ts'
import {
  assertPluginPackageFileSize,
  assertPluginTreeSafe,
  extractPluginPackage,
  isInsidePath,
  resolvePluginFile
} from './packageSecurity.ts'
import { redactSensitiveText } from '../security/secureStorage.ts'
import { protectProviderMedia } from '../security/remoteMediaGrants.ts'
import { normalizeThemeContribution, normalizeUiContribution } from './themeContribution.ts'
import type {
  PluginHostApiResult,
  PluginHostRequest,
  PluginHostResponse,
  TwilightMediaProviderMethod,
  TwilightMediaProviderHealth,
  TwilightMediaProviderRegistration,
  TwilightPluginExtensionContribution,
  TwilightThemeContribution,
  TwilightUiContribution,
  TwilightPluginDescriptor,
  TwilightPluginInstallResult,
  TwilightPluginInstallEvidence,
  TwilightPluginManifest,
  TwilightPluginPaths,
  TwilightPluginPermission,
  TwilightPluginSource,
  TwilightPluginStateRecord,
  TwilightPluginUninstallOptions
} from './types'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

export interface TwilightPluginManagerOptions {
  appVersion: string
  hostEntry: string
  bundledPlugins?: Array<{
    id: string
    sourcePath: string
    defaultEnabled?: boolean
  }>
  ncm?: {
    request: (
      path: string,
      cookie?: string,
      options?: { signal?: AbortSignal; idempotencyKey?: string }
    ) => Promise<unknown>
    officialLogin: () => Promise<string>
    getCachedSong: (songId: number) => Promise<string | null>
    cacheSong: (songId: number, url: string, fileName?: string) => Promise<string | null>
  }
  getPlaybackInfo: () => Promise<unknown> | unknown
  applyNativeDspPluginChain: (chainJson: string) => Promise<void> | void
  player: {
    play: () => Promise<void> | void
    pause: () => Promise<void> | void
    togglePause: () => Promise<void> | void
    stop: () => Promise<void> | void
    next: () => Promise<void> | void
    previous: () => Promise<void> | void
  }
  getProxyEnv?: () => Record<string, string>
}

interface RunningPlugin {
  process: UtilityProcess
  descriptor: TwilightPluginDescriptor
  trial: boolean
  subscriptions: Set<string>
  providers: TwilightMediaProviderRegistration[]
  ui: TwilightUiContribution[]
  themes: TwilightThemeContribution[]
}

interface InstallFromPathOptions {
  source?: TwilightPluginSource
  sourceLabel?: string
  evidence?: TwilightPluginInstallEvidence
}

interface StartPluginOptions {
  persistState?: boolean
  trial?: boolean
}

interface DescriptorReadOptions {
  paths?: TwilightPluginPaths
  state?: TwilightPluginStateRecord
}

interface ProviderRpcMetadata {
  providerId: string
  pluginId: string
  method: TwilightMediaProviderMethod
}

interface UiCommandRpcMetadata {
  command: string
  pluginId: string
}

export interface TwilightProviderCallOptions {
  /** Reuse this key when retrying one user-initiated write after an unknown outcome. */
  idempotencyKey?: string
  /** Cancels queued or active plugin RPC work and propagates cancellation to the provider host. */
  signal?: AbortSignal
}

const STATE_FILE = 'plugin-state.json'
const PLUGIN_ACTIVATE_TIMEOUT_MS = 5000
const PLUGIN_DEACTIVATE_TIMEOUT_MS = 1500
const PLUGIN_UI_COMMAND_TIMEOUT_MS = 5000
const INTERNAL_NCM_PLUGIN_ID = 'com.twilightecho.provider.ncm'
const RESERVED_PROVIDER_IDS = new Set(['local', 'ncm'])
const PUBLIC_APP_EVENTS = new Set(['app:ready', 'app:before-quit'])
const PLAYER_EVENTS = new Set([
  'player:track-change',
  'player:play',
  'player:pause',
  'player:stop',
  'player:progress',
  'player:queue-change',
  'player:playback-info'
])
const PLUGIN_EVENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(?::[a-zA-Z0-9-]+)+$/

export class TwilightPluginManager extends EventEmitter {
  private readonly appVersion: string
  private readonly hostEntry: string
  private readonly bundledPlugins: NonNullable<TwilightPluginManagerOptions['bundledPlugins']>
  private readonly ncm: TwilightPluginManagerOptions['ncm']
  private readonly getPlaybackInfo: TwilightPluginManagerOptions['getPlaybackInfo']
  private readonly applyNativeDspPluginChain: TwilightPluginManagerOptions['applyNativeDspPluginChain']
  private readonly player: TwilightPluginManagerOptions['player']
  private readonly getProxyEnv: TwilightPluginManagerOptions['getProxyEnv']
  private readonly running = new Map<string, RunningPlugin>()
  private readonly providerHealth = new Map<string, ProviderHealthRecord>()
  private readonly stopOperations = new Map<string, Promise<void>>()
  private readonly internalNcmRequests = new Map<string, AbortController>()
  private readonly loggedThemeCompatibilityNotes = new Set<string>()
  /**
   * Every state-changing lifecycle action for one plugin shares this queue.
   * Staging may happen before the manifest id is known, but no installed
   * state, runtime, DSP chain, or plugin directory changes outside it.
   */
  private readonly pluginOperationQueue = new PluginOperationQueue()
  private readonly rpcCalls = new PluginRpcCoordinator()
  private statePersistence: PluginStatePersistence | null = null
  private shuttingDown = false
  private state: PluginStateFile = {}

  constructor(options: TwilightPluginManagerOptions) {
    super()
    this.appVersion = options.appVersion
    this.hostEntry = options.hostEntry
    this.bundledPlugins = options.bundledPlugins ?? []
    this.ncm = options.ncm
    this.getPlaybackInfo = options.getPlaybackInfo
    this.applyNativeDspPluginChain = options.applyNativeDspPluginChain
    this.player = options.player
    this.getProxyEnv = options.getProxyEnv
  }

  get roots(): {
    plugins: string
    staging: string
    data: string
    logs: string
    stateFile: string
  } {
    const userData = app.getPath('userData')
    return {
      plugins: join(userData, 'plugins'),
      staging: join(userData, 'plugin-staging'),
      data: join(userData, 'plugin-data'),
      logs: join(userData, 'logs', 'plugins'),
      stateFile: join(userData, STATE_FILE)
    }
  }

  async initialize(): Promise<void> {
    this.ensureRoots()
    await this.loadState()
    await this.syncBundledPlugins()
    await this.scanAndStartEnabled()
    await this.syncNativeDspChain()
  }

  async list(): Promise<TwilightPluginDescriptor[]> {
    this.ensureRoots()
    const descriptorsById = new Map<string, TwilightPluginDescriptor[]>()
    const rootEntries = await safeReadDir(this.roots.plugins)
    for (const pluginDir of rootEntries) {
      const idRoot = join(this.roots.plugins, pluginDir)
      const versionEntries = await safeReadDir(idRoot)
      for (const version of versionEntries) {
        const descriptor = await this.readDescriptor(join(idRoot, version), 'scan')
        const descriptors = descriptorsById.get(descriptor.id) ?? []
        descriptors.push(descriptor)
        descriptorsById.set(descriptor.id, descriptors)
      }
    }
    return [...descriptorsById.entries()]
      .map(([id, descriptors]) => this.selectActiveDescriptor(id, descriptors))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async installFromPath(
    sourcePath: string,
    options: InstallFromPathOptions = {}
  ): Promise<TwilightPluginInstallResult> {
    const source = resolve(sourcePath)
    if (!existsSync(source)) throw new Error('插件来源不存在')
    const sourceStats = await stat(source)
    const isTep = sourceStats.isFile() && extname(source).toLowerCase() === '.tep'
    if (!sourceStats.isDirectory() && !isTep) {
      throw new Error('插件来源必须是目录或 .tep 文件')
    }
    if (isTep) await assertPluginPackageFileSize(source)
    const transactionRoot = await this.createInstallStagingRoot()
    try {
      const suppliedEvidence: TwilightPluginInstallEvidence = options.evidence ?? {
        sourceLabel: options.sourceLabel ?? source,
        indexSourceUrl: null,
        configuredIndexUrl: null,
        loadedFrom: 'local',
        fetchedAt: null,
        expiresAt: null,
        stale: false,
        expired: false,
        originVerified: false,
        cacheFormat: null,
        expectedPackageSha256: null,
        packageSha256: null,
        checksumVerified: false,
        manifestVerified: false,
        verification: null
      }
      let installSource: string
      let manifest: TwilightPluginManifest
      if (isTep) {
        const packageStagingRoot = join(transactionRoot, 'package')
        mkdirSync(packageStagingRoot, { recursive: true })
        const boundary = await runFinalPluginPackageTrustBoundary({
          sourcePath: source,
          stagingRoot: packageStagingRoot,
          evidence: suppliedEvidence,
          inspectStagedPackage: async (packagePath) => {
            const candidateSource = await this.extractTep(
              packagePath,
              join(packageStagingRoot, 'extract')
            )
            const candidateManifest = await this.readManifest(candidateSource)
            if (this.isBundledPluginId(candidateManifest.id)) {
              throw new Error('自带插件随 Twilight Echo 分发，不能用本地包覆盖安装')
            }
            await assertPluginTreeSafe(candidateSource)
            return { installSource: candidateSource, manifest: candidateManifest }
          },
          requestConfirmation: ({ manifest: candidateManifest }, evidence) =>
            this.requestTrustBasedInstall(candidateManifest, evidence)
        })
        installSource = boundary.inspected.installSource
        manifest = boundary.inspected.manifest
      } else {
        installSource = source
        const boundEvidence = bindFinalPluginPackageEvidence(suppliedEvidence, null)
        manifest = await this.readManifest(installSource)
        if (this.isBundledPluginId(manifest.id)) {
          throw new Error('自带插件随 Twilight Echo 分发，不能用本地包覆盖安装')
        }
        await assertPluginTreeSafe(installSource)
        const evidence = { ...boundEvidence, manifestVerified: true }
        await confirmPluginInstallWithFreshEvidence(evidence, () =>
          this.requestTrustBasedInstall(manifest, evidence)
        )
      }
      return await this.pluginOperationQueue.run(manifest.id, async () => {
        const candidateRoot = join(transactionRoot, 'candidate')
        await cp(installSource, candidateRoot, {
          recursive: true,
          filter: (path) => !isInsidePath(path, this.roots.plugins)
        })
        await assertPluginTreeSafe(candidateRoot)
        const stagedManifest = await this.readManifest(candidateRoot)
        if (stagedManifest.id !== manifest.id || stagedManifest.version !== manifest.version) {
          throw new Error('Staged plugin manifest changed during installation.')
        }

        const previousState = cloneStateRecord(this.state[manifest.id])
        const previousDescriptor = await this.findDescriptor(manifest.id).catch(() => null)
        const wasEnabled = previousState?.enabled === true
        const target = this.versionRoot(manifest.id, manifest.version)
        const now = new Date().toISOString()
        const sourceType: TwilightPluginSource = options.source ?? (isTep ? 'tep' : 'directory')
        const nextState: TwilightPluginStateRecord = {
          ...previousState,
          enabled: wasEnabled,
          installedAt: previousState?.installedAt ?? now,
          updatedAt: now,
          source: sourceType,
          activeVersion: manifest.version,
          lastError: undefined
        }
        const candidate = await this.readDescriptor(candidateRoot, sourceType, {
          paths: this.pathsForRoot(manifest.id, manifest.version, candidateRoot),
          state: nextState
        })
        let committedPlugin: TwilightPluginDescriptor | null = null
        let previousWasStopped = false

        await this.commitStagedPluginUpdateWithReporting(manifest.id, {
          stagingRoot: transactionRoot,
          candidateRoot,
          targetRoot: target,
          validateCandidate: async () => {
            if (candidate.status === 'invalid') {
              throw new Error(candidate.error ?? 'Staged plugin is invalid.')
            }
          },
          trialActivateCandidate: async () => {
            if (wasEnabled) {
              await this.stopPlugin(manifest.id)
              previousWasStopped = true
            }
            await this.trialActivatePlugin(candidate)
          },
          commitActiveVersion: async () => {
            this.state[manifest.id] = nextState
            await this.saveState()
          },
          activateCommittedCandidate: async () => {
            const activeCandidate = await this.readDescriptor(target, sourceType)
            if (activeCandidate.status === 'invalid') {
              throw new Error(activeCandidate.error ?? 'Installed plugin is invalid.')
            }
            committedPlugin = activeCandidate
            if (!wasEnabled) return
            if (activeCandidate.main) await this.startPlugin(activeCandidate)
            await this.syncNativeDspChain()
          },
          rollbackActiveVersion: async () => {
            if (previousState) this.state[manifest.id] = previousState
            else delete this.state[manifest.id]
            await this.saveState()
          },
          restorePreviousVersion: async () => {
            if (!previousWasStopped || !wasEnabled || !previousDescriptor) return
            await this.stopPlugin(manifest.id)
            if (previousDescriptor.main) await this.startPlugin(previousDescriptor)
            await this.syncNativeDspChain()
          }
        })

        const plugin = committedPlugin ?? (await this.readDescriptor(target, sourceType))
        this.emit('changed')
        return {
          plugin,
          warning: '信任式安装：插件拥有与应用相同的权限，请仅安装可信来源。'
        }
      })
    } finally {
      await rm(transactionRoot, { recursive: true, force: true })
    }
  }

  async chooseAndInstall(): Promise<TwilightPluginInstallResult | null> {
    const result = await dialog.showOpenDialog({
      title: '安装 Twilight Echo 插件',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'Twilight Echo Plugin', extensions: ['tep'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return this.installFromPath(result.filePaths[0])
  }

  async enable(id: string): Promise<TwilightPluginDescriptor> {
    return this.pluginOperationQueue.run(id, () => this.enableUnchecked(id))
  }

  private async enableUnchecked(id: string): Promise<TwilightPluginDescriptor> {
    const descriptor = await this.findDescriptor(id)
    if (descriptor.status === 'invalid') throw new Error(descriptor.error ?? '插件无效')
    try {
      this.setEnabled(id, true)
      const descriptors = await this.list()
      const startupPlan = planPluginStartup(descriptors)
      const dependencyError = startupPlan.failures.get(id)
      if (dependencyError) throw new Error(dependencyError)
      const refreshed = await this.findDescriptor(id)
      if (refreshed.main) {
        await this.startPlugin(refreshed)
      } else {
        this.markStarted(refreshed)
      }
      await this.syncNativeDspChain()
    } catch (error) {
      this.markFailed(id, error instanceof Error ? error.message : String(error), descriptor)
      throw error
    }
    return this.findDescriptor(id)
  }

  async disable(id: string): Promise<TwilightPluginDescriptor> {
    return this.pluginOperationQueue.run(id, () => this.disableUnchecked(id))
  }

  private async disableUnchecked(id: string): Promise<TwilightPluginDescriptor> {
    this.setEnabled(id, false)
    await this.stopPlugin(id)
    await this.syncNativeDspChain()
    return this.findDescriptor(id)
  }

  async uninstall(id: string, options: TwilightPluginUninstallOptions = {}): Promise<void> {
    return this.pluginOperationQueue.run(id, () => this.uninstallUnchecked(id, options))
  }

  private async uninstallUnchecked(
    id: string,
    options: TwilightPluginUninstallOptions
  ): Promise<void> {
    if (this.isBundledPluginId(id)) {
      throw new Error('自带插件不能卸载；如需关闭，请在插件页停用')
    }
    await this.disableUnchecked(id).catch(() => undefined)
    await rm(join(this.roots.plugins, id), { recursive: true, force: true })
    if (options.removeData) {
      await rm(join(this.roots.data, id), { recursive: true, force: true })
    }
    delete this.state[id]
    await this.saveState()
    await this.syncNativeDspChain()
    this.emit('changed')
  }

  async openLog(id: string): Promise<void> {
    const descriptor = await this.findDescriptor(id)
    ensureParent(descriptor.paths.logPath)
    if (!existsSync(descriptor.paths.logPath))
      await writeFile(descriptor.paths.logPath, '', 'utf-8')
    shell.showItemInFolder(descriptor.paths.logPath)
  }

  async getLog(id: string): Promise<string> {
    const descriptor = await this.findDescriptor(id)
    try {
      const raw = await readFile(descriptor.paths.logPath, 'utf-8')
      return raw.slice(-20000)
    } catch {
      return ''
    }
  }

  async handleNativeDspHostCrash(reason: string): Promise<void> {
    const descriptors = await this.list()
    for (const descriptor of descriptors) {
      if (!descriptor.enabled || !descriptor.type.includes('dsp')) continue
      const message = `原生 DSP 音频服务崩溃，已旁路：${reason}`
      await this.pluginOperationQueue.run(descriptor.id, async () => {
        // An uninstall may have completed before this crash notification reached us.
        if (!this.state[descriptor.id]) return
        this.markFailed(descriptor.id, message, descriptor)
        this.appendLog(descriptor, 'error', message)
      })
    }
    await this.applyNativeDspPluginChain(JSON.stringify({ plugins: [] }))
    await this.saveState()
    this.emit('changed')
  }

  async setNativeDspPluginParameters(
    id: string,
    parameters: Record<string, number>
  ): Promise<TwilightPluginDescriptor> {
    return this.pluginOperationQueue.run(id, () =>
      this.setNativeDspPluginParametersUnchecked(id, parameters)
    )
  }

  private async setNativeDspPluginParametersUnchecked(
    id: string,
    parameters: Record<string, number>
  ): Promise<TwilightPluginDescriptor> {
    const descriptor = await this.findDescriptor(id)
    if (!descriptor.type.includes('dsp')) throw new Error('只有 DSP 插件支持原生参数')
    const normalized: Record<string, number> = {}
    for (const [key, value] of Object.entries(parameters)) {
      const name = key.trim()
      if (!name) continue
      if (!Number.isFinite(value)) throw new Error(`DSP 参数不是有限数字：${name}`)
      normalized[name] = value
    }
    const state = this.state[id]
    if (!state) throw new Error('插件状态不存在')
    state.nativeDspParameters = normalized
    state.updatedAt = new Date().toISOString()
    await this.saveState()
    await this.syncNativeDspChain()
    this.emit('changed')
    return this.findDescriptor(id)
  }

  async broadcastEvent(name: string, payload: unknown): Promise<void> {
    for (const running of this.running.values()) {
      if (running.subscriptions.has(name)) {
        running.process.postMessage({ kind: 'event', name, payload } satisfies PluginHostRequest)
      }
    }
  }

  listProviders(): TwilightMediaProviderRegistration[] {
    return dedupeProviderRegistrations(this.running.values()).map((provider) => ({
      ...provider,
      health: this.getProviderHealth(provider.id)
    }))
  }

  async listExtensions(): Promise<TwilightPluginExtensionContribution[]> {
    const runningExtensions = [...this.running.values()]
      .filter((running) => running.ui.length > 0 || running.themes.length > 0)
      .map((running) => ({
        pluginId: running.descriptor.id,
        ui: running.ui,
        themes: running.themes
      }))
    const runningPluginIds = new Set(runningExtensions.map((entry) => entry.pluginId))
    const manifestThemeExtensions = (await this.list())
      .filter((descriptor) => descriptor.enabled && descriptor.status !== 'invalid')
      .filter((descriptor) => !runningPluginIds.has(descriptor.id))
      .map((descriptor) => ({
        pluginId: descriptor.id,
        ui: [],
        themes: this.normalizeDeclarativeThemeContributions(descriptor)
      }))
      .filter((entry) => entry.themes.length > 0)
    return [...runningExtensions, ...manifestThemeExtensions]
  }

  async executeUiCommand(command: string, args: unknown[] = []): Promise<unknown> {
    const normalized = command.trim()
    if (!normalized) throw new Error('UI command 不能为空')
    const running = [...this.running.values()].find((candidate) =>
      candidate.ui.some((contribution) => contribution.command === normalized)
    )
    if (!running) throw new Error(`UI command 未注册：${normalized}`)
    const requestId = randomUUID()
    return this.rpcCalls.request<unknown, UiCommandRpcMetadata>({
      requestId,
      pluginId: running.descriptor.id,
      kind: 'ui-command',
      timeoutMs: PLUGIN_UI_COMMAND_TIMEOUT_MS,
      metadata: { command: normalized, pluginId: running.descriptor.id },
      dispatch: () => {
        this.assertRunningPlugin(running)
        running.process.postMessage({
          kind: 'ui-command',
          requestId,
          command: normalized,
          args
        } satisfies PluginHostRequest)
      },
      cancel: (reason) => this.cancelHostRpc(running, requestId, reason),
      onTimeout: () => {
        const latestRunning = this.running.get(running.descriptor.id)
        this.markFailed(
          running.descriptor.id,
          `UI command 调用超时：${normalized}`,
          latestRunning?.descriptor ?? running.descriptor
        )
        void this.stopPlugin(running.descriptor.id)
      }
    })
  }

  async callProvider(
    providerId: string,
    method: TwilightMediaProviderMethod,
    args: unknown[],
    options: TwilightProviderCallOptions = {}
  ): Promise<unknown> {
    const normalizedProviderId = providerId.trim().toLowerCase()
    const running = findProviderRoute(this.running.values(), normalizedProviderId, method)
    const hasProvider = [...this.running.values()].some((candidate) =>
      candidate.providers.some((provider) => provider.id === normalizedProviderId)
    )
    if (!running) {
      const isBundledProvider = this.isBundledPluginId(normalizedProviderId)
      throw new Error(
        hasProvider
          ? isBundledProvider
            ? `Provider ${normalizedProviderId} does not implement ${method}。内置音源插件尚未加载最新代码，请重启应用。`
            : `Provider ${normalizedProviderId} does not implement ${method}`
          : `Provider 未启用：${normalizedProviderId}`
      )
    }

    const requestId = randomUUID()
    const idempotencyKey = resolveProviderIdempotencyKey(method, options.idempotencyKey)
    return this.rpcCalls.request<unknown, ProviderRpcMetadata>({
      requestId,
      pluginId: running.descriptor.id,
      kind: 'provider',
      timeoutMs: getProviderCallTimeoutMs(method),
      metadata: {
        providerId: normalizedProviderId,
        pluginId: running.descriptor.id,
        method
      },
      dispatch: () => {
        this.assertRunningPlugin(running)
        running.process.postMessage({
          kind: 'provider-call',
          requestId,
          providerId: normalizedProviderId,
          method,
          args,
          idempotencyKey
        } satisfies PluginHostRequest)
      },
      cancel: (reason) => this.cancelHostRpc(running, requestId, reason),
      signal: options.signal,
      onTimeout: () => {
        this.recordProviderCallFailure(
          normalizedProviderId,
          running.descriptor.id,
          method,
          `Provider 调用超时：${normalizedProviderId}.${method}`
        )
      },
      ...(idempotencyKey
        ? {
            idempotency: {
              scope: `${running.descriptor.id}:${normalizedProviderId}:${method}`,
              key: idempotencyKey,
              fingerprint: JSON.stringify(args)
            }
          }
        : {})
    })
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true
    try {
      await Promise.all([...this.running.keys()].map((id) => this.stopPlugin(id)))
    } finally {
      await this.statePersistenceFor().flush()
    }
  }

  private assertRunningPlugin(running: RunningPlugin): void {
    if (this.running.get(running.descriptor.id) !== running) {
      throw new Error(`Plugin ${running.descriptor.id} is no longer running.`)
    }
  }

  private cancelHostRpc(running: RunningPlugin, requestId: string, reason: string): void {
    if (this.running.get(running.descriptor.id) !== running) return
    running.process.postMessage({ kind: 'cancel', requestId, reason } satisfies PluginHostRequest)
  }

  private internalNcmRequestKey(pluginId: string, requestId: string): string {
    return `${pluginId}\u0000${requestId}`
  }

  private abortInternalNcmRequest(pluginId: string, requestId: string, reason: string): void {
    const key = this.internalNcmRequestKey(pluginId, requestId)
    const controller = this.internalNcmRequests.get(key)
    if (!controller) return
    controller.abort(new Error(reason))
  }

  private abortInternalNcmRequests(pluginId: string, reason: string): void {
    const prefix = `${pluginId}\u0000`
    for (const [key, controller] of this.internalNcmRequests) {
      if (!key.startsWith(prefix)) continue
      controller.abort(new Error(reason))
      this.internalNcmRequests.delete(key)
    }
  }

  private async scanAndStartEnabled(): Promise<void> {
    const descriptors = await this.list()
    const startupPlan = planPluginStartup(descriptors)
    for (const [id, error] of startupPlan.failures) {
      const descriptor = descriptors.find((candidate) => candidate.id === id)
      this.markFailed(id, error, descriptor)
    }
    // `ordered` is a dependency topological order; activation waits up to 5s
    // per plugin, so start each dependency level concurrently instead of paying
    // the sum of every plugin's activation time.
    const startupDepthById = new Map<string, number>()
    const wavesByDepth = new Map<number, TwilightPluginDescriptor[]>()
    for (const descriptor of startupPlan.ordered) {
      let depth = 0
      for (const dependencyId of Object.keys(descriptor.dependencies ?? {})) {
        depth = Math.max(depth, (startupDepthById.get(dependencyId) ?? -1) + 1)
      }
      startupDepthById.set(descriptor.id, depth)
      if (!descriptor.main) continue
      const wave = wavesByDepth.get(depth) ?? []
      wave.push(descriptor)
      wavesByDepth.set(depth, wave)
    }
    for (const depth of [...wavesByDepth.keys()].sort((left, right) => left - right)) {
      const wave = wavesByDepth.get(depth) ?? []
      await Promise.all(
        wave.map(async (descriptor) => {
          await this.startPlugin(descriptor).catch((error) => {
            this.markFailed(
              descriptor.id,
              error instanceof Error ? error.message : String(error),
              descriptor
            )
          })
        })
      )
    }
  }

  private async syncBundledPlugins(): Promise<void> {
    for (const bundled of this.bundledPlugins) {
      try {
        if (!existsSync(bundled.sourcePath)) continue
        const manifest = await this.readManifest(bundled.sourcePath)
        if (manifest.id !== bundled.id) {
          throw new Error(`自带插件 ID 不匹配：${manifest.id} !== ${bundled.id}`)
        }

        const targetRoot = join(this.roots.plugins, manifest.id)
        const target = this.versionRoot(manifest.id, manifest.version)
        await rm(targetRoot, { recursive: true, force: true })
        mkdirSync(dirname(target), { recursive: true })
        await cp(bundled.sourcePath, target, { recursive: true })

        const now = new Date().toISOString()
        const previous = this.state[manifest.id]
        const shouldRecoverBundledFailure =
          previous?.enabled === false &&
          previous?.source === 'bundled' &&
          isRecoverableBundledPluginFailure(previous.lastError)
        this.state[manifest.id] = {
          ...previous,
          enabled: shouldRecoverBundledFailure
            ? bundled.defaultEnabled === true
            : (previous?.enabled ?? bundled.defaultEnabled === true),
          installedAt: previous?.installedAt ?? now,
          updatedAt: previous?.updatedAt ?? now,
          source: 'bundled',
          activeVersion: manifest.version,
          lastError: shouldRecoverBundledFailure ? undefined : previous?.lastError
        }
      } catch (error) {
        console.error(
          `[插件系统] 同步自带插件失败：${bundled.id}`,
          error instanceof Error ? error.message : error
        )
      }
    }
    await this.saveState()
  }

  private async syncNativeDspChain(descriptors?: TwilightPluginDescriptor[]): Promise<void> {
    const currentDescriptors = descriptors ?? (await this.list())
    const enabled = currentDescriptors
      .filter(
        (descriptor) =>
          descriptor.enabled && descriptor.status !== 'invalid' && descriptor.type.includes('dsp')
      )
      .filter((descriptor) => this.resolveNativeDspBinary(descriptor) !== null)
      .sort((left, right) => left.id.localeCompare(right.id))
    const chain = {
      plugins: enabled.map((descriptor) => ({
        id: descriptor.id,
        path: this.resolveNativeDspBinary(descriptor),
        enabled: true,
        parameters: this.state[descriptor.id]?.nativeDspParameters ?? {}
      }))
    }
    await this.applyNativeDspPluginChain(JSON.stringify(chain))
  }

  private async trialActivatePlugin(candidate: TwilightPluginDescriptor): Promise<void> {
    this.normalizeDeclarativeThemeContributions(candidate)
    await trialStagedPluginCandidate({
      candidate,
      listActiveDescriptors: () => this.list(),
      startJavaScriptCandidate: () =>
        this.startPlugin(candidate, { persistState: false, trial: true }),
      stopJavaScriptCandidate: () => this.stopPlugin(candidate.id),
      syncDspChain: (descriptors) => this.syncNativeDspChain(descriptors)
    })
  }

  private async commitStagedPluginUpdateWithReporting(
    pluginId: string,
    options: StagedPluginUpdateOptions
  ): Promise<void> {
    try {
      await commitStagedPluginUpdate(options)
    } catch (error) {
      if (error instanceof PluginUpdateRollbackError) {
        this.reportPluginUpdateRollbackFailure(pluginId, error)
      }
      throw error
    }
  }

  private async startPlugin(
    descriptor: TwilightPluginDescriptor,
    options: StartPluginOptions = {}
  ): Promise<void> {
    await this.stopOperations.get(descriptor.id)
    if (this.running.has(descriptor.id)) return
    if (!descriptor.main) throw new Error('JS 插件缺少 main 入口')
    if (!isCompatibleTwilightRange(descriptor.engines.twilightEcho, this.appVersion)) {
      throw new Error(`插件要求 Twilight Echo ${descriptor.engines.twilightEcho}`)
    }
    const mainPath = resolve(descriptor.paths.versionRoot, descriptor.main)
    const safeMainPath = resolvePluginFile(mainPath, descriptor.paths.versionRoot)
    if (!safeMainPath) {
      throw new Error('插件 main 入口不存在或越界')
    }
    mkdirSync(descriptor.paths.dataDir, { recursive: true })
    const proxyEnv = this.getProxyEnv?.() ?? {}
    const child = utilityProcess.fork(this.hostEntry, [], {
      serviceName: `twilight-plugin-${descriptor.id}`,
      stdio: 'pipe',
      ...(Object.keys(proxyEnv).length > 0 ? { env: { ...process.env, ...proxyEnv } } : {})
    })
    const running: RunningPlugin = {
      process: child,
      descriptor,
      trial: options.trial === true,
      subscriptions: new Set(),
      providers: [],
      ui: [],
      themes: this.normalizeDeclarativeThemeContributions(descriptor)
    }
    this.running.set(descriptor.id, running)
    child.on('message', (message: PluginHostResponse) => {
      void this.handleHostMessage(descriptor.id, message)
    })
    child.on('exit', (code) => {
      if (this.running.get(descriptor.id) !== running) return
      const wasStopping = this.stopOperations.has(descriptor.id)
      this.rpcCalls.cancelPlugin(
        descriptor.id,
        `Plugin host exited before its pending RPCs completed (exit code: ${code}).`
      )
      this.abortInternalNcmRequests(
        descriptor.id,
        `Plugin host exited before its internal API completed (exit code: ${code}).`
      )
      this.running.delete(descriptor.id)
      if (
        this.state[descriptor.id]?.enabled &&
        !running.trial &&
        !wasStopping &&
        !this.shuttingDown
      ) {
        this.markFailed(descriptor.id, `插件宿主进程退出：${code}`)
      }
    })
    child.on('error', (_type, location) => {
      if (this.running.get(descriptor.id) !== running) return
      const errorMessage = `插件宿主进程错误：${location}`
      this.rpcCalls.cancelPlugin(descriptor.id, errorMessage)
      this.abortInternalNcmRequests(descriptor.id, errorMessage)
      if (!running.trial) this.markFailed(descriptor.id, errorMessage)
      void this.stopPlugin(descriptor.id)
    })
    child.stdout?.on('data', (chunk) => this.appendLog(descriptor, 'info', chunk.toString()))
    child.stderr?.on('data', (chunk) => this.appendLog(descriptor, 'error', chunk.toString()))
    const activation = this.waitForActivation(child, descriptor)
    child.postMessage({
      kind: 'activate',
      pluginId: descriptor.id,
      manifest: toManifest(descriptor),
      mainPath: safeMainPath,
      dataDir: descriptor.paths.dataDir,
      apiVersion: descriptor.apiVersion
    } satisfies PluginHostRequest)
    try {
      await activation
      if (options.persistState !== false) this.markStarted(descriptor)
      this.appendLog(descriptor, 'info', '插件已激活')
    } catch (error) {
      await this.stopPlugin(descriptor.id).catch(() => undefined)
      throw error
    }
  }

  private async stopPlugin(id: string): Promise<void> {
    const existingStop = this.stopOperations.get(id)
    if (existingStop) return existingStop
    const running = this.running.get(id)
    if (!running) {
      this.rpcCalls.cancelPlugin(id, `Plugin ${id} is no longer running.`)
      this.abortInternalNcmRequests(id, `Plugin ${id} is no longer running.`)
      return
    }
    const trackedStop = this.stopRunningPlugin(id, running).finally(() => {
      if (this.stopOperations.get(id) === trackedStop) this.stopOperations.delete(id)
    })
    this.stopOperations.set(id, trackedStop)
    return trackedStop
  }

  private async stopRunningPlugin(id: string, running: RunningPlugin): Promise<void> {
    this.rpcCalls.cancelPlugin(id, `Plugin ${id} was stopped before its RPC completed.`)
    this.abortInternalNcmRequests(id, `Plugin ${id} was stopped before its internal API completed.`)
    const requestId = randomUUID()
    try {
      running.process.postMessage({ kind: 'deactivate', requestId } satisfies PluginHostRequest)
    } catch {
      // The process can exit between the lifecycle lookup and postMessage.
    }
    await new Promise<void>((resolveDone) => {
      const timer = setTimeout(resolveDone, PLUGIN_DEACTIVATE_TIMEOUT_MS)
      const onMessage = (message: PluginHostResponse): void => {
        if (message.kind === 'deactivated' && message.requestId === requestId) {
          clearTimeout(timer)
          running.process.off('message', onMessage)
          resolveDone()
        }
      }
      running.process.on('message', onMessage)
    })
    await new Promise<void>((resolveDone) => {
      const timer = setTimeout(resolveDone, PLUGIN_DEACTIVATE_TIMEOUT_MS)
      running.process.once('exit', () => {
        clearTimeout(timer)
        resolveDone()
      })
      running.process.kill()
    })
    if (this.running.get(id) === running) this.running.delete(id)
  }

  private waitForActivation(
    child: UtilityProcess,
    descriptor: TwilightPluginDescriptor
  ): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('error', onError)
      }
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) rejectReady(error)
        else resolveReady()
      }
      const timer = setTimeout(() => {
        this.appendLog(descriptor, 'error', `插件启动超时：${PLUGIN_ACTIVATE_TIMEOUT_MS}ms`)
        settle(new Error(`插件启动超时：${PLUGIN_ACTIVATE_TIMEOUT_MS}ms`))
      }, PLUGIN_ACTIVATE_TIMEOUT_MS)
      const onMessage = (message: PluginHostResponse): void => {
        if (message.kind === 'activated' && message.pluginId === descriptor.id) {
          settle()
        } else if (message.kind === 'host-error') {
          settle(new Error(message.message))
        }
      }
      const onExit = (code: number | null): void => {
        settle(new Error(`插件宿主进程退出：${code}`))
      }
      const onError = (_type: unknown, location: unknown): void => {
        settle(new Error(`插件宿主进程错误：${String(location)}`))
      }
      child.on('message', onMessage)
      child.on('exit', onExit)
      child.on('error', onError)
    })
  }

  private async handleHostMessage(id: string, message: PluginHostResponse): Promise<void> {
    const running = this.running.get(id)
    if (!running) return
    if (message.kind === 'log') {
      this.appendLog(running.descriptor, message.level, message.message)
      return
    }
    if (message.kind === 'host-error') {
      if (!running.trial) this.markFailed(id, message.message)
      await this.stopPlugin(id)
      return
    }
    if (message.kind === 'api-event-subscribe') {
      try {
        const eventName = this.normalizeEventSubscription(id, message.eventName)
        running.subscriptions.add(eventName)
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        if (!running.trial) this.markFailed(id, messageText, running.descriptor)
        await this.stopPlugin(id)
        return
      }
      return
    }
    if (message.kind === 'api-cancel') {
      this.abortInternalNcmRequest(id, message.requestId, message.reason)
      return
    }
    if (message.kind === 'api-call') {
      const controller =
        message.namespace === 'internal' && message.method === 'ncmRequest'
          ? new AbortController()
          : null
      const requestKey = controller ? this.internalNcmRequestKey(id, message.requestId) : null
      if (controller && requestKey) this.internalNcmRequests.set(requestKey, controller)
      try {
        const result = await this.handleApiCall(id, message, controller?.signal)
        if (this.running.get(id) === running) running.process.postMessage(result)
      } finally {
        if (requestKey && this.internalNcmRequests.get(requestKey) === controller) {
          this.internalNcmRequests.delete(requestKey)
        }
      }
    }
    if (message.kind === 'provider-result') {
      this.handleProviderResult(id, message)
    }
    if (message.kind === 'ui-command-result') {
      this.handleUiCommandResult(id, message)
    }
  }

  private async handleApiCall(
    id: string,
    message: Extract<PluginHostResponse, { kind: 'api-call' }>,
    signal?: AbortSignal
  ): Promise<PluginHostApiResult> {
    try {
      if (message.namespace === 'providers') {
        return {
          kind: 'api-result',
          requestId: message.requestId,
          ok: true,
          value: this.registerProviderFromPlugin(id, message)
        }
      }
      if (message.namespace === 'extensions') {
        return {
          kind: 'api-result',
          requestId: message.requestId,
          ok: true,
          value: this.registerExtensionFromPlugin(id, message)
        }
      }
      if (message.namespace === 'internal') {
        return {
          kind: 'api-result',
          requestId: message.requestId,
          ok: true,
          value: await this.handleInternalApiCall(id, message, signal)
        }
      }
      if (message.namespace !== 'player') throw new Error('未知 API 命名空间')
      const method = message.method
      if (method === 'getPlaybackInfo') {
        this.requirePermission(id, 'player:observe', 'player.getPlaybackInfo')
        return {
          kind: 'api-result',
          requestId: message.requestId,
          ok: true,
          value: await this.getPlaybackInfo()
        }
      }
      if (['play', 'pause', 'togglePause', 'stop', 'next', 'previous'].includes(method)) {
        this.requirePermission(id, 'player:control', `player.${method}`)
        await this.player[method as keyof typeof this.player]()
        return { kind: 'api-result', requestId: message.requestId, ok: true, value: null }
      }
      throw new Error('未知播放器 API')
    } catch (error) {
      return {
        kind: 'api-result',
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private registerProviderFromPlugin(
    pluginId: string,
    message: Extract<PluginHostResponse, { kind: 'api-call' }>
  ): TwilightMediaProviderRegistration {
    if (message.method !== 'register') throw new Error('未知 Provider API')
    const running = this.running.get(pluginId)
    if (!running) throw new Error('插件未运行')
    if (!running.descriptor.type.includes('provider')) {
      throw new Error('只有 provider 类型插件可以注册 MediaProvider')
    }
    const raw = message.args[0]
    if (!raw || typeof raw !== 'object') throw new Error('Provider 注册信息必须是对象')
    const record = raw as Record<string, unknown>
    const providerId = typeof record.id === 'string' ? record.id.trim().toLowerCase() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const capabilities = Array.isArray(record.capabilities)
      ? record.capabilities.filter(
          (item): item is TwilightMediaProviderRegistration['capabilities'][number] =>
            typeof item === 'string' &&
            [
              'search',
              'playbackUrl',
              'lyrics',
              'cover',
              'playlist',
              'library',
              'login',
              'download'
            ].includes(item)
        )
      : []
    if (!providerId || !/^[a-z][a-z0-9-]*$/.test(providerId)) {
      throw new Error('Provider id 必须是小写前缀，例如 bili 或 ncm')
    }
    if (!name) throw new Error('Provider name 必填')
    if (capabilities.length === 0) throw new Error('Provider capabilities 必须声明至少一项能力')
    this.requirePermission(pluginId, 'network', 'providers.register')
    this.requireProviderCapabilityPermissions(pluginId, capabilities)
    this.assertProviderIdAvailable(pluginId, providerId)
    const ui = normalizeProviderUi(record.ui)
    const health = normalizeProviderHealth(record.health, providerId, pluginId)
    if (health) this.providerHealth.set(providerId, health)
    const provider: TwilightMediaProviderRegistration = { id: providerId, name, capabilities, ui }
    const existingIndex = running.providers.findIndex((candidate) => candidate.id === providerId)
    if (existingIndex >= 0) running.providers[existingIndex] = provider
    else running.providers.push(provider)
    this.emit('changed')
    return provider
  }

  private normalizeEventSubscription(pluginId: string, rawEventName: unknown): string {
    const eventName = typeof rawEventName === 'string' ? rawEventName.trim() : ''
    if (!eventName || eventName.length > 128 || !PLUGIN_EVENT_NAME_PATTERN.test(eventName)) {
      throw new Error('插件事件名称无效')
    }
    if (PLAYER_EVENTS.has(eventName) || eventName.startsWith('audioEngine:')) {
      this.requirePermission(pluginId, 'player:observe', `订阅 ${eventName}`)
      return eventName
    }
    if (eventName.startsWith('library:')) {
      this.requirePermission(pluginId, 'library:read', `订阅 ${eventName}`)
      return eventName
    }
    if (PUBLIC_APP_EVENTS.has(eventName)) {
      return eventName
    }
    throw new Error(`不支持的插件事件：${eventName}`)
  }

  private requireProviderCapabilityPermissions(
    pluginId: string,
    capabilities: TwilightMediaProviderRegistration['capabilities']
  ): void {
    if (capabilities.includes('library')) {
      this.requirePermission(pluginId, 'library:read', '注册 library Provider 能力')
    }
  }

  private assertProviderIdAvailable(pluginId: string, providerId: string): void {
    if (RESERVED_PROVIDER_IDS.has(providerId)) {
      if (providerId === 'ncm' && pluginId === INTERNAL_NCM_PLUGIN_ID) return
      const owner = providerId === 'ncm' ? '内置网易云插件' : '本地音乐库'
      throw new Error(`Provider id ${providerId} 已保留给${owner}`)
    }
    for (const running of this.running.values()) {
      if (running.descriptor.id === pluginId) continue
      if (running.providers.some((provider) => provider.id === providerId)) {
        throw new Error(`Provider id 已被插件 ${running.descriptor.id} 注册：${providerId}`)
      }
    }
  }

  private async handleInternalApiCall(
    pluginId: string,
    message: Extract<PluginHostResponse, { kind: 'api-call' }>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (pluginId !== INTERNAL_NCM_PLUGIN_ID) {
      throw new Error('内部 API 仅允许自带网易云插件访问')
    }
    if (!this.ncm) throw new Error('网易云内部服务不可用')
    if (message.method === 'ncmRequest') {
      const [path, cookie, rawOptions] = message.args
      if (typeof path !== 'string') throw new Error('ncmRequest path 必须是字符串')
      const options = normalizeInternalNcmRequestOptions(rawOptions)
      return this.ncm.request(path, typeof cookie === 'string' ? cookie : undefined, {
        ...options,
        signal
      })
    }
    if (message.method === 'ncmOfficialLogin') {
      return this.ncm.officialLogin()
    }
    if (message.method === 'ncmGetCachedSong') {
      const songId = Number(message.args[0])
      if (!Number.isFinite(songId)) throw new Error('ncmGetCachedSong songId 无效')
      return this.ncm.getCachedSong(songId)
    }
    if (message.method === 'ncmCacheSong') {
      const songId = Number(message.args[0])
      const url = message.args[1]
      const fileName = message.args[2]
      if (!Number.isFinite(songId)) throw new Error('ncmCacheSong songId 无效')
      if (typeof url !== 'string') throw new Error('ncmCacheSong url 必须是字符串')
      return this.ncm.cacheSong(songId, url, typeof fileName === 'string' ? fileName : undefined)
    }
    throw new Error('未知内部 API')
  }

  private registerExtensionFromPlugin(
    pluginId: string,
    message: Extract<PluginHostResponse, { kind: 'api-call' }>
  ): TwilightUiContribution | TwilightThemeContribution {
    const running = this.running.get(pluginId)
    if (!running) throw new Error('插件未运行')
    if (message.method === 'registerUi') {
      const contribution = normalizeUiContribution(
        running.descriptor.type,
        running.descriptor.permissions,
        message.args[0]
      )
      running.ui.push(contribution)
      this.emit('changed')
      return contribution
    }
    if (message.method === 'registerTheme') {
      throw new Error('主题必须通过 manifest contributes.themes 声明，运行时主题注册已禁用')
    }
    throw new Error('未知扩展 API')
  }

  private normalizeDeclarativeThemeContributions(
    descriptor: TwilightPluginDescriptor
  ): TwilightThemeContribution[] {
    const contributes = descriptor.contributes
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) return []
    const themes = (contributes as Record<string, unknown>).themes
    if (!Array.isArray(themes)) return []
    return themes.map((theme) =>
      this.normalizeThemeContributionFromDescriptor(descriptor, theme, 'manifest theme')
    )
  }

  private normalizeThemeContributionFromDescriptor(
    descriptor: TwilightPluginDescriptor,
    raw: unknown,
    source: string
  ): TwilightThemeContribution {
    const contribution = normalizeThemeContribution({
      pluginApiVersion: descriptor.apiVersion,
      pluginTypes: descriptor.type,
      raw,
      source,
      resolveStylesheet: (stylesheet) => this.resolveThemeStylesheet(descriptor, stylesheet)
    })
    this.recordThemeCompatibilityNotes(descriptor, contribution)
    return contribution
  }

  private recordThemeCompatibilityNotes(
    descriptor: TwilightPluginDescriptor,
    contribution: TwilightThemeContribution
  ): void {
    for (const note of contribution.compatibilityNotes ?? []) {
      const key = `${descriptor.id}@${descriptor.version}:${contribution.id}:${note}`
      if (this.loggedThemeCompatibilityNotes.has(key)) continue
      this.loggedThemeCompatibilityNotes.add(key)
      this.appendLog(descriptor, 'warn', `Theme ${contribution.id}: ${note}`)
    }
  }

  private requirePermission(
    pluginId: string,
    permission: TwilightPluginPermission,
    capability: string
  ): void {
    const running = this.running.get(pluginId)
    if (!running) throw new Error('插件未运行')
    if (!running.descriptor.permissions.includes(permission)) {
      throw new Error(
        `插件 ${running.descriptor.id} 未声明 ${permission} 权限，不能调用 ${capability}`
      )
    }
  }

  private resolveThemeStylesheet(descriptor: TwilightPluginDescriptor, stylesheet: string): string {
    const stylesheetPath = resolve(descriptor.paths.versionRoot, stylesheet)
    const safeStylesheetPath = resolvePluginFile(stylesheetPath, descriptor.paths.versionRoot)
    if (!safeStylesheetPath) {
      throw new Error('主题 stylesheet 不存在或越界')
    }
    return safeStylesheetPath
  }

  private handleProviderResult(
    pluginId: string,
    message: Extract<PluginHostResponse, { kind: 'provider-result' }>
  ): void {
    const metadata = this.rpcCalls.getMetadata<ProviderRpcMetadata>(pluginId, message.requestId)
    if (!metadata) return
    if (message.ok) {
      const completion = this.rpcCalls.complete<ProviderRpcMetadata>(pluginId, message.requestId, {
        ok: true,
        value: protectProviderMedia(message.value, metadata.method)
      })
      if (completion.status !== 'settled') return
      this.recordProviderCallSuccess(
        completion.metadata.providerId,
        completion.metadata.pluginId,
        completion.metadata.method
      )
      return
    }

    const staleBundledProvider =
      this.isBundledPluginId(metadata.pluginId) &&
      /^Provider .+ does not implement /i.test(message.error)
    const error = staleBundledProvider
      ? `${message.error}。内置音源插件尚未加载最新代码，请重启应用。`
      : message.error
    const completion = this.rpcCalls.complete<ProviderRpcMetadata>(pluginId, message.requestId, {
      ok: false,
      error
    })
    if (completion.status !== 'settled') return
    this.recordProviderCallFailure(
      completion.metadata.providerId,
      completion.metadata.pluginId,
      completion.metadata.method,
      error
    )
  }

  private getProviderHealth(providerId: string): TwilightMediaProviderHealth {
    const normalizedProviderId = providerId.trim().toLowerCase()
    const running = [...this.running.values()].find((candidate) =>
      candidate.providers.some((provider) => provider.id === normalizedProviderId)
    )
    const pluginId = running?.descriptor.id ?? normalizedProviderId
    const pluginStatus = running?.descriptor.status ?? 'disabled'
    const health = this.providerHealth.get(normalizedProviderId)
    const totalCalls = health?.totalCalls ?? 0
    const successfulCalls = health?.successfulCalls ?? 0
    const failedCalls = health?.failedCalls ?? 0
    return {
      providerId: normalizedProviderId,
      pluginId,
      pluginStatus: pluginStatus,
      available:
        pluginStatus === 'enabled' &&
        (health?.lastError ? failedCalls === 0 || successfulCalls > 0 : true),
      totalCalls,
      successfulCalls,
      failedCalls,
      successRate: totalCalls > 0 ? successfulCalls / totalCalls : 1,
      methodStats: getProviderMethodStats(health),
      lastError: health?.lastError ?? running?.descriptor.error ?? null,
      lastCheckedAt: health?.lastCheckedAt ?? null
    }
  }

  private recordProviderCallSuccess(
    providerId: string,
    pluginId: string,
    method: TwilightMediaProviderMethod
  ): void {
    const health = this.ensureProviderHealth(providerId, pluginId)
    health.totalCalls += 1
    health.successfulCalls += 1
    health.lastError = null
    health.lastCheckedAt = new Date().toISOString()
    const methodHealth = this.ensureProviderMethodHealth(health, method)
    methodHealth.totalCalls += 1
    methodHealth.successfulCalls += 1
    methodHealth.lastError = null
    methodHealth.lastCheckedAt = health.lastCheckedAt
  }

  private recordProviderCallFailure(
    providerId: string,
    pluginId: string,
    method: TwilightMediaProviderMethod,
    message: string
  ): void {
    const health = this.ensureProviderHealth(providerId, pluginId)
    health.totalCalls += 1
    health.failedCalls += 1
    health.lastError = message
    health.lastCheckedAt = new Date().toISOString()
    const methodHealth = this.ensureProviderMethodHealth(health, method)
    methodHealth.totalCalls += 1
    methodHealth.failedCalls += 1
    methodHealth.lastError = message
    methodHealth.lastCheckedAt = health.lastCheckedAt
  }

  private ensureProviderHealth(providerId: string, pluginId: string): ProviderHealthRecord {
    const normalizedProviderId = providerId.trim().toLowerCase()
    const existing = this.providerHealth.get(normalizedProviderId)
    if (existing) {
      existing.pluginId = pluginId
      return existing
    }
    const created: ProviderHealthRecord = {
      providerId: normalizedProviderId,
      pluginId,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      methodStats: {},
      lastError: null,
      lastCheckedAt: null
    }
    this.providerHealth.set(normalizedProviderId, created)
    return created
  }

  private ensureProviderMethodHealth(
    health: ProviderHealthRecord,
    method: TwilightMediaProviderMethod
  ): ProviderMethodHealthRecord {
    const existing = health.methodStats[method]
    if (existing) return existing
    const created: ProviderMethodHealthRecord = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      lastError: null,
      lastCheckedAt: null
    }
    health.methodStats[method] = created
    return created
  }

  private handleUiCommandResult(
    pluginId: string,
    message: Extract<PluginHostResponse, { kind: 'ui-command-result' }>
  ): void {
    this.rpcCalls.complete<UiCommandRpcMetadata>(pluginId, message.requestId, message)
  }

  private async readDescriptor(
    versionRoot: string,
    source: TwilightPluginDescriptor['source'],
    options: DescriptorReadOptions = {}
  ): Promise<TwilightPluginDescriptor> {
    try {
      const manifest = await this.readManifest(versionRoot)
      const state = options.state ?? this.state[manifest.id]
      const paths = options.paths ?? this.pathsFor(manifest.id, manifest.version)
      const error = this.validateRuntimeDescriptor(manifest, paths.versionRoot)
      const descriptorSource = state?.source ?? source
      return {
        ...manifest,
        status: error
          ? 'invalid'
          : state?.lastError
            ? 'failed'
            : state?.enabled
              ? 'enabled'
              : 'disabled',
        enabled: state?.enabled === true && !error,
        builtIn: this.isBundledPluginId(manifest.id) || descriptorSource === 'bundled',
        error: error ?? state?.lastError ?? null,
        isDsp: manifest.type.includes('dsp'),
        source: descriptorSource,
        installedAt: state?.installedAt ?? null,
        updatedAt: state?.updatedAt ?? null,
        paths
      }
    } catch (error) {
      const id = basename(dirname(versionRoot)) || 'unknown'
      const version = basename(versionRoot) || 'unknown'
      return {
        id,
        name: id,
        version,
        description: '',
        author: '',
        license: '',
        type: [],
        engines: { twilightEcho: '*' },
        apiVersion: 1,
        permissions: [],
        status: 'invalid',
        enabled: false,
        builtIn: this.isBundledPluginId(id),
        error: error instanceof Error ? error.message : String(error),
        isDsp: false,
        source,
        installedAt: null,
        updatedAt: null,
        paths: options.paths ?? this.pathsFor(id, version)
      }
    }
  }

  private validateRuntimeDescriptor(
    manifest: TwilightPluginManifest,
    versionRoot: string
  ): string | null {
    if (!isCompatibleTwilightRange(manifest.engines.twilightEcho, this.appVersion)) {
      return `插件要求 Twilight Echo ${manifest.engines.twilightEcho}`
    }
    if (manifest.main) {
      const mainPath = resolve(versionRoot, manifest.main)
      if (!resolvePluginFile(mainPath, versionRoot)) {
        return '插件 main 入口不存在或越界'
      }
    }
    if (manifest.type.includes('dsp')) {
      const binary = this.resolveNativeDspBinaryAt(manifest, versionRoot)
      if (!binary) return 'DSP 插件缺少当前平台 binary'
    }
    return null
  }

  private async readManifest(root: string): Promise<TwilightPluginManifest> {
    const raw = await readFile(join(root, 'plugin.json'), 'utf-8')
    return validatePluginManifest(parseJsonWithNestingLimit(raw))
  }

  private async findDescriptor(id: string): Promise<TwilightPluginDescriptor> {
    const descriptors = await this.list()
    const descriptor = descriptors.find((candidate) => candidate.id === id)
    if (!descriptor) throw new Error('插件未安装')
    return descriptor
  }

  private async extractTep(source: string, tempRoot: string): Promise<string> {
    await extractPluginPackage(source, tempRoot)
    if (existsSync(join(tempRoot, 'plugin.json'))) return tempRoot
    const entries = await safeReadDir(tempRoot)
    if (entries.length === 1 && existsSync(join(tempRoot, entries[0], 'plugin.json'))) {
      return join(tempRoot, entries[0])
    }
    throw new Error('.tep 包根目录必须包含 plugin.json')
  }

  private async requestTrustBasedInstall(
    manifest: TwilightPluginManifest,
    evidence: TwilightPluginInstallEvidence
  ): Promise<boolean> {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['安装', '取消'],
      cancelId: 1,
      defaultId: 1,
      title: '安装 Twilight Echo 插件',
      message: `安装 ${manifest.name}？`,
      detail: buildPluginInstallConfirmationDetail(manifest, evidence)
    })
    return result.response === 0
  }

  private setEnabled(id: string, enabled: boolean): void {
    const now = new Date().toISOString()
    const previous = this.state[id]
    this.state[id] = {
      ...previous,
      enabled,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      source: previous?.source ?? this.defaultStateSource(id),
      lastError: undefined
    }
    this.queueStateSave()
    this.emit('changed')
  }

  private markFailed(id: string, message: string, descriptor?: TwilightPluginDescriptor): void {
    const now = new Date().toISOString()
    const previous = this.state[id]
    this.state[id] = {
      ...previous,
      enabled: false,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      source: previous?.source ?? this.defaultStateSource(id),
      lastError: message
    }
    if (descriptor) this.appendLog(descriptor, 'error', message)
    this.queueStateSave()
    this.emit('changed')
  }

  private markStarted(descriptor: TwilightPluginDescriptor): void {
    const now = new Date().toISOString()
    const previous = this.state[descriptor.id]
    this.state[descriptor.id] = {
      ...previous,
      enabled: true,
      installedAt: previous?.installedAt ?? descriptor.installedAt ?? now,
      updatedAt: now,
      source: previous?.source ?? this.defaultStateSource(descriptor.id),
      activeVersion: previous?.activeVersion ?? descriptor.version,
      lastError: undefined
    }
    this.queueStateSave()
    this.emit('changed')
  }

  private appendLog(descriptor: TwilightPluginDescriptor, level: string, message: string): void {
    ensureParent(descriptor.paths.logPath)
    const line = `[${new Date().toISOString()}] [${level}] ${redactSensitiveText(message).trim()}\n`
    void writeFile(descriptor.paths.logPath, line, { flag: 'a', encoding: 'utf-8' })
  }

  private pathsFor(id: string, version: string): TwilightPluginPaths {
    const versionRoot = this.versionRoot(id, version)
    return this.pathsForRoot(id, version, versionRoot)
  }

  private pathsForRoot(id: string, _version: string, versionRoot: string): TwilightPluginPaths {
    return {
      root: dirname(versionRoot),
      versionRoot,
      manifestPath: join(versionRoot, 'plugin.json'),
      dataDir: join(this.roots.data, id),
      logPath: join(this.roots.logs, `${id}.log`)
    }
  }

  private versionRoot(id: string, version: string): string {
    return join(this.roots.plugins, id, version)
  }

  private async createInstallStagingRoot(): Promise<string> {
    const stagingRoot = join(this.roots.staging, randomUUID())
    mkdirSync(stagingRoot, { recursive: true })
    return stagingRoot
  }

  private selectActiveDescriptor(
    id: string,
    descriptors: TwilightPluginDescriptor[]
  ): TwilightPluginDescriptor {
    const activeVersion = this.state[id]?.activeVersion
    const active = activeVersion
      ? descriptors.find((descriptor) => descriptor.version === activeVersion)
      : undefined
    if (active) return active
    return descriptors.reduce((current, descriptor) =>
      compareSemver(descriptor.version, current.version) > 0 ? descriptor : current
    )
  }

  private ensureRoots(): void {
    mkdirSync(this.roots.plugins, { recursive: true })
    mkdirSync(this.roots.staging, { recursive: true })
    mkdirSync(this.roots.data, { recursive: true })
    mkdirSync(this.roots.logs, { recursive: true })
  }

  private async loadState(): Promise<void> {
    try {
      const loaded = await this.statePersistenceFor().load()
      this.state = loaded.state
      if (loaded.status === 'recovered') {
        this.reportStateIssue('state-recovery-warning', loaded.warning)
        this.notifyStateIssueUser('warning', loaded.warning)
      } else if (loaded.status === 'unrecoverable') {
        this.reportStateIssue('state-load-error', loaded.warning)
        this.notifyStateIssueUser('error', loaded.warning)
      }
    } catch (error) {
      this.state = {}
      this.reportStateIssue('state-load-error', error)
      this.notifyStateIssueUser('error', error)
    }
  }

  private async saveState(): Promise<void> {
    try {
      await this.statePersistenceFor().save(this.state)
    } catch (error) {
      this.reportStateIssue('state-write-error', error)
      throw error
    }
  }

  private queueStateSave(): void {
    void this.saveState().catch(() => undefined)
  }

  private statePersistenceFor(): PluginStatePersistence {
    const stateFile = this.roots.stateFile
    if (!this.statePersistence || this.statePersistence.filePath !== stateFile) {
      this.statePersistence = new PluginStatePersistence(stateFile)
    }
    return this.statePersistence
  }

  private reportStateIssue(
    event: 'state-recovery-warning' | 'state-load-error' | 'state-write-error',
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : String(error)
    if (event === 'state-recovery-warning') console.warn(`[plugin-state] ${message}`)
    else console.error(`[plugin-state] ${message}`)
    this.emit(event, { stateFile: this.roots.stateFile, message })
  }

  private notifyStateIssueUser(type: 'warning' | 'error', error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    void dialog
      .showMessageBox({
        type,
        buttons: ['确定'],
        defaultId: 0,
        title: type === 'warning' ? '插件状态已恢复' : '插件状态读取失败',
        message:
          type === 'warning'
            ? '插件状态文件损坏，已从备份恢复。'
            : '插件状态文件损坏且无法从备份恢复。',
        detail
      })
      .catch((notificationError) => {
        console.error(
          '[plugin-state] Failed to show state recovery notification:',
          notificationError
        )
      })
  }

  private reportPluginUpdateRollbackFailure(
    pluginId: string,
    error: PluginUpdateRollbackError
  ): void {
    const activationError = redactSensitiveText(
      error.activationError instanceof Error
        ? error.activationError.message
        : String(error.activationError)
    )
    const failures = error.failures.map((failure) => ({
      phase: failure.phase,
      message: redactSensitiveText(failure.message)
    }))
    const message = `Plugin ${pluginId} update failed (${activationError}) and rollback failed: ${failures
      .map((failure) => `${failure.phase}: ${failure.message}`)
      .join('; ')}`
    console.error(`[plugin-update] ${message}`)
    this.emit('update-rollback-error', { pluginId, message, activationError, failures })
  }

  private resolveNativeDspBinary(
    descriptor: TwilightPluginDescriptor | TwilightPluginManifest
  ): string | null {
    const root =
      'paths' in descriptor
        ? descriptor.paths.versionRoot
        : this.versionRoot(descriptor.id, descriptor.version)
    return this.resolveNativeDspBinaryAt(descriptor, root)
  }

  private resolveNativeDspBinaryAt(
    descriptor: TwilightPluginDescriptor | TwilightPluginManifest,
    versionRoot: string
  ): string | null {
    const binary = descriptor.binary
    if (!binary) return null
    const key = `${process.platform}-${process.arch}`
    const relPath = binary[key] ?? binary[process.platform]
    if (!relPath) return null
    return resolvePluginFile(resolve(versionRoot, relPath), versionRoot)
  }

  private isBundledPluginId(id: string): boolean {
    return this.bundledPlugins.some((plugin) => plugin.id === id)
  }

  private defaultStateSource(id: string): TwilightPluginSource {
    return this.isBundledPluginId(id) ? 'bundled' : 'directory'
  }
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}
