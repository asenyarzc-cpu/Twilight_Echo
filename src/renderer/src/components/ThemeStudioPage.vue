<script setup lang="ts">
import {
  useThemeStudioEditor,
  type BuiltInThemePresetId,
  type ThemeStudioDomain
} from './theme-studio/useThemeStudioEditor'
import EqualizerPage from './EqualizerPage.vue'
import LocalDashboard from './LocalDashboard.vue'
import PlayerBar from './PlayerBar.vue'
import PlayingMusic from './PlayingMusic.vue'
import SideMenu from './SideMenu.vue'
import TitleBar from './TitleBar.vue'

const props = defineProps<{ initialDomain?: ThemeStudioDomain }>()
const emit = defineEmits<{ back: [] }>()

const {
  BUILT_IN_THEME_FONTS,
  BUILT_IN_THEME_PRESETS,
  accentPalette,
  activeDomain,
  activeKey,
  activeModes,
  applyAccentPalette,
  applyBackgroundPalette,
  applySelected,
  assetSource,
  backgroundBindings,
  backgroundPalette,
  canRedo,
  canUndo,
  changeName,
  closeStudio,
  contrastWarnings,
  deleteSelected,
  derivePreset,
  domain,
  domains,
  draft,
  duplicateSelected,
  exportTheme,
  filteredStudioHits,
  fontAssets,
  fontBindings,
  fontSelection,
  fontSource,
  getBuiltInThemePreset,
  getPluginThemeKey,
  historyLabel,
  imageAssets,
  importAsset,
  importTheme,
  isDirty,
  isUnsavedDraft,
  jumpToSearchHit,
  localError,
  notice,
  persistedHistory,
  personalizationBackgroundBindings,
  playerLayouts,
  presetPreviewStyle,
  previewCanvasStyle,
  previewNavigationOpen,
  previewSurface,
  previewSurfaces,
  previewViewportRef,
  previewViewportStyle,
  profiles,
  rangeNumber,
  redo,
  removeOverride,
  resetAll,
  resetGroup,
  resolveThemeProfileModes,
  restoreVersion,
  scheduleTime,
  selectedKey,
  selectedPluginTheme,
  selectBuiltIn,
  selectProfile,
  selectThemeKey,
  setPlayerLayout,
  setTone,
  sourceFor,
  studioSearchQuery,
  supportsColorPicker,
  themeContributions,
  themeStore,
  toggleWindowInheritance,
  tone,
  undo,
  updateAppearanceMode,
  updateArtworkMode,
  updateAssetBinding,
  updateEqualizerMode,
  updateFontSlot,
  updateIconFamily,
  updateLibraryMode,
  updateNavigationMode,
  updatePlayerMode,
  updateRange,
  updateScheduleTime,
  updateToken,
  updateTypographyMode,
  updateVisibility,
  updateWindowBoolean,
  updateWindowNumber,
  updateWindowText,
  valueFor,
  valueForId,
  visibleDefinitions,
  visibilityOptions,
  visibilityValue,
  windowDefaultValue
} = useThemeStudioEditor({
  initialDomain: props.initialDomain,
  onBack: () => emit('back')
})
void previewViewportRef.value
</script>

<template>
  <div class="theme-studio-page" data-te-surface="theme-studio">
    <header class="theme-studio-header">
      <button
        type="button"
        class="studio-icon-button"
        data-te-back-button="icon"
        title="返回"
        aria-label="返回"
        @click="closeStudio"
      >
        <i class="ph ph-arrow-left"></i>
      </button>
      <div>
        <h1>主题工作室 · Beta</h1>
        <span>{{
          isDirty ? '有未应用的修改' : '深度定制已可用；像素黄金矩阵与性能证据仍在收口 (P7)'
        }}</span>
      </div>
      <label class="theme-profile-picker">
        <span>配置档</span>
        <select :value="selectedKey" aria-label="当前主题配置档" @change="selectThemeKey">
          <optgroup label="内置预设">
            <option
              v-for="preset in BUILT_IN_THEME_PRESETS"
              :key="preset.id"
              :value="`preset:${preset.id}`"
            >
              {{ preset.name }}{{ activeKey === `preset:${preset.id}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
          <option v-if="draft && isUnsavedDraft" :value="`profile:${draft.id}`">
            {{ draft.name }} · 未保存
          </option>
          <optgroup v-if="profiles.length" label="个人主题">
            <option v-for="profile in profiles" :key="profile.id" :value="`profile:${profile.id}`">
              {{ profile.name }}{{ activeKey === `profile:${profile.id}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
          <optgroup v-if="themeContributions.length" label="插件主题">
            <option
              v-for="theme in themeContributions"
              :key="getPluginThemeKey(theme)"
              :value="`plugin:${getPluginThemeKey(theme)}`"
            >
              {{ theme.name
              }}{{ activeKey === `plugin:${getPluginThemeKey(theme)}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
        </select>
      </label>
      <div class="theme-studio-actions">
        <div class="studio-segment" aria-label="主题变体">
          <button
            type="button"
            title="浅色变体"
            aria-label="浅色变体"
            :class="{ active: tone === 'pureWhite' }"
            @click="setTone('pureWhite')"
          >
            <i class="ph ph-sun"></i>
          </button>
          <button
            type="button"
            title="深色变体"
            aria-label="深色变体"
            :class="{ active: tone === 'dark' }"
            @click="setTone('dark')"
          >
            <i class="ph ph-moon"></i>
          </button>
        </div>
        <button
          type="button"
          class="studio-icon-button"
          title="恢复当前视觉域"
          aria-label="恢复当前视觉域"
          :disabled="!draft || domain === 'presets'"
          @click="resetGroup"
        >
          <i class="ph ph-arrow-u-up-left"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="恢复完整默认值"
          aria-label="恢复完整默认值"
          :disabled="!draft"
          @click="resetAll"
        >
          <i class="ph ph-broom"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="撤销"
          aria-label="撤销"
          :disabled="!canUndo"
          @click="undo"
        >
          <i class="ph ph-arrow-counter-clockwise"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="重做"
          aria-label="重做"
          :disabled="!canRedo"
          @click="redo"
        >
          <i class="ph ph-arrow-clockwise"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="导入主题"
          aria-label="导入主题"
          @click="importTheme"
        >
          <i class="ph ph-download-simple"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="创建副本"
          aria-label="创建副本"
          @click="duplicateSelected"
        >
          <i class="ph ph-copy"></i>
        </button>
        <button
          type="button"
          class="studio-command primary"
          :disabled="themeStore.saving.value"
          @click="applySelected"
        >
          <i :class="themeStore.saving.value ? 'pi pi-spin pi-spinner' : 'ph ph-check'"></i
          ><span>应用</span>
        </button>
      </div>
    </header>

    <div class="theme-studio-workspace">
      <aside class="theme-library-pane" aria-label="视觉域">
        <div class="pane-heading">
          <strong>视觉域</strong>
        </div>
        <label class="studio-search">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input
            v-model="studioSearchQuery"
            type="search"
            placeholder="搜索设置、令牌或模式"
            aria-label="搜索主题设置"
          />
        </label>
        <div v-if="filteredStudioHits.length" class="studio-search-hits" role="listbox">
          <button
            v-for="hit in filteredStudioHits"
            :key="`${hit.kind}:${hit.id}`"
            type="button"
            role="option"
            @click="jumpToSearchHit(hit)"
          >
            <strong>{{ hit.title }}</strong>
            <small>{{ hit.kind }} · {{ hit.domain }}</small>
          </button>
        </div>
        <nav class="theme-domain-list">
          <button
            v-for="item in domains"
            :key="item.id"
            type="button"
            :class="{ active: domain === item.id }"
            @click="domain = item.id"
          >
            <i :class="item.icon"></i><span>{{ item.label }}</span>
          </button>
        </nav>

        <div class="window-inheritance">
          <label>
            <span>迷你播放器</span>
            <input
              type="checkbox"
              :checked="themeStore.snapshot.value?.data.windowInheritance.miniPlayer"
              @change="toggleWindowInheritance('miniPlayer')"
            />
          </label>
          <label>
            <span>桌面歌词</span>
            <input
              type="checkbox"
              :checked="themeStore.snapshot.value?.data.windowInheritance.desktopLyrics"
              @change="toggleWindowInheritance('desktopLyrics')"
            />
          </label>
        </div>
      </aside>

      <main class="theme-preview-pane">
        <div class="preview-toolbar">
          <div>
            <strong>实时应用视图</strong><span>{{ activeDomain.label }}</span>
          </div>
          <div class="studio-segment preview-surface-switcher" aria-label="预览页面">
            <button
              v-for="surface in previewSurfaces"
              :key="surface.id"
              type="button"
              :class="{ active: previewSurface === surface.id }"
              :aria-pressed="previewSurface === surface.id"
              @click="previewSurface = surface.id"
            >
              <i :class="surface.icon"></i><span>{{ surface.label }}</span>
            </button>
          </div>
        </div>

        <section
          ref="previewViewportRef"
          class="theme-preview-stage live-preview-viewport"
          :style="previewViewportStyle"
        >
          <div class="live-preview-canvas" :style="previewCanvasStyle" inert aria-hidden="true">
            <TitleBar
              :menu-open="previewNavigationOpen"
              :glass="previewSurface === 'player'"
              :streaming="false"
              :hide-start="false"
              title-surface="default"
            />
            <SideMenu
              v-if="previewSurface === 'dashboard'"
              :open="previewNavigationOpen"
              active-key="dashboard"
            />
            <div
              v-if="previewSurface === 'dashboard'"
              class="main-content live-preview-app"
              :class="{ 'menu-open': previewNavigationOpen }"
            >
              <LocalDashboard />
            </div>
            <PlayingMusic v-else-if="previewSurface === 'player'" />
            <EqualizerPage v-else />
            <PlayerBar
              v-if="previewSurface !== 'equalizer'"
              :glass="previewSurface === 'player'"
              :menu-open="previewNavigationOpen"
              preview
            />
          </div>
        </section>
      </main>

      <aside class="theme-editor-pane" aria-label="主题编辑器">
        <div class="pane-heading">
          <strong>{{ activeDomain.label }}</strong>
          <div>
            <button
              type="button"
              class="studio-icon-button"
              title="导出主题"
              aria-label="导出主题"
              :disabled="!draft || isUnsavedDraft"
              @click="exportTheme"
            >
              <i class="ph ph-upload-simple"></i>
            </button>
            <button
              type="button"
              class="studio-icon-button danger"
              title="删除主题"
              aria-label="删除主题"
              :disabled="!draft || isUnsavedDraft"
              @click="deleteSelected"
            >
              <i class="ph ph-trash"></i>
            </button>
          </div>
        </div>

        <section v-if="domain === 'presets'" class="preset-gallery-section">
          <div class="control-section-heading">
            <span>内置预设</span><small>预览后确认应用</small>
          </div>
          <div class="preset-gallery" aria-label="内置主题预设">
            <article
              v-for="preset in BUILT_IN_THEME_PRESETS"
              :key="preset.id"
              class="preset-gallery-item"
              :class="{
                selected: selectedKey === `preset:${preset.id}`,
                active: activeKey === `preset:${preset.id}`
              }"
            >
              <button
                type="button"
                class="preset-preview-command"
                :aria-pressed="selectedKey === `preset:${preset.id}`"
                @click="selectBuiltIn(preset.id as BuiltInThemePresetId)"
              >
                <span
                  class="preset-thumbnail"
                  :style="presetPreviewStyle(preset)"
                  :data-layout="resolveThemeProfileModes(preset).player?.layout"
                  aria-hidden="true"
                >
                  <i></i><i></i><i></i><i></i>
                </span>
                <span class="preset-copy">
                  <strong>{{ preset.name }}</strong>
                  <small>{{ preset.description }}</small>
                </span>
              </button>
              <div class="preset-item-actions">
                <span v-if="activeKey === `preset:${preset.id}`">当前使用</span>
                <button
                  type="button"
                  title="从预设派生"
                  aria-label="从预设派生"
                  @click="derivePreset(preset)"
                >
                  <i class="ph ph-copy"></i>
                </button>
              </div>
            </article>
          </div>

          <div class="control-section-heading user-profile-heading">
            <span>个人主题</span><small>{{ profiles.length }} / 32</small>
          </div>
          <div v-if="profiles.length" class="preset-gallery user-profile-gallery">
            <article
              v-for="profile in profiles"
              :key="profile.id"
              class="preset-gallery-item"
              :class="{
                selected: selectedKey === `profile:${profile.id}`,
                active: activeKey === `profile:${profile.id}`
              }"
            >
              <button
                type="button"
                class="preset-preview-command"
                :aria-pressed="selectedKey === `profile:${profile.id}`"
                @click="selectProfile(profile)"
              >
                <span
                  class="preset-thumbnail"
                  :style="presetPreviewStyle(profile)"
                  :data-layout="resolveThemeProfileModes(profile).player?.layout"
                  aria-hidden="true"
                >
                  <i></i><i></i><i></i><i></i>
                </span>
                <span class="preset-copy">
                  <strong>{{ profile.name }}</strong>
                  <small>
                    {{
                      profile.source?.kind === 'builtin-preset'
                        ? `派生自 ${getBuiltInThemePreset(profile.source.presetId)?.name ?? '内置预设'}`
                        : profile.description || '个人配置档'
                    }}
                  </small>
                </span>
              </button>
              <div class="preset-item-actions">
                <span v-if="activeKey === `profile:${profile.id}`">当前使用</span>
                <time>{{ new Date(profile.updatedAt).toLocaleDateString('zh-CN') }}</time>
              </div>
            </article>
          </div>
          <p v-else class="preset-empty-state">尚未创建个人主题</p>

          <section v-if="draft" class="profile-history-section">
            <div class="control-section-heading">
              <span>版本历史</span><small>最多保留 8 个版本</small>
            </div>
            <div v-if="persistedHistory.length" class="profile-history-list">
              <div v-for="entry in persistedHistory" :key="entry.savedAt">
                <span>
                  <strong>{{ entry.profile.name }}</strong>
                  <time>{{ historyLabel(entry) }}</time>
                </span>
                <button
                  type="button"
                  title="恢复此版本"
                  aria-label="恢复此版本"
                  @click="restoreVersion(entry)"
                >
                  <i class="ph ph-clock-counter-clockwise"></i>
                </button>
              </div>
            </div>
            <p v-else class="preset-empty-state">保存修改后会在此保留可恢复版本</p>
          </section>
        </section>

        <input
          v-if="draft && domain !== 'presets'"
          class="theme-name-input"
          :value="draft.name"
          maxlength="80"
          aria-label="主题名称"
          @change="changeName"
        />
        <div v-else-if="domain !== 'presets'" class="read-only-theme">
          <i class="ph ph-lock"></i><span>创建副本后编辑</span>
        </div>

        <section v-if="domain === 'personalization'" class="studio-control-section">
          <div class="control-section-heading">
            <span>个性化运行模式</span
            ><small>配置档 · {{ tone === 'dark' ? '深色' : '浅色' }}</small>
          </div>
          <label class="studio-setting-row">
            <span>强调色来源<small>封面模式复用已缓存主色</small></span>
            <select
              :value="activeModes.appearance?.accentSource"
              :disabled="!draft"
              @change="updateAppearanceMode('accentSource', $event)"
            >
              <option value="fixed">固定颜色</option>
              <option value="cover">当前封面</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>背景处理<small>失败时保留实色背景</small></span>
            <select
              :value="activeModes.appearance?.backgroundTreatment"
              :disabled="!draft"
              @change="updateAppearanceMode('backgroundTreatment', $event)"
            >
              <option value="solid">实色</option>
              <option value="gradient">双色渐变</option>
              <option value="cover-blur">封面模糊</option>
              <option value="image">本地图片</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>日夜调度<small>切换只重解析当前变体</small></span>
            <select
              :value="activeModes.appearance?.toneScheduling"
              :disabled="!draft"
              @change="updateAppearanceMode('toneScheduling', $event)"
            >
              <option value="manual">手动</option>
              <option value="system">跟随系统</option>
              <option value="timed">定时时段</option>
            </select>
          </label>
          <div v-if="activeModes.appearance?.toneScheduling === 'timed'" class="schedule-time-grid">
            <label>
              <span>浅色开始</span>
              <input
                type="time"
                :value="scheduleTime('lightStartMinutes')"
                :disabled="!draft"
                @change="updateScheduleTime('lightStartMinutes', $event)"
              />
            </label>
            <label>
              <span>深色开始</span>
              <input
                type="time"
                :value="scheduleTime('darkStartMinutes')"
                :disabled="!draft"
                @change="updateScheduleTime('darkStartMinutes', $event)"
              />
            </label>
          </div>
          <label class="studio-setting-row">
            <span>对比度保护<small>普通文本 4.5:1，大文本 3:1</small></span>
            <select
              :value="activeModes.appearance?.contrastGuard"
              :disabled="!draft"
              @change="updateAppearanceMode('contrastGuard', $event)"
            >
              <option value="off">关闭</option>
              <option value="warn">仅预警</option>
              <option value="enforce">安全回退</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>特效模式<small>关闭模糊/玻璃/封面滤镜，不覆盖系统动效偏好</small></span>
            <select
              :value="activeModes.appearance?.effectsMode"
              :disabled="!draft"
              @change="updateAppearanceMode('effectsMode', $event)"
            >
              <option value="full">完整特效</option>
              <option value="reduced">关闭特效</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'personalization'" class="palette-editor">
          <div class="control-section-heading">
            <span>精选强调色</span><small>{{ accentPalette.length }} 色</small>
          </div>
          <div class="palette-grid" aria-label="精选强调色色板">
            <button
              v-for="entry in accentPalette"
              :key="entry.id"
              type="button"
              :class="{ active: valueForId('color.primary.500') === entry.value }"
              :style="{ '--swatch-color': entry.value }"
              :title="entry.label"
              :aria-label="entry.label"
              :disabled="!draft"
              @click="applyAccentPalette(entry.value)"
            ></button>
          </div>
          <div class="control-section-heading background-palette-heading">
            <span>精选背景色</span><small>{{ backgroundPalette.length }} 色</small>
          </div>
          <div class="palette-grid" aria-label="精选背景色色板">
            <button
              v-for="entry in backgroundPalette"
              :key="entry.id"
              type="button"
              :class="{ active: valueForId('surface.app') === entry.value }"
              :style="{ '--swatch-color': entry.value }"
              :title="entry.label"
              :aria-label="entry.label"
              :disabled="!draft"
              @click="applyBackgroundPalette(entry.value)"
            ></button>
          </div>
        </section>

        <section v-if="domain === 'navigation'" class="studio-control-section">
          <div class="control-section-heading">
            <span>图标与导航模式</span><small>静态宿主变体</small>
          </div>
          <label class="studio-setting-row">
            <span>图标族<small>语义槽保持不变</small></span>
            <select
              :value="activeModes.icons?.family"
              :disabled="!draft"
              @change="updateIconFamily"
            >
              <option value="outline">描边</option>
              <option value="rounded">圆润粗线</option>
              <option value="filled">填充</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>导航布局<small>菜单结构不由主题修改</small></span>
            <select
              :value="activeModes.navigation?.style"
              :disabled="!draft"
              @change="updateNavigationMode('style', $event)"
            >
              <option value="expanded">展开</option>
              <option value="compact">紧凑</option>
              <option value="rail">图标栏</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>导航图标大小<small>点击区域保持固定</small></span>
            <select
              :value="activeModes.navigation?.iconScale"
              :disabled="!draft"
              @change="updateNavigationMode('iconScale', $event)"
            >
              <option value="sm">小</option>
              <option value="md">中</option>
              <option value="lg">大</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>内置标识<small>仅控制宿主品牌标识</small></span>
            <select
              :value="activeModes.navigation?.logo"
              :disabled="!draft"
              @change="updateNavigationMode('logo', $event)"
            >
              <option value="hide">隐藏</option>
              <option value="show">显示</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'library'" class="studio-control-section">
          <div class="control-section-heading">
            <span>媒体库模式</span><small>不改变数据流</small>
          </div>
          <label class="studio-setting-row">
            <span>信息密度<small>虚拟列表步长保持稳定</small></span>
            <select
              :value="activeModes.library?.density"
              :disabled="!draft"
              @change="updateLibraryMode('density', $event)"
            >
              <option value="comfortable">舒适</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>选中样式<small>填充或描边</small></span>
            <select
              :value="activeModes.library?.selection"
              :disabled="!draft"
              @change="updateLibraryMode('selection', $event)"
            >
              <option value="fill">填充</option>
              <option value="stroke">描边</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>标题区叠层<small>强度由下方令牌控制</small></span>
            <select
              :value="activeModes.library?.titleOverlay"
              :disabled="!draft"
              @change="updateLibraryMode('titleOverlay', $event)"
            >
              <option value="off">关闭</option>
              <option value="on">开启</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'player'" class="studio-control-section player-layout-section">
          <div class="control-section-heading">
            <span>播放器布局</span><small>宿主缩略图</small>
          </div>
          <div class="layout-gallery" aria-label="播放器布局">
            <button
              v-for="layout in playerLayouts"
              :key="layout.id"
              type="button"
              class="layout-choice"
              :class="{ active: activeModes.player?.layout === layout.id }"
              :aria-pressed="activeModes.player?.layout === layout.id"
              :disabled="!draft"
              @click="setPlayerLayout(layout.id)"
            >
              <span class="layout-thumbnail" :data-layout="layout.id" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
              <span>{{ layout.label }}</span>
            </button>
          </div>
        </section>

        <section v-if="domain === 'player'" class="studio-control-section">
          <div class="control-section-heading">
            <span>控制区与封面</span><small>静态呈现</small>
          </div>
          <label class="studio-setting-row">
            <span>控制区<small>业务按钮保持不变</small></span>
            <select
              :value="activeModes.player?.controls"
              :disabled="!draft"
              @change="updatePlayerMode('controls', $event)"
            >
              <option value="standard">标准</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>标题对齐<small>与布局正交</small></span>
            <select
              :value="activeModes.player?.titleAlign"
              :disabled="!draft"
              @change="updatePlayerMode('titleAlign', $event)"
            >
              <option value="left">左对齐</option>
              <option value="center">居中</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>进度样式<small>原生 range 行为不变</small></span>
            <select
              :value="activeModes.player?.progress"
              :disabled="!draft"
              @change="updatePlayerMode('progress', $event)"
            >
              <option value="line">直线无滑块</option>
              <option value="ring">空心圆</option>
              <option value="solid">实心圆</option>
              <option value="spectrum">频谱轨道</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>封面过渡<small>遵循减少动态效果</small></span>
            <select
              :value="activeModes.artwork?.transition"
              :disabled="!draft"
              @change="updateArtworkMode('transition', $event)"
            >
              <option value="fade">淡入</option>
              <option value="slide">滑入</option>
              <option value="none">无过渡</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>封面阴影<small>只影响视觉层</small></span>
            <select
              :value="activeModes.artwork?.shadow"
              :disabled="!draft"
              @change="updateArtworkMode('shadow', $event)"
            >
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'player'" class="studio-control-section">
          <div class="control-section-heading">
            <span>均衡器视觉</span><small>不修改 DSP 参数</small>
          </div>
          <label class="studio-setting-row">
            <span>面板材质<small>中性、着色或玻璃</small></span>
            <select
              :value="activeModes.equalizer?.panel"
              :disabled="!draft"
              @change="updateEqualizerMode('panel', $event)"
            >
              <option value="neutral">中性</option>
              <option value="tinted">着色</option>
              <option value="glass">玻璃</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>滑块<small>空心环或实心圆</small></span>
            <select
              :value="activeModes.equalizer?.slider"
              :disabled="!draft"
              @change="updateEqualizerMode('slider', $event)"
            >
              <option value="ring">空心环</option>
              <option value="solid">实心圆</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>旋钮指示<small>线形或圆点</small></span>
            <select
              :value="activeModes.equalizer?.knob"
              :disabled="!draft"
              @change="updateEqualizerMode('knob', $event)"
            >
              <option value="line">线形</option>
              <option value="dot">圆点</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>频谱<small>柱形、线形或面积</small></span>
            <select
              :value="activeModes.equalizer?.spectrum"
              :disabled="!draft"
              @change="updateEqualizerMode('spectrum', $event)"
            >
              <option value="bars">柱形</option>
              <option value="line">线形</option>
              <option value="area">面积</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>按钮<small>柔和、描边或填充</small></span>
            <select
              :value="activeModes.equalizer?.button"
              :disabled="!draft"
              @change="updateEqualizerMode('button', $event)"
            >
              <option value="soft">柔和</option>
              <option value="outline">描边</option>
              <option value="solid">填充</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'player'" class="studio-control-section">
          <div class="control-section-heading"><span>可见性</span><small>白名单槽位</small></div>
          <div class="visibility-grid">
            <label v-for="option in visibilityOptions" :key="option.id">
              <span>{{ option.label }}</span>
              <input
                type="checkbox"
                :checked="visibilityValue(option.id)"
                :disabled="!draft"
                @change="updateVisibility(option.id, $event)"
              />
            </label>
          </div>
        </section>

        <section v-if="domain === 'typography'" class="studio-control-section">
          <div class="control-section-heading"><span>字体行为</span><small>配置档</small></div>
          <label class="studio-setting-row">
            <span>标题大写<small>不改写原始元数据</small></span>
            <select
              :value="activeModes.typography?.titleCase"
              :disabled="!draft"
              @change="updateTypographyMode('titleCase', $event)"
            >
              <option value="preserve">保留原样</option>
              <option value="uppercase">大写显示</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>歌词强调高亮<small>当前行使用强调色</small></span>
            <select
              :value="activeModes.typography?.lyricAccent"
              :disabled="!draft"
              @change="updateTypographyMode('lyricAccent', $event)"
            >
              <option value="off">关闭</option>
              <option value="accent">强调色</option>
            </select>
          </label>
          <label class="studio-setting-row">
            <span>自适应标题颜色<small>按信息层级应用强调色</small></span>
            <select
              :value="activeModes.typography?.titleColor"
              :disabled="!draft"
              @change="updateTypographyMode('titleColor', $event)"
            >
              <option value="off">禁用</option>
              <option value="track">曲目标题</option>
              <option value="artist-album">艺术家与专辑</option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'typography'" class="font-library-editor">
          <div class="asset-editor-heading">
            <span>字体风格库</span>
            <button type="button" :disabled="!draft" @click="importAsset('font')">
              <i class="ph ph-file-woff"></i><span>导入 WOFF2</span>
            </button>
          </div>
          <label v-for="binding in fontBindings" :key="binding.key">
            <span
              >{{ binding.label }}<small>{{ fontSource(binding) }}</small></span
            >
            <select
              :value="fontSelection(binding)"
              :disabled="!draft"
              @change="updateFontSlot(binding, $event)"
            >
              <option value="custom">自定义令牌</option>
              <optgroup label="内置字体">
                <option
                  v-for="font in BUILT_IN_THEME_FONTS"
                  :key="font.id"
                  :value="`builtin:${font.id}`"
                >
                  {{ font.label }} · {{ font.category }}
                </option>
              </optgroup>
              <optgroup v-if="fontAssets.length" label="本地资源">
                <option v-for="asset in fontAssets" :key="asset.id" :value="`asset:${asset.id}`">
                  {{ asset.path }}
                </option>
              </optgroup>
            </select>
          </label>
        </section>

        <div v-if="domain === 'windows'" class="window-default-grid">
          <section class="studio-control-section">
            <div class="control-section-heading">
              <span>迷你播放器</span><small>继承开启时生效</small>
            </div>
            <label class="studio-setting-row">
              <span>表面颜色<small>无封面时也保留</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('miniPlayer', 'surfaceColor'))"
                :disabled="!draft"
                @input="updateWindowText('miniPlayer', 'surfaceColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>强调色<small>控件与进度</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('miniPlayer', 'accentColor'))"
                :disabled="!draft"
                @input="updateWindowText('miniPlayer', 'accentColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>主要文字<small>覆盖自动取色</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('miniPlayer', 'primaryTextColor'))"
                :disabled="!draft"
                @input="updateWindowText('miniPlayer', 'primaryTextColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>字体<small>本地字体栈</small></span>
              <input
                type="text"
                :value="String(windowDefaultValue('miniPlayer', 'fontFamily'))"
                :disabled="!draft"
                @change="updateWindowText('miniPlayer', 'fontFamily', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >表面透明度<small
                  >{{ windowDefaultValue('miniPlayer', 'surfaceOpacity') }}%</small
                ></span
              >
              <input
                type="range"
                min="40"
                max="100"
                :value="Number(windowDefaultValue('miniPlayer', 'surfaceOpacity'))"
                :disabled="!draft"
                @input="updateWindowNumber('miniPlayer', 'surfaceOpacity', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >玻璃模糊<small>{{ windowDefaultValue('miniPlayer', 'glassBlur') }}px</small></span
              >
              <input
                type="range"
                min="0"
                max="40"
                :value="Number(windowDefaultValue('miniPlayer', 'glassBlur'))"
                :disabled="!draft"
                @input="updateWindowNumber('miniPlayer', 'glassBlur', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >圆角<small>{{ windowDefaultValue('miniPlayer', 'cornerRadius') }}px</small></span
              >
              <input
                type="range"
                min="0"
                max="36"
                :value="Number(windowDefaultValue('miniPlayer', 'cornerRadius'))"
                :disabled="!draft"
                @input="updateWindowNumber('miniPlayer', 'cornerRadius', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>边框颜色<small>独立窗口轮廓</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('miniPlayer', 'borderColor'))"
                :disabled="!draft"
                @input="updateWindowText('miniPlayer', 'borderColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>阴影颜色<small>窗口层次</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('miniPlayer', 'shadowColor'))"
                :disabled="!draft"
                @input="updateWindowText('miniPlayer', 'shadowColor', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >阴影强度<small
                  >{{ windowDefaultValue('miniPlayer', 'shadowStrength') }}%</small
                ></span
              >
              <input
                type="range"
                min="0"
                max="100"
                :value="Number(windowDefaultValue('miniPlayer', 'shadowStrength'))"
                :disabled="!draft"
                @input="updateWindowNumber('miniPlayer', 'shadowStrength', $event)"
              />
            </label>
          </section>

          <section class="studio-control-section">
            <div class="control-section-heading">
              <span>桌面歌词</span><small>文字与窗口材质</small>
            </div>
            <label class="studio-setting-row">
              <span>文字颜色<small>未激活歌词</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('desktopLyrics', 'color'))"
                :disabled="!draft"
                @input="updateWindowText('desktopLyrics', 'color', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>高亮颜色<small>当前歌词</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('desktopLyrics', 'highlightColor'))"
                :disabled="!draft"
                @input="updateWindowText('desktopLyrics', 'highlightColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>背景颜色<small>桌面歌词窗口</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('desktopLyrics', 'backgroundColor'))"
                :disabled="!draft"
                @input="updateWindowText('desktopLyrics', 'backgroundColor', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>字体<small>系统或内置字体 ID</small></span>
              <input
                type="text"
                :value="String(windowDefaultValue('desktopLyrics', 'fontFamily'))"
                :disabled="!draft"
                @change="updateWindowText('desktopLyrics', 'fontFamily', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >字号<small>{{ windowDefaultValue('desktopLyrics', 'fontSize') }}px</small></span
              >
              <input
                type="range"
                min="12"
                max="80"
                :value="Number(windowDefaultValue('desktopLyrics', 'fontSize'))"
                :disabled="!draft"
                @input="updateWindowNumber('desktopLyrics', 'fontSize', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >背景透明度<small
                  >{{ windowDefaultValue('desktopLyrics', 'backgroundOpacity') }}%</small
                ></span
              >
              <input
                type="range"
                min="0"
                max="100"
                :value="Number(windowDefaultValue('desktopLyrics', 'backgroundOpacity'))"
                :disabled="!draft"
                @input="updateWindowNumber('desktopLyrics', 'backgroundOpacity', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>文字阴影<small>关闭后保留阴影参数</small></span>
              <input
                type="checkbox"
                :checked="Boolean(windowDefaultValue('desktopLyrics', 'shadow'))"
                :disabled="!draft"
                @change="updateWindowBoolean('desktopLyrics', 'shadow', $event)"
              />
            </label>
            <label class="studio-setting-row">
              <span>阴影颜色<small>文字边缘</small></span>
              <input
                type="color"
                :value="String(windowDefaultValue('desktopLyrics', 'shadowColor'))"
                :disabled="!draft"
                @input="updateWindowText('desktopLyrics', 'shadowColor', $event)"
              />
            </label>
            <label class="studio-setting-row window-range-row">
              <span
                >阴影模糊<small
                  >{{ windowDefaultValue('desktopLyrics', 'shadowBlur') }}px</small
                ></span
              >
              <input
                type="range"
                min="0"
                max="30"
                :value="Number(windowDefaultValue('desktopLyrics', 'shadowBlur'))"
                :disabled="!draft"
                @input="updateWindowNumber('desktopLyrics', 'shadowBlur', $event)"
              />
            </label>
          </section>
        </div>

        <section v-if="domain === 'personalization' || domain === 'advanced'" class="asset-editor">
          <div class="asset-editor-heading">
            <span>本地背景资源</span>
            <button type="button" :disabled="!draft" @click="importAsset('image')">
              <i class="ph ph-image-square"></i><span>导入图片</span>
            </button>
          </div>
          <label
            v-for="binding in domain === 'personalization'
              ? personalizationBackgroundBindings
              : backgroundBindings"
            :key="binding.key"
          >
            <span
              >{{ binding.label }}<small>{{ assetSource(binding.key) }}</small></span
            >
            <select
              :value="draft?.assetBindings?.[binding.key] ?? ''"
              :disabled="!draft"
              @change="updateAssetBinding(binding.key, $event)"
            >
              <option value="">不使用资源</option>
              <option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">
                {{ asset.path }}
              </option>
            </select>
          </label>
        </section>

        <section v-if="domain === 'personalization' || domain === 'advanced'" class="asset-editor">
          <div class="asset-editor-heading">
            <span>本地字体资源</span>
            <button type="button" :disabled="!draft" @click="importAsset('font')">
              <i class="ph ph-file-woff"></i><span>导入 WOFF2</span>
            </button>
          </div>
          <label v-for="binding in fontBindings" :key="binding.key">
            <span
              >{{ binding.label }}<small>{{ assetSource(binding.key) }}</small></span
            >
            <select
              :value="draft?.assetBindings?.[binding.key] ?? ''"
              :disabled="!draft"
              @change="updateAssetBinding(binding.key, $event)"
            >
              <option value="">使用令牌字体</option>
              <option v-for="asset in fontAssets" :key="asset.id" :value="asset.id">
                {{ asset.path }}
              </option>
            </select>
          </label>
        </section>

        <div v-if="domain !== 'presets'" class="token-editor-list" :class="{ disabled: !draft }">
          <div
            v-for="definition in visibleDefinitions"
            :key="definition.id"
            class="token-editor-row"
          >
            <div>
              <span
                ><strong>{{ definition.label }}</strong
                ><small>{{ definition.surface }}</small></span
              >
              <span class="token-source">{{ sourceFor(definition) }}</span>
            </div>
            <div class="token-control">
              <template v-if="definition.min != null && definition.max != null">
                <input
                  type="range"
                  :min="definition.min"
                  :max="definition.max"
                  :step="definition.step || 1"
                  :value="rangeNumber(definition)"
                  :disabled="!draft"
                  @input="updateRange(definition, $event)"
                />
                <code>{{ valueFor(definition) }}</code>
              </template>
              <template
                v-else-if="definition.kind === 'color' && supportsColorPicker(valueFor(definition))"
              >
                <input
                  type="color"
                  :value="valueFor(definition)"
                  :disabled="!draft"
                  @input="updateToken(definition, ($event.target as HTMLInputElement).value)"
                />
                <input
                  type="text"
                  :value="valueFor(definition)"
                  :disabled="!draft"
                  @change="updateToken(definition, ($event.target as HTMLInputElement).value)"
                />
              </template>
              <input
                v-else
                type="text"
                :value="valueFor(definition)"
                :disabled="!draft"
                @change="updateToken(definition, ($event.target as HTMLInputElement).value)"
              />
              <button
                type="button"
                class="studio-icon-button"
                title="恢复默认"
                aria-label="恢复默认"
                :disabled="!draft || !draft.overrides[tone][definition.id]"
                @click="removeOverride(definition)"
              >
                <i class="ph ph-arrow-u-up-left"></i>
              </button>
            </div>
          </div>
        </div>

        <section
          v-if="contrastWarnings.length && activeModes.appearance?.contrastGuard !== 'off'"
          class="contrast-warning"
          role="status"
        >
          <div><i class="ph ph-warning"></i><strong>对比度预警</strong></div>
          <p v-for="warning in contrastWarnings" :key="warning.label">
            {{ warning.label }}：{{ warning.ratio.toFixed(2) }}:1，最低
            {{ warning.minimum.toFixed(1) }}:1
          </p>
        </section>

        <section
          v-if="selectedPluginTheme?.compatibilityNotes?.length"
          class="contrast-warning"
          role="status"
        >
          <div><i class="ph ph-warning"></i><strong>主题兼容提示</strong></div>
          <p v-for="note in selectedPluginTheme.compatibilityNotes" :key="note">{{ note }}</p>
        </section>

        <p v-if="localError || themeStore.error.value" class="studio-message error">
          {{ localError || themeStore.error.value }}
        </p>
        <p v-else-if="notice" class="studio-message">{{ notice }}</p>
      </aside>
    </div>
  </div>
</template>

<style src="./theme-studio/ThemeStudioPage.css"></style>
