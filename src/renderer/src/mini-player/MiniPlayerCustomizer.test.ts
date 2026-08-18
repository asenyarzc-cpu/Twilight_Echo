import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./MiniPlayerCustomizer.vue', import.meta.url), 'utf8')
const customizerStyles = readFileSync(
  new URL('./MiniPlayerCustomizer.css', import.meta.url),
  'utf8'
)
const settingsSection = readFileSync(
  new URL('../components/settings-page/MiniPlayerSettingsSection.vue', import.meta.url),
  'utf8'
)
const settingsPage = readFileSync(
  new URL('../components/SettingsPage.vue', import.meta.url),
  'utf8'
)
const settingsAppearance = readFileSync(
  new URL('../components/settings-page/AppearanceSettingsSection.vue', import.meta.url),
  'utf8'
)
const settingsSurfaces = [settingsPage, settingsAppearance].join('\n')
const settingsStore = readFileSync(
  new URL('../stores/useSettingsStore.ts', import.meta.url),
  'utf8'
)

test('mini player customizer exposes four controlled tabs and no global api calls', () => {
  for (const tab of ['theme', 'background', 'appearance', 'layout']) {
    assert.match(source, new RegExp(`'${tab}'`))
  }
  assert.doesNotMatch(source, /window\.api/)
  assert.match(source, /pickBackgroundImage/)
  assert.match(source, /update:settings/)
})

test('mini player customizer includes every approved control family', () => {
  for (const field of [
    'kind',
    'solidColor',
    'gradientStart',
    'gradientEnd',
    'gradientAngle',
    'imageFit',
    'blur',
    'brightness',
    'saturation',
    'opacity',
    'overlayColor',
    'overlayOpacity',
    'accentMode',
    'accentColor',
    'textMode',
    'primaryTextColor',
    'mutedTextColor',
    'surfaceOpacity',
    'glassBlur',
    'cornerRadius',
    'borderWidth',
    'borderColor',
    'shadowStrength',
    'preference'
  ]) {
    assert.match(source, new RegExp(field))
  }
  assert.doesNotMatch(source, /playbackState/)
})

test('mini player customizer uses semantic controls and automatic persistence actions', () => {
  assert.match(source, /type="color"/)
  assert.match(source, /type="range"/)
  assert.match(source, /type="checkbox"/)
  assert.match(source, /@change="emit\('flush'\)"/)
  assert.match(source, /@click="emit\('undo'\)"/)
  assert.match(source, /@click="emit\('reset'\)"/)
  assert.doesNotMatch(source, />\s*应用\s*</)
})

test('overlay customizer uses the active mini player surface family for readable contrast', () => {
  const overlayRule =
    customizerStyles.match(/\.mini-customizer\.is-overlay\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(overlayRule, /--customizer-panel:[^;]*var\(--mini-background-fallback\)/)
})

test('main settings reuses the controlled mini player customizer', () => {
  assert.match(settingsSection, /MiniPlayerCustomizer/)
  assert.match(settingsSection, /useMiniPlayerCustomizationDraft/)
  assert.match(settingsSection, /chooseBackgroundImage/)
  assert.match(settingsSurfaces, /MiniPlayerSettingsSection/)
  assert.match(
    settingsStore,
    /hasOwnProperty\.call\(patch, 'miniPlayer'\)[\s\S]*cloneMiniPlayerSettings\(patch\.miniPlayer\)/
  )
  assert.match(settingsStore, /from '\.\.\/\.\.\/\.\.\/shared\/miniPlayer\.ts'/)
})
