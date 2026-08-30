const PLUGIN_HOST_EXIT_ERROR_PREFIX = '插件宿主进程退出：'
const RECOVERABLE_STARTUP_ERRORS = new Set(['Invalid value for env'])

export function isRecoverableBundledPluginFailure(lastError: string | undefined): boolean {
  return (
    typeof lastError === 'string' &&
    (lastError.startsWith(PLUGIN_HOST_EXIT_ERROR_PREFIX) ||
      RECOVERABLE_STARTUP_ERRORS.has(lastError))
  )
}
