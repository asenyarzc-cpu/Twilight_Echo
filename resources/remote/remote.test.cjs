const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const { runInNewContext } = require('node:vm')

const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
const source = readFileSync(join(__dirname, 'remote.js'), 'utf8')
const css = readFileSync(join(__dirname, 'remote.css'), 'utf8')

class Element {
  constructor(tag = 'div') {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.events = new Map()
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.max = '100'
    this.className = ''
    this.textContent = ''
    this.style = { setProperty() {} }
    this.classList = {
      add: (...names) => {
        this.className = [...new Set([...this.className.split(' '), ...names])].join(' ')
      },
      remove: (...names) => {
        this.className = this.className
          .split(' ')
          .filter((name) => !names.includes(name))
          .join(' ')
      },
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name)
        if (add) this.classList.add(name)
        else this.classList.remove(name)
        return add
      }
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  append(...children) {
    for (const child of children) {
      if (child.tag === 'fragment') this.children.push(...child.children)
      else this.children.push(child)
    }
  }
  replaceChildren(...children) {
    this.children = []
    this.append(...children)
  }
  addEventListener(type, fn) {
    if (!this.events.has(type)) this.events.set(type, [])
    this.events.get(type).push(fn)
  }
  async emit(type, extra = {}) {
    for (const fn of this.events.get(type) || []) await fn({ preventDefault() {}, ...extra })
  }
  querySelectorAll(selector) {
    const found = []
    for (const child of this.children) {
      if (
        selector.startsWith('.')
          ? child.classList.contains(selector.slice(1))
          : child.tag === selector
      )
        found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  focus() {}
  scrollIntoView() {}
}

function harness(options = {}) {
  const nodes = new Map()
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1])
    node.hidden = /\bhidden\b/.test(match[0])
    nodes.set(match[2], node)
  }
  nodes.get('seek').max = '1000'
  for (const id of ['btn-play', 'mini-play', 'btn-mute']) nodes.get(id).append(new Element('use'))
  nodes.get('pair-submit').append(new Element('span'))
  const tabs = ['library', 'playlists', 'queue'].map((view) => {
    const node = new Element('button')
    node.dataset.view = view
    return node
  })
  const mobile = ['player', 'library', 'queue'].map((view) => {
    const node = new Element('button')
    node.dataset.mobile = view
    return node
  })
  const document = new Element('document')
  document.body = new Element('body')
  document.hidden = false
  document.activeElement = null
  document.getElementById = (id) => {
    assert.ok(nodes.has(id), `missing HTML id: ${id}`)
    return nodes.get(id)
  }
  document.querySelectorAll = (selector) => (selector === '[data-view]' ? tabs : mobile)
  document.createElement = (tag) => new Element(tag)
  document.createElementNS = (_ns, tag) => new Element(tag)
  document.createDocumentFragment = () => new Element('fragment')
  const window = new Element('window')
  window.scrollTo = () => {}
  const timers = new Map()
  let timerId = 0
  const events = []
  const requests = []
  const storage = new Map(options.savedToken === false ? [] : [['te_remote_token', 'saved-token']])
  const snapshot = {
    state: 'paused',
    title: '测试曲目',
    artist: '测试歌手',
    album: '测试专辑',
    position: 20,
    duration: 200,
    volume: 0.6,
    muted: false,
    isLive: false,
    queueIndex: 1,
    queueLength: 3,
    queueRevision: 1,
    playMode: 'sequence'
  }
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `opaque-${index}`,
    title: index === 0 ? '<img src=x onerror=alert(1)>' : `曲目 ${index}`,
    artist: '歌手',
    album: '专辑',
    duration: 180,
    index
  }))
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })
  const fetch = async (path, init = {}) => {
    requests.push({ path, ...init })
    if (options.fetch) {
      const custom = await options.fetch(path, init)
      if (custom) return custom
    }
    if (path === '/api/state') return response(200, snapshot)
    if (path === '/api/pair') return response(200, { token: 'new-token' })
    if (path === '/api/command') return response(200, { ok: true })
    if (path.startsWith('/api/browse')) {
      const params = new URLSearchParams(path.split('?')[1])
      return response(200, {
        items: params.get('query') ? [] : items,
        total: params.get('query') ? 0 : items.length,
        offset: 0,
        limit: 40,
        revision: 1
      })
    }
    return response(404, { error: 'not_found' })
  }
  runInNewContext(source, {
    document,
    window,
    fetch,
    URLSearchParams,
    AbortController,
    performance,
    localStorage: {
      getItem: (key) => {
        if (options.blockStorage) throw new Error('blocked')
        return storage.get(key) || null
      },
      setItem: (key, value) => {
        if (options.blockStorage) throw new Error('blocked')
        storage.set(key, value)
      },
      removeItem: (key) => storage.delete(key)
    },
    EventSource: class extends Element {
      constructor(url) {
        super('events')
        this.url = url
        this.closed = false
        events.push(this)
      }
      close() {
        this.closed = true
      }
    },
    setInterval: () => 1,
    setTimeout: (fn, ms) => {
      timers.set(++timerId, { fn, ms })
      return timerId
    },
    clearTimeout: (id) => timers.delete(id)
  })
  return {
    nodes,
    tabs,
    mobile,
    document,
    window,
    events,
    requests,
    storage,
    snapshot,
    items,
    commands: () =>
      requests
        .filter((request) => request.path === '/api/command')
        .map((request) => JSON.parse(request.body)),
    flush: async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    },
    runTimers: async (ms) => {
      for (const [id, timer] of timers)
        if (timer.ms === ms) {
          timers.delete(id)
          await timer.fn()
        }
    }
  }
}

test('remote markup has unique IDs, labeled PIN/sliders/navigation and reduced-motion support', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['pin-input', 'seek', 'volume', 'play-mode', 'search-input'])
    assert.match(html, new RegExp(`for="${id}"`))
  assert.match(html, /pattern="\[0-9\]\{6\}"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(css, /\[hidden\]\s*\{\s*display: none !important/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(/)
})

test('saved token is verified through authenticated state, then browsing requests bounded pages', async () => {
  const h = harness()
  await h.flush()
  assert.equal(h.requests[0].path, '/api/state')
  assert.equal(h.requests[0].headers.authorization, 'Bearer saved-token')
  assert.equal(h.nodes.get('session-panel').hidden, false)
  const browse = h.requests.find((request) => request.path.startsWith('/api/browse'))
  assert.equal(new URLSearchParams(browse.path.split('?')[1]).get('limit'), '40')
  assert.equal(h.nodes.get('track-list').children.length, 3)
  assert.equal(
    h.nodes.get('track-list').querySelector('.track-name').textContent,
    '<img src=x onerror=alert(1)>'
  )
})

test('expired saved token returns to pairing rather than trusting global paired status', async () => {
  const h = harness({
    fetch: async (path) =>
      path === '/api/state'
        ? { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
        : null
  })
  await h.flush()
  assert.equal(h.nodes.get('pair-panel').hidden, false)
  assert.equal(h.nodes.get('session-panel').hidden, true)
  assert.equal(h.storage.has('te_remote_token'), false)
  assert.equal(h.events.length, 0)
})

test('blocked storage does not prevent PIN pairing or in-memory session use', async () => {
  const h = harness({ blockStorage: true })
  h.nodes.get('pin-input').value = '123456'
  await h.nodes.get('pair-form').emit('submit')
  await h.flush()
  assert.equal(h.nodes.get('session-panel').hidden, false)
  assert.equal(
    h.requests.find((request) => request.path === '/api/state').headers.authorization,
    'Bearer new-token'
  )
  assert.match(h.nodes.get('toast').textContent, /未允许保存配对/)
})

test('library play/enqueue commands use opaque ids and queue mutations include displayed revision', async () => {
  const h = harness()
  await h.flush()
  await h.nodes.get('track-list').querySelector('.track-main').emit('click')
  await h.flush()
  assert.deepEqual(h.commands()[0], { action: 'playTrack', id: 'opaque-0' })
  await h.nodes.get('track-list').querySelector('.track-action').emit('click')
  await h.flush()
  assert.deepEqual(h.commands()[1], { action: 'enqueueTrack', id: 'opaque-0' })
  await h.tabs[2].emit('click')
  await h.flush()
  assert.equal(h.nodes.get('track-list').children[1].classList.contains('current'), true)
  await h.nodes.get('track-list').querySelector('.track-main').emit('click')
  await h.flush()
  assert.deepEqual(h.commands()[2], { action: 'jumpQueue', index: 0, revision: 1 })
  await h.nodes.get('track-list').querySelector('.track-action').emit('click')
  await h.flush()
  assert.deepEqual(h.commands()[3], { action: 'removeQueue', index: 0, revision: 1 })
})

test('stale queue is refreshed and explained without replaying the failed command', async () => {
  const h = harness({
    fetch: async (path) =>
      path === '/api/command'
        ? { ok: false, status: 409, json: async () => ({ error: 'queue_changed' }) }
        : null
  })
  await h.flush()
  await h.tabs[2].emit('click')
  await h.flush()
  const requests = h.requests.length
  await h.nodes.get('track-list').querySelector('.track-main').emit('click')
  await h.flush()
  assert.equal(h.commands().length, 1)
  assert.ok(h.requests.slice(requests).some((request) => request.path.startsWith('/api/browse')))
  assert.match(h.nodes.get('toast').textContent, /重新选择/)
})

test('SSE auth revocation closes session, while offline state disables playback', async () => {
  const h = harness()
  await h.flush()
  await h.window.emit('offline')
  assert.equal(h.nodes.get('btn-play').disabled, true)
  await h.nodes.get('btn-play').emit('click')
  assert.equal(h.commands().length, 0)
  const latest = h.events.at(-1)
  await latest.emit('auth')
  assert.equal(h.nodes.get('session-panel').hidden, true)
  assert.equal(latest.closed, true)
})

test('progress drag is not overwritten by incoming snapshots and live streams cannot seek', async () => {
  const h = harness()
  await h.flush()
  h.nodes.get('seek').value = '800'
  await h.nodes.get('seek').emit('input')
  await h.events.at(-1).emit('state', { data: JSON.stringify({ position: 40 }) })
  assert.equal(h.nodes.get('seek').value, '800')
  await h.nodes.get('seek').emit('change')
  await h.flush()
  assert.deepEqual(h.commands()[0], { action: 'seek', positionSeconds: 160 })
  await h.events.at(-1).emit('state', { data: JSON.stringify({ isLive: true }) })
  assert.equal(h.nodes.get('seek').disabled, true)
  await h.nodes.get('seek').emit('change')
  assert.equal(h.commands().length, 1)
})

test('artwork accepts bounded raster data only and never loads host paths or arbitrary URLs', async () => {
  const h = harness()
  await h.flush()
  for (const coverUrl of [
    'file:///private/music/cover.jpg',
    'http://internal-host/secret',
    'data:image/svg+xml;base64,PHN2Zz4='
  ]) {
    await h.events.at(-1).emit('state', { data: JSON.stringify({ coverUrl }) })
    assert.equal(h.nodes.get('cover').hidden, true)
  }
  await h.events
    .at(-1)
    .emit('state', { data: JSON.stringify({ coverUrl: 'data:image/png;base64,YQ==' }) })
  assert.equal(h.nodes.get('cover').src, 'data:image/png;base64,YQ==')
})

test('PIN failures preserve actionable pairing errors instead of showing session-expired text', async () => {
  for (const code of ['invalid_pin', 'too_many_pair_attempts']) {
    const h = harness({
      savedToken: false,
      fetch: async (path) =>
        path === '/api/pair'
          ? { ok: false, status: 401, json: async () => ({ error: code }) }
          : null
    })
    h.nodes.get('pin-input').value = '123456'
    await h.nodes.get('pair-form').emit('submit')
    assert.match(
      h.nodes.get('pair-error').textContent,
      code === 'invalid_pin' ? /PIN 不正确/ : /尝试过于频繁/
    )
    assert.equal(h.nodes.get('pair-submit').disabled, false)
  }
})

test('an older browse response cannot overwrite a newer view', async () => {
  let resolveOld
  const h = harness({
    fetch: async (path) =>
      path.startsWith('/api/browse?view=library')
        ? new Promise((resolve) => {
            resolveOld = resolve
          })
        : null
  })
  await h.flush()
  await h.tabs[2].emit('click')
  await h.flush()
  assert.equal(h.nodes.get('list-label').textContent, '播放队列')
  resolveOld({ ok: true, status: 200, json: async () => ({ items: [], total: 0 }) })
  await h.flush()
  assert.equal(h.nodes.get('list-label').textContent, '播放队列')
  assert.equal(h.nodes.get('track-list').children.length, 3)
})

test('disconnect resets mobile navigation and does not retain private list metadata', async () => {
  const h = harness()
  await h.flush()
  await h.mobile[2].emit('click')
  await h.flush()
  await h.nodes.get('btn-disconnect').emit('click')
  assert.equal(h.mobile[0].attributes['aria-current'], 'page')
  assert.equal(h.nodes.get('track-list').children.length, 0)
  assert.equal(h.nodes.get('session-panel').hidden, true)
})

test('search is debounced, empty state is useful, and mobile library retains player controls', async () => {
  const h = harness()
  await h.flush()
  const count = h.requests.length
  h.nodes.get('search-input').value = 'missing'
  await h.nodes.get('search-input').emit('input')
  assert.equal(h.requests.length, count)
  await h.runTimers(250)
  await h.flush()
  assert.equal(h.nodes.get('list-empty').hidden, false)
  assert.match(h.nodes.get('empty-description').textContent, /关键词/)
  await h.mobile[1].emit('click')
  await h.flush()
  assert.equal(h.document.body.classList.contains('mobile-browser'), true)
  assert.equal(h.nodes.get('mini-player').hidden, false)
  await h.nodes.get('mini-open').emit('click')
  assert.equal(h.document.body.classList.contains('mobile-browser'), false)
})

test('malformed queue revisions fail closed without rendering mutation controls', async () => {
  for (const revision of ['1', -1, 1.5, null]) {
    const h = harness({
      fetch: async (path) =>
        path.startsWith('/api/browse?view=queue')
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                items: [{ id: 'id', title: 'Song', index: 0 }],
                total: 1,
                revision
              })
            }
          : null
    })
    await h.flush()
    await h.tabs[2].emit('click')
    await h.flush()
    assert.equal(h.nodes.get('track-list').children.length, 0)
    assert.equal(h.nodes.get('browse-error').hidden, false)
  }
})
