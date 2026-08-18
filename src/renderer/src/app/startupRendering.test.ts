import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')

test('startup defers NCM login and loads PlayerBar asynchronously', () => {
  assert.match(
    app,
    /const PlayerBar = defineAsyncComponent\(\(\) => import\('\.\/components\/PlayerBar\.vue'\)\)/
  )
  assert.match(app, /idleLoginCheck = scheduleIdleTask\(\(\) => \{[\s\S]*void checkLogin\(\)/)
  assert.doesNotMatch(app, /if \(loadedSettings\.autoCheckLogin\) \{\s*void checkLogin\(\)/)
  assert.match(app, /idleLoginCheck\?\.cancel\(\)/)
})

test('startup begins the aggregate snapshot before loading App', () => {
  assert.match(main, /beginStartupSnapshot\(\)/)
  assert.match(main, /import\('\.\/App\.vue'\)/)
  assert.match(main, /if \(isMiniPlayer\) await bootstrapThemeRuntime\(\)/)
})
