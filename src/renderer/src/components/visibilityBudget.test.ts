import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('hidden documents pause iframe animation frames and QR polling', () => {
  const iframe = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )
  const visibilityController = readFileSync(
    new URL(
      '../../../../resources/audio-visualizer/visibility-animation-controller.js',
      import.meta.url
    ),
    'utf8'
  )
  const login = readFileSync(new URL('./LoginPage.vue', import.meta.url), 'utf8')
  assert.match(iframe, /<script src="\.\/visibility-animation-controller\.js"><\/script>/)
  assert.match(visibilityController, /if \(isHidden\(\)\) stop\(\)\s*else resume\(\)/)
  assert.match(
    iframe,
    /window\.createVisibilityAnimationController\(\s*\(\) => document\.hidden,\s*\(\) => \{\s*stopSpectrumLoop\(\);?\s*stopPlayheadLoop\(\);?\s*\},\s*\(\) => \{\s*if \(isPlaying\) \{\s*startSpectrumLoop\(\);?\s*startPlayheadLoop\(\);?\s*\}\s*\}\s*\)/
  )
  assert.match(
    iframe,
    /document\.addEventListener\('visibilitychange', \(\) =>\s*visibilityAnimationController\.onVisibilityChange\(\)\s*\)/
  )
  assert.match(login, /if \(document\.hidden\) return/)
  assert.match(
    login,
    /document\.addEventListener\('visibilitychange', onDocumentVisibilityChange\)/
  )
})
