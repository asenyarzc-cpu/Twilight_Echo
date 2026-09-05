import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PlaybackSettingsSection.vue', import.meta.url), 'utf8')

test('playback diagnostics expose the active PCM provider implementation', () => {
  assert.match(
    source,
    /const outputProviderImplementation = computed\(\s*\(\) => outputInfo\.value\?\.providerImplementation \?\? ''\s*\)/
  )
  assert.match(
    source,
    /<span v-if="outputProviderImplementation">[\s\S]*Provider \{\{ outputProviderImplementation \}\}/
  )
})
