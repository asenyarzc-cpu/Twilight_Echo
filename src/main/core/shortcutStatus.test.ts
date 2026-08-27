import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlayerShortcutStatuses } from './shortcutStatus.ts'

const shortcuts = [
  { accelerator: 'CommandOrControl+Alt+Left', action: 'previous', label: '上一首' },
  { accelerator: 'CommandOrControl+Alt+Right', action: 'next', label: '下一首' },
  { accelerator: 'CommandOrControl+Alt+Space', action: 'playPause', label: '播放 / 暂停' }
]

test('builds disabled shortcut status without trying to register accelerators', () => {
  let registerCalls = 0
  const statuses = buildPlayerShortcutStatuses(shortcuts, false, () => {
    registerCalls += 1
    return true
  })

  assert.equal(registerCalls, 0)
  assert.equal(statuses.length, shortcuts.length)
  assert.equal(
    statuses.every((status) => !status.registered && status.error === null),
    true
  )
})

test('records registered and failed shortcut accelerators', () => {
  const statuses = buildPlayerShortcutStatuses(
    shortcuts,
    true,
    (accelerator) => accelerator !== 'CommandOrControl+Alt+Right'
  )

  assert.equal(statuses.find((status) => status.action === 'previous')?.registered, true)
  const failed = statuses.find((status) => status.action === 'next')
  assert.equal(failed?.registered, false)
  assert.match(failed?.error ?? '', /占用|冲突|失败/)
})
