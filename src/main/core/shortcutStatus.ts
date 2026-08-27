export interface PlayerShortcutDefinition<Action extends string = string> {
  accelerator: string
  action: Action
  label: string
}

export function buildPlayerShortcutStatuses<Action extends string>(
  shortcuts: Array<PlayerShortcutDefinition<Action>>,
  enabled: boolean,
  register: (accelerator: string) => boolean
): Array<PlayerShortcutDefinition<Action> & { registered: boolean; error: string | null }> {
  return shortcuts.map((shortcut) => {
    if (!enabled) {
      return {
        ...shortcut,
        registered: false,
        error: null
      }
    }

    const registered = register(shortcut.accelerator)
    return {
      ...shortcut,
      registered,
      error: registered
        ? null
        : `快捷键注册失败，可能已被系统或其他应用占用：${shortcut.accelerator}`
    }
  })
}
