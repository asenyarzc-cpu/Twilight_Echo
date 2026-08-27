import assert from 'node:assert/strict'
import test from 'node:test'

const {
  DEFAULT_RADIO_STATIONS,
  cloneRadioStationsDocument,
  isHttpOrHttpsUrl,
  isInsecureHttpUrl,
  isRadioStation,
  isRadioStationsDocument
} = (await import(
  new URL('./radioStations.ts', import.meta.url).href
)) as typeof import('./radioStations')

test('radio station URL helpers accept http/https and reject credentials', () => {
  assert.equal(isHttpOrHttpsUrl('https://stream.example/live'), true)
  assert.equal(isHttpOrHttpsUrl('http://stream.example/live'), true)
  assert.equal(isInsecureHttpUrl('http://stream.example/live'), true)
  assert.equal(isInsecureHttpUrl('https://stream.example/live'), false)
  assert.equal(isHttpOrHttpsUrl('https://user:pass@stream.example/live'), false)
  assert.equal(isHttpOrHttpsUrl('ftp://stream.example/live'), false)
})

test('radio station requires allowInsecureHttp for plain http streams', () => {
  const base = {
    id: 'radio_1',
    name: 'Test',
    streamUrl: 'http://stream.example/live',
    allowInsecureHttp: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  assert.equal(isRadioStation(base), false)
  assert.equal(isRadioStation({ ...base, allowInsecureHttp: true }), true)
  assert.equal(
    isRadioStation({
      ...base,
      streamUrl: 'https://stream.example/live',
      allowInsecureHttp: false
    }),
    true
  )
})

test('radio stations document validates schema and clones deeply', () => {
  const document = cloneRadioStationsDocument({
    ...DEFAULT_RADIO_STATIONS,
    stations: [
      {
        id: 'radio_1',
        name: 'Jazz',
        streamUrl: 'https://stream.example/jazz',
        allowInsecureHttp: false,
        tags: ['jazz'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  assert.equal(isRadioStationsDocument(document), true)
  document.stations[0].tags!.push('night')
  assert.deepEqual(DEFAULT_RADIO_STATIONS.stations, [])
  assert.equal(isRadioStationsDocument({ schemaVersion: 2, stations: [] }), false)
})
