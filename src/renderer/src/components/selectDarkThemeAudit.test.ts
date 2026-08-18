import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

test('all native select controls inherit an explicit dark popup and field palette', () => {
  const root = resolve(import.meta.dirname)
  const consumers = vueFiles(root).filter((path) => readFileSync(path, 'utf8').includes('<select'))
  const baseCss = readFileSync(join(root, '../assets/base.css'), 'utf8')

  assert.ok(consumers.length >= 8, 'audit must cover every select-owning renderer component')
  assert.match(
    baseCss,
    /html\[data-theme='dark'\] select\s*\{[\s\S]*color-scheme:\s*dark;[\s\S]*background-color:\s*var\(--te-settings-control-bg\) !important;[\s\S]*color:\s*var\(--te-settings-text\) !important/
  )
  assert.match(
    baseCss,
    /html\[data-theme='dark'\] select option\s*\{[\s\S]*background-color:\s*var\(--te-settings-control-bg\) !important;[\s\S]*color:\s*var\(--te-settings-text\) !important/
  )
})

test('the lyric font combobox themes its own popup instead of inheriting the select rules', () => {
  // This control replaced a native <select> so it could render each family in its
  // own face. That puts its popup outside the base.css select palette above, so
  // it has to carry tokenized colours itself or it would go unstyled in dark mode.
  const source = readFileSync(new URL('./LyricsAppearanceCustomizer.vue', import.meta.url), 'utf8')
  const menu = source.match(/\.font-menu \{[\s\S]*?\n\}/)?.[0] ?? ''
  const option = source.match(/\.font-option \{[\s\S]*?\n\}/)?.[0] ?? ''

  assert.match(menu, /background:\s*var\(--te-settings-bg\)/)
  assert.match(menu, /border:\s*1px solid var\(--te-card-border\)/)
  assert.match(option, /color:\s*var\(--te-neutral-900\)/)
})

test('Playbar lyric source selects use the deck palette for both field and popup', () => {
  const source = readFileSync(new URL('./player-bar/HiFiSidebar.css', import.meta.url), 'utf8')
  const selector = source.match(/\.deck-lyric-source-controls select \{[\s\S]*?\n\}/)?.[0] ?? ''

  assert.match(selector, /background:\s*var\(--d-well\)/)
  assert.match(selector, /color:\s*var\(--d-ink\)/)
  assert.match(
    source,
    /\.deck-lyric-source-controls select option \{[\s\S]*background:\s*var\(--d-card\)[\s\S]*color:\s*var\(--d-ink\)/
  )
})
