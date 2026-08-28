import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseByteOrder,
  decodeValue,
  encodeValue,
  type ValueType,
} from '../../src/core/datacodec.js'

// Reference: the 32-bit float 1.0 is 0x3F800000 in IEEE-754 big-endian.
// Bytes A=3F B=80 C=00 D=00.
const FLOAT_ONE_BE = Buffer.from([0x3f, 0x80, 0x00, 0x00])

test('parseByteOrder rejects non-permutations', () => {
  assert.throws(() => parseByteOrder('ABAB', 4))
  assert.throws(() => parseByteOrder('ABC', 4))
  assert.throws(() => parseByteOrder('ZZZZ', 4))
})

test('parseByteOrder aliases map correctly for 32-bit', () => {
  assert.deepEqual(parseByteOrder('BE', 4).perm, [0, 1, 2, 3])
  assert.deepEqual(parseByteOrder('LE', 4).perm, [3, 2, 1, 0])
  assert.deepEqual(parseByteOrder('SW', 4).perm, [2, 3, 0, 1]) // CDAB
  assert.deepEqual(parseByteOrder('SB', 4).perm, [1, 0, 3, 2]) // BADC
})

test('PLC4X synonyms accepted', () => {
  assert.deepEqual(parseByteOrder('BIG_ENDIAN', 4).perm, [0, 1, 2, 3])
  assert.deepEqual(parseByteOrder('LITTLE_ENDIAN', 4).perm, [3, 2, 1, 0])
})

test('float32 1.0 decodes correctly under every named 32-bit order', () => {
  // Build the wire bytes for each order by permuting the canonical BE bytes,
  // then confirm decode returns 1.0.
  for (const order of ['BE', 'LE', 'SW', 'SB', 'ABCD', 'DCBA', 'CDAB', 'BADC']) {
    const perm = parseByteOrder(order, 4)
    // wire = fromCanonical(canonical)
    const wire = perm.fromCanonical(FLOAT_ONE_BE)
    const res = decodeValue('float32', wire, 0, perm)
    assert.equal(res.value, 1.0, `order ${order}`)
    assert.equal(res.invalid, false)
  }
})

test('encode/decode round-trips for every type under random permutations', () => {
  const cases: Array<{ type: ValueType; width: number; values: unknown[] }> = [
    { type: 'int16', width: 2, values: [0, -1, 32767, -32768, 1234] },
    { type: 'uint16', width: 2, values: [0, 65535, 40000] },
    { type: 'int32', width: 4, values: [0, -1, 2147483647, -2147483648] },
    { type: 'uint32', width: 4, values: [0, 4294967295, 123456] },
    { type: 'float32', width: 4, values: [1.0, -3.5, 3.14159, 0] },
    { type: 'float64', width: 8, values: [1.0, -2.718281828, 1e10] },
    { type: 'int64', width: 8, values: [0n, -1n, 9223372036854775807n] },
    { type: 'uint64', width: 8, values: [0n, 18446744073709551615n] },
  ]

  for (const c of cases) {
    const perms = enumeratePerms(c.width)
    // sample a handful for 8-byte to keep runtime bounded
    const sample = c.width === 8 ? perms.filter((_, i) => i % 500 === 0) : perms
    for (const permStr of sample) {
      const perm = parseByteOrder(permStr, c.width)
      for (const v of c.values) {
        const wire = encodeValue(c.type, v as number, perm)
        const dec = decodeValue(c.type, wire, 0, perm)
        if (typeof v === 'bigint') assert.equal(dec.value, v, `${c.type} ${permStr}`)
        else
          assert.ok(
            Math.abs(Number(dec.value) - (v as number)) <
              Math.max(1e-3, Math.abs(v as number) * 1e-6),
            `${c.type} ${permStr} v=${v} got=${dec.value}`
          )
      }
    }
  }
})

test('float NaN/Inf flagged invalid', () => {
  const perm = parseByteOrder('BE', 4)
  const nan = Buffer.from([0x7f, 0xc0, 0x00, 0x00])
  assert.equal(decodeValue('float32', nan, 0, perm).invalid, true)
  const inf = Buffer.from([0x7f, 0x80, 0x00, 0x00])
  assert.equal(decodeValue('float32', inf, 0, perm).invalid, true)
})

test('bcd16 decode/encode', () => {
  const perm = parseByteOrder('BE', 2)
  // 0x1234 => 1234 decimal
  const wire = Buffer.from([0x12, 0x34])
  assert.equal(decodeValue('bcd16', wire, 0, perm).value, 1234)
  // invalid nibble
  assert.equal(decodeValue('bcd16', Buffer.from([0x1a, 0x34]), 0, perm).invalid, true)
  const enc = encodeValue('bcd16', 5678, perm)
  assert.deepEqual([...enc], [0x56, 0x78])
})

test('string decode with AB and BA register order', () => {
  const perm = parseByteOrder('BE', 2)
  // "AB" order: bytes as-is
  const abWire = Buffer.from('Hello\0\0\0', 'latin1')
  const ab = decodeValue('string', abWire, 0, perm, {
    bytes: 8,
    encoding: 'latin1',
    regOrder: 'AB',
  })
  assert.equal(ab.value, 'Hello')
  // "BA" swaps bytes within each register. For "ABCD" (2 registers) the wire
  // bytes are "BADC"; decoding with BA must recover "ABCD".
  const baRaw = Buffer.from('BADC', 'latin1')
  const ba = decodeValue('string', baRaw, 0, perm, {
    bytes: 4,
    encoding: 'latin1',
    regOrder: 'BA',
  })
  assert.equal(ba.value, 'ABCD')
})

test('bitstring16 produces bit array json', () => {
  const perm = parseByteOrder('BE', 2)
  const res = decodeValue('bitstring16', Buffer.from([0x00, 0x05]), 0, perm)
  assert.equal(res.value, 0x0005)
  assert.deepEqual(res.json, [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('encode out-of-range throws', () => {
  const perm = parseByteOrder('BE', 2)
  assert.throws(() => encodeValue('uint16', 70000, perm))
  assert.throws(() => encodeValue('int16', 40000, perm))
})

// Enumerate all permutation strings of the first `width` letters.
function enumeratePerms(width: number): string[] {
  const letters = 'ABCDEFGH'.slice(0, width).split('')
  const out: string[] = []
  const permute = (arr: string[], cur: string[]) => {
    if (arr.length === 0) {
      out.push(cur.join(''))
      return
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1))
      permute(rest, cur.concat(arr[i]!))
    }
  }
  permute(letters, [])
  return out
}
