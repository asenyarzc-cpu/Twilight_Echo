import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeContributionId,
  normalizeText,
  normalizeThemeContribution,
  normalizeUiContribution
} from './themeContribution.ts'

test('normalizes UI contributions as command-only for ui and tool plugins', () => {
  const contribution = normalizeUiContribution(['tool', 'ui'], ['ui:inject'], {
    id: ' player-actions ',
    kind: 'playerBarButton',
    title: ' Player Actions ',
    description: '  Opens actions  ',
    icon: ' pi pi-play ',
    command: 'playerActions',
    renderMode: 'html',
    autoLoad: true
  })

  assert.deepEqual(contribution, {
    id: 'player-actions',
    kind: 'playerBarButton',
    title: 'Player Actions',
    description: 'Opens actions',
    icon: 'pi pi-play',
    command: 'playerActions',
    renderMode: 'command',
    autoLoad: true
  })
  assert.throws(
    () => normalizeUiContribution(['theme'], ['ui:inject'], { id: 'x', kind: 'settingsPanel' }),
    /只有 ui 或 tool/
  )
  assert.throws(
    () => normalizeUiContribution(['ui'], [], { id: 'x', kind: 'settingsPanel' }),
    /ui:inject/
  )
  assert.throws(
    () => normalizeUiContribution(['ui'], ['ui:inject'], { id: 'x', kind: 'unknown' }),
    /未知 UI 扩展点/
  )
})

test('normalizes contribution ids and bounded text labels', () => {
  assert.equal(normalizeContributionId(' my-contribution '), 'my-contribution')
  assert.throws(() => normalizeContributionId('Bad Id'), /小写标识符/)
  assert.equal(normalizeText('  short  ', 'required'), 'short')
  assert.equal(normalizeText('x'.repeat(200), 'required').length, 120)
  assert.throws(() => normalizeText('   ', 'required'), /required/)
})

test('plugin API v1 keeps legacy variables, stylesheet, and structured themes', () => {
  const contribution = normalizeThemeContribution({
    pluginApiVersion: 1,
    pluginTypes: ['theme'],
    source: 'manifest theme',
    resolveStylesheet: (stylesheet) => `C:/plugin/${stylesheet}`,
    raw: {
      id: 'legacy',
      name: 'Legacy',
      variables: { '--te-primary-500': '#2563eb' },
      stylesheet: 'theme.css',
      structured: {
        schemaVersion: 1,
        variants: { dark: { tokens: { 'color.primary.500': '#60a5fa' } } }
      }
    }
  })

  assert.equal(contribution.stylesheet, 'C:/plugin/theme.css')
  assert.equal(contribution.structured?.schemaVersion, 1)
  assert.deepEqual(contribution.variables, { '--te-primary-500': '#2563eb' })
  assert.equal(contribution.compatibilityNotes, undefined)
})

test('structured theme v2 requires plugin API v2 and filters unknown host modes', () => {
  const raw = {
    id: 'mode-theme',
    name: 'Mode Theme',
    structured: {
      schemaVersion: 2,
      variants: {},
      modes: {
        navigation: { style: 'rail', futureStyle: 'floating' },
        player: { layout: 'cinema', controls: 'pro' },
        visibility: { playerDuration: false, futureControl: false },
        futureDomain: { value: 'future' }
      }
    }
  }

  assert.throws(
    () =>
      normalizeThemeContribution({
        pluginApiVersion: 1,
        pluginTypes: ['theme'],
        source: 'manifest theme',
        resolveStylesheet: (stylesheet) => stylesheet,
        raw
      }),
    /apiVersion 2/
  )

  const contribution = normalizeThemeContribution({
    pluginApiVersion: 2,
    pluginTypes: ['theme'],
    source: 'manifest theme',
    resolveStylesheet: (stylesheet) => stylesheet,
    raw
  })
  assert.deepEqual(contribution.structured, {
    schemaVersion: 2,
    variants: {},
    modes: {
      navigation: { style: 'rail' },
      player: { controls: 'pro' },
      visibility: { playerDuration: false }
    }
  })
  assert.deepEqual(contribution.compatibilityNotes, [
    '主题 mode navigation.futureStyle 不受当前宿主支持，已忽略',
    '主题 mode player.layout 不受当前宿主支持，已忽略',
    '主题 mode visibility.futureControl 不受当前宿主支持，已忽略',
    '主题 mode futureDomain 不受当前宿主支持，已忽略'
  ])
})

test('schema v1 modes are ignored with a compatibility note', () => {
  const contribution = normalizeThemeContribution({
    pluginApiVersion: 2,
    pluginTypes: ['theme'],
    source: 'manifest theme',
    resolveStylesheet: (stylesheet) => stylesheet,
    raw: {
      id: 'mixed-version',
      name: 'Mixed Version',
      variables: { '--te-primary-500': '#2563eb' },
      structured: { schemaVersion: 1, variants: {}, modes: { navigation: { style: 'rail' } } }
    }
  })

  assert.deepEqual(contribution.compatibilityNotes, [
    'structured schemaVersion 1 不支持 modes，已忽略该字段'
  ])
})

test('structured theme v3 accepts a declarative host shell layout only for plugin API v3', () => {
  const raw = {
    id: 'shell-theme',
    name: 'Shell Theme',
    structured: {
      schemaVersion: 3,
      variants: {},
      layout: {
        desktop: {
          columns: ['standard', 'fill'],
          rows: ['auto', 'fill', 'auto'],
          areas: [
            ['titleBar', 'titleBar'],
            ['navigation', 'content'],
            ['navigation', 'playerBar']
          ]
        },
        navigation: 'persistent'
      }
    }
  }

  assert.throws(
    () =>
      normalizeThemeContribution({
        pluginApiVersion: 2,
        pluginTypes: ['theme'],
        source: 'manifest theme',
        resolveStylesheet: (stylesheet) => stylesheet,
        raw
      }),
    /apiVersion 3/
  )

  const contribution = normalizeThemeContribution({
    pluginApiVersion: 3,
    pluginTypes: ['theme'],
    source: 'manifest theme',
    resolveStylesheet: (stylesheet) => stylesheet,
    raw
  })
  assert.equal(contribution.structured?.schemaVersion, 3)
  assert.equal(
    contribution.structured?.schemaVersion === 3
      ? contribution.structured.layout?.navigation
      : undefined,
    'persistent'
  )
})
