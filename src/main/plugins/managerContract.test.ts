import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { TwilightMediaProviderRegistration } from '../../../packages/plugin-api/src/index.ts'
import type { TwilightMediaProviderMethod } from './types.ts'

type ProviderRegistrationMethodKeys = Exclude<
  keyof TwilightMediaProviderRegistration,
  'id' | 'name' | 'capabilities' | 'health'
>
type MethodsMissingFromRegistration = Exclude<
  TwilightMediaProviderMethod,
  ProviderRegistrationMethodKeys
>
type MethodsMissingFromUnion = Exclude<ProviderRegistrationMethodKeys, TwilightMediaProviderMethod>
type AssertNever<T> = [T] extends [never] ? true : never
const registrationCoversUnion: AssertNever<MethodsMissingFromRegistration> = true
const unionCoversRegistration: AssertNever<MethodsMissingFromUnion> = true

const managerSource = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')
const statePersistenceSource = readFileSync(
  new URL('./statePersistence.ts', import.meta.url),
  'utf8'
)
const operationQueueSource = readFileSync(new URL('./operationQueue.ts', import.meta.url), 'utf8')
const rpcCoordinatorSource = readFileSync(new URL('./rpcCoordinator.ts', import.meta.url), 'utf8')
const providerRoutingSource = readFileSync(new URL('./providerRouting.ts', import.meta.url), 'utf8')
const updateTransactionSource = readFileSync(
  new URL('./updateTransaction.ts', import.meta.url),
  'utf8'
)
const packageSecuritySource = readFileSync(new URL('./packageSecurity.ts', import.meta.url), 'utf8')
const pluginTypesSource = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const themeContributionSource = readFileSync(
  new URL('./themeContribution.ts', import.meta.url),
  'utf8'
)
const pluginHostSource = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')
const pluginApiSource = readFileSync(
  new URL('../../../packages/plugin-api/src/index.ts', import.meta.url),
  'utf8'
)
function readPreloadSources(): string {
  const root = new URL('../../preload/', import.meta.url)
  return [
    'index.ts',
    'types.ts',
    'index.d.ts',
    'sleepTimerEvents.ts',
    'domains/dataApi.ts',
    'domains/audioEngineApi.ts',
    'domains/desktopLyricsApi.ts',
    'domains/libraryApi.ts',
    'domains/mediaSubscriptionsApi.ts',
    'domains/networkSourcesApi.ts',
    'domains/settingsApi.ts',
    'domains/themesApi.ts',
    'domains/pluginsApi.ts',
    'domains/systemApi.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, root), 'utf8'))
    .join('\n')
}

const preloadSource = readPreloadSources()
const pluginIpcSource = readFileSync(new URL('../ipc/plugins.ts', import.meta.url), 'utf8')
const pluginExtensionPageSource = readFileSync(
  new URL('../../renderer/src/components/PluginExtensionPage.vue', import.meta.url),
  'utf8'
)

test('provider method union and plugin-api registration typings stay in sync', () => {
  assert.equal(registrationCoversUnion, true)
  assert.equal(unionCoversRegistration, true)
})

test('plugin manager keeps UI command failures isolated to the owning plugin', () => {
  assert.match(managerSource, /const PLUGIN_UI_COMMAND_TIMEOUT_MS = 5000/)
  assert.match(managerSource, /UI command 调用超时/)
  assert.match(managerSource, /this\.markFailed\(\s*running\.descriptor\.id/)
  assert.match(managerSource, /void this\.stopPlugin\(running\.descriptor\.id\)/)
})

test('plugin manager enforces controlled UI and theme extension contracts', () => {
  assert.match(themeContributionSource, /permissions\.includes\('ui:inject'\)/)
  assert.match(themeContributionSource, /'localSidebarItem'/)
  assert.match(themeContributionSource, /'streamingHome'/)
  assert.match(themeContributionSource, /const renderMode = 'command'/)
  assert.doesNotMatch(themeContributionSource, /record\.renderMode === 'html'/)
  assert.doesNotMatch(pluginExtensionPageSource, /srcdoc|allow-same-origin|htmlContent/)
  assert.match(pluginExtensionPageSource, /<pre>\{\{ textResult \}\}<\/pre>/)
  assert.match(managerSource, /this\.resolveThemeStylesheet/)
  assert.match(managerSource, /resolvePluginFile\(stylesheetPath, descriptor\.paths\.versionRoot\)/)
  assert.match(themeContributionSource, /\^--te-\[a-z0-9-_\]\+\$/)
  assert.match(
    managerSource,
    /主题必须通过 manifest contributes\.themes 声明，运行时主题注册已禁用/
  )
  assert.match(pluginHostSource, /Themes must be declared in plugin\.json contributes\.themes/)
  assert.match(managerSource, /themes: this\.normalizeDeclarativeThemeContributions\(descriptor\)/)
})

test('plugin manager rejects symlink escapes in installed plugin resources', () => {
  assert.match(managerSource, /assertPluginPackageFileSize\(source\)/)
  assert.match(managerSource, /extractPluginPackage\(source, tempRoot\)/)
  assert.match(managerSource, /assertPluginTreeSafe\(installSource\)/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_PACKAGE_BYTES = 50 \* 1024 \* 1024/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_EXTRACTED_BYTES = 100 \* 1024 \* 1024/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_PACKAGE_FILES = 2000/)
  assert.match(packageSecuritySource, /inspectZipPackage\(source\)/)
  assert.match(packageSecuritySource, /isZipSymlink\(entry\)/)
  assert.match(packageSecuritySource, /info\.isSymbolicLink\(\)/)
  assert.match(packageSecuritySource, /realpathSync\(root\)/)
  assert.match(packageSecuritySource, /realpathSync\(filePath\)/)
  assert.match(managerSource, /resolvePluginFile\(mainPath, descriptor\.paths\.versionRoot\)/)
  assert.match(
    managerSource,
    /return resolvePluginFile\(resolve\(versionRoot, relPath\), versionRoot\)/
  )
})

test('plugin manager routes tep installs through the final hash and confirmation boundary', () => {
  assert.match(managerSource, /await runFinalPluginPackageTrustBoundary\(\{/)
  assert.match(managerSource, /inspectStagedPackage: async \(packagePath\)/)
  assert.match(
    managerSource,
    /requestConfirmation: \(\{ manifest: candidateManifest \}, evidence\)/
  )
  assert.doesNotMatch(managerSource, /if \(isTep\)[\s\S]{0,300}this\.confirmTrustBasedInstall/)
})

test('plugin updates stage, trial activate, and roll back without deleting the prior version', () => {
  assert.match(managerSource, /staging: join\(userData, 'plugin-staging'\)/)
  assert.match(managerSource, /await commitStagedPluginUpdate\(/)
  assert.match(managerSource, /await this\.trialActivatePlugin\(candidate\)/)
  assert.match(managerSource, /activeVersion: manifest\.version/)
  assert.match(managerSource, /restorePreviousVersion: async \(\) =>/)
  assert.doesNotMatch(managerSource, /removeOtherPluginVersions/)
  assert.doesNotMatch(managerSource, /mkdtemp\(join\(tmpdir\(\), 'twilight-plugin-'/)
})

test('plugin updates serialize same-id installs and surface rollback failures', () => {
  assert.match(
    managerSource,
    /private readonly pluginOperationQueue = new PluginOperationQueue\(\)/
  )
  assert.match(managerSource, /return await this\.pluginOperationQueue\.run\(manifest\.id/)
  assert.match(managerSource, /PluginUpdateRollbackError/)
  assert.match(managerSource, /update-rollback-error/)
  assert.match(operationQueueSource, /private readonly tails = new Map<string, Promise<void>>\(\)/)
  assert.match(updateTransactionSource, /class PluginUpdateRollbackError/)
  assert.doesNotMatch(
    updateTransactionSource,
    /rollbackActiveVersion\(\)\.catch\(\(\) => undefined\)/
  )
  assert.doesNotMatch(
    updateTransactionSource,
    /restorePreviousVersion\(\)\.catch\(\(\) => undefined\)/
  )
})

test('plugin state persistence serializes fsynced atomic writes and surfaces recovery', () => {
  assert.match(statePersistenceSource, /private writeTail: Promise<void> = Promise\.resolve\(\)/)
  assert.match(statePersistenceSource, /await handle\.sync\(\)/)
  assert.match(statePersistenceSource, /await writeRawFileAtomically\(backupPath, backupRaw\)/)
  assert.match(statePersistenceSource, /await writeRawFileAtomically\(filePath, json\)/)
  assert.match(managerSource, /state-recovery-warning/)
  assert.match(managerSource, /state-write-error/)
  assert.match(managerSource, /await this\.statePersistenceFor\(\)\.flush\(\)/)
  assert.match(managerSource, /private notifyStateIssueUser\(/)
  assert.match(managerSource, /dialog[\s\S]*\.showMessageBox\(/)
})

test('plugin manager enforces plugin API namespace permissions at the gateway', () => {
  assert.match(managerSource, /private requirePermission\(/)
  assert.match(managerSource, /'player:observe'/)
  assert.match(managerSource, /'player:control'/)
  assert.match(managerSource, /'library:read'/)
  assert.match(
    managerSource,
    /this\.requirePermission\(pluginId,\s*'network',\s*'providers\.register'/
  )
  assert.match(managerSource, /private requireProviderCapabilityPermissions\(/)
  assert.match(managerSource, /capabilities\.includes\('library'\)/)
  assert.match(managerSource, /private normalizeEventSubscription\(/)
  assert.match(managerSource, /this\.requirePermission\(id,\s*'player:observe'/)
  assert.match(managerSource, /this\.requirePermission\(id,\s*'player:control'/)
  assert.match(
    managerSource,
    /message\.kind === 'api-event-subscribe'[\s\S]*this\.normalizeEventSubscription\(id/
  )
  assert.match(
    managerSource,
    /eventName\.startsWith\('library:'\)[\s\S]*this\.requirePermission\(pluginId,\s*'library:read'/
  )
})

test('plugin manager prevents provider id takeover', () => {
  assert.match(managerSource, /const RESERVED_PROVIDER_IDS = new Set\(\['local', 'ncm'\]\)/)
  assert.match(managerSource, /private assertProviderIdAvailable\(/)
  assert.match(managerSource, /Provider id \$\{providerId\} 已保留给/)
  assert.match(managerSource, /Provider id 已被插件 \$\{running\.descriptor\.id\} 注册/)
})

test('plugin host enforces declared settings permission before private settings access', () => {
  assert.match(pluginHostSource, /message\.manifest\.permissions/)
  assert.match(pluginHostSource, /createSettingsApi\(/)
  assert.match(pluginHostSource, /requireLocalPermission\([^)]*'settings'/)
})

test('plugin manager exposes declarative manifest themes without executing theme scripts', () => {
  assert.match(managerSource, /normalizeDeclarativeThemeContributions/)
  assert.match(managerSource, /descriptor\.contributes/)
  assert.match(managerSource, /manifest theme/)
  assert.match(managerSource, /normalizeThemeContribution/)
  assert.match(managerSource, /loggedThemeCompatibilityNotes/)
  assert.match(themeContributionSource, /pluginApiVersion < 2/)
  assert.match(themeContributionSource, /findUnsupportedThemeModeIds/)
})

test('plugin manager blocks bundled plugin uninstall while allowing disable', () => {
  assert.match(managerSource, /async disable\(id: string\)/)
  assert.match(managerSource, /async uninstall\(id: string/)
  assert.match(managerSource, /this\.isBundledPluginId\(id\)/)
  assert.match(managerSource, /自带插件不能卸载/)
})

test('plugin manager isolates startup failures and keeps other enabled plugins loading', () => {
  assert.match(managerSource, /private async scanAndStartEnabled\(\)/)
  assert.match(managerSource, /for \(const descriptor of startupPlan\.ordered\)/)
  assert.match(
    managerSource,
    /await this\.startPlugin\(descriptor\)\.catch\(\(error\) => \{[\s\S]*this\.markFailed\(\s*descriptor\.id/
  )
})

test('plugin lifecycle stop is single-flight and stale process events cannot discard a replacement', () => {
  assert.match(
    managerSource,
    /private readonly stopOperations = new Map<string, Promise<void>>\(\)/
  )
  assert.match(managerSource, /const existingStop = this\.stopOperations\.get\(id\)/)
  assert.match(managerSource, /if \(existingStop\) return existingStop/)
  assert.match(managerSource, /await this\.stopOperations\.get\(descriptor\.id\)/)
  assert.match(
    managerSource,
    /child\.on\('exit',[\s\S]*if \(this\.running\.get\(descriptor\.id\) !== running\) return/
  )
  assert.match(
    managerSource,
    /if \(this\.running\.get\(id\) === running\) this\.running\.delete\(id\)/
  )
})

test('provider and UI RPC cancellation is wired through protocol, host AbortSignal, and public typings', () => {
  assert.match(pluginTypesSource, /kind: 'cancel'[\s\S]*requestId: string[\s\S]*reason: string/)
  assert.match(pluginHostSource, /const pendingPluginCalls = new Map<string, AbortController>\(\)/)
  assert.match(pluginHostSource, /cancelPluginCall\(message\.requestId, message\.reason\)/)
  assert.match(pluginHostSource, /signal: controller\.signal/)
  assert.match(pluginHostSource, /abortPendingPluginCalls\('Plugin is being deactivated\.'\)/)
  assert.match(
    pluginApiSource,
    /interface TwilightProviderRequestContext[\s\S]*signal: AbortSignal/
  )
  assert.match(pluginApiSource, /interface TwilightUiCommandContext[\s\S]*signal: AbortSignal/)
  assert.match(managerSource, /interface TwilightProviderCallOptions[\s\S]*signal\?: AbortSignal/)
  assert.match(managerSource, /kind: 'provider-call'[\s\S]*signal: options\.signal/)
})

test('provider downloads are capability-gated and final file access remains host-only', () => {
  assert.match(pluginApiSource, /\| 'download'/)
  assert.match(pluginApiSource, /createDownload\?\(/)
  assert.match(pluginApiSource, /getDownloadStatus\?\(/)
  assert.match(pluginApiSource, /getDownloadFile\?\(/)
  assert.match(pluginApiSource, /cancelDownload\?\(/)
  assert.match(rpcCoordinatorSource, /'createDownload'/)
  assert.match(pluginHostSource, /'getDownloadFile'/)
  assert.match(pluginIpcSource, /const HOST_ONLY_PROVIDER_METHODS/)
  assert.match(pluginIpcSource, /provider download methods are host-only/)
})

test('provider write idempotency is connected from renderer bridge through host request context', () => {
  assert.match(preloadSource, /providerWriteIdempotency\.begin\(/)
  assert.match(rpcCoordinatorSource, /const IDEMPOTENT_PROVIDER_WRITE_METHODS/)
  assert.match(
    rpcCoordinatorSource,
    /IDEMPOTENT_PROVIDER_WRITE_METHODS[\s\S]*'completeCloudUpload'/
  )
  assert.match(rpcCoordinatorSource, /IDEMPOTENT_PROVIDER_WRITE_METHODS[\s\S]*'createDownload'/)
  assert.match(managerSource, /kind: 'provider-call'[\s\S]*idempotencyKey/)
  assert.match(pluginHostSource, /idempotencyKey: message\.idempotencyKey/)
  assert.match(pluginApiSource, /idempotencyKey\?: string/)
})

test('plugin manager exposes per-plugin logs for troubleshooting', () => {
  assert.match(managerSource, /async openLog\(id: string\)/)
  assert.match(managerSource, /async getLog\(id: string\)/)
  assert.match(managerSource, /raw\.slice\(-20000\)/)
  assert.match(managerSource, /private appendLog\(descriptor: TwilightPluginDescriptor/)
  assert.match(managerSource, /logs', 'plugins'/)
})

test('plugin manager tracks provider health for calls and plugin failures', () => {
  assert.match(providerRoutingSource, /export interface ProviderHealthRecord/)
  assert.match(managerSource, /private readonly providerHealth = new Map/)
  assert.match(managerSource, /private getProviderHealth\(/)
  assert.match(providerRoutingSource, /export function normalizeProviderHealth\(/)
  assert.match(managerSource, /private recordProviderCallSuccess\(/)
  assert.match(managerSource, /private recordProviderCallFailure\(/)
  assert.match(providerRoutingSource, /export interface ProviderMethodHealthRecord/)
  assert.match(providerRoutingSource, /methodStats:/)
  assert.match(providerRoutingSource, /successRate:/)
  assert.match(providerRoutingSource, /totalCalls:/)
  assert.match(providerRoutingSource, /failedCalls:/)
  assert.match(providerRoutingSource, /lastError:/)
  assert.match(managerSource, /pluginStatus:/)
  assert.match(
    managerSource,
    /const health = normalizeProviderHealth\(record\.health,\s*providerId,\s*pluginId/
  )
  assert.match(managerSource, /if \(health\) this\.providerHealth\.set\(providerId,\s*health\)/)
  assert.match(
    managerSource,
    /this\.recordProviderCallSuccess\(\s*completion\.metadata\.providerId,\s*completion\.metadata\.pluginId,\s*completion\.metadata\.method/
  )
  assert.match(
    managerSource,
    /this\.recordProviderCallFailure\(\s*completion\.metadata\.providerId,\s*completion\.metadata\.pluginId,\s*completion\.metadata\.method/
  )
  assert.match(managerSource, /health: this\.getProviderHealth/)
})

test('plugin host forwards provider health registration metadata', () => {
  assert.match(pluginHostSource, /health\?: Record<string, unknown>/)
  assert.match(pluginHostSource, /health: provider\.health/)
})

test('specialized windows receive only their scoped preload APIs', () => {
  const miniPlayerApi = preloadSource.match(/const miniPlayerWindowApi = \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(preloadSource, /exposedApiForDocument\(\)/)
  assert.match(
    preloadSource,
    /if \(isDesktopLyricsDocument\(\)\) return \{ desktopLyrics: desktopLyricsWindowApi \}/
  )
  assert.match(
    preloadSource,
    /if \(isMiniPlayerDocument\(\)\) \{[\s\S]*?return \{ miniPlayer: miniPlayerWindowApi, data: miniPlayerCoverDataApi \}/
  )
  // The lyrics window is the shared renderer document with a `window` query now.
  assert.match(preloadSource, /get\('window'\) === 'desktop-lyrics'/)
  assert.match(preloadSource, /get\('window'\) === 'mini-player'/)
  assert.match(miniPlayerApi, /chooseBackgroundImage/)
  assert.doesNotMatch(miniPlayerApi, /ipcRenderer\.(?:invoke|send)\('(?:settings|shell|dialog):/)
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\('electron'/)
})

test('provider results replace approved remote media URLs before returning to the renderer', () => {
  assert.match(
    managerSource,
    /import \{ protectProviderMedia \} from '\.\.\/security\/remoteMediaGrants\.ts'/
  )
  assert.match(managerSource, /value: protectProviderMedia\(message\.value, metadata\.method\)/)
})

test('plugin host logs rotate at a bounded size and append through a serialized write chain', () => {
  assert.match(managerSource, /const PLUGIN_LOG_MAX_BYTES = \d+/)
  assert.match(managerSource, /logWriteChains = new Map<string, Promise<void>>/)
  assert.match(managerSource, /logSizes = new Map<string, number>/)
  const appendLog = managerSource.match(
    /private appendLog\(descriptor: TwilightPluginDescriptor, level: string, message: string\): void \{([\s\S]*?)\n  \}/
  )
  assert.ok(appendLog, 'appendLog should exist')
  const body = appendLog[1]
  assert.match(body, /size \+ lineBytes > PLUGIN_LOG_MAX_BYTES/)
  assert.match(body, /await rm\(previousLogPath, \{ force: true \}\)/)
  assert.match(body, /await rename\(logPath, previousLogPath\)/)
  assert.match(body, /this\.logWriteChains\.get\(logPath\) \?\? Promise\.resolve\(\)/)
})
