import assert from 'node:assert/strict'
import test from 'node:test'

type NcmRequest = {
  path: string
  cookie?: string
}

function queryValue(path: string, key: string): string | null {
  const queryStart = path.indexOf('?')
  if (queryStart < 0) return null
  const params = new URLSearchParams(path.slice(queryStart + 1))
  return params.get(key)
}

interface TestNcmProvider {
  getQrKey(): Promise<unknown>
  getQrImage(key: string): Promise<unknown>
  checkQrLogin(key: string): Promise<{ code: number; message?: string }>
  sendCaptcha(phone: string, countrycode?: string): Promise<{ code: number; message?: string }>
  loginByPhonePassword(
    phone: string,
    password: string,
    countrycode?: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  loginByPhoneCaptcha(
    phone: string,
    captcha: string,
    countrycode?: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  loginByEmailPassword(
    email: string,
    password: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  searchSongs(keywords: string): Promise<unknown>
  getPlaybackUrl(
    track: unknown,
    options?: { force?: boolean; quality?: string }
  ): Promise<string | null>
}

test('bundled NCM provider follows documented QR login request params', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/qr/key')) {
              return { code: 200, data: { unikey: 'qr-key' } }
            }
            if (path.startsWith('/login/qr/create')) {
              return { code: 200, data: { qrimg: 'data:image/png;base64,test' } }
            }
            if (path.startsWith('/login/qr/check')) {
              return { code: 801 }
            }
            if (path.startsWith('/cloudsearch')) {
              return { code: 200, result: { songs: [], songCount: 0 } }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.ok(registeredProvider.current)
  const provider = registeredProvider.current

  await provider.getQrKey()
  await provider.getQrImage('qr-key')
  await provider.checkQrLogin('qr-key')

  const loginRequests = requests.filter((request) => request.path.startsWith('/login/qr/'))
  assert.equal(loginRequests.length, 3)
  assert.equal(queryValue(loginRequests[0].path, 'ua'), null, loginRequests[0].path)
  assert.equal(queryValue(loginRequests[1].path, 'platform'), 'web', loginRequests[1].path)
  assert.equal(queryValue(loginRequests[1].path, 'ua'), 'pc', loginRequests[1].path)
  assert.equal(queryValue(loginRequests[2].path, 'ua'), 'pc', loginRequests[2].path)
  for (const request of loginRequests)
    assert.equal(request.path.includes('chainId='), false, request.path)

  await provider.searchSongs('hello')
  const searchRequest = requests.find((request) => request.path.startsWith('/cloudsearch'))
  assert.ok(searchRequest)
  assert.match(
    queryValue(searchRequest.path, 'ua') ?? '',
    /Chrome\/123\.0\.0\.0/,
    searchRequest.path
  )

  await provider.getPlaybackUrl({ id: 'ncm:1' })
  const playbackRequest = requests.find((request) => request.path.startsWith('/song/url'))
  assert.ok(playbackRequest)
  assert.equal(queryValue(playbackRequest.path, 'ua'), null, playbackRequest.path)

  providerModule.deactivate()
})

test('bundled NCM provider falls back when the preferred playback endpoint fails', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/song/url/v1') && path.includes('level=hires')) {
              throw new Error('preferred level unavailable')
            }
            if (path.startsWith('/song/url/v1') && path.includes('level=lossless')) {
              return {
                code: 200,
                data: [{ id: 2609824992, url: 'https://music.example/song.mp3', br: 320000 }]
              }
            }
            return { code: 200, data: [] }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(
    await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' }),
    'https://music.example/song.mp3'
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[0].path.includes('level=hires'), true, requests[0].path)
  assert.equal(requests[1].path.includes('level=lossless'), true, requests[1].path)

  await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' })
  assert.equal(requests.length, 2)

  providerModule.deactivate()
})

test('bundled NCM provider sends captcha with phone and country code', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/captcha/sent')) return { code: 200, data: true }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.sendCaptcha('13800138000', '86')
  assert.equal(result?.code, 200)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path.startsWith('/captcha/sent?'), true, requests[0].path)
  assert.equal(queryValue(requests[0].path, 'phone'), '13800138000')
  assert.equal(queryValue(requests[0].path, 'ctcode'), '86')

  providerModule.deactivate()
})

test('bundled NCM provider logs in with phone password and stores returned cookie', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/cellphone')) {
              return { code: 200, cookie: 'MUSIC_U=phone-token;__csrf=csrf-token' }
            }
            if (path.startsWith('/login/status')) {
              return {
                code: 200,
                data: {
                  code: 200,
                  profile: { userId: 1001, nickname: 'phone-user', avatarUrl: 'avatar.jpg' }
                }
              }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const login = await registeredProvider.current?.loginByPhonePassword(
    '13800138000',
    'p@ss#word',
    '86'
  )
  assert.equal(login?.loggedIn, true)
  const loginRequest = requests.find((request) => request.path.startsWith('/login/cellphone'))
  assert.ok(loginRequest)
  assert.equal(queryValue(loginRequest.path, 'phone'), '13800138000')
  assert.equal(queryValue(loginRequest.path, 'countrycode'), '86')
  assert.equal(queryValue(loginRequest.path, 'password'), 'p@ss#word')
  assert.equal(settings.get('cookie'), 'MUSIC_U=phone-token;__csrf=csrf-token')

  providerModule.deactivate()
})

test('bundled NCM provider logs in with phone captcha and email password', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/cellphone') && queryValue(path, 'captcha') === '246810') {
              return { code: 200, cookie: 'MUSIC_U=captcha-token' }
            }
            if (path.startsWith('/login?')) {
              return { code: 200, cookie: 'MUSIC_U=email-token' }
            }
            if (path.startsWith('/login/status')) {
              return {
                code: 200,
                data: {
                  code: 200,
                  profile: { userId: 1002, nickname: 'login-user', avatarUrl: 'avatar.jpg' }
                }
              }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const captchaLogin = await registeredProvider.current?.loginByPhoneCaptcha(
    '13800138000',
    '246810',
    '86'
  )
  assert.equal(captchaLogin?.loggedIn, true)
  const captchaRequest = requests.find(
    (request) => queryValue(request.path, 'captcha') === '246810'
  )
  assert.ok(captchaRequest)
  assert.equal(queryValue(captchaRequest.path, 'phone'), '13800138000')
  assert.equal(settings.get('cookie'), 'MUSIC_U=captcha-token')

  const emailLogin = await registeredProvider.current?.loginByEmailPassword(
    'user@example.com',
    'email-password'
  )
  assert.equal(emailLogin?.loggedIn, true)
  const emailRequest = requests.find((request) => request.path.startsWith('/login?'))
  assert.ok(emailRequest)
  assert.equal(queryValue(emailRequest.path, 'email'), 'user@example.com')
  assert.equal(queryValue(emailRequest.path, 'password'), 'email-password')
  assert.equal(settings.get('cookie'), 'MUSIC_U=email-token')

  providerModule.deactivate()
})

test('bundled NCM provider retries QR checks without cookies after API 502', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/qr/check') && !path.includes('noCookie=true')) {
              return { code: 502, message: 'bad gateway' }
            }
            if (path.startsWith('/login/qr/check') && path.includes('noCookie=true')) {
              return { code: 801 }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal((await registeredProvider.current?.checkQrLogin('qr-key'))?.code, 801)
  assert.deepEqual(
    requests.map((request) => request.path),
    ['/login/qr/check?key=qr-key&ua=pc', '/login/qr/check?key=qr-key&noCookie=true&ua=pc']
  )

  providerModule.deactivate()
})

test('bundled NCM provider reports login risk-control errors to the login UI', async () => {
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(): Promise<unknown> {
            return { code: 503, message: 'Service Unavailable' }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.checkQrLogin('qr-key')
  assert.equal(result?.code, 503)
  assert.match(result?.message ?? '', /高频|风控/)

  providerModule.deactivate()
})

test('bundled NCM provider preserves NetEase network risk messages', async () => {
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(): Promise<unknown> {
            return { code: 400, message: '您当前的网络环境存在安全风险' }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.sendCaptcha('13800138000', '86')
  assert.equal(result?.code, 400)
  assert.match(result?.message ?? '', /网络环境存在安全风险/)
  assert.match(result?.message ?? '', /24 小时/)

  providerModule.deactivate()
})

test('bundled NCM provider prefers local cache path and falls back to remote URL', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])
  const cachedPath = 'D:\\TwilightCache\\ncm-cache\\2609824992.flac'

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            return {
              code: 200,
              data: [{ id: 2609824992, url: 'https://music.example/song.flac', br: 999000 }]
            }
          },
          async getCachedSong(): Promise<string> {
            return cachedPath
          },
          async cacheSong(): Promise<string> {
            return cachedPath
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(
    await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' }),
    cachedPath
  )
  assert.equal(requests.length, 0)

  providerModule.deactivate()
})

test('bundled NCM provider does not cache empty playback lookups', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            return { code: 200, data: [{ id: 404, url: null, msg: 'no playable url' }] }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:404' }), null)
  // auto quality: hires/lossless/exhigh/standard + classic br fallbacks (999/320/128)
  // + one final gray-track match. Empty results remain uncached.
  assert.equal(requests.length, 8)
  assert.equal(new URL(requests[7].path, 'http://twilight.local').pathname, '/song/url/match')

  assert.equal(await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:404' }), null)
  assert.equal(requests.length, 16)

  providerModule.deactivate()
})
