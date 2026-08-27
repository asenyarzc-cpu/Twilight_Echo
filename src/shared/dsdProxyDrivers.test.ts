import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dsdProxyIdentityOf,
  filterDsdProxyDevices,
  isDsdProxyDevice,
  looksLikeDsdProxyDriver
} from './dsdProxyDrivers.ts'

test('recognizes known DSD proxy drivers across separator spellings', () => {
  assert.ok(looksLikeDsdProxyDriver('foo_dsd_asio'))
  assert.ok(looksLikeDsdProxyDriver('foo-dsd-asio'))
  assert.ok(looksLikeDsdProxyDriver('FOO_DSD_ASIO'))
  assert.ok(looksLikeDsdProxyDriver('ASIO Proxy Install'))
  assert.ok(looksLikeDsdProxyDriver('Signalyst ASIO-Proxy'))
})

test('does not mistake ordinary hardware ASIO drivers for proxies', () => {
  assert.equal(looksLikeDsdProxyDriver('FiiO ASIO Driver'), false)
  assert.equal(looksLikeDsdProxyDriver('XMOS USB Audio 2.0 ST 3086'), false)
  assert.equal(looksLikeDsdProxyDriver('Realtek ASIO'), false)
  assert.equal(looksLikeDsdProxyDriver('ASIO4ALL v2'), false)
  assert.equal(looksLikeDsdProxyDriver(''), false)
})

test('identity join tolerates missing device fields', () => {
  assert.equal(dsdProxyIdentityOf({ id: 'asio:foo_dsd_asio' }), 'asio:foo_dsd_asio')
  assert.equal(dsdProxyIdentityOf({}), '')
  assert.equal(dsdProxyIdentityOf({ id: 'a', label: 'b', name: 'c', driverName: 'd' }), 'a b c d')
})

test('detects a proxy from any single identity field', () => {
  assert.ok(isDsdProxyDevice({ driverName: 'foo_dsd_asio' }))
  assert.ok(isDsdProxyDevice({ id: 'asio:foo-dsd-asio', label: 'DSD Proxy' }))
  assert.equal(isDsdProxyDevice({ id: 'asio:fiio', label: 'FiiO ASIO Driver' }), false)
})

test('filtering keeps original order and returns only proxy candidates', () => {
  const devices = [
    { id: 'asio:fiio', label: 'FiiO ASIO Driver' },
    { id: 'asio:foo_dsd_asio', label: 'foo_dsd_asio' },
    { id: 'asio:xmos', label: 'XMOS USB Audio' },
    { id: 'asio:proxy2', label: 'ASIO Proxy' }
  ]
  assert.deepEqual(
    filterDsdProxyDevices(devices).map((device) => device.id),
    ['asio:foo_dsd_asio', 'asio:proxy2']
  )
})
