import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearCachedThemeRuntime,
  injectCachedThemeRuntime,
  persistThemeRuntimeCache,
  themeRuntimeCacheStorageKey
} from './themeRuntimeCache.ts'

class FakeStyle {
  colorScheme = ''
}

class FakeElement {
  id = ''
  textContent = ''
  dataset: Record<string, string> = {}
  style = new FakeStyle()
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
}

function createDocument(): {
  documentElement: FakeElement
  head: { appendChild: (element: FakeElement) => void }
  createElement: () => FakeElement
  getElementById: (id: string) => FakeElement | null
} {
  const elements = new Map<string, FakeElement>()
  return {
    documentElement: new FakeElement(),
    head: {
      appendChild: (element) => {
        elements.set(element.id, element)
      }
    },
    createElement: () => new FakeElement(),
    getElementById: (id) => elements.get(id) ?? null
  }
}

test('persists and synchronously injects a bounded theme runtime cache', () => {
  const storage = new Map<string, string>()
  const originalDocument = globalThis.document
  const originalStorage = globalThis.localStorage
  const fakeDocument = createDocument()
  try {
    Object.assign(globalThis, {
      document: fakeDocument,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    })
    persistThemeRuntimeCache({
      css: ':root { --te-app-bg: #123456; }',
      attributes: { 'data-te-shell-layout': 'classic' },
      activeTheme: 'builtin:twilight-echo-default',
      tone: 'dark'
    })
    assert.equal(typeof storage.get(themeRuntimeCacheStorageKey), 'string')
    assert.equal(injectCachedThemeRuntime(), true)
    assert.equal(
      fakeDocument.getElementById('twilight-theme-runtime')?.textContent,
      ':root { --te-app-bg: #123456; }'
    )
    assert.equal(fakeDocument.documentElement.dataset.theme, 'dark')
    assert.equal(fakeDocument.documentElement.getAttribute('data-te-shell-layout'), 'classic')
    assert.equal(fakeDocument.documentElement.getAttribute('data-theme-cached'), 'true')
  } finally {
    Object.assign(globalThis, { document: originalDocument, localStorage: originalStorage })
  }
})

test('rejects malformed and expired theme runtime caches', () => {
  const storage = new Map<string, string>()
  const originalDocument = globalThis.document
  const originalStorage = globalThis.localStorage
  try {
    Object.assign(globalThis, {
      document: createDocument(),
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    })
    storage.set(themeRuntimeCacheStorageKey, '{invalid')
    assert.equal(injectCachedThemeRuntime(), false)
    storage.set(
      themeRuntimeCacheStorageKey,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 0,
        css: '',
        attributes: {},
        theme: 'builtin:twilight-echo-default',
        tone: 'dark'
      })
    )
    assert.equal(injectCachedThemeRuntime(), false)
    clearCachedThemeRuntime()
    assert.equal(storage.has(themeRuntimeCacheStorageKey), false)
  } finally {
    Object.assign(globalThis, { document: originalDocument, localStorage: originalStorage })
  }
})
