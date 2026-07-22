import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseObjectAddress,
  parseAsdu,
} from '../../src/core/address.js'

const DEFAULTS = {
  byteOrder16: 'AB',
  byteOrder32: 'ABCD',
  byteOrder64: 'ABCDEFGH',
  byteOrderStr: 'AB',
}

test('parseObjectAddress canonical forms', () => {
  assert.deepEqual(parseObjectAddress('hr:0'), { area: 'hr', offset: 0, bit: null })
  assert.deepEqual(parseObjectAddress('ir:100'), { area: 'ir', offset: 100, bit: null })
  assert.deepEqual(parseObjectAddress('co:5'), { area: 'co', offset: 5, bit: null })
  assert.deepEqual(parseObjectAddress('di:3'), { area: 'di', offset: 3, bit: null })
  assert.deepEqual(parseObjectAddress('hr:10.b7'), { area: 'hr', offset: 10, bit: 7 })
})

test('parseObjectAddress PLC4X-style aliases', () => {
  assert.deepEqual(parseObjectAddress('holding-register:4'), {
    area: 'hr',
    offset: 4,
    bit: null,
  })
  assert.deepEqual(parseObjectAddress('input-register:20'), {
    area: 'ir',
    offset: 20,
    bit: null,
  })
  assert.deepEqual(parseObjectAddress('coil:1'), { area: 'co', offset: 1, bit: null })
})

test('parseObjectAddress rejects invalid', () => {
  assert.throws(() => parseObjectAddress('xx:5'))
  assert.throws(() => parseObjectAddress('hr:99999'))
  assert.throws(() => parseObjectAddress('co:5.b3')) // bit on bit-area
  assert.throws(() => parseObjectAddress('hr:5.b16'))
})

test('parseObjectAddress Modicon mode', () => {
  assert.deepEqual(parseObjectAddress('40001', true), {
    area: 'hr',
    offset: 0,
    bit: null,
  })
  assert.deepEqual(parseObjectAddress('30011', true), {
    area: 'ir',
    offset: 10,
    bit: null,
  })
  assert.deepEqual(parseObjectAddress('10005', true), {
    area: 'di',
    offset: 4,
    bit: null,
  })
  assert.deepEqual(parseObjectAddress('00001', true), {
    area: 'co',
    offset: 0,
    bit: null,
  })
})

test('parseAsdu type + byte order', () => {
  const a = parseAsdu('float32_cdab', 'hr', DEFAULTS)
  assert.equal(a.type, 'float32')
  assert.deepEqual(a.perm.perm, [2, 3, 0, 1])
  assert.equal(a.regCount, 2)

  const b = parseAsdu('int32_le', 'hr', DEFAULTS)
  assert.equal(b.type, 'int32')
  assert.deepEqual(b.perm.perm, [3, 2, 1, 0])

  const c = parseAsdu('uint64_ghefcdab', 'hr', DEFAULTS)
  assert.equal(c.type, 'uint64')
  assert.equal(c.regCount, 4)
})

test('parseAsdu defaults from connection when order omitted', () => {
  const a = parseAsdu('float32', 'hr', { ...DEFAULTS, byteOrder32: 'CDAB' })
  assert.deepEqual(a.perm.perm, [2, 3, 0, 1])
})

test('parseAsdu empty => bool for bit area, uint16 for reg area', () => {
  assert.equal(parseAsdu('', 'co', DEFAULTS).type, 'bool')
  assert.equal(parseAsdu(null, 'hr', DEFAULTS).type, 'uint16')
})

test('parseAsdu bare byte-order token defaults numeric type (PLC4X migration)', () => {
  // The PLC4X driver used ASDU purely for endianness.
  const a = parseAsdu('LITTLE_ENDIAN', 'hr', DEFAULTS)
  assert.equal(a.type, 'uint16')
  assert.deepEqual(a.perm.perm, [1, 0])
})

test('parseAsdu string with byte count', () => {
  const a = parseAsdu('string:16', 'hr', DEFAULTS)
  assert.equal(a.type, 'string')
  assert.equal(a.regCount, 8)
  assert.equal(a.str?.bytes, 16)
})
