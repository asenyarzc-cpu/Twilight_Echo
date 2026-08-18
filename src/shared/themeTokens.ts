export const THEME_DOCUMENT_SCHEMA_VERSION = 1
export const THEME_PROFILE_SCHEMA_VERSION = 2
export const TWILIGHT_DEFAULT_THEME_ID = 'builtin:twilight-echo-default'

import { lightFont } from './themeData.ts'
import type {
  ThemeDocumentV1,
  ThemeTokenDefinition,
  ThemeTokenGroup,
  ThemeTokenKind,
  ThemeTone,
  ThemeVariant
} from './theme.ts'
function token(
  id: string,
  cssVariable: `--te-${string}`,
  label: string,
  group: ThemeTokenGroup,
  surface: string,
  kind: ThemeTokenKind,
  pureWhite: string,
  dark: string,
  control: Partial<
    Pick<ThemeTokenDefinition, 'min' | 'max' | 'step' | 'unit' | 'options' | 'adaptive'>
  > = {}
): ThemeTokenDefinition {
  return {
    id,
    cssVariable,
    label,
    group,
    surface,
    kind,
    defaults: { pureWhite, dark },
    ...control
  }
}
export const THEME_TOKEN_DEFINITIONS: readonly ThemeTokenDefinition[] = Object.freeze([
  token(
    'color.primary.500',
    '--te-primary-500',
    '主强调色',
    'colors',
    'global',
    'color',
    '#2563eb',
    '#2563eb',
    {
      adaptive: 'cover-accent'
    }
  ),
  token(
    'color.primary.400',
    '--te-primary-400',
    '主强调色悬浮',
    'colors',
    'global',
    'color',
    '#3b82f6',
    '#3b82f6',
    {
      adaptive: 'cover-accent'
    }
  ),
  token(
    'color.primary.300',
    '--te-primary-300',
    '主强调色柔和',
    'colors',
    'global',
    'color',
    '#93c5fd',
    '#93c5fd',
    {
      adaptive: 'cover-accent'
    }
  ),
  token(
    'color.primary.rgb',
    '--te-primary-rgb',
    '主强调色 RGB',
    'colors',
    'global',
    'raw',
    '37, 99, 235',
    '37, 99, 235',
    {
      adaptive: 'cover-accent'
    }
  ),
  token(
    'color.favorite',
    '--te-favorite-500',
    '收藏色',
    'colors',
    'global',
    'color',
    '#db2777',
    '#d94f7d'
  ),
  token(
    'color.success',
    '--te-success-500',
    '成功色',
    'colors',
    'global',
    'color',
    '#16a34a',
    '#14b881'
  ),
  token(
    'color.warning',
    '--te-warning-500',
    '警告色',
    'colors',
    'global',
    'color',
    '#d97706',
    '#f59e0b'
  ),
  token('color.info', '--te-info-500', '信息色', 'colors', 'global', 'color', '#2563eb', '#38bdf8'),
  token(
    'color.accentCyan',
    '--te-accent-cyan',
    '青色辅助色',
    'colors',
    'global',
    'color',
    '#0891b2',
    '#2dd4bf'
  ),
  token(
    'color.neutral.50',
    '--te-neutral-50',
    '最低层背景',
    'colors',
    'global',
    'color',
    '#ffffff',
    '#050505'
  ),
  token(
    'color.neutral.100',
    '--te-neutral-100',
    '柔和背景',
    'colors',
    'global',
    'color',
    '#f8fafc',
    '#111111'
  ),
  token(
    'color.neutral.200',
    '--te-neutral-200',
    '浅边界',
    'colors',
    'global',
    'color',
    '#e5e7eb',
    '#1f1f1f'
  ),
  token(
    'color.neutral.300',
    '--te-neutral-300',
    '中边界',
    'colors',
    'global',
    'color',
    '#d1d5db',
    '#343434'
  ),
  token(
    'color.neutral.500',
    '--te-neutral-500',
    '次要文字',
    'colors',
    'global',
    'color',
    '#64748b',
    '#9b9b9b'
  ),
  token(
    'color.neutral.700',
    '--te-neutral-700',
    '正文辅助',
    'colors',
    'global',
    'color',
    '#334155',
    '#d8d8d8'
  ),
  token(
    'color.neutral.900',
    '--te-neutral-900',
    '主要文字',
    'colors',
    'global',
    'color',
    '#0f172a',
    '#f7f7f2'
  ),
  token('surface.app', '--te-app-bg', '应用背景', 'colors', 'app', 'color', '#f4f4f7', '#17181a'),
  token(
    'surface.local',
    '--te-local-bg',
    '本地音乐背景',
    'colors',
    'local',
    'color',
    '#f4f4f7',
    '#17181a'
  ),
  token(
    'surface.settings',
    '--te-settings-bg',
    '设置背景',
    'colors',
    'settings',
    'color',
    '#f5f6f8',
    '#17181a'
  ),
  token(
    'surface.streaming',
    '--te-streaming-bg',
    '流媒体背景',
    'colors',
    'streaming',
    'color',
    '#f4f4f7',
    '#17181a'
  ),
  token(
    'surface.player',
    '--te-player-bg',
    '播放页背景',
    'colors',
    'player',
    'color',
    '#f4f4f7',
    '#17181a'
  ),
  token(
    'background.gradientStart',
    '--te-background-gradient-start',
    '渐变起始色',
    'colors',
    'app-background',
    'color',
    '#eff6ff',
    '#111827'
  ),
  token(
    'background.gradientEnd',
    '--te-background-gradient-end',
    '渐变结束色',
    'colors',
    'app-background',
    'color',
    '#f5f3ff',
    '#1d1728'
  ),
  token(
    'background.gradientAngle',
    '--te-background-gradient-angle',
    '渐变角度',
    'materials',
    'app-background',
    'number',
    '135deg',
    '135deg',
    { min: 0, max: 360, step: 1, unit: 'deg' }
  ),
  token(
    'background.coverBlur',
    '--te-background-cover-blur',
    '封面背景模糊',
    'materials',
    'app-background',
    'length',
    '28px',
    '36px',
    { min: 0, max: 64, step: 1, unit: 'px' }
  ),
  token(
    'background.overlayOpacity',
    '--te-background-overlay-opacity',
    '背景叠层强度',
    'materials',
    'app-background',
    'number',
    '12%',
    '38%',
    { min: 0, max: 80, step: 1, unit: '%' }
  ),
  token(
    'shell.control.text',
    '--te-shell-control-text',
    '应用壳控制文字',
    'colors',
    'app-shell',
    'color',
    '#0f172a',
    '#f7f7f2'
  ),
  token(
    'shell.control.hoverSurface',
    '--te-shell-control-hover',
    '应用壳控制悬浮',
    'materials',
    'app-shell',
    'color',
    'rgba(37, 99, 235, 0.08)',
    'rgba(245, 158, 11, 0.12)'
  ),
  token(
    'settings.text.primary',
    '--te-settings-text',
    '设置主要文字',
    'colors',
    'settings',
    'color',
    '#1a1a1a',
    '#f7f7f2'
  ),
  token(
    'settings.text.muted',
    '--te-settings-text-muted',
    '设置辅助文字',
    'colors',
    'settings',
    'color',
    '#8a8f98',
    '#9b9b9b'
  ),
  token(
    'settings.control.surface',
    '--te-settings-control-bg',
    '设置控件表面',
    'materials',
    'settings',
    'color',
    '#ffffff',
    '#181818'
  ),
  token(
    'settings.control.border',
    '--te-settings-control-border',
    '设置控件边框',
    'materials',
    'settings',
    'color',
    'rgba(15, 23, 42, 0.06)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'settings.panel.border',
    '--te-settings-panel-border',
    '设置面板边框',
    'materials',
    'settings',
    'color',
    'transparent',
    'transparent'
  ),
  token(
    'settings.navigation.text',
    '--te-settings-nav-text',
    '设置导航文字',
    'colors',
    'settings-navigation',
    'color',
    '#5c6370',
    '#d8d8d8'
  ),
  token(
    'settings.navigation.hoverSurface',
    '--te-settings-nav-hover',
    '设置导航悬浮',
    'materials',
    'settings-navigation',
    'color',
    'rgba(15, 23, 42, 0.04)',
    'rgba(255, 255, 255, 0.065)'
  ),
  token(
    'settings.navigation.activeSurface',
    '--te-settings-nav-active',
    '设置导航选中',
    'materials',
    'settings-navigation',
    'color',
    '#ffffff',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'navigation.surface',
    '--te-navigation-bg',
    '导航表面',
    'materials',
    'navigation',
    'color',
    'rgba(255, 255, 255, 0.94)',
    '#17181a'
  ),
  token(
    'navigation.border',
    '--te-navigation-border',
    '导航边框',
    'materials',
    'navigation',
    'color',
    'rgba(0, 0, 0, 0.05)',
    'transparent'
  ),
  token(
    'navigation.shadow',
    '--te-navigation-shadow',
    '导航阴影',
    'materials',
    'navigation',
    'shadow',
    '4px 0 24px rgba(15, 23, 42, 0.03)',
    'none'
  ),
  token(
    'navigation.text',
    '--te-navigation-text',
    '导航文字',
    'colors',
    'navigation',
    'color',
    '#475569',
    '#d8d8d8'
  ),
  token(
    'navigation.icon',
    '--te-navigation-icon',
    '导航图标',
    'colors',
    'navigation',
    'color',
    '#64748b',
    '#9b9b9b'
  ),
  token(
    'navigation.hoverSurface',
    '--te-navigation-hover',
    '导航悬浮表面',
    'materials',
    'navigation',
    'color',
    'rgba(15, 23, 42, 0.04)',
    'rgba(255, 255, 255, 0.065)'
  ),
  token(
    'navigation.hoverText',
    '--te-navigation-hover-text',
    '导航悬浮文字',
    'colors',
    'navigation',
    'color',
    '#0f172a',
    '#f7f7f2'
  ),
  token(
    'navigation.activeSurface',
    '--te-navigation-active',
    '导航选中表面',
    'materials',
    'navigation',
    'color',
    'rgba(37, 99, 235, 0.08)',
    'rgba(245, 158, 11, 0.16)'
  ),
  token(
    'navigation.activeText',
    '--te-navigation-active-text',
    '导航选中文字',
    'colors',
    'navigation',
    'color',
    '#2563eb',
    '#f59e0b'
  ),
  token(
    'navigation.indicator',
    '--te-navigation-indicator',
    '导航指示器',
    'colors',
    'navigation',
    'color',
    '#2563eb',
    '#f59e0b'
  ),
  token(
    'navigation.opacity',
    '--te-navigation-opacity',
    '导航表面透明度',
    'materials',
    'navigation',
    'number',
    '94%',
    '100%',
    { min: 35, max: 100, step: 1, unit: '%' }
  ),
  token(
    'navigation.radius',
    '--te-navigation-radius',
    '导航外框圆角',
    'shape',
    'navigation',
    'length',
    '0px',
    '0px',
    { min: 0, max: 28, step: 1, unit: 'px' }
  ),
  token(
    'library.page.surface',
    '--te-library-bg',
    '媒体库页面表面',
    'materials',
    'library',
    'gradient',
    'linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.9))',
    'linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.9))'
  ),
  token(
    'library.table.surface',
    '--te-library-table-bg',
    '媒体库列表表面',
    'materials',
    'library',
    'color',
    'rgba(255, 255, 255, 0.16)',
    'rgba(255, 255, 255, 0.16)'
  ),
  token(
    'library.table.border',
    '--te-library-table-border',
    '媒体库列表边框',
    'materials',
    'library',
    'color',
    'rgba(255, 255, 255, 0.52)',
    'rgba(255, 255, 255, 0.52)'
  ),
  token(
    'library.table.shadow',
    '--te-library-table-shadow',
    '媒体库列表阴影',
    'materials',
    'library',
    'shadow',
    '0 26px 78px rgba(86, 70, 160, 0.1)',
    '0 26px 78px rgba(86, 70, 160, 0.1)'
  ),
  token(
    'library.row.text',
    '--te-library-row-text',
    '媒体库行文字',
    'colors',
    'library',
    'color',
    '#334155',
    '#d8d8d8'
  ),
  token(
    'library.row.hoverSurface',
    '--te-library-row-hover',
    '媒体库行悬浮',
    'materials',
    'library',
    'color',
    'rgba(255, 255, 255, 0.22)',
    'rgba(255, 255, 255, 0.065)'
  ),
  token(
    'library.selection.surface',
    '--te-library-selection-bg',
    '媒体库选中表面',
    'materials',
    'library',
    'color',
    'rgba(15, 23, 42, 0.045)',
    'rgba(255, 255, 255, 0.06)'
  ),
  token(
    'library.selection.hoverSurface',
    '--te-library-selection-hover',
    '媒体库选中悬浮',
    'materials',
    'library',
    'color',
    'rgba(15, 23, 42, 0.07)',
    'rgba(255, 255, 255, 0.09)'
  ),
  token(
    'library.selection.indicator',
    '--te-library-selection-indicator',
    '媒体库选中指示器',
    'colors',
    'library',
    'color',
    'rgba(15, 23, 42, 0.55)',
    'rgba(255, 255, 255, 0.72)'
  ),
  token(
    'library.icon',
    '--te-library-icon',
    '媒体库图标颜色',
    'colors',
    'library',
    'color',
    '#64748b',
    '#b8b8b2'
  ),
  token(
    'library.iconSize',
    '--te-library-icon-size',
    '媒体库图标大小',
    'shape',
    'library',
    'length',
    '18px',
    '18px',
    { min: 14, max: 32, step: 1, unit: 'px' }
  ),
  token(
    'library.selection.radius',
    '--te-library-selection-radius',
    '选中曲目圆角',
    'shape',
    'library-selection',
    'length',
    '10px',
    '10px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'library.selection.inlineInset',
    '--te-library-selection-inline-inset',
    '选中曲目左右边距',
    'shape',
    'library-selection',
    'length',
    '0px',
    '0px',
    { min: 0, max: 18, step: 1, unit: 'px' }
  ),
  token(
    'library.coverRadius',
    '--te-library-cover-radius',
    '媒体库封面圆角',
    'shape',
    'library-cover',
    'length',
    '8px',
    '8px',
    { min: 0, max: 28, step: 1, unit: 'px' }
  ),
  token(
    'library.titleOverlayOpacity',
    '--te-library-title-overlay-opacity',
    '标题区叠层强度',
    'materials',
    'library-header',
    'number',
    '72%',
    '72%',
    { min: 0, max: 100, step: 1, unit: '%' }
  ),
  token(
    'library.actionSurface',
    '--te-library-action-bg',
    '底部操作区背景',
    'materials',
    'library-actions',
    'color',
    'rgba(37, 99, 235, 0.08)',
    'rgba(56, 189, 248, 0.12)'
  ),
  token(
    'library.actionRadius',
    '--te-library-action-radius',
    '底部操作区圆角',
    'shape',
    'library-actions',
    'length',
    '12px',
    '12px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'surface.card',
    '--te-card-bg',
    '卡片背景',
    'materials',
    'card',
    'color',
    '#ffffff',
    '#181818'
  ),
  token(
    'surface.cardBorder',
    '--te-card-border',
    '卡片边框',
    'materials',
    'card',
    'color',
    'rgba(15, 23, 42, 0.08)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'surface.subtle',
    '--te-subtle-bg',
    '次级表面',
    'materials',
    'global',
    'color',
    '#f8fafc',
    '#121212'
  ),
  token(
    'surface.hover',
    '--te-hover-bg',
    '悬浮表面',
    'materials',
    'global',
    'color',
    '#f3f4f6',
    'rgba(255, 255, 255, 0.065)'
  ),
  token(
    'surface.active',
    '--te-active-bg',
    '选中表面',
    'materials',
    'global',
    'color',
    '#e8e8e8',
    'rgba(245, 158, 11, 0.16)'
  ),
  token(
    'material.glass',
    '--te-glass-bg',
    '玻璃表面',
    'materials',
    'global',
    'color',
    'rgba(255, 255, 255, 0.94)',
    'rgba(24, 24, 24, 0.82)'
  ),
  token(
    'material.glassStrong',
    '--te-glass-bg-strong',
    '强化玻璃表面',
    'materials',
    'global',
    'color',
    'rgba(255, 255, 255, 0.98)',
    'rgba(29, 29, 29, 0.94)'
  ),
  token(
    'material.glassBorder',
    '--te-glass-border',
    '玻璃边框',
    'materials',
    'global',
    'color',
    'rgba(15, 23, 42, 0.1)',
    'rgba(255, 255, 255, 0.09)'
  ),
  token(
    'material.glassShadow',
    '--te-glass-shadow',
    '玻璃阴影',
    'materials',
    'global',
    'shadow',
    '0 16px 42px rgba(15, 23, 42, 0.08)',
    '0 18px 54px rgba(0, 0, 0, 0.34)'
  ),
  token(
    'material.surfaceOpacity',
    '--te-surface-opacity',
    '全局表面透明度',
    'materials',
    'global',
    'number',
    '100%',
    '100%',
    {
      min: 40,
      max: 100,
      step: 1,
      unit: '%'
    }
  ),
  token(
    'material.glowMain',
    '--te-glow-main',
    '主色光晕',
    'materials',
    'global',
    'color',
    'rgba(37, 99, 235, 0.12)',
    'rgba(245, 158, 11, 0.18)',
    {
      adaptive: 'cover-accent'
    }
  ),
  token(
    'material.glowSoft',
    '--te-glow-soft',
    '柔和光晕',
    'materials',
    'global',
    'color',
    'rgba(59, 130, 246, 0.08)',
    'rgba(217, 79, 125, 0.12)'
  ),
  token(
    'material.glowCyan',
    '--te-glow-cyan',
    '青色光晕',
    'materials',
    'global',
    'color',
    'rgba(8, 145, 178, 0.08)',
    'rgba(45, 212, 191, 0.1)'
  ),
  token(
    'typography.sans',
    '--te-font-sans',
    '界面字体',
    'typography',
    'global',
    'font',
    lightFont,
    lightFont
  ),
  token(
    'typography.display',
    '--te-font-display',
    '标题字体',
    'typography',
    'global',
    'font',
    lightFont,
    lightFont
  ),
  token(
    'typography.rounded',
    '--te-font-rounded',
    '圆体字体',
    'typography',
    'global',
    'font',
    lightFont,
    lightFont
  ),
  token(
    'typography.titleWeight',
    '--te-text-title',
    '标题字重',
    'typography',
    'global',
    'number',
    '700',
    '700',
    {
      min: 400,
      max: 900,
      step: 100
    }
  ),
  token(
    'typography.bodyWeight',
    '--te-text-body',
    '正文字重',
    'typography',
    'global',
    'number',
    '500',
    '500',
    {
      min: 300,
      max: 700,
      step: 100
    }
  ),
  token(
    'typography.metaWeight',
    '--te-text-meta',
    '辅助字重',
    'typography',
    'global',
    'number',
    '400',
    '400',
    {
      min: 300,
      max: 700,
      step: 100
    }
  ),
  token(
    'typography.bodySize',
    '--te-font-size-body',
    '界面字号',
    'typography',
    'global',
    'length',
    '14px',
    '14px',
    { min: 12, max: 20, step: 1, unit: 'px' }
  ),
  token(
    'typography.chromeText',
    '--te-chrome-text',
    '导航与底栏文字',
    'typography',
    'app-chrome',
    'color',
    '#475569',
    '#d8d8d8'
  ),
  token(
    'shape.cardRadius',
    '--te-card-radius',
    '卡片圆角',
    'shape',
    'card',
    'length',
    '16px',
    '16px',
    {
      min: 0,
      max: 24,
      step: 1,
      unit: 'px'
    }
  ),
  token(
    'shape.globalRadius',
    '--te-radius-global',
    '全局圆角',
    'shape',
    'global',
    'length',
    '10px',
    '10px',
    {
      min: 0,
      max: 24,
      step: 1,
      unit: 'px'
    }
  ),
  token(
    'shape.dialogRadius',
    '--te-dialog-radius',
    '对话框圆角',
    'shape',
    'dialog',
    'length',
    '8px',
    '8px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'shape.searchRadius',
    '--te-search-radius',
    '搜索框圆角',
    'shape',
    'search',
    'length',
    '10px',
    '10px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'shape.toastRadius',
    '--te-toast-radius',
    '提示圆角',
    'shape',
    'toast',
    'length',
    '8px',
    '8px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'shape.trackTitleRadius',
    '--te-track-title-radius',
    '曲目标题背景圆角',
    'shape',
    'track-title',
    'length',
    '6px',
    '6px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'material.trackTitleOpacity',
    '--te-track-title-opacity',
    '曲目标题背景透明度',
    'materials',
    'track-title',
    'number',
    '0%',
    '0%',
    { min: 0, max: 100, step: 1, unit: '%' }
  ),
  token(
    'shape.cardBorderWidth',
    '--te-card-border-width',
    '卡片边框宽度',
    'shape',
    'card',
    'length',
    '1px',
    '1px',
    {
      min: 0,
      max: 3,
      step: 0.5,
      unit: 'px'
    }
  ),
  token(
    'material.cardBlur',
    '--te-card-blur',
    '卡片模糊',
    'materials',
    'card',
    'length',
    '20px',
    '20px',
    {
      min: 0,
      max: 40,
      step: 1,
      unit: 'px'
    }
  ),
  token(
    'material.cardSaturation',
    '--te-card-saturate',
    '卡片饱和度',
    'materials',
    'card',
    'number',
    '150%',
    '150%',
    {
      min: 80,
      max: 180,
      step: 1,
      unit: '%'
    }
  ),
  token(
    'layout.uiScale',
    '--te-ui-scale',
    '界面缩放',
    'layout',
    'global',
    'number',
    '0.94',
    '0.94',
    {
      min: 0.85,
      max: 1.1,
      step: 0.01
    }
  ),
  token(
    'layout.menuWidth',
    '--te-menu-width',
    '侧边栏宽度',
    'layout',
    'sidebar',
    'length',
    'clamp(132px, 18vw, 216px)',
    'clamp(132px, 18vw, 216px)'
  ),
  token(
    'playback.text.page',
    '--te-playback-page-text',
    '播放页正文',
    'playback',
    'player',
    'color',
    '#f4f7fb',
    '#f4f7fb'
  ),
  token(
    'playback.accent',
    '--te-playback-accent',
    '播放强调色',
    'playback',
    'player',
    'color',
    '#7c4dff',
    '#7c4dff',
    { adaptive: 'cover-accent' }
  ),
  token(
    'playback.backdrop.filter',
    '--te-playback-backdrop-filter',
    '封面背景滤镜',
    'playback',
    'player',
    'filter',
    'blur(58px) saturate(1.22) brightness(0.52)',
    'blur(58px) saturate(1.32) brightness(0.36)'
  ),
  token(
    'playback.backdrop.scrim',
    '--te-playback-backdrop-scrim',
    '播放背景遮罩',
    'playback',
    'player',
    'gradient',
    'linear-gradient(180deg, rgba(5, 7, 11, 0.72) 0%, rgba(5, 7, 11, 0.74) 52%, rgba(5, 7, 11, 0.78) 100%)',
    'linear-gradient(180deg, rgba(5, 7, 11, 0.72) 0%, rgba(5, 7, 11, 0.74) 52%, rgba(5, 7, 11, 0.78) 100%)'
  ),
  token(
    'playback.backdrop.highlight',
    '--te-playback-backdrop-highlight',
    '播放背景高光',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.12)',
    'rgba(255, 255, 255, 0.12)'
  ),
  token(
    'playback.backdrop.fluid',
    '--te-playback-fluid-bg',
    '动态背景渐变',
    'playback',
    'player',
    'gradient',
    'linear-gradient(135deg, #0f172a, #1e3a5f, #312e81, #1e3a5f, #0f172a)',
    'linear-gradient(135deg, #0f172a, #1e3a5f, #312e81, #1e3a5f, #0f172a)'
  ),
  token(
    'playback.cover.surface',
    '--te-playback-cover-surface',
    '封面底材',
    'playback',
    'player',
    'color',
    'rgba(15, 23, 42, 0.08)',
    'rgba(15, 23, 42, 0.45)'
  ),
  token(
    'playback.cover.shadow',
    '--te-playback-cover-shadow',
    '封面阴影',
    'playback',
    'player',
    'shadow',
    '0 26px 70px rgba(15, 23, 42, 0.28)',
    '0 26px 70px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.06)'
  ),
  token(
    'playback.cover.radius',
    '--te-playback-cover-radius',
    '封面圆角',
    'playback',
    'player',
    'length',
    '26px',
    '26px',
    { min: 0, max: 40, step: 1, unit: 'px' }
  ),
  token(
    'playback.cover.placeholderText',
    '--te-playback-cover-placeholder-text',
    '空封面图标',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.34)',
    'rgba(148, 163, 184, 0.55)'
  ),
  token(
    'playback.track.title',
    '--te-playback-track-title',
    '曲目标题',
    'playback',
    'player',
    'color',
    '#ffffff',
    '#ffffff'
  ),
  token(
    'playback.track.artist',
    '--te-playback-track-artist',
    '曲目艺人',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.78)',
    'rgba(255, 255, 255, 0.78)'
  ),
  token(
    'playback.track.album',
    '--te-playback-track-album',
    '曲目专辑',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.48)',
    'rgba(255, 255, 255, 0.48)'
  ),
  token(
    'playback.lyrics.text',
    '--te-playback-lyric-text',
    '歌词正文',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.42)',
    'rgba(255, 255, 255, 0.42)'
  ),
  token(
    'playback.lyrics.hoverText',
    '--te-playback-lyric-hover-text',
    '歌词悬浮文字',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.74)',
    'rgba(255, 255, 255, 0.74)'
  ),
  token(
    'playback.lyrics.activeText',
    '--te-playback-lyric-active-text',
    '当前歌词',
    'playback',
    'lyrics',
    'color',
    '#ffffff',
    '#ffffff'
  ),
  token(
    'playback.lyrics.activeSurface',
    '--te-playback-lyric-active-surface',
    '当前歌词表面',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.08)',
    'rgba(255, 255, 255, 0.08)'
  ),
  token(
    'playback.lyrics.activeBorder',
    '--te-playback-lyric-active-border',
    '当前歌词边框',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.1)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'playback.lyrics.activeShadow',
    '--te-playback-lyric-active-shadow',
    '当前歌词阴影',
    'playback',
    'lyrics',
    'shadow',
    '0 14px 28px rgba(0, 0, 0, 0.18)',
    '0 14px 28px rgba(0, 0, 0, 0.18)'
  ),
  token(
    'playback.lyrics.translation',
    '--te-playback-lyric-translation',
    '歌词翻译',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.58)',
    'rgba(255, 255, 255, 0.58)'
  ),
  token(
    'playback.lyrics.translationActive',
    '--te-playback-lyric-translation-active',
    '当前歌词翻译',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.82)',
    'rgba(255, 255, 255, 0.82)'
  ),
  token(
    'playback.lyrics.romanization',
    '--te-playback-lyric-romanization',
    '歌词音译',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.46)',
    'rgba(255, 255, 255, 0.46)'
  ),
  token(
    'playback.lyrics.romanizationActive',
    '--te-playback-lyric-romanization-active',
    '当前歌词音译',
    'playback',
    'lyrics',
    'color',
    'rgba(255, 255, 255, 0.72)',
    'rgba(255, 255, 255, 0.72)'
  ),
  token(
    'playback.control.surface',
    '--te-playback-control-surface',
    '播放控制表面',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.08)',
    'rgba(255, 255, 255, 0.08)'
  ),
  token(
    'playback.control.border',
    '--te-playback-control-border',
    '播放控制边框',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.1)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'playback.control.text',
    '--te-playback-control-text',
    '播放控制图标',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.7)',
    'rgba(255, 255, 255, 0.7)'
  ),
  token(
    'playback.control.hoverSurface',
    '--te-playback-control-hover-surface',
    '播放控制悬浮表面',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.14)',
    'rgba(255, 255, 255, 0.14)'
  ),
  token(
    'playback.control.hoverBorder',
    '--te-playback-control-hover-border',
    '播放控制悬浮边框',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.16)',
    'rgba(255, 255, 255, 0.16)'
  ),
  token(
    'playback.control.hoverText',
    '--te-playback-control-hover-text',
    '播放控制悬浮图标',
    'playback',
    'player',
    'color',
    'rgba(255, 255, 255, 0.92)',
    'rgba(255, 255, 255, 0.92)'
  ),
  token(
    'playback.control.hoverShadow',
    '--te-playback-control-hover-shadow',
    '播放控制悬浮阴影',
    'playback',
    'player',
    'shadow',
    '0 4px 12px rgba(0, 0, 0, 0.18)',
    '0 4px 12px rgba(0, 0, 0, 0.18)'
  ),
  token(
    'playback.cover.size',
    '--te-playback-cover-size',
    '播放页封面尺寸',
    'playback',
    'artwork-player',
    'number',
    '100%',
    '100%',
    { min: 48, max: 100, step: 1, unit: '%' }
  ),
  token(
    'playback.artwork.listRadius',
    '--te-artwork-list-radius',
    '列表封面圆角',
    'playback',
    'artwork-list',
    'length',
    '12px',
    '12px',
    { min: 0, max: 28, step: 1, unit: 'px' }
  ),
  token(
    'playback.control.size',
    '--te-player-control-size',
    '控制按钮大小',
    'playback',
    'player-controls',
    'length',
    '32px',
    '32px',
    { min: 28, max: 48, step: 1, unit: 'px' }
  ),
  token(
    'playback.control.playSize',
    '--te-player-play-size',
    '播放按钮大小',
    'playback',
    'player-controls',
    'length',
    '44px',
    '44px',
    { min: 36, max: 64, step: 1, unit: 'px' }
  ),
  token(
    'playback.control.gap',
    '--te-player-control-gap',
    '控制按钮间距',
    'playback',
    'player-controls',
    'length',
    '12px',
    '12px',
    { min: 4, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'playback.control.radius',
    '--te-player-control-radius',
    '控制按钮圆角',
    'playback',
    'player-controls',
    'length',
    '999px',
    '999px',
    { min: 0, max: 999, step: 1, unit: 'px' }
  ),
  token(
    'playback.control.borderWidth',
    '--te-player-control-border-width',
    '控制按钮描边',
    'playback',
    'player-controls',
    'length',
    '0px',
    '0px',
    { min: 0, max: 4, step: 1, unit: 'px' }
  ),
  token(
    'playback.progress.track',
    '--te-player-progress-track',
    '进度条轨道',
    'playback',
    'player-progress',
    'color',
    'rgba(37, 99, 235, 0.16)',
    'rgba(255, 255, 255, 0.14)'
  ),
  token(
    'playback.progress.fill',
    '--te-player-progress-fill',
    '进度条已播放',
    'playback',
    'player-progress',
    'gradient',
    'linear-gradient(90deg, #2563eb, #0d9488)',
    'linear-gradient(90deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.88))'
  ),
  token(
    'playback.progress.height',
    '--te-player-progress-height',
    '进度条高度',
    'playback',
    'player-progress',
    'length',
    '6px',
    '6px',
    { min: 2, max: 14, step: 1, unit: 'px' }
  ),
  token(
    'playback.progress.radius',
    '--te-player-progress-radius',
    '进度条圆角',
    'playback',
    'player-progress',
    'length',
    '999px',
    '999px',
    { min: 0, max: 999, step: 1, unit: 'px' }
  ),
  token(
    'playback.progress.thumbSize',
    '--te-player-progress-thumb-size',
    '进度滑块大小',
    'playback',
    'player-progress',
    'length',
    '12px',
    '12px',
    { min: 6, max: 22, step: 1, unit: 'px' }
  ),
  token(
    'playback.time.surface',
    '--te-player-time-surface',
    '时长背景',
    'playback',
    'player-time',
    'color',
    'rgba(37, 99, 235, 0.08)',
    'rgba(255, 255, 255, 0.08)'
  ),
  token(
    'playback.time.radius',
    '--te-player-time-radius',
    '时长背景圆角',
    'playback',
    'player-time',
    'length',
    '8px',
    '8px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'playback.time.opacity',
    '--te-player-time-opacity',
    '时长背景透明度',
    'playback',
    'player-time',
    'number',
    '0%',
    '0%',
    { min: 0, max: 100, step: 1, unit: '%' }
  ),
  token(
    'playback.equalizer.panelSurface',
    '--te-equalizer-panel-bg',
    '均衡器面板表面',
    'playback',
    'equalizer-panel',
    'color',
    '#ffffff',
    '#181818'
  ),
  token(
    'playback.equalizer.panelBorder',
    '--te-equalizer-panel-border',
    '均衡器面板边框',
    'playback',
    'equalizer-panel',
    'color',
    'rgba(15, 23, 42, 0.08)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'playback.equalizer.panelRadius',
    '--te-equalizer-panel-radius',
    '均衡器面板圆角',
    'playback',
    'equalizer-panel',
    'length',
    '20px',
    '20px',
    { min: 0, max: 32, step: 1, unit: 'px' }
  ),
  token(
    'playback.equalizer.sliderTrack',
    '--te-equalizer-slider-track',
    '均衡器滑轨',
    'playback',
    'equalizer-slider',
    'color',
    'rgba(15, 23, 42, 0.06)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'playback.equalizer.sliderFill',
    '--te-equalizer-slider-fill',
    '均衡器滑轨填充',
    'playback',
    'equalizer-slider',
    'gradient',
    'linear-gradient(to top, #2563eb, #14b8a6)',
    'linear-gradient(to top, #38bdf8, #a78bfa)'
  ),
  token(
    'playback.equalizer.sliderThumb',
    '--te-equalizer-slider-thumb',
    '均衡器滑块颜色',
    'playback',
    'equalizer-slider',
    'color',
    '#ffffff',
    '#f8fafc'
  ),
  token(
    'playback.equalizer.sliderThumbSize',
    '--te-equalizer-slider-thumb-size',
    '均衡器滑块大小',
    'playback',
    'equalizer-slider',
    'length',
    '20px',
    '20px',
    { min: 12, max: 30, step: 1, unit: 'px' }
  ),
  token(
    'playback.equalizer.grid',
    '--te-equalizer-grid',
    '均衡器辅助线',
    'playback',
    'equalizer-spectrum',
    'color',
    'rgba(15, 23, 42, 0.07)',
    'rgba(255, 255, 255, 0.1)'
  ),
  token(
    'playback.equalizer.guide',
    '--te-equalizer-guide',
    '均衡器频率准线',
    'playback',
    'equalizer-spectrum',
    'color',
    'rgba(37, 99, 235, 0.45)',
    'rgba(56, 189, 248, 0.55)'
  ),
  token(
    'playback.equalizer.spectrum',
    '--te-equalizer-spectrum',
    '均衡器频谱颜色',
    'playback',
    'equalizer-spectrum',
    'color',
    '#2563eb',
    '#38bdf8'
  ),
  token(
    'playback.equalizer.buttonSurface',
    '--te-equalizer-button-bg',
    '均衡器按钮表面',
    'playback',
    'equalizer-controls',
    'color',
    'rgba(37, 99, 235, 0.08)',
    'rgba(56, 189, 248, 0.12)'
  ),
  token(
    'playback.equalizer.buttonRadius',
    '--te-equalizer-button-radius',
    '均衡器按钮圆角',
    'playback',
    'equalizer-controls',
    'length',
    '10px',
    '10px',
    { min: 0, max: 24, step: 1, unit: 'px' }
  ),
  token(
    'playback.equalizer.knobSize',
    '--te-equalizer-knob-size',
    '音量面板旋钮大小',
    'playback',
    'equalizer-controls',
    'length',
    '18px',
    '18px',
    { min: 12, max: 30, step: 1, unit: 'px' }
  ),
  token(
    'motion.enter',
    '--te-ease-enter',
    '进入缓动',
    'motion',
    'global',
    'easing',
    'cubic-bezier(0.4, 0, 0.2, 1)',
    'cubic-bezier(0.4, 0, 0.2, 1)'
  ),
  token(
    'motion.soft',
    '--te-ease-soft',
    '柔和缓动',
    'motion',
    'global',
    'easing',
    'cubic-bezier(0.2, 0.8, 0.2, 1)',
    'cubic-bezier(0.2, 0.8, 0.2, 1)'
  )
])
export function variantFromDefaults(tone: ThemeTone): ThemeVariant {
  return {
    tokens: Object.fromEntries(
      THEME_TOKEN_DEFINITIONS.map((definition) => [definition.id, definition.defaults[tone]])
    )
  }
}
export const TWILIGHT_DEFAULT_THEME: ThemeDocumentV1 = Object.freeze({
  schemaVersion: THEME_DOCUMENT_SCHEMA_VERSION,
  id: TWILIGHT_DEFAULT_THEME_ID,
  name: 'Twilight Echo 默认主题',
  description: '播放器升级前的原始视觉，所有未覆盖令牌均继承这里的值。',
  variants: {
    pureWhite: variantFromDefaults('pureWhite'),
    dark: variantFromDefaults('dark')
  },
  windowDefaults: {
    miniPlayer: {
      surfaceColor: '#11121d',
      accentColor: '#7c4dff',
      primaryTextColor: '#ffffff',
      mutedTextColor: '#b8b7c2',
      fontFamily: lightFont,
      surfaceOpacity: 94,
      glassBlur: 18,
      cornerRadius: 25,
      borderWidth: 1,
      borderColor: '#353542',
      shadowStrength: 80,
      shadowColor: '#000000'
    },
    desktopLyrics: {
      fontFamily: 'system',
      fontSize: 32,
      fontWeight: 700,
      color: '#ffffff',
      highlightColor: '#3b82f6',
      backgroundColor: '#000000',
      backgroundOpacity: 30,
      shadow: true,
      shadowBlur: 8,
      shadowColor: '#000000'
    }
  }
})
