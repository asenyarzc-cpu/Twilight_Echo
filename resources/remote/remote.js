;(() => {
  const TOKEN_KEY = 'te_remote_token'
  const PAGE_SIZE = 40
  const $ = (id) => document.getElementById(id)
  const tabs = [...document.querySelectorAll('[data-view]')]
  const mobileTabs = [...document.querySelectorAll('[data-mobile]')]
  const errors = {
    invalid_pin: 'PIN 不正确，请核对电脑上的 6 位数字。',
    rate_limited: '操作有点快，请稍等片刻再试。',
    too_many_pair_attempts: '配对尝试过于频繁，请稍后再试。',
    unauthorized: '配对已失效，请重新输入 PIN。',
    invalid_command: '这个操作暂时不可用，请刷新后重试。',
    queue_changed: '电脑上的队列已更新，请在刷新后的列表中重新选择。',
    stale_queue: '队列已变化，已为你刷新，请重新选择。',
    desktop_unavailable: '电脑端暂未就绪，请确认主程序已打开。',
    renderer_unavailable: '电脑端暂未就绪，请确认主程序已打开。',
    renderer_not_ready: '电脑端暂未就绪，请确认主程序已打开。',
    renderer_timeout: '电脑端响应超时，请稍后重试。',
    renderer_busy: '电脑端正在处理其他操作，请稍后再试。',
    request_timeout: '电脑端响应超时，请稍后重试。',
    track_not_found: '这首歌已不在音乐库中，请刷新列表。',
    playlist_not_found: '这个歌单已不存在，请返回歌单列表。',
    command_handler_missing: '播放服务暂未就绪，请稍后重试。'
  }
  let token = ''
  try {
    token = localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    token = ''
  }
  let eventSource = null
  let connection = false
  let paired = false
  let state = {
    state: 'stopped',
    title: '',
    artist: '',
    album: '',
    position: 0,
    duration: 0,
    volume: 0.7,
    muted: false,
    isLive: false,
    queueIndex: -1,
    queueLength: 0,
    queueRevision: 0,
    playMode: 'sequence'
  }
  let receivedAt = 0
  let view = 'library'
  let playlist = null
  let offset = 0
  let page = null
  let browseVersion = 0
  let browseController = null
  let searchTimer = null
  let queueTimer = null
  let toastTimer = null
  let commandPending = false
  let pairing = false
  let seeking = false
  let volumeEditing = false
  let restoreVolume = 0.7
  let lastAuthCheck = 0
  let artwork = ''

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor(total / 60) % 60
    const rest = String(total % 60).padStart(2, '0')
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('svg-icon')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#i-${name}`)
    svg.append(use)
    return svg
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag)
    element.className = className
    element.textContent = text
    return element
  }

  function showError(element, message = '') {
    element.textContent = message
    element.hidden = !message
  }

  function friendlyError(error) {
    if (error.name === 'AbortError') return '连接超时，请确认手机与电脑仍在同一局域网。'
    if (error.status === 409) return errors.queue_changed
    if (error.status === 429) return errors.rate_limited
    if (errors[error.message]) return errors[error.message]
    if (error.status === 401) return errors.unauthorized
    if (error instanceof TypeError) return '连接暂时中断，请检查网络或电脑端服务。'
    return '暂时无法完成操作，请刷新后重试。'
  }

  function notify(message, error = false) {
    clearTimeout(toastTimer)
    $('toast').textContent = message
    $('toast').dataset.error = String(error)
    $('toast').hidden = false
    toastTimer = setTimeout(
      () => {
        $('toast').hidden = true
      },
      error ? 6000 : 3000
    )
  }

  function storeToken(value) {
    token = value
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      notify('浏览器未允许保存配对，关闭网页后需重新输入 PIN。')
    }
  }

  function setConnection(text, connected = false) {
    connection = connected
    $('status-text').textContent = text
    $('status-chip').classList.toggle('ok', connected)
    updateControls()
  }

  function updateControls() {
    const disabled = !connection || commandPending
    for (const id of ['btn-prev', 'btn-next', 'mini-next', 'btn-mute', 'volume', 'play-mode'])
      $(id).disabled = disabled
    for (const id of ['btn-play', 'mini-play'])
      $(id).disabled = disabled || (!state.title && !state.queueLength)
    $('seek').disabled = disabled || state.isLive || !(state.duration > 0)
    for (const button of $('track-list').querySelectorAll('button')) button.disabled = disabled
  }

  async function api(path, options = {}) {
    const requestToken = token
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    const external = options.signal
    const abort = () => controller.abort()
    if (external?.aborted) controller.abort()
    external?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {})
        }
      })
      const body = await response.json()
      if (!response.ok) {
        const error = new Error(body?.error || `HTTP ${response.status}`)
        error.status = response.status
        if (
          response.status === 401 &&
          requestToken &&
          requestToken === token &&
          path !== '/api/pair'
        )
          clearSession(errors.unauthorized)
        throw error
      }
      return body
    } finally {
      clearTimeout(timeout)
      external?.removeEventListener('abort', abort)
    }
  }

  function setRange(element, value) {
    element.value = String(value)
    element.style.setProperty(
      '--fill',
      `${Math.max(0, Math.min(100, (Number(value) / Number(element.max)) * 100))}%`
    )
  }

  function renderProgress() {
    if (seeking || document.activeElement === $('seek')) return
    const elapsed =
      connection && state.state === 'playing'
        ? Math.min(5, (performance.now() - receivedAt) / 1000)
        : 0
    const position = Math.min(
      state.duration || Infinity,
      Math.max(0, Number(state.position) || 0) + elapsed
    )
    $('pos').textContent = formatTime(position)
    $('dur').textContent = state.isLive ? '直播' : formatTime(state.duration)
    setRange(
      $('seek'),
      state.isLive || !state.duration ? 0 : Math.round((position / state.duration) * 1000)
    )
    $('seek').setAttribute(
      'aria-valuetext',
      `${formatTime(position)} / ${formatTime(state.duration)}`
    )
  }

  function renderArtwork(url) {
    const safe =
      typeof url === 'string' &&
      url.length <= 2_800_000 &&
      /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(url)
        ? url
        : ''
    if (safe === artwork) return
    artwork = safe
    const cover = $('cover')
    cover.hidden = true
    if (safe) cover.src = safe
    else cover.removeAttribute('src')
  }

  $('cover').addEventListener('load', () => {
    $('cover').hidden = !artwork
  })
  $('cover').addEventListener('error', () => {
    $('cover').hidden = true
  })

  function applyState(next) {
    if (!next || typeof next !== 'object') return
    const oldRevision = state.queueRevision
    const oldIndex = state.queueIndex
    state = { ...state, ...next }
    receivedAt = performance.now()
    $('title').textContent = state.title || '挑一首喜欢的歌'
    $('artist').textContent =
      state.artist || (state.title ? '未知歌手' : '从音乐库开始，或继续播放队列')
    $('album').textContent = state.album || '属于你的音乐时刻'
    $('mini-title').textContent = state.title || '挑一首喜欢的歌'
    $('mini-artist').textContent = state.artist || '从音乐库开始'
    $('playback-label').textContent =
      state.state === 'playing' ? '正在播放' : state.state === 'paused' ? '已暂停' : '等待播放'
    $('live-badge').hidden = !state.isLive
    $('queue-count').textContent = `队列 · ${state.queueLength || 0}`
    $('tab-queue-count').textContent = String(state.queueLength || 0)
    $('cast-line').textContent = state.castTarget
      ? `正在投送至 ${state.castTarget}`
      : '输出至电脑 · 本机播放'
    for (const id of ['btn-play', 'mini-play']) {
      const button = $(id)
      const label = state.state === 'playing' ? '暂停' : '播放'
      button.setAttribute('aria-label', label)
      button.title = label
      const use = button.querySelector('use')
      use.setAttribute('href', state.state === 'playing' ? '#i-pause' : '#i-play')
    }
    if (state.volume > 0 && !state.muted) restoreVolume = state.volume
    if (!volumeEditing && document.activeElement !== $('volume')) {
      const volume = Math.round((state.muted ? 0 : state.volume) * 100)
      setRange($('volume'), volume)
      $('volume-value').textContent = `${volume}%`
    }
    const silent = state.muted || state.volume === 0
    $('btn-mute').setAttribute('aria-pressed', String(silent))
    $('btn-mute').setAttribute('aria-label', silent ? '恢复音量' : '静音')
    $('btn-mute').title = silent ? '恢复音量' : '静音'
    $('btn-mute')
      .querySelector('use')
      .setAttribute('href', silent ? '#i-mute' : '#i-volume')
    if (document.activeElement !== $('play-mode'))
      $('play-mode').value = state.playMode || 'sequence'
    renderArtwork(state.coverDataUrl || state.coverUrl)
    renderProgress()
    updateControls()
    if (oldIndex !== state.queueIndex && view === 'queue') highlightQueue()
    if (oldRevision !== state.queueRevision && view === 'queue' && page && paired) {
      clearTimeout(queueTimer)
      queueTimer = setTimeout(() => void loadBrowse(), 180)
    }
  }

  function disconnectEvents() {
    eventSource?.close()
    eventSource = null
  }

  function connectEvents() {
    disconnectEvents()
    if (!token) return
    const sessionToken = token
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
    eventSource = source
    source.addEventListener('state', (event) => {
      if (sessionToken !== token || source !== eventSource) return
      try {
        const next = JSON.parse(event.data)
        setConnection('已连接', true)
        applyState(next)
      } catch {
        setConnection('同步异常')
      }
    })
    source.addEventListener('auth', () => {
      if (source === eventSource) clearSession(errors.unauthorized)
    })
    source.addEventListener('ping', () => {
      if (source === eventSource) setConnection('已连接', true)
    })
    source.onerror = () => {
      if (source !== eventSource) return
      setConnection('正在重连')
      if (Date.now() - lastAuthCheck > 5000) {
        lastAuthCheck = Date.now()
        void refreshState(false)
      }
    }
  }

  async function refreshState(reconnect = true) {
    if (!token) return
    const sessionToken = token
    try {
      const next = await api('/api/state')
      if (sessionToken !== token) return
      const wasDisconnected = !connection
      applyState(next)
      if (!paired) enterPaired()
      if (reconnect) {
        setConnection('已连接', true)
        if (wasDisconnected) connectEvents()
      }
    } catch (error) {
      if (sessionToken !== token) return
      setConnection('连接已中断')
      if (!paired) showError($('pair-error'), friendlyError(error))
    }
  }

  function enterPaired() {
    paired = true
    $('pair-panel').hidden = true
    $('session-panel').hidden = false
    $('btn-disconnect').hidden = false
    $('mini-player').hidden = false
    document.body.classList.add('paired')
    setConnection('已连接', true)
    connectEvents()
    void loadBrowse()
  }

  function clearSession(message = '') {
    storeToken('')
    paired = false
    disconnectEvents()
    browseVersion++
    browseController?.abort()
    clearTimeout(searchTimer)
    clearTimeout(queueTimer)
    $('pair-panel').hidden = false
    $('session-panel').hidden = true
    $('btn-disconnect').hidden = true
    document.body.classList.remove('paired', 'mobile-browser')
    updateMobileTabs('player')
    selectView('library')
    $('track-list').replaceChildren()
    page = null
    state = {
      ...state,
      state: 'stopped',
      title: '',
      artist: '',
      album: '',
      position: 0,
      duration: 0,
      queueIndex: -1,
      queueLength: 0,
      queueRevision: '',
      coverUrl: null,
      coverDataUrl: null
    }
    artwork = ''
    $('cover').removeAttribute('src')
    $('cover').hidden = true
    setConnection('等待配对')
    showError($('pair-error'), message)
  }

  function currentQuery() {
    return $('search-input').value.trim()
  }

  function highlightQueue() {
    for (const row of $('track-list').children) {
      const current = Number(row.dataset.index) === state.queueIndex && view === 'queue'
      row.classList.toggle('current', current)
      const button = row.querySelector('.track-main')
      if (current) button.setAttribute('aria-current', 'true')
      else button.removeAttribute('aria-current')
      const number = row.querySelector('.track-number')
      if (number) {
        if (current) number.replaceChildren(icon('play'))
        else number.textContent = String(Number(row.dataset.index) + 1).padStart(2, '0')
      }
    }
  }

  function renderPage(result) {
    page = result
    $('track-list').replaceChildren()
    $('result-count').textContent = String(result.total)
    const isPlaylists = view === 'playlists' && !playlist
    $('list-label').textContent =
      playlist?.title ||
      (view === 'queue'
        ? '播放队列'
        : isPlaylists
          ? '你的歌单'
          : currentQuery()
            ? '搜索结果'
            : '全部曲目')
    $('list-hint').textContent = view === 'queue' ? '点击切换 · 右侧移除' : '选一首，开启此刻'
    $('playlist-back').hidden = !playlist
    $('track-list').setAttribute('aria-label', isPlaylists ? '歌单列表' : '曲目列表')
    const fragment = document.createDocumentFragment()
    for (const [index, item] of result.items.entries()) {
      const row = textElement('div', isPlaylists ? 'track-row playlist-row' : 'track-row', '')
      row.setAttribute('role', 'listitem')
      row.dataset.index = String(item.index ?? offset + index)
      const main = textElement('button', 'track-main', '')
      main.type = 'button'
      main.setAttribute(
        'aria-label',
        `${isPlaylists ? '打开歌单' : '播放'}：${item.title || '未命名'}${item.artist ? `，${item.artist}` : ''}`
      )
      if (!isPlaylists)
        main.append(
          textElement('span', 'track-number', String(offset + index + 1).padStart(2, '0'))
        )
      const thumb = textElement('span', 'track-thumb', '')
      thumb.setAttribute('aria-hidden', 'true')
      thumb.append(icon(isPlaylists ? 'library' : 'disc'))
      const details = textElement('span', 'track-details', '')
      details.append(textElement('span', 'track-name', item.title || '未命名'))
      details.append(
        textElement(
          'span',
          'track-subtitle',
          isPlaylists
            ? `${item.trackCount ?? 0} 首曲目`
            : [item.artist || '未知歌手', item.album].filter(Boolean).join(' · ')
        )
      )
      main.append(thumb, details)
      if (!isPlaylists)
        main.append(
          textElement('span', 'track-duration', item.duration > 0 ? formatTime(item.duration) : '—')
        )
      main.addEventListener('click', () => {
        if (isPlaylists) {
          playlist = { id: item.id, title: item.title }
          $('search-input').placeholder = '搜索歌曲、歌手或专辑'
          offset = 0
          $('search-input').value = ''
          $('search-clear').hidden = true
          void loadBrowse()
        } else {
          const command =
            view === 'queue'
              ? { action: 'jumpQueue', index: item.index, revision: result.revision }
              : { action: 'playTrack', id: item.id }
          void sendCommand(command, `正在播放「${item.title || '未命名'}」`)
        }
      })
      row.append(main)
      if (isPlaylists) {
        const arrow = icon('arrow')
        arrow.classList.add('playlist-arrow')
        row.append(arrow)
      } else {
        const action = textElement('button', 'icon-button track-action', '')
        action.type = 'button'
        const label = view === 'queue' ? '从队列移除' : '加入播放队列'
        action.setAttribute('aria-label', `${label}：${item.title || '未命名'}`)
        action.title = label
        action.append(icon(view === 'queue' ? 'close' : 'plus'))
        action.addEventListener(
          'click',
          () =>
            void sendCommand(
              view === 'queue'
                ? { action: 'removeQueue', index: item.index, revision: result.revision }
                : { action: 'enqueueTrack', id: item.id },
              view === 'queue' ? '已从播放队列移除' : '已加入播放队列'
            )
        )
        row.append(action)
      }
      fragment.append(row)
    }
    $('track-list').append(fragment)
    $('list-empty').hidden = result.items.length > 0
    $('empty-title').textContent = currentQuery()
      ? '没有找到这段旋律'
      : view === 'queue'
        ? '下一首，由你决定'
        : isPlaylists
          ? '留一份喜欢的声音'
          : '这里还很安静'
    $('empty-description').textContent = currentQuery()
      ? '换个关键词试试，可以搜索歌名、歌手或专辑。'
      : view === 'queue'
        ? '去音乐库选歌，或用曲目右侧的「＋」加入队列。'
        : isPlaylists
          ? '在电脑端创建歌单后，就能在这里浏览和点播。'
          : '在电脑端添加音乐后，就能在这里选歌。'
    $('pagination').hidden = result.total <= PAGE_SIZE
    $('page-prev').disabled = offset === 0
    $('page-next').disabled = offset + result.items.length >= result.total
    $('page-label').textContent =
      `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(result.total / PAGE_SIZE))}`
    if (view === 'queue') highlightQueue()
    updateControls()
  }

  async function loadBrowse() {
    clearTimeout(searchTimer)
    clearTimeout(queueTimer)
    if (!paired || !token) return
    browseController?.abort()
    const controller = new AbortController()
    browseController = controller
    const version = ++browseVersion
    const query = new URLSearchParams({
      view,
      query: currentQuery(),
      offset: String(offset),
      limit: String(PAGE_SIZE)
    })
    if (playlist) query.set('playlistId', playlist.id)
    showError($('browse-error'))
    $('list-loading').hidden = false
    $('list-empty').hidden = true
    $('pagination').hidden = true
    $('track-list').replaceChildren()
    $('track-list').setAttribute('aria-busy', 'true')
    try {
      const result = await api(`/api/browse?${query}`, { signal: controller.signal })
      if (version !== browseVersion || !paired) return
      if (
        !result ||
        !Array.isArray(result.items) ||
        result.items.length > PAGE_SIZE ||
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        (view === 'queue' &&
          (!Number.isSafeInteger(result.revision) ||
            result.revision < 0 ||
            result.items.some((item) => !Number.isSafeInteger(item.index) || item.index < 0)))
      )
        throw new Error('invalid_response')
      if (offset > 0 && offset >= result.total) {
        offset = Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE)
        void loadBrowse()
        return
      }
      renderPage(result)
    } catch (error) {
      if (controller.signal.aborted || version !== browseVersion || !paired) return
      showError($('browse-error'), `${friendlyError(error)} 可点击右上角刷新重试。`)
      $('result-count').textContent = '—'
    } finally {
      if (version === browseVersion) {
        $('list-loading').hidden = true
        $('track-list').setAttribute('aria-busy', 'false')
      }
    }
  }

  async function sendCommand(command, success = '') {
    if (!connection || commandPending) return
    commandPending = true
    const sessionToken = token
    updateControls()
    try {
      await api('/api/command', { method: 'POST', body: JSON.stringify(command) })
      if (sessionToken !== token) return
      if (success) notify(success)
      await refreshState()
      if (view === 'queue' && paired) await loadBrowse()
    } catch (error) {
      if (sessionToken !== token) return
      notify(friendlyError(error), true)
      if (error.status === 409) void loadBrowse()
      if (error.name === 'AbortError' || error instanceof TypeError) setConnection('连接已中断')
    } finally {
      commandPending = false
      updateControls()
    }
  }

  function selectView(next) {
    view = next
    playlist = null
    offset = 0
    page = null
    $('search-input').value = ''
    $('search-clear').hidden = true
    $('search-input').placeholder = next === 'playlists' ? '搜索歌单' : '搜索歌曲、歌手或专辑'
    for (const tab of tabs) {
      const active = tab.dataset.view === view
      tab.classList.toggle('active', active)
      if (active) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
    if (document.body.classList.contains('mobile-browser'))
      updateMobileTabs(view === 'queue' ? 'queue' : 'library')
    void loadBrowse()
  }

  function updateMobileTabs(active) {
    for (const tab of mobileTabs) {
      const selected = tab.dataset.mobile === active
      tab.classList.toggle('active', selected)
      if (selected) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
  }

  function openMobile(destination) {
    const browser = destination !== 'player'
    document.body.classList.toggle('mobile-browser', browser)
    updateMobileTabs(destination)
    if (browser) selectView(destination)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  $('pair-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (pairing) return
    const pin = $('pin-input').value.trim()
    if (!/^\d{6}$/.test(pin)) {
      showError($('pair-error'), '请输入完整的 6 位数字 PIN。')
      return
    }
    pairing = true
    $('pair-submit').disabled = true
    $('pair-submit').querySelector('span').textContent = '正在连接…'
    showError($('pair-error'))
    try {
      const result = await api('/api/pair', { method: 'POST', body: JSON.stringify({ pin }) })
      if (typeof result?.token !== 'string' || !result.token) throw new Error('invalid_response')
      storeToken(result.token)
      $('pin-input').value = ''
      await refreshState()
    } catch (error) {
      showError($('pair-error'), friendlyError(error))
    } finally {
      pairing = false
      $('pair-submit').disabled = false
      $('pair-submit').querySelector('span').textContent = '进入听音室'
    }
  })

  $('btn-disconnect').addEventListener('click', () => {
    clearSession()
    $('pin-input').focus()
  })
  $('btn-prev').addEventListener('click', () => void sendCommand({ action: 'previous' }))
  for (const id of ['btn-next', 'mini-next'])
    $(id).addEventListener('click', () => void sendCommand({ action: 'next' }))
  for (const id of ['btn-play', 'mini-play'])
    $(id).addEventListener(
      'click',
      () => void sendCommand({ action: state.state === 'playing' ? 'pause' : 'play' })
    )
  $('btn-mute').addEventListener(
    'click',
    () =>
      void sendCommand({
        action: 'setVolume',
        volume: state.muted || state.volume === 0 ? restoreVolume : 0
      })
  )
  $('play-mode').addEventListener('change', async () => {
    await sendCommand({ action: 'setPlayMode', mode: $('play-mode').value })
    $('play-mode').value = state.playMode || 'sequence'
  })
  $('seek').addEventListener('input', () => {
    seeking = true
    setRange($('seek'), $('seek').value)
    const position = (Number($('seek').value) / 1000) * state.duration
    $('pos').textContent = formatTime(position)
    $('seek').setAttribute(
      'aria-valuetext',
      `${formatTime(position)} / ${formatTime(state.duration)}`
    )
  })
  $('seek').addEventListener('change', async () => {
    if (!state.isLive && state.duration > 0)
      await sendCommand({
        action: 'seek',
        positionSeconds: (Number($('seek').value) / 1000) * state.duration
      })
    seeking = false
    renderProgress()
  })
  for (const event of ['blur', 'pointercancel'])
    $('seek').addEventListener(event, () => {
      seeking = false
      renderProgress()
    })
  $('volume').addEventListener('input', () => {
    volumeEditing = true
    setRange($('volume'), $('volume').value)
    $('volume-value').textContent = `${$('volume').value}%`
  })
  $('volume').addEventListener('change', async () => {
    await sendCommand({ action: 'setVolume', volume: Number($('volume').value) / 100 })
    volumeEditing = false
  })
  for (const event of ['blur', 'pointercancel'])
    $('volume').addEventListener(event, () => {
      volumeEditing = false
    })
  tabs.forEach((tab) => tab.addEventListener('click', () => selectView(tab.dataset.view)))
  mobileTabs.forEach((tab) => tab.addEventListener('click', () => openMobile(tab.dataset.mobile)))
  $('btn-open-queue').addEventListener('click', () => openMobile('queue'))
  $('mini-open').addEventListener('click', () => openMobile('player'))
  $('playlist-back').addEventListener('click', () => selectView('playlists'))
  $('btn-refresh').addEventListener('click', () => {
    void refreshState()
    void loadBrowse()
  })
  $('page-prev').addEventListener('click', () => {
    offset = Math.max(0, offset - PAGE_SIZE)
    void loadBrowse()
    $('browse-title').scrollIntoView({ block: 'start' })
  })
  $('page-next').addEventListener('click', () => {
    offset += PAGE_SIZE
    void loadBrowse()
    $('browse-title').scrollIntoView({ block: 'start' })
  })
  function search() {
    offset = 0
    browseVersion++
    browseController?.abort()
    clearTimeout(searchTimer)
    $('search-clear').hidden = !$('search-input').value
    searchTimer = setTimeout(() => void loadBrowse(), 250)
  }
  $('search-input').addEventListener('input', search)
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault()
    offset = 0
    void loadBrowse()
  })
  $('search-clear').addEventListener('click', () => {
    $('search-input').value = ''
    search()
    $('search-input').focus()
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token) {
      void refreshState()
      if (paired) void loadBrowse()
    }
  })
  window.addEventListener('online', () => {
    if (token) void refreshState()
  })
  window.addEventListener('offline', () => setConnection('网络已断开'))
  window.addEventListener('pagehide', disconnectEvents)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && token) {
      connectEvents()
      void refreshState()
    }
  })
  setInterval(() => {
    if (paired && !document.hidden) renderProgress()
  }, 500)
  if (token) void refreshState()
  else setConnection('等待配对')
})()
