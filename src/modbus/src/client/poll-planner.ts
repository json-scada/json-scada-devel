/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Poll planner: turns the list of tags bound to a connection into an optimized
// set of read blocks, coalescing adjacent addresses (within maxAddressGap) up to
// the per-request size limits, one plan per (unitId, area).

import {
  parseObjectAddress,
  parseAsdu,
  isBitArea,
  type Area,
  type ParsedAsdu,
} from '../core/address.js'
import { FC } from '../core/pdu.js'

export interface TagBinding {
  id: unknown // realtimeData _id
  tag: string
  unitId: number
  area: Area
  offset: number
  bit: number | null
  asdu: ParsedAsdu
  kconv1: number
  kconv2: number
  span: number // registers or bits occupied
}

export interface TagSlice {
  binding: TagBinding
  // start offset relative to the block's start (in registers for reg areas,
  // in bits for bit areas)
  relStart: number
}

export interface ReadBlock {
  unitId: number
  area: Area
  fc: 1 | 2 | 3 | 4
  startAddr: number
  count: number // registers or coils
  slices: TagSlice[]
}

export interface AsduDefaults {
  byteOrder16: string
  byteOrder32: string
  byteOrder64: string
  byteOrderStr: string
  stringEncoding: 'latin1' | 'utf8' | 'ascii'
}

export interface PlannerLimits {
  maxReadRegisters: number
  maxReadCoils: number
  maxAddressGap: number
  useModicon: boolean
}

// Build a TagBinding from raw protocolSource* fields. Returns null (with reason)
// when the tag address/ASDU is unparseable.
export function buildBinding(
  raw: {
    id: unknown
    tag: string
    objectAddress: string
    asdu: string | null
    commonAddress: unknown
    kconv1: unknown
    kconv2: unknown
  },
  defaults: AsduDefaults,
  useModicon: boolean
): { binding?: TagBinding; error?: string } {
  try {
    const addr = parseObjectAddress(raw.objectAddress, useModicon)
    const asdu = parseAsdu(raw.asdu, addr.area, defaults)
    const span = isBitArea(addr.area) ? 1 : Math.max(1, asdu.regCount)
    const unitId = clampUnit(raw.commonAddress)
    return {
      binding: {
        id: raw.id,
        tag: raw.tag,
        unitId,
        area: addr.area,
        offset: addr.offset,
        bit: addr.bit,
        asdu,
        kconv1: toNum(raw.kconv1, 1),
        kconv2: toNum(raw.kconv2, 0),
        span,
      },
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Compute the ordered read plan for a set of bindings.
export function planReads(
  bindings: TagBinding[],
  limits: PlannerLimits
): ReadBlock[] {
  const groups = new Map<string, TagBinding[]>()
  for (const b of bindings) {
    const key = `${b.unitId}:${b.area}`
    let list = groups.get(key)
    if (!list) groups.set(key, (list = []))
    list.push(b)
  }

  const blocks: ReadBlock[] = []
  for (const [, list] of groups) {
    list.sort((a, b) => a.offset - b.offset)
    const first = list[0]!
    const bit = isBitArea(first.area)
    const maxCount = bit ? limits.maxReadCoils : limits.maxReadRegisters
    const fc = fcForArea(first.area)

    let blockStart = first.offset
    let blockEnd = first.offset + first.span // exclusive
    let slices: TagSlice[] = [{ binding: first, relStart: 0 }]

    const flush = () => {
      blocks.push({
        unitId: first.unitId,
        area: first.area,
        fc,
        startAddr: blockStart,
        count: blockEnd - blockStart,
        slices,
      })
    }

    for (let i = 1; i < list.length; i++) {
      const b = list[i]!
      const tentativeEnd = Math.max(blockEnd, b.offset + b.span)
      const gap = b.offset - blockEnd
      const fits = tentativeEnd - blockStart <= maxCount && gap <= limits.maxAddressGap
      if (fits) {
        blockEnd = tentativeEnd
        slices.push({ binding: b, relStart: b.offset - blockStart })
      } else {
        flush()
        blockStart = b.offset
        blockEnd = b.offset + b.span
        slices = [{ binding: b, relStart: 0 }]
      }
    }
    flush()
  }
  return blocks
}

function fcForArea(area: Area): 1 | 2 | 3 | 4 {
  switch (area) {
    case 'co':
      return FC.READ_COILS
    case 'di':
      return FC.READ_DISCRETE_INPUTS
    case 'hr':
      return FC.READ_HOLDING_REGISTERS
    case 'ir':
      return FC.READ_INPUT_REGISTERS
  }
}

function clampUnit(v: unknown): number {
  const n = Math.round(toNum(v, 1))
  if (n < 0 || n > 255) return 1
  return n
}

function toNum(v: unknown, dflt: number): number {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
