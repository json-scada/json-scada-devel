import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PointMap, type ServerPoint } from '../../src/server/point-map.js'
import { normalizeServerConnection } from '../../src/server/conn-config.js'
import { parseAsdu } from '../../src/core/address.js'

const cfg = normalizeServerConnection({
  protocolConnectionNumber: 1,
  name: 'SRV',
})
const map = new PointMap(cfg)

const DEFAULTS = {
  byteOrder16: 'AB',
  byteOrder32: 'ABCD',
  byteOrder64: 'ABCDEFGH',
  byteOrderStr: 'AB',
  stringEncoding: 'latin1' as const,
}

// Minimal ServerPoint helper. `kconv*` are the protocolDestination scaling,
// `tagKconv*` the tag-level realtimeData scaling; both are applied.
function point(
  tagType: ServerPoint['tagType'],
  tagKconv1: number,
  tagKconv2: number,
  destKconv1 = 1,
  destKconv2 = 0
): ServerPoint {
  return {
    id: 1,
    pointKey: 1,
    tag: 't',
    unitId: 1,
    area: 'hr',
    offset: 0,
    bit: null,
    asdu: parseAsdu('uint16', 'hr', DEFAULTS),
    kconv1: destKconv1,
    kconv2: destKconv2,
    span: 1,
    isCommand: true,
    tagType,
    tagKconv1,
    tagKconv2,
    cmdConnectionNumber: 1,
    cmdCommonAddress: 1,
    cmdObjectAddress: 'hr:0',
    cmdAsdu: 'uint16',
  }
}

test('digital, kconv1 != -1: forced to 1/0', () => {
  const p = point('digital', 1, 0)
  assert.deepEqual(map.routeCommandValue(p, 1), { value: 1, valueString: '1' })
  assert.deepEqual(map.routeCommandValue(p, 5), { value: 1, valueString: '1' })
  assert.deepEqual(map.routeCommandValue(p, 0), { value: 0, valueString: '0' })
  assert.deepEqual(map.routeCommandValue(p, 0xff00), { value: 1, valueString: '1' })
})

test('digital, kconv1 == -1: forced to 1/0 then inverted', () => {
  const p = point('digital', -1, 0)
  assert.deepEqual(map.routeCommandValue(p, 1), { value: 0, valueString: '0' })
  assert.deepEqual(map.routeCommandValue(p, 42), { value: 0, valueString: '0' })
  assert.deepEqual(map.routeCommandValue(p, 0), { value: 1, valueString: '1' })
})

test('analog: value*kconv1 + kconv2 (tag-level only)', () => {
  const p = point('analog', 2, 10)
  assert.deepEqual(map.routeCommandValue(p, 5), { value: 20, valueString: '20' })
  const p2 = point('analog', 0.1, -3)
  assert.equal(map.routeCommandValue(p2, 100).value, 7)
  const p3 = point('analog', 1, 0)
  assert.equal(map.routeCommandValue(p3, 1234).value, 1234)
})

test('analog: destination AND tag-level scaling both applied', () => {
  // dest: raw*10 + 5 ; tag: v*2 + 1  =>  (5*10+5)*2+1 = 111
  const p = point('analog', 2, 1, 10, 5)
  assert.equal(map.routeCommandValue(p, 5).value, 111)

  // destination-only scaling still applies when tag scaling is identity
  const p2 = point('analog', 1, 0, 0.5, 0)
  assert.equal(map.routeCommandValue(p2, 100).value, 50)
})

test('digital: destination -1 alone inverts', () => {
  const p = point('digital', 1, 0, -1, 0)
  assert.equal(map.routeCommandValue(p, 1).value, 0)
  assert.equal(map.routeCommandValue(p, 0).value, 1)
})

test('digital: both -1 cancel out (no inversion)', () => {
  const p = point('digital', -1, 0, -1, 0)
  assert.equal(map.routeCommandValue(p, 1).value, 1)
  assert.equal(map.routeCommandValue(p, 0).value, 0)
})

test('string: passes decoded string through, value 0', () => {
  const p = point('string', 1, 0)
  assert.deepEqual(map.routeCommandValue(p, 'HELLO'), {
    value: 0,
    valueString: 'HELLO',
  })
})
