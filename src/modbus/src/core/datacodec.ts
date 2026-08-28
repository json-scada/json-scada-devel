/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Byte-order-aware codec converting between Modbus register buffers and JS values.
//
// On the wire, register contents are ALWAYS 16-bit words, big-endian within each
// word, in ascending register order. A logical N-byte value therefore occupies
// ceil(N/2) registers whose raw bytes, in wire order, we label A B C D E F G H...
// (A = high byte of the lowest-addressed register).
//
// A non-standard device may store the logical value with the bytes permuted. We
// model that with an explicit byte permutation: read the wire buffer, reorder its
// bytes into canonical big-endian order per the permutation, then decode with a
// DataView as big-endian. Encoding is the exact inverse permutation. This single
// mechanism expresses EVERY possible byte order (all N! permutations), not just a
// fixed set of swap modes.

export type ValueType =
  | 'bool'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float32'
  | 'float64'
  | 'bcd16'
  | 'bcd32'
  | 'bitstring16'
  | 'string'

// Width in bytes for each register-backed value type (string is variable).
const TYPE_BYTES: Record<Exclude<ValueType, 'bool' | 'string'>, number> = {
  int16: 2,
  uint16: 2,
  bcd16: 2,
  bitstring16: 2,
  int32: 4,
  uint32: 4,
  bcd32: 4,
  float32: 4,
  int64: 8,
  uint64: 8,
  float64: 8,
}

// Named byte-order aliases per width. Values are permutation strings over the
// first `width` letters (A=index 0 ... ). "Standard" (BE) is the identity.
const ALIASES: Record<number, Record<string, string>> = {
  2: { BE: 'AB', LE: 'BA', SW: 'AB', SB: 'BA' },
  4: { BE: 'ABCD', LE: 'DCBA', SW: 'CDAB', SB: 'BADC' },
  8: {
    BE: 'ABCDEFGH',
    LE: 'HGFEDCBA',
    SW: 'GHEFCDAB',
    SB: 'BADCFEHG',
  },
}

// Synonyms accepted for migration from the PLC4X/PLC4J drivers.
const SYNONYMS: Record<string, string> = {
  BIG_ENDIAN: 'BE',
  LITTLE_ENDIAN: 'LE',
  REV_ENDIAN: 'LE',
  '': 'BE',
}

// A compiled permutation: perm[i] = source byte index in the wire buffer that
// belongs at canonical (big-endian) position i.
export class BytePermutation {
  readonly width: number
  readonly perm: number[]
  private readonly inverse: number[]

  constructor(width: number, perm: number[]) {
    this.width = width
    this.perm = perm
    this.inverse = new Array<number>(width)
    for (let i = 0; i < width; i++) this.inverse[perm[i]!] = i
  }

  // Reorder `width` wire bytes at wireBuf[offset..] into canonical big-endian.
  toCanonical(wireBuf: Buffer, offset: number): Buffer {
    const out = Buffer.allocUnsafe(this.width)
    for (let i = 0; i < this.width; i++) out[i] = wireBuf[offset + this.perm[i]!]!
    return out
  }

  // Reorder a canonical big-endian buffer back into wire order.
  fromCanonical(canonical: Buffer): Buffer {
    const out = Buffer.allocUnsafe(this.width)
    for (let i = 0; i < this.width; i++) out[i] = canonical[this.inverse[i]!]!
    return out
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOP'

// Parse a byte-order spec (alias, synonym, or explicit permutation string) into
// a compiled BytePermutation for the given byte width. Throws on invalid input.
export function parseByteOrder(spec: string, width: number): BytePermutation {
  if (width === 1) return new BytePermutation(1, [0])
  let s = (spec || '').trim().toUpperCase()
  if (s in SYNONYMS) s = SYNONYMS[s]!
  const aliasTable = ALIASES[width]
  if (aliasTable && s in aliasTable) s = aliasTable[s]!

  if (s.length !== width) {
    throw new Error(
      `Invalid byte order "${spec}" for ${width}-byte value: expected a ${width}-letter permutation or a named alias`
    )
  }
  const perm: number[] = []
  const seen = new Set<number>()
  const expected = LETTERS.slice(0, width)
  for (const ch of s) {
    const idx = expected.indexOf(ch)
    if (idx < 0 || seen.has(idx)) {
      throw new Error(
        `Invalid byte order "${spec}": must be a permutation of "${expected}"`
      )
    }
    seen.add(idx)
    perm.push(idx)
  }
  return new BytePermutation(width, perm)
}

export interface StringOptions {
  // number of characters (bytes); registers = ceil(bytes/2)
  bytes: number
  // encoding of the extracted bytes
  encoding: 'latin1' | 'utf8' | 'ascii'
  // per-register byte order: 'AB' (default) or 'BA' (swapped)
  regOrder: 'AB' | 'BA'
}

export interface DecodeResult {
  value: number | bigint | boolean | string
  // true if the raw content cannot represent a valid finite value (NaN/Inf)
  invalid: boolean
  // optional JSON representation (bit arrays for bitstrings)
  json?: unknown
}

// Number of 16-bit registers a value type occupies.
export function registerCount(type: ValueType, str?: StringOptions): number {
  if (type === 'bool') return 0 // bit areas are addressed as coils, not registers
  if (type === 'string') {
    if (!str) throw new Error('string type requires StringOptions')
    return Math.ceil(str.bytes / 2)
  }
  return TYPE_BYTES[type] / 2
}

// Decode a value of `type` from `regs` (a big-endian wire buffer of registers),
// starting at register index `regIndex`, applying the given byte permutation.
export function decodeValue(
  type: ValueType,
  regs: Buffer,
  regIndex: number,
  perm: BytePermutation,
  str?: StringOptions
): DecodeResult {
  const byteOffset = regIndex * 2

  if (type === 'string') {
    if (!str) throw new Error('string type requires StringOptions')
    return decodeString(regs, byteOffset, str)
  }

  const canonical = perm.toCanonical(regs, byteOffset)
  const dv = new DataView(
    canonical.buffer,
    canonical.byteOffset,
    canonical.byteLength
  )

  switch (type) {
    case 'uint16':
      return { value: dv.getUint16(0, false), invalid: false }
    case 'int16':
      return { value: dv.getInt16(0, false), invalid: false }
    case 'uint32':
      return { value: dv.getUint32(0, false), invalid: false }
    case 'int32':
      return { value: dv.getInt32(0, false), invalid: false }
    case 'uint64':
      return { value: dv.getBigUint64(0, false), invalid: false }
    case 'int64':
      return { value: dv.getBigInt64(0, false), invalid: false }
    case 'float32': {
      const v = dv.getFloat32(0, false)
      return { value: v, invalid: !Number.isFinite(v) }
    }
    case 'float64': {
      const v = dv.getFloat64(0, false)
      return { value: v, invalid: !Number.isFinite(v) }
    }
    case 'bcd16':
      return decodeBcd(canonical, 2)
    case 'bcd32':
      return decodeBcd(canonical, 4)
    case 'bitstring16': {
      const raw = dv.getUint16(0, false)
      const bits: number[] = []
      for (let b = 0; b < 16; b++) bits.push((raw >>> b) & 1)
      return { value: raw, invalid: false, json: bits }
    }
    default:
      throw new Error(`Unsupported decode type: ${type as string}`)
  }
}

// Encode a JS value of `type` into a big-endian wire register buffer, applying
// the inverse byte permutation. Returns a Buffer of registerCount()*2 bytes.
export function encodeValue(
  type: ValueType,
  value: number | bigint | boolean | string,
  perm: BytePermutation,
  str?: StringOptions
): Buffer {
  if (type === 'string') {
    if (!str) throw new Error('string type requires StringOptions')
    return encodeString(value == null ? '' : String(value), str)
  }
  if (type === 'bool') throw new Error('bool has no register encoding')

  // Narrow away 'bool' | 'string': `value` is numeric from here on.
  const numValue = value as number | bigint | boolean
  const width = TYPE_BYTES[type]
  const canonical = Buffer.alloc(width)
  const dv = new DataView(
    canonical.buffer,
    canonical.byteOffset,
    canonical.byteLength
  )

  switch (type) {
    case 'uint16':
      dv.setUint16(0, clampUint(numValue, 0xffff), false)
      break
    case 'int16':
      dv.setInt16(0, clampInt(numValue, -0x8000, 0x7fff), false)
      break
    case 'uint32':
      dv.setUint32(0, clampUint(numValue, 0xffffffff), false)
      break
    case 'int32':
      dv.setInt32(0, clampInt(numValue, -0x80000000, 0x7fffffff), false)
      break
    case 'uint64':
      dv.setBigUint64(0, toBigInt(numValue) & 0xffffffffffffffffn, false)
      break
    case 'int64':
      dv.setBigInt64(0, BigInt.asIntN(64, toBigInt(numValue)), false)
      break
    case 'float32':
      dv.setFloat32(0, Number(numValue), false)
      break
    case 'float64':
      dv.setFloat64(0, Number(numValue), false)
      break
    case 'bcd16':
      encodeBcd(canonical, Number(numValue), 2)
      break
    case 'bcd32':
      encodeBcd(canonical, Number(numValue), 4)
      break
    case 'bitstring16':
      dv.setUint16(0, clampUint(numValue, 0xffff), false)
      break
    default:
      throw new Error(`Unsupported encode type: ${type as string}`)
  }

  return perm.fromCanonical(canonical)
}

function decodeString(
  regs: Buffer,
  byteOffset: number,
  str: StringOptions
): DecodeResult {
  const numRegs = Math.ceil(str.bytes / 2)
  const raw = Buffer.allocUnsafe(numRegs * 2)
  regs.copy(raw, 0, byteOffset, byteOffset + numRegs * 2)
  if (str.regOrder === 'BA') {
    for (let i = 0; i < numRegs; i++) {
      const t = raw[i * 2]!
      raw[i * 2] = raw[i * 2 + 1]!
      raw[i * 2 + 1] = t
    }
  }
  const sliced = raw.subarray(0, str.bytes)
  // Trim at first NUL, then trailing whitespace.
  let end = sliced.length
  for (let i = 0; i < sliced.length; i++) {
    if (sliced[i] === 0) {
      end = i
      break
    }
  }
  const value = sliced.toString(str.encoding, 0, end).replace(/\s+$/, '')
  return { value, invalid: false }
}

function encodeString(value: string, str: StringOptions): Buffer {
  const numRegs = Math.ceil(str.bytes / 2)
  const raw = Buffer.alloc(numRegs * 2)
  Buffer.from(value, str.encoding).copy(raw, 0, 0, str.bytes)
  if (str.regOrder === 'BA') {
    for (let i = 0; i < numRegs; i++) {
      const t = raw[i * 2]!
      raw[i * 2] = raw[i * 2 + 1]!
      raw[i * 2 + 1] = t
    }
  }
  return raw
}

function decodeBcd(canonical: Buffer, bytes: number): DecodeResult {
  let result = 0
  for (let i = 0; i < bytes; i++) {
    const hi = (canonical[i]! >>> 4) & 0x0f
    const lo = canonical[i]! & 0x0f
    if (hi > 9 || lo > 9) return { value: 0, invalid: true }
    result = result * 100 + hi * 10 + lo
  }
  return { value: result, invalid: false }
}

function encodeBcd(canonical: Buffer, value: number, bytes: number): void {
  let v = Math.max(0, Math.round(value))
  for (let i = bytes - 1; i >= 0; i--) {
    const lo = v % 10
    v = Math.floor(v / 10)
    const hi = v % 10
    v = Math.floor(v / 10)
    canonical[i] = (hi << 4) | lo
  }
}

function clampUint(value: number | bigint | boolean, max: number): number {
  const v = Math.round(Number(value))
  if (v < 0 || v > max)
    throw new RangeError(`value ${v} out of range [0, ${max}]`)
  return v
}

function clampInt(value: number | bigint | boolean, min: number, max: number): number {
  const v = Math.round(Number(value))
  if (v < min || v > max)
    throw new RangeError(`value ${v} out of range [${min}, ${max}]`)
  return v
}

function toBigInt(value: number | bigint | boolean): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'boolean') return value ? 1n : 0n
  return BigInt(Math.round(value))
}
