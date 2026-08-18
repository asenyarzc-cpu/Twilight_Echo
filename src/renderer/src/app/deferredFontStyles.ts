export function activateDeferredFontStyles(): void {
  for (const preload of document.querySelectorAll<HTMLLinkElement>('link[data-deferred-font]')) {
    if (preload.dataset.activated === 'true') continue
    const stylesheet = document.createElement('link')
    stylesheet.rel = 'stylesheet'
    stylesheet.href = preload.href
    stylesheet.dataset.deferredFontStylesheet = 'true'
    preload.dataset.activated = 'true'
    document.head.appendChild(stylesheet)
  }
}
