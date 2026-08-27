import assert from 'node:assert/strict'
import test from 'node:test'

const { planPluginStartup } = (await import(
  new URL('./dependencies.ts', import.meta.url).href
)) as typeof import('./dependencies')

type TestPlugin = {
  id: string
  name: string
  version: string
  enabled: boolean
  status: 'installed' | 'enabled' | 'disabled' | 'invalid' | 'failed'
  dependencies?: Record<string, string>
}

function plugin(id: string, patch: Partial<TestPlugin> = {}): TestPlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    enabled: true,
    status: 'enabled',
    ...patch
  }
}

test('orders enabled plugins by dependencies', () => {
  const plan = planPluginStartup([
    plugin('com.example.feature', {
      dependencies: {
        'com.example.base': '>=1.0.0'
      }
    }),
    plugin('com.example.base')
  ])

  assert.deepEqual(
    plan.ordered.map((entry) => entry.id),
    ['com.example.base', 'com.example.feature']
  )
  assert.equal(plan.failures.size, 0)
})

test('fails plugins with missing, disabled, or incompatible dependencies', () => {
  const plan = planPluginStartup([
    plugin('com.example.missing', {
      dependencies: { 'com.example.none': '>=1.0.0' }
    }),
    plugin('com.example.disabled-consumer', {
      dependencies: { 'com.example.disabled': '*' }
    }),
    plugin('com.example.disabled', { enabled: false, status: 'disabled' }),
    plugin('com.example.incompatible-consumer', {
      dependencies: { 'com.example.old': '>=2.0.0' }
    }),
    plugin('com.example.old', { version: '1.0.0' })
  ])

  assert.match(plan.failures.get('com.example.missing') ?? '', /缺少依赖插件/)
  assert.match(plan.failures.get('com.example.disabled-consumer') ?? '', /未启用/)
  assert.match(plan.failures.get('com.example.incompatible-consumer') ?? '', /不满足/)
  assert.deepEqual(
    plan.ordered.map((entry) => entry.id),
    ['com.example.old']
  )
})

test('fails cyclic plugin dependencies and dependents', () => {
  const plan = planPluginStartup([
    plugin('com.example.a', { dependencies: { 'com.example.b': '*' } }),
    plugin('com.example.b', { dependencies: { 'com.example.a': '*' } }),
    plugin('com.example.c', { dependencies: { 'com.example.a': '*' } })
  ])

  assert.match(plan.failures.get('com.example.a') ?? '', /循环/)
  assert.match(plan.failures.get('com.example.b') ?? '', /循环/)
  assert.match(plan.failures.get('com.example.c') ?? '', /启动条件失败/)
  assert.deepEqual(plan.ordered, [])
})
