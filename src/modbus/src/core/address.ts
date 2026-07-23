/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Parsers for the JSON-SCADA tag address / ASDU grammar used by the Modbus
// drivers.
//
// Object address:  <area>:<offset>[.b<bit>]
//   area   = co | di | hr | ir           (0-based PDU addressing)
//   offset = 0..65535
//   .b<bit>= optional bit 0..15 within a register (hr/ir only)
// Modicon compatibility (when enabled): plain numeric 1-based references such as
//   40001 -> hr:0, 30011 -> ir:10, 00001/1 -> co:0, 10005 -> di:4.
// PLC4X compatibility: holding-register:4 / input-register:4 / coil:4 / discrete-input:4.
//
// ASDU:  <type>[_<byteOrder>]   e.g. float32_cdab, int32_le, uint16, string:16_ba

import {
  parseByteOrder,
  registerCount,
  type BytePermutation,
  type StringOptions,
  type ValueType,
} from './datacodec.js'

export type Area = 'co' | 'di' | 'hr' | 'ir'

export interface ParsedAddress {
  area: Area
  offset: number
  bit: number | null // bit index for packed-in-register digitals, else null
}

const AREA_ALIASES: Record<string, Area> = {
  co: 'co',
  coil: 'co',
  coils: 'co',
  di: 'di',
  'discrete-input': 'di',
  'discrete-inputs': 'di',
  discreteinput: 'di',
  hr: 'hr',
  'holding-register': 'hr',
  'holding-registers': 'hr',
  holding: 'hr',
  ir: 'ir',
  'input-register': 'ir',
  'input-registers': 'ir',
  input: 'ir',
}

export function isBitArea(area: Area): boolean {
  return area === 'co' || area === 'di'
}

export function isWritableArea(area: Area): boolean {
  return area === 'co' || area === 'hr'
}

// Parse an object address string. `useModicon` enables plain-numeric 1-based refs.
export function parseObjectAddress(
  raw: string,
  useModicon = false
): ParsedAddress {
  const s = String(raw).trim()

  // Modicon plain-numeric form.
  if (useModicon && /^\d+$/.test(s)) {
    return parseModicon(s)
  }

  const m = /^([a-zA-Z-]+)\s*:\s*(\d+)(?:\.b(\d+))?$/.exec(s)
  if (!m) {
    throw new Error(`Invalid Modbus object address: "${raw}"`)
  }
  const areaKey = m[1]!.toLowerCase()
  const area = AREA_ALIASES[areaKey]
  if (!area) throw new Error(`Unknown Modbus area "${m[1]}" in "${raw}"`)

  const offset = parseInt(m[2]!, 10)
  if (offset < 0 || offset > 0xffff)
    throw new Error(`Modbus address offset out of range in "${raw}"`)

  let bit: number | null = null
  if (m[3] !== undefined) {
    if (isBitArea(area))
      throw new Error(`Bit suffix .b not allowed on bit area in "${raw}"`)
    bit = parseInt(m[3], 10)
    if (bit < 0 || bit > 15)
      throw new Error(`Bit index out of range 0..15 in "${raw}"`)
  }
  return { area, offset, bit }
}

function parseModicon(s: string): ParsedAddress {
  const n = parseInt(s, 10)
  // 5-digit (1-based within 1..65536 block) or 6-digit references.
  // 0xxxx -> coils, 1xxxx -> discrete inputs, 3xxxx -> input regs, 4xxxx -> holding.
  let area: Area
  let base: number
  const str = s
  const lead = str.length >= 5 ? parseInt(str[0]!, 10) : 0
  if (str.length >= 5 && (lead === 0 || lead === 1 || lead === 3 || lead === 4)) {
    base = parseInt(str.slice(1), 10)
    area = lead === 0 ? 'co' : lead === 1 ? 'di' : lead === 3 ? 'ir' : 'hr'
  } else {
    // Bare number 1..N: treat as coil reference.
    area = 'co'
    base = n
  }
  const offset = base - 1
  if (offset < 0 || offset > 0xffff)
    throw new Error(`Modicon reference out of range: "${s}"`)
  return { area, offset, bit: null }
}

export interface ParsedAsdu {
  type: ValueType
  byteOrder: string // original spec, for logging / echo
  perm: BytePermutation
  str?: StringOptions
  regCount: number // registers occupied (0 for bool)
}

const TYPE_ALIASES: Record<string, ValueType> = {
  bool: 'bool',
  boolean: 'bool',
  bit: 'bool',
  coil: 'bool',
  digital: 'bool',
  int16: 'int16',
  short: 'int16',
  int: 'int16',
  uint16: 'uint16',
  word: 'uint16',
  uint: 'uint16',
  int32: 'int32',
  dint: 'int32',
  uint32: 'uint32',
  udint: 'uint32',
  dword: 'uint32',
  int64: 'int64',
  lint: 'int64',
  uint64: 'uint64',
  ulint: 'uint64',
  lword: 'uint64',
  float32: 'float32',
  float: 'float32',
  real: 'float32',
  float64: 'float64',
  double: 'float64',
  lreal: 'float64',
  bcd16: 'bcd16',
  bcd32: 'bcd32',
  bitstring16: 'bitstring16',
  bits: 'bitstring16',
  string: 'string',
}

// Parse an ASDU string into a value type + compiled byte order. `defaults`
// supplies the connection-level byte order per width when the ASDU omits it.
export function parseAsdu(
  raw: string | null | undefined,
  area: Area,
  defaults: {
    byteOrder16: string
    byteOrder32: string
    byteOrder64: string
    byteOrderStr: string
    stringEncoding?: 'latin1' | 'utf8' | 'ascii'
  }
): ParsedAsdu {
  let s = (raw ?? '').toString().trim().toLowerCase()

  // A bare byte-order token (BE/LE/SW/SB/permutation) with no type is accepted
  // for register areas, defaulting the type; the PLC4X driver used ASDU purely
  // for endianness, so keep that behavior for migration.
  if (s === '') {
    s = isBitArea(area) ? 'bool' : 'uint16'
  }

  // Split off an optional string byte count "string:N".
  let strBytes: number | null = null
  const strMatch = /^string:(\d+)(.*)$/.exec(s)
  if (strMatch) {
    strBytes = parseInt(strMatch[1]!, 10)
    s = 'string' + strMatch[2]
  }

  // Separate <type>_<byteorder>.
  let typeToken = s
  let orderToken = ''
  const us = s.indexOf('_')
  if (us >= 0) {
    typeToken = s.slice(0, us)
    orderToken = s.slice(us + 1)
  }

  // Bare byte-order alias with no recognizable type -> default numeric type.
  if (!(typeToken in TYPE_ALIASES)) {
    const bareOrder = s.toUpperCase()
    if (isByteOrderToken(bareOrder)) {
      orderToken = bareOrder
      typeToken = isBitArea(area) ? 'bool' : 'uint16'
    }
  }

  const type = TYPE_ALIASES[typeToken]
  if (!type) throw new Error(`Unknown Modbus ASDU type "${raw}"`)

  if (type === 'bool') {
    return {
      type,
      byteOrder: '',
      perm: parseByteOrder('', 1),
      regCount: 0,
    }
  }

  let str: StringOptions | undefined
  let width: number
  if (type === 'string') {
    const bytes = strBytes ?? 2
    str = {
      bytes,
      encoding: defaults.stringEncoding ?? 'latin1',
      regOrder: orderToken.toUpperCase() === 'BA' || orderToken.toUpperCase() === 'LE' ? 'BA' : 'AB',
    }
    width = 2 // per-register order handled inside the codec
  } else {
    width = registerCount(type) * 2
  }

  const order = orderToken || defaultOrderForWidth(width, defaults)
  const perm = parseByteOrder(order, width === 2 && type === 'string' ? 2 : width)

  return {
    type,
    byteOrder: order,
    perm,
    str,
    regCount: registerCount(type, str),
  }
}

function defaultOrderForWidth(
  width: number,
  d: { byteOrder16: string; byteOrder32: string; byteOrder64: string }
): string {
  switch (width) {
    case 2:
      return d.byteOrder16 || 'AB'
    case 4:
      return d.byteOrder32 || 'ABCD'
    case 8:
      return d.byteOrder64 || 'ABCDEFGH'
    default:
      return 'AB'
  }
}

function isByteOrderToken(s: string): boolean {
  if (['BE', 'LE', 'SW', 'SB', 'BIG_ENDIAN', 'LITTLE_ENDIAN', 'REV_ENDIAN'].includes(s))
    return true
  return /^[A-H]+$/.test(s) && new Set(s).size === s.length
}
