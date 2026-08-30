<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  pluginIndexLoadedFromLabel,
  pluginIndexSourceLabel,
  presentPluginTrust
} from '@renderer/utils/pluginTrustPresentation'
import {
  createPluginTrustRefreshController,
  type PluginTrustRefreshController
} from '@renderer/utils/pluginTrustRefresh'

type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'invalid' | 'failed'

interface PluginDescriptor {
  id: string
  name: string
  version: string
  description: string
  author: string
  license: string
  type: string[]
  main?: string
  dependencies?: Record<string, string>
  permissions: string[]
  status: PluginStatus
  enabled: boolean
  builtIn: boolean
  error: string | null
  isDsp: boolean
  source: 'directory' | 'tep' | 'bundled' | 'index' | 'scan'
  installedAt: string | null
  updatedAt: string | null
  paths: {
    versionRoot: string
    dataDir: string
    logPath: string
  }
}

type PluginIndexInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'incompatible'
  | 'built-in-blocked'

type PluginIndexEntry = Awaited<ReturnType<typeof window.api.plugins.listIndex>>[number]
type PluginIndexStatus = Awaited<ReturnType<typeof window.api.plugins.getIndexStatus>>

interface NativeDspParameter {
  id: string
  name: string
  type: 'bool' | 'int' | 'float' | 'enum' | string
  defaultValue: number
  minValue: number
  maxValue: number
  step: number
  unit: string
  enumValues?: string[] | string | null
  currentValue: number
}

interface NativeDspStatus {
  id: string
  loaded?: boolean
  active?: boolean
  bypassed?: boolean
  bypassReason?: string
  lastError?: string
  parameters?: NativeDspParameter[]
}

const plugins = ref<PluginDescriptor[]>([])
const indexEntries = ref<PluginIndexEntry[]>([])
const indexStatus = ref<PluginIndexStatus | null>(null)
const nativeDspStatuses = ref<Record<string, NativeDspStatus>>({})
const loading = ref(false)
const marketLoading = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')
const marketError = ref('')
const selectedLog = ref('')
const selectedLogPlugin = ref('')
const trustEvaluationTimeMs = ref(Date.now())
let removePluginListener: (() => void) | null = null
let trustRefreshController: PluginTrustRefreshController | null = null
let indexRequestGeneration = 0

const enabledCount = computed(() => plugins.value.filter((plugin) => plugin.enabled).length)
const marketCount = computed(() => indexEntries.value.length)
const indexSourceLabel = computed(() => {
  return pluginIndexSourceLabel(indexStatus.value)
})

const indexLoadedFromLabel = computed(() => {
  return pluginIndexLoadedFromLabel(indexStatus.value?.loadedFrom)
})

function pluginTrust(entry: PluginIndexEntry) {
  return presentPluginTrust(entry, indexStatus.value, trustEvaluationTimeMs.value)
}
const pluginGroups = computed(() =>
  [
    {
      id: 'regular',
      title: 'JS / 内容插件',
      description: '音源、工具、UI 和主题插件运行在受控插件宿主进程中。',
      plugins: plugins.value.filter((plugin) => !plugin.isDsp)
    },
    {
      id: 'dsp',
      title: '原生 DSP 插件',
      description: '原生 DSP 插件加载到音频引擎进程内，故障会被旁路，硬崩溃会触发引擎恢复路径。',
      plugins: plugins.value.filter((plugin) => plugin.isDsp)
    }
  ].filter((group) => group.plugins.length > 0)
)

async function refreshPlugins(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    plugins.value = await window.api.plugins.list()
    const playbackInfo = await window.api.audioEngine.getPlaybackInfo()
    const rawStatuses = playbackInfo.outputInfo?.nativeDsp?.plugins
    nativeDspStatuses.value = Array.isArray(rawStatuses)
      ? Object.fromEntries(
          rawStatuses
            .filter(
              (item): item is NativeDspStatus =>
                Boolean(item) &&
                typeof item === 'object' &&
                typeof (item as NativeDspStatus).id === 'string'
            )
            .map((item) => [item.id, normalizeNativeDspStatus(item)])
        )
      : {}
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function refreshIndex(force = false): Promise<void> {
  const generation = ++indexRequestGeneration
  trustEvaluationTimeMs.value = Date.now()
  marketLoading.value = true
  marketError.value = ''
  try {
    const entries = force
      ? await window.api.plugins.refreshIndex()
      : await window.api.plugins.listIndex()
    const status = await window.api.plugins.getIndexStatus()
    if (generation !== indexRequestGeneration) return
    indexEntries.value = entries
    indexStatus.value = status
  } catch (err) {
    if (generation !== indexRequestGeneration) return
    marketError.value = err instanceof Error ? err.message : String(err)
    indexStatus.value = await window.api.plugins.getIndexStatus().catch(() => null)
    indexEntries.value = []
  } finally {
    if (generation === indexRequestGeneration) {
      trustEvaluationTimeMs.value = Date.now()
      marketLoading.value = false
      trustRefreshController?.schedule()
    }
  }
}

async function installPlugin(): Promise<void> {
  error.value = ''
  const result = await window.api.plugins.chooseAndInstall()
  if (result) {
    await refreshPlugins()
  }
}

async function togglePlugin(plugin: PluginDescriptor): Promise<void> {
  busyId.value = plugin.id
  error.value = ''
  try {
    if (plugin.enabled) {
      await window.api.plugins.disable(plugin.id)
    } else {
      await window.api.plugins.enable(plugin.id)
    }
    await refreshPlugins()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    await refreshPlugins()
  } finally {
    busyId.value = null
  }
}

function formatPluginInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(message)) {
    return (
      `无法下载插件包（${message}）。` +
      '离线索引仅用于发现；请改用「从本地安装包 (.tep)」，或配置可访问 GitHub raw 的代理/镜像。'
    )
  }
  return message
}

async function installIndexPlugin(entry: PluginIndexEntry): Promise<void> {
  busyId.value = entry.id
  marketError.value = ''
  try {
    await window.api.plugins.installFromIndex(entry.id)
    await refreshPlugins()
    await refreshIndex(true)
  } catch (err) {
    marketError.value = formatPluginInstallError(err)
    await refreshIndex(true)
  } finally {
    busyId.value = null
  }
}

async function uninstallPlugin(plugin: PluginDescriptor): Promise<void> {
  const removeData = window.confirm(
    `卸载 ${plugin.name}？\n\n选择“确定”会同时清除插件私有数据。选择“取消”仅卸载插件文件。`
  )
  busyId.value = plugin.id
  error.value = ''
  try {
    await window.api.plugins.uninstall(plugin.id, { removeData })
    await refreshPlugins()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busyId.value = null
  }
}

async function openLog(plugin: PluginDescriptor): Promise<void> {
  await window.api.plugins.openLog(plugin.id)
}

async function previewLog(plugin: PluginDescriptor): Promise<void> {
  selectedLogPlugin.value = plugin.name
  selectedLog.value = await window.api.plugins.getLog(plugin.id)
}

function statusLabel(status: PluginStatus): string {
  const labels: Record<PluginStatus, string> = {
    installed: '已安装',
    enabled: '已启用',
    disabled: '已停用',
    invalid: '无效',
    failed: '失败'
  }
  return labels[status]
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    provider: '音源',
    tool: '工具',
    ui: '界面',
    theme: '主题',
    dsp: 'DSP'
  }
  return labels[type] ?? type
}

function installStateLabel(entry: PluginIndexEntry): string {
  const state = entry.installState ?? 'not-installed'
  const labels: Record<PluginIndexInstallState, string> = {
    'not-installed': '可安装',
    installed: entry.installedVersion ? `已安装 v${entry.installedVersion}` : '已安装',
    'update-available': entry.installedVersion
      ? `可更新 v${entry.installedVersion} → v${entry.version}`
      : '可更新',
    incompatible: '不兼容',
    'built-in-blocked': '自带插件'
  }
  return labels[state]
}

function canInstallIndexEntry(entry: PluginIndexEntry): boolean {
  return (
    entry.installState === 'not-installed' ||
    entry.installState === 'update-available' ||
    !entry.installState
  )
}

function dependencyEntries(plugin: PluginDescriptor): [string, string][] {
  return Object.entries(plugin.dependencies ?? {})
}

function normalizeNativeDspStatus(status: NativeDspStatus): NativeDspStatus {
  return {
    ...status,
    parameters: Array.isArray(status.parameters)
      ? status.parameters.map((parameter) => ({
          ...parameter,
          enumValues: Array.isArray(parameter.enumValues)
            ? parameter.enumValues
            : typeof parameter.enumValues === 'string'
              ? safeParseEnumValues(parameter.enumValues)
              : null
        }))
      : []
  }
}

function safeParseEnumValues(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function nativeDspStatus(plugin: PluginDescriptor): NativeDspStatus | null {
  return nativeDspStatuses.value[plugin.id] ?? null
}

function nativeDspParameters(plugin: PluginDescriptor): NativeDspParameter[] {
  return nativeDspStatus(plugin)?.parameters ?? []
}

async function updateNativeDspParameter(
  plugin: PluginDescriptor,
  parameter: NativeDspParameter,
  rawValue: string | number | boolean
): Promise<void> {
  const status = nativeDspStatus(plugin)
  const values: Record<string, number> = {}
  for (const item of status?.parameters ?? []) {
    values[item.id] = Number.isFinite(item.currentValue) ? item.currentValue : item.defaultValue
  }
  values[parameter.id] =
    parameter.type === 'bool'
      ? rawValue === true || rawValue === 'true'
        ? 1
        : 0
      : Number(rawValue)
  await window.api.plugins.setNativeDspParameters(plugin.id, values)
  await refreshPlugins()
}

function formatDate(value: string | null): string {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatIndexTime(value: string | null | undefined): string {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function refreshTrustOnResume(): void {
  trustEvaluationTimeMs.value = Date.now()
  void trustRefreshController?.refreshNow().catch(() => undefined)
}

function handleTrustVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshTrustOnResume()
}

onMounted(() => {
  trustRefreshController = createPluginTrustRefreshController({
    getSnapshot: () => ({ entries: indexEntries.value, status: indexStatus.value }),
    refresh: () => refreshIndex(false)
  })
  window.addEventListener('focus', refreshTrustOnResume)
  document.addEventListener('visibilitychange', handleTrustVisibilityChange)
  void refreshPlugins()
  void refreshIndex()
  removePluginListener = window.api.plugins.onChanged(() => {
    void refreshPlugins()
    refreshTrustOnResume()
  })
})

onUnmounted(() => {
  removePluginListener?.()
  window.removeEventListener('focus', refreshTrustOnResume)
  document.removeEventListener('visibilitychange', handleTrustVisibilityChange)
  trustRefreshController?.stop()
  trustRefreshController = null
})
</script>

<template>
  <div class="plugin-panel">
    <div class="plugin-hero">
      <div>
        <span class="plugin-kicker">Trust-based plugin runtime</span>
        <h3>插件系统</h3>
        <p>
          安装前会展示权限；JS 插件运行在独立 utilityProcess，原生 DSP
          插件单独标记风险并挂入音频引擎 DSP 链。
        </p>
      </div>
      <div class="plugin-actions">
        <button class="text-button" :disabled="loading" @click="refreshPlugins">
          <i class="pi pi-sync"></i>
          刷新
        </button>
        <button class="primary-button" @click="installPlugin">
          <i class="pi pi-plus"></i>
          安装目录 / .tep
        </button>
      </div>
    </div>

    <div class="plugin-summary">
      <span>已安装 {{ plugins.length }}</span>
      <span>已启用 {{ enabledCount }}</span>
      <span>市场 {{ marketCount }}</span>
      <span>日志：logs/plugins/&lt;id&gt;.log</span>
    </div>

    <div v-if="error" class="plugin-error">{{ error }}</div>

    <div v-if="plugins.length === 0 && !loading" class="plugin-empty">
      暂无插件。可以安装本地目录或 .tep 包。
    </div>

    <section class="plugin-market">
      <div class="plugin-group-head">
        <strong>插件市场</strong>
        <span
          >当前索引用于发现插件；安装前展示来源、有效期、SHA-256、签名、权限与代码执行风险。</span
        >
      </div>
      <div class="plugin-market-actions">
        <button class="text-button" :disabled="marketLoading" @click="refreshIndex(true)">
          <i class="pi pi-refresh"></i>
          刷新市场
        </button>
      </div>
      <div v-if="indexStatus" class="plugin-index-status">
        <span>{{ indexSourceLabel }}</span>
        <span>{{ indexLoadedFromLabel }}</span>
        <span>获取 {{ formatIndexTime(indexStatus.lastFetchedAt) }}</span>
        <span>过期 {{ formatIndexTime(indexStatus.expiresAt) }}</span>
        <span v-if="indexStatus.stale" class="warn">使用回退索引</span>
        <span v-if="indexStatus.expired" class="warn">索引已过期</span>
        <span v-if="!indexStatus.originVerified" class="warn">来源未验证</span>
        <span v-if="indexStatus.trustStoreError" class="warn">签名信任库不可用</span>
        <span v-if="indexStatus.error" class="warn">最近错误：{{ indexStatus.error }}</span>
        <span class="source-url" :title="indexStatus.sourceUrl">{{ indexStatus.sourceUrl }}</span>
        <span
          v-if="indexStatus.configuredSourceUrl !== indexStatus.sourceUrl"
          class="source-url warn"
          :title="indexStatus.configuredSourceUrl"
        >
          配置：{{ indexStatus.configuredSourceUrl }}
        </span>
      </div>
      <div v-if="marketError" class="plugin-error">{{ marketError }}</div>
      <div v-if="indexEntries.length === 0 && !marketLoading && !marketError" class="plugin-empty">
        暂无索引插件。仍可安装本地目录或 .tep 包。
      </div>
      <div class="market-grid">
        <article
          v-for="entry in indexEntries"
          :key="`${entry.id}:${entry.version}`"
          class="market-card"
        >
          <div class="plugin-title-row">
            <h4>{{ entry.name }}</h4>
            <span class="plugin-pill" :class="entry.installState || 'not-installed'">
              {{ installStateLabel(entry) }}
            </span>
            <span
              class="plugin-pill"
              :class="`trust-${pluginTrust(entry).tone}`"
              :title="pluginTrust(entry).detail"
            >
              <i :class="pluginTrust(entry).icon"></i>
              {{ pluginTrust(entry).label }}
            </span>
          </div>
          <p>{{ entry.description || '没有描述' }}</p>
          <div class="plugin-meta">
            <span>{{ entry.id }}</span>
            <span>v{{ entry.version }}</span>
            <span>{{ entry.author }}</span>
            <span>{{ entry.engines.twilightEcho }}</span>
            <span>签名 {{ entry.verification.signatureStatus }}</span>
            <span :title="entry.verification.keyFingerprintSha256 || entry.verification.reason">
              指纹 {{ entry.verification.keyFingerprintSha256?.slice(0, 12) || '无' }}
            </span>
          </div>
          <div class="plugin-tags">
            <span v-for="type in entry.type" :key="type">{{ typeLabel(type) }}</span>
            <span v-for="tag in entry.tags || []" :key="tag">{{ tag }}</span>
          </div>
          <div class="plugin-permissions">
            <strong>权限</strong>
            <span v-if="entry.permissions.length === 0">无</span>
            <code v-for="permission in entry.permissions" :key="permission">{{ permission }}</code>
          </div>
          <div class="market-card-actions">
            <button
              class="primary-button"
              :disabled="busyId === entry.id || !canInstallIndexEntry(entry)"
              :title="canInstallIndexEntry(entry) ? '安装索引插件' : installStateLabel(entry)"
              @click="installIndexPlugin(entry)"
            >
              <i class="pi pi-download"></i>
              {{ entry.installState === 'update-available' ? '更新' : '安装' }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <div class="plugin-list">
      <section v-for="group in pluginGroups" :key="group.id" class="plugin-group">
        <div class="plugin-group-head">
          <strong>{{ group.title }}</strong>
          <span>{{ group.description }}</span>
        </div>
        <article
          v-for="plugin in group.plugins"
          :key="`${plugin.id}:${plugin.version}`"
          class="plugin-card"
          :class="{ failed: plugin.status === 'failed' || plugin.status === 'invalid' }"
        >
          <div class="plugin-card-main">
            <div class="plugin-title-row">
              <h4>{{ plugin.name }}</h4>
              <span class="plugin-pill" :class="plugin.status">{{
                statusLabel(plugin.status)
              }}</span>
              <span v-if="plugin.builtIn" class="plugin-pill builtin">自带基础插件</span>
              <span v-if="plugin.isDsp" class="plugin-pill native">原生 DSP 风险</span>
            </div>
            <p>{{ plugin.description || '没有描述' }}</p>
            <div class="plugin-meta">
              <span>{{ plugin.id }}</span>
              <span>v{{ plugin.version }}</span>
              <span>{{ plugin.author }}</span>
              <span>更新 {{ formatDate(plugin.updatedAt) }}</span>
            </div>
            <div class="plugin-tags">
              <span v-for="type in plugin.type" :key="type">{{ typeLabel(type) }}</span>
            </div>
            <div v-if="dependencyEntries(plugin).length > 0" class="plugin-dependencies">
              <strong>依赖</strong>
              <code v-for="[dependencyId, range] in dependencyEntries(plugin)" :key="dependencyId">
                {{ dependencyId }} {{ range }}
              </code>
            </div>
            <div class="plugin-permissions">
              <strong>权限</strong>
              <span v-if="plugin.permissions.length === 0">无</span>
              <code v-for="permission in plugin.permissions" :key="permission">{{
                permission
              }}</code>
            </div>
            <div v-if="plugin.isDsp" class="plugin-native-note">
              原生插件与音频引擎同进程运行；处理失败会自动 bypass，硬崩溃可能触发引擎恢复。
            </div>
            <div v-if="plugin.isDsp && nativeDspStatus(plugin)" class="plugin-native-status">
              <span>loaded: {{ nativeDspStatus(plugin)?.loaded ? 'yes' : 'no' }}</span>
              <span>active: {{ nativeDspStatus(plugin)?.active ? 'yes' : 'no' }}</span>
              <span v-if="nativeDspStatus(plugin)?.bypassed">
                bypass:
                {{
                  nativeDspStatus(plugin)?.bypassReason ||
                  nativeDspStatus(plugin)?.lastError ||
                  'unknown'
                }}
              </span>
            </div>
            <div
              v-if="plugin.isDsp && nativeDspParameters(plugin).length > 0"
              class="plugin-native-params"
            >
              <strong>DSP 参数</strong>
              <label
                v-for="parameter in nativeDspParameters(plugin)"
                :key="parameter.id"
                class="plugin-native-param"
              >
                <span
                  >{{ parameter.name
                  }}<small v-if="parameter.unit"> {{ parameter.unit }}</small></span
                >
                <input
                  v-if="parameter.type === 'bool'"
                  type="checkbox"
                  :checked="parameter.currentValue > 0"
                  @change="
                    updateNativeDspParameter(
                      plugin,
                      parameter,
                      ($event.target as HTMLInputElement).checked
                    )
                  "
                />
                <select
                  v-else-if="parameter.type === 'enum'"
                  :value="parameter.currentValue"
                  @change="
                    updateNativeDspParameter(
                      plugin,
                      parameter,
                      ($event.target as HTMLSelectElement).value
                    )
                  "
                >
                  <option
                    v-for="(option, optionIndex) in parameter.enumValues || []"
                    :key="option"
                    :value="optionIndex"
                  >
                    {{ option }}
                  </option>
                </select>
                <input
                  v-else
                  type="number"
                  :min="parameter.minValue"
                  :max="parameter.maxValue"
                  :step="parameter.step || (parameter.type === 'int' ? 1 : 0.01)"
                  :value="parameter.currentValue"
                  @change="
                    updateNativeDspParameter(
                      plugin,
                      parameter,
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
              </label>
            </div>
            <div v-if="plugin.error" class="plugin-card-error">{{ plugin.error }}</div>
          </div>
          <div class="plugin-card-actions">
            <button
              class="text-button"
              :disabled="busyId === plugin.id || plugin.status === 'invalid'"
              @click="togglePlugin(plugin)"
            >
              {{ plugin.enabled ? '停用' : '启用' }}
            </button>
            <button class="text-button" @click="previewLog(plugin)">查看日志</button>
            <button class="icon-button subtle" title="打开日志文件" @click="openLog(plugin)">
              <i class="pi pi-external-link"></i>
            </button>
            <button
              class="danger-button"
              :disabled="busyId === plugin.id || plugin.builtIn"
              :title="plugin.builtIn ? '自带插件不能卸载，可停用' : '卸载插件'"
              @click="uninstallPlugin(plugin)"
            >
              卸载
            </button>
          </div>
        </article>
      </section>
    </div>

    <div v-if="selectedLogPlugin" class="plugin-log">
      <div class="plugin-log-head">
        <strong>{{ selectedLogPlugin }} 日志</strong>
        <button
          class="icon-button subtle"
          @click="
            selectedLogPlugin = ''
            selectedLog = ''
          "
        >
          <i class="pi pi-times"></i>
        </button>
      </div>
      <pre>{{ selectedLog || '暂无日志' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.plugin-panel,
.plugin-list,
.plugin-market {
  display: grid;
  gap: 12px;
}

.plugin-group {
  display: grid;
  gap: 10px;
}

.plugin-group-head {
  display: grid;
  gap: 4px;
  padding: 4px 2px;
}

.plugin-group-head strong {
  color: var(--te-neutral-900);
  font-size: 13px;
}

.plugin-group-head span,
.plugin-native-note {
  color: var(--te-neutral-500);
  font-size: 12px;
  line-height: 1.5;
}

.plugin-hero,
.plugin-card,
.market-card,
.plugin-log {
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 10px;
  background: var(--te-card-bg);
}

.plugin-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  padding: 18px;
}

.plugin-kicker {
  color: var(--te-neutral-500);
  font-size: 12px;
  font-weight: 900;
}

.plugin-hero h3,
.plugin-card h4,
.market-card h4 {
  margin: 0;
  color: var(--te-neutral-900);
}

.plugin-hero p,
.plugin-card p,
.market-card p {
  margin: 6px 0 0;
  color: var(--te-neutral-600);
  font-size: 13px;
  line-height: 1.5;
}

.plugin-actions,
.plugin-card-actions,
.plugin-market-actions,
.market-card-actions,
.plugin-title-row,
.plugin-meta,
.plugin-tags,
.plugin-dependencies,
.plugin-permissions,
.plugin-summary,
.plugin-log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.plugin-summary,
.plugin-empty,
.plugin-error {
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-600);
  font-size: 12px;
  font-weight: 800;
}

.plugin-index-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--te-neutral-500);
  font-size: 12px;
  font-weight: 800;
}

.plugin-index-status span {
  max-width: 100%;
  border-radius: 999px;
  background: var(--te-subtle-bg);
  padding: 5px 8px;
}

.plugin-index-status .warn {
  background: var(--te-warning-soft-bg);
  color: #c2410c;
}

.plugin-index-status .source-url {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-error,
.plugin-card-error {
  background: var(--te-danger-soft-bg);
  color: #dc2626;
}

.plugin-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  padding: 16px;
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.market-card {
  display: grid;
  gap: 10px;
  padding: 14px;
}

.plugin-card.failed {
  border-color: rgba(220, 38, 38, 0.22);
}

.plugin-meta,
.plugin-tags,
.plugin-dependencies,
.plugin-permissions {
  margin-top: 10px;
  color: var(--te-neutral-500);
  font-size: 12px;
}

.plugin-tags span,
.plugin-pill,
.plugin-dependencies code,
.plugin-permissions code {
  border-radius: 999px;
  padding: 4px 8px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-600);
  font-size: 11px;
  font-weight: 900;
}

.plugin-pill.enabled {
  background: #ecfdf5;
  color: #047857;
}

.plugin-pill.failed,
.plugin-pill.invalid,
.plugin-pill.native {
  background: var(--te-warning-soft-bg);
  color: #c2410c;
}

.plugin-pill.builtin {
  background: var(--te-info-soft-bg);
  color: #1d4ed8;
}

.plugin-pill.trust-official {
  background: #eef2ff;
  color: #4f46e5;
}

.plugin-pill.trust-signed {
  background: #ecfdf5;
  color: #047857;
}

.plugin-pill.trust-declared {
  background: #fefce8;
  color: #a16207;
}

.plugin-pill.trust-unverified {
  background: var(--te-subtle-bg);
  color: var(--te-neutral-500);
}

.plugin-pill.not-installed,
.plugin-pill.update-available {
  background: #ecfdf5;
  color: #047857;
}

.plugin-pill.incompatible,
.plugin-pill.built-in-blocked {
  background: var(--te-subtle-bg);
  color: var(--te-neutral-500);
}

.plugin-card-error {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}

.plugin-native-note {
  margin-top: 12px;
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--te-warning-soft-bg);
  color: #9a3412;
  font-weight: 800;
}

.plugin-native-status,
.plugin-native-params {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--te-neutral-500);
  font-size: 12px;
}

.plugin-native-params strong {
  color: var(--te-neutral-700);
}

.plugin-native-param {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 6px;
}

.plugin-native-param small {
  color: var(--te-neutral-400);
}

.plugin-native-param input[type='number'],
.plugin-native-param select {
  width: 92px;
  min-height: 28px;
  border: 1px solid rgba(17, 24, 39, 0.12);
  border-radius: 6px;
  background: var(--te-card-bg);
  color: var(--te-neutral-800);
  padding: 4px 6px;
}

.plugin-card-actions {
  justify-content: flex-end;
}

.plugin-log {
  overflow: hidden;
}

.plugin-log-head {
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(17, 24, 39, 0.08);
}

.plugin-log pre {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 14px;
  background: #0f172a;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

@media (max-width: 820px) {
  .plugin-hero,
  .plugin-card {
    grid-template-columns: 1fr;
  }

  .plugin-card-actions {
    justify-content: flex-start;
  }
}
</style>
