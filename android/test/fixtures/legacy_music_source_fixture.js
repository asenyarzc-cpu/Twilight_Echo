/**
 * @name Codex Runtime Fixture
 * @description Local QuickJS bridge smoke-test source
 * @author Codex
 * @version 1.0.0
 * @homepage https://example.com/source
 */

lx.on(lx.EVENT_NAMES.request, ({ action }) => {
  if (action !== 'musicUrl') throw new Error('Unsupported action')
  return 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
})

lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: {
      name: 'Kuwo fixture',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
    tx: {
      name: 'QQ fixture',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k'],
    },
  },
})
