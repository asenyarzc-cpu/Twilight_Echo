export type ThemeTone = 'pureWhite' | 'dark'

export interface ThemePaletteEntry {
  id: string
  label: string
  value: string
}

export interface BuiltInThemeFont {
  id: string
  label: string
  category: 'system' | 'sans' | 'serif' | 'mono' | 'display'
  value: string
}

export const lightFont =
  "'Inter', 'Plus Jakarta Sans', 'MiSans', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

export const BUILT_IN_THEME_FONTS: readonly BuiltInThemeFont[] = Object.freeze([
  { id: 'system', label: '系统与 MiSans', category: 'system', value: lightFont },
  {
    id: 'inter',
    label: 'Inter',
    category: 'sans',
    value: "'Inter', 'MiSans', 'Microsoft YaHei UI', system-ui, sans-serif"
  },
  {
    id: 'jakarta',
    label: 'Plus Jakarta Sans',
    category: 'sans',
    value: "'Plus Jakarta Sans', 'MiSans', 'Microsoft YaHei UI', system-ui, sans-serif"
  },
  {
    id: 'lora',
    label: 'Lora Serif',
    category: 'serif',
    value: "'Lora', 'MiSans', 'Microsoft YaHei UI', Georgia, serif"
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    category: 'mono',
    value: "'JetBrains Mono', 'MiSans', Consolas, monospace"
  },
  {
    id: 'space',
    label: 'Space Grotesk',
    category: 'display',
    value: "'Space Grotesk', 'MiSans', 'Microsoft YaHei UI', system-ui, sans-serif"
  }
])

export const THEME_ACCENT_PALETTES: Readonly<Record<ThemeTone, readonly ThemePaletteEntry[]>> =
  Object.freeze({
    pureWhite: Object.freeze([
      { id: 'blue', label: '湖蓝', value: '#2563eb' },
      { id: 'indigo', label: '靛青', value: '#4f46e5' },
      { id: 'violet', label: '紫罗兰', value: '#7c3aed' },
      { id: 'fuchsia', label: '品红', value: '#c026d3' },
      { id: 'rose', label: '玫瑰', value: '#e11d48' },
      { id: 'red', label: '朱红', value: '#dc2626' },
      { id: 'orange', label: '橙色', value: '#ea580c' },
      { id: 'amber', label: '琥珀', value: '#d97706' },
      { id: 'lime', label: '青柠', value: '#65a30d' },
      { id: 'green', label: '翠绿', value: '#16a34a' },
      { id: 'emerald', label: '祖母绿', value: '#059669' },
      { id: 'teal', label: '蓝绿', value: '#0d9488' },
      { id: 'cyan', label: '青色', value: '#0891b2' },
      { id: 'sky', label: '天蓝', value: '#0284c7' },
      { id: 'slate', label: '石板', value: '#475569' },
      { id: 'graphite', label: '石墨', value: '#374151' }
    ]),
    dark: Object.freeze([
      { id: 'amber', label: '琥珀', value: '#f59e0b' },
      { id: 'gold', label: '金色', value: '#eab308' },
      { id: 'orange', label: '橙色', value: '#fb923c' },
      { id: 'coral', label: '珊瑚', value: '#fb7185' },
      { id: 'rose', label: '玫瑰', value: '#f43f5e' },
      { id: 'pink', label: '粉色', value: '#ec4899' },
      { id: 'fuchsia', label: '品红', value: '#d946ef' },
      { id: 'violet', label: '紫罗兰', value: '#a78bfa' },
      { id: 'indigo', label: '靛青', value: '#818cf8' },
      { id: 'blue', label: '亮蓝', value: '#60a5fa' },
      { id: 'sky', label: '天蓝', value: '#38bdf8' },
      { id: 'cyan', label: '青色', value: '#22d3ee' },
      { id: 'teal', label: '蓝绿', value: '#2dd4bf' },
      { id: 'emerald', label: '祖母绿', value: '#34d399' },
      { id: 'green', label: '翠绿', value: '#4ade80' },
      { id: 'lime', label: '青柠', value: '#a3e635' }
    ])
  })

export const THEME_BACKGROUND_PALETTES: Readonly<Record<ThemeTone, readonly ThemePaletteEntry[]>> =
  Object.freeze({
    pureWhite: Object.freeze([
      { id: 'paper', label: '纸白', value: '#f4f4f7' },
      { id: 'snow', label: '雪白', value: '#f8fafc' },
      { id: 'mist', label: '雾灰', value: '#f1f5f9' },
      { id: 'blue-mist', label: '蓝雾', value: '#eff6ff' },
      { id: 'indigo-mist', label: '靛雾', value: '#eef2ff' },
      { id: 'violet-mist', label: '紫雾', value: '#f5f3ff' },
      { id: 'rose-mist', label: '玫瑰雾', value: '#fff1f2' },
      { id: 'amber-mist', label: '暖雾', value: '#fffbeb' },
      { id: 'green-mist', label: '绿雾', value: '#f0fdf4' },
      { id: 'teal-mist', label: '青雾', value: '#f0fdfa' },
      { id: 'cyan-mist', label: '天青雾', value: '#ecfeff' },
      { id: 'warm-gray', label: '暖灰', value: '#fafaf9' },
      { id: 'pearl', label: '珍珠', value: '#f5f5f4' },
      { id: 'lavender', label: '薰衣草', value: '#faf5ff' },
      { id: 'blush', label: '浅绯', value: '#fdf2f8' },
      { id: 'mint', label: '薄荷', value: '#ecfdf5' }
    ]),
    dark: Object.freeze([
      { id: 'charcoal', label: '炭黑', value: '#17181a' },
      { id: 'ink', label: '墨黑', value: '#111214' },
      { id: 'black', label: '纯黑', value: '#09090b' },
      { id: 'slate', label: '深石板', value: '#0f172a' },
      { id: 'navy', label: '深海', value: '#111827' },
      { id: 'indigo', label: '夜靛', value: '#17172a' },
      { id: 'violet', label: '夜紫', value: '#1d1728' },
      { id: 'plum', label: '暗梅', value: '#24161f' },
      { id: 'wine', label: '酒红', value: '#281719' },
      { id: 'umber', label: '暗褐', value: '#241c16' },
      { id: 'olive', label: '暗橄榄', value: '#1d2117' },
      { id: 'forest', label: '暗林', value: '#14211a' },
      { id: 'teal', label: '暗青', value: '#122322' },
      { id: 'cyan', label: '暗天青', value: '#102129' },
      { id: 'steel', label: '钢蓝', value: '#17202a' },
      { id: 'graphite', label: '石墨', value: '#1c1c1f' }
    ])
  })
