'use strict'

globalThis.music_source_setup = metadataJson => {
  delete globalThis.music_source_setup
  const metadata = JSON.parse(metadataJson)
  const nativeCall = globalThis.__music_source_native_call__
  const nativeMd5 = globalThis.__music_source_md5__
  const bytesToBase64 = globalThis.__music_source_bytes_to_b64__
  const base64ToBytes = globalThis.__music_source_b64_to_bytes__
  const aesEncrypt = globalThis.__music_source_aes_encrypt__
  const rsaEncrypt = globalThis.__music_source_rsa_encrypt__
  const nativeSetTimeout = globalThis.__music_source_set_timeout__
  const nativeClearTimeout = globalThis.__music_source_clear_timeout__
  delete globalThis.__music_source_native_call__
  delete globalThis.__music_source_md5__
  delete globalThis.__music_source_bytes_to_b64__
  delete globalThis.__music_source_b64_to_bytes__
  delete globalThis.__music_source_aes_encrypt__
  delete globalThis.__music_source_rsa_encrypt__
  delete globalThis.__music_source_set_timeout__
  delete globalThis.__music_source_clear_timeout__

  const callNative = (action, data) => {
    const json = JSON.stringify(data == null ? {} : data)
    if (json.length > 4 * 1024 * 1024) throw new Error('Payload too large')
    nativeCall(action, json)
  }

  const utf8Bytes = value => {
    const encoded = unescape(encodeURIComponent(value))
    const bytes = new Uint8Array(encoded.length)
    for (let index = 0; index < encoded.length; index++) {
      bytes[index] = encoded.charCodeAt(index)
    }
    return bytes
  }
  const utf8String = bytes => {
    let binary = ''
    for (const value of bytes) binary += String.fromCharCode(value)
    return decodeURIComponent(escape(binary))
  }
  const toBytes = value => {
    if (typeof value === 'string') return utf8Bytes(value)
    if (Array.isArray(value)) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value)
    throw new Error('Unsupported buffer input')
  }
  const toBase64 = value => bytesToBase64(JSON.stringify(Array.from(toBytes(value))))
  const buffer = {
    from(value, encoding) {
      if (encoding === 'base64') return new Uint8Array(JSON.parse(base64ToBytes(value)))
      if (encoding === 'hex') {
        const pairs = value.match(/.{1,2}/g) || []
        return new Uint8Array(pairs.map(pair => parseInt(pair, 16)))
      }
      return toBytes(value)
    },
    bufToString(value, encoding) {
      const bytes = toBytes(value)
      if (encoding === 'base64') return toBase64(bytes)
      if (encoding === 'hex') {
        return Array.from(bytes).map(item => item.toString(16).padStart(2, '0')).join('')
      }
      if (encoding === 'binary') return bytes
      return utf8String(bytes)
    },
  }

  const timers = new Map()
  let nextTimerId = 1
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new Error('callback must be a function')
    const id = nextTimerId++
    timers.set(id, () => callback(...args))
    nativeSetTimeout(id, Math.max(0, Math.min(Number(delay) || 0, 60000)))
    return id
  }
  globalThis.clearTimeout = id => {
    timers.delete(id)
    nativeClearTimeout(id)
  }

  const httpCallbacks = new Map()
  let nextHttpId = 1
  let requestHandler = null
  let activeResolve = null
  const resolveQueue = []

  const normalizeRequestOptions = raw => {
    const options = Object.assign({}, raw || {})
    options.method = String(options.method || 'get').toLowerCase()
    options.timeout = Math.max(1000, Math.min(Number(options.timeout) || 15000, 60000))
    if (ArrayBuffer.isView(options.body) || Array.isArray(options.body)) {
      options.bodyBase64 = toBase64(options.body)
      delete options.body
    }
    return options
  }

  const request = (url, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    if (typeof callback !== 'function') throw new Error('request callback is required')
    const requestId = String(nextHttpId++)
    const ownerRequestId = activeResolve ? activeResolve.requestId : null
    httpCallbacks.set(requestId, { callback, ownerRequestId })
    if (activeResolve) activeResolve.httpRequests.add(requestId)
    callNative('httpRequest', {
      requestId,
      ownerRequestId,
      url: String(url),
      options: normalizeRequestOptions(options),
    })
    return () => {
      if (!httpCallbacks.has(requestId)) return
      httpCallbacks.delete(requestId)
      callNative('httpCancel', { requestId })
    }
  }

  const finishResolve = () => {
    activeResolve = null
    if (resolveQueue.length) runResolve(resolveQueue.shift())
  }
  const failResolve = (requestId, error) => {
    callNative('resolveResult', {
      requestId,
      status: false,
      error: error && error.message ? error.message : String(error),
    })
  }
  const runResolve = payload => {
    if (activeResolve) {
      resolveQueue.push(payload)
      return
    }
    if (typeof requestHandler !== 'function') {
      failResolve(payload.requestId, 'Request event is not defined')
      return
    }
    activeResolve = {
      requestId: payload.requestId,
      httpRequests: new Set(),
      canceled: false,
    }
    const requestState = activeResolve
    let response
    try {
      response = requestHandler.call(globalThis.lx, {
        source: payload.source,
        action: 'musicUrl',
        info: { type: payload.quality, musicInfo: payload.musicInfo },
      })
    } catch (error) {
      failResolve(payload.requestId, error)
      finishResolve()
      return
    }
    Promise.resolve(response).then(result => {
      if (requestState.canceled) return
      const url = typeof result === 'string' ? result : result && result.url
      if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//i.test(url)) {
        throw new Error('音源返回了无效的播放地址')
      }
      const responsePayload = {
        requestId: payload.requestId,
        status: true,
        url,
      }
      const fileName = result && typeof result === 'object' &&
        typeof result.fileName === 'string' ? result.fileName.trim() : ''
      if (fileName && !/^(null|undefined)$/i.test(fileName)) responsePayload.fileName = fileName
      callNative('resolveResult', responsePayload)
    }).catch(error => {
      if (!requestState.canceled) failResolve(payload.requestId, error)
    }).finally(finishResolve)
  }

  const supportedSources = new Set(['kw', 'kg', 'tx', 'wy', 'mg'])
  const supportedQualities = new Set([
    '128k', '192k', '320k', 'ape', 'wav', 'flac', 'flac24bit',
    'hires', 'atmos', 'atmos_plus', 'master',
  ])
  const normalizeInit = raw => {
    const sources = {}
    const input = raw && raw.sources
    if (!input || typeof input !== 'object') throw new Error('Missing source capabilities')
    for (const [code, value] of Object.entries(input)) {
      if (!supportedSources.has(code) || !value || value.type !== 'music') continue
      const actions = Array.isArray(value.actions)
        ? value.actions.filter(action => action === 'musicUrl')
        : []
      const qualitys = Array.isArray(value.qualitys)
        ? value.qualitys.filter(quality => supportedQualities.has(quality))
        : []
      if (actions.length) sources[code] = { type: 'music', actions, qualitys }
    }
    return { sources }
  }

  globalThis.lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    request,
    on(eventName, handler) {
      if (eventName !== 'request' || typeof handler !== 'function') {
        return Promise.reject(new Error('Unsupported event'))
      }
      requestHandler = handler
      return Promise.resolve()
    },
    send(eventName, data) {
      if (eventName === 'inited') {
        try {
          callNative('init', { status: true, info: normalizeInit(data) })
          return Promise.resolve()
        } catch (error) {
          callNative('init', { status: false, error: error.message })
          return Promise.reject(error)
        }
      }
      if (eventName === 'updateAlert') return Promise.resolve()
      return Promise.reject(new Error('Unsupported event'))
    },
    utils: {
      buffer,
      crypto: {
        md5(value) { return nativeMd5(String(value)) },
        randomBytes(size) {
          const output = new Uint8Array(size)
          for (let index = 0; index < size; index++) output[index] = Math.floor(Math.random() * 256)
          return output
        },
        aesEncrypt(value, mode, key, iv) {
          const transformation = mode === 'aes-128-cbc'
            ? 'AES/CBC/PKCS7Padding'
            : 'AES'
          const result = aesEncrypt(toBase64(value), toBase64(key), iv ? toBase64(iv) : '', transformation)
          return buffer.from(result, 'base64')
        },
        rsaEncrypt(value, key) {
          const result = rsaEncrypt(toBase64(value), String(key), 'RSA/ECB/NoPadding')
          return buffer.from(result, 'base64')
        },
      },
    },
    currentScriptInfo: metadata,
    version: '2.0.0',
    env: 'mobile',
  }

  globalThis.__music_source_handle__ = (action, dataJson) => {
    if (action === 'resolve') {
      runResolve(JSON.parse(dataJson))
      return
    }
    if (action === 'httpResponse') {
      const payload = JSON.parse(dataJson)
      const target = httpCallbacks.get(payload.requestId)
      if (!target) return
      httpCallbacks.delete(payload.requestId)
      if (activeResolve) activeResolve.httpRequests.delete(payload.requestId)
      if (payload.error) {
        target.callback(new Error(payload.error), null, null)
      } else {
        const response = payload.response || {}
        if (response.binary && typeof response.body === 'string') {
          response.body = buffer.from(response.body, 'base64')
        }
        target.callback(null, response, response.body)
      }
      return
    }
    if (action === 'timeout') {
      const id = Number(dataJson)
      const callback = timers.get(id)
      if (callback) {
        timers.delete(id)
        callback()
      }
    }
  }
}
