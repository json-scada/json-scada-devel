/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// In-memory register/coil banks for the server, keyed by (unitId, area). Values
// are pre-encoded so serving a read is a pure memory copy with no Mongo access.
// Also owns the mapping from written addresses back to the command tags.

import Log from '../common/simple-logger.js'
import { encodeValue, decodeValue } from '../core/datacodec.js'
import {
  parseObjectAddress,
  parseAsdu,
  isBitArea,
  isWritableArea,
  type Area,
  type ParsedAsdu,
} from '../core/address.js'
import type { ModbusServerConnection } from './conn-config.js'

export type TagType = 'analog' | 'digital' | 'string'

export interface ServerPoint {
  id: unknown // realtimeData _id
  pointKey: number
  tag: string
  unitId: number
  area: Area
  offset: number
  bit: number | null
  asdu: ParsedAsdu
  // protocolDestination scaling, applied when encoding the supervised value OUT.
  kconv1: number
  kconv2: number
  span: number // registers or bits
  isCommand: boolean // has a protocolSource (can relay writes)
  // tag-level fields from realtimeData, used when routing a received write as a
  // command (see PointMap.routeCommandValue):
  tagType: TagType
  tagKconv1: number
  tagKconv2: number
  // command routing fields copied from the tag's protocolSource*:
  cmdConnectionNumber: number | null
  cmdCommonAddress: number | null
  cmdObjectAddress: string | null
  cmdAsdu: string | null
}

interface UnitBanks {
  // register areas: Map<offset, uint16 word>
  hr: Map<number, number>
  ir: Map<number, number>
  // bit areas: Map<offset, boolean>
  co: Map<number, boolean>
  di: Map<number, boolean>
}

function emptyBanks(): UnitBanks {
  return { hr: new Map(), ir: new Map(), co: new Map(), di: new Map() }
}

export class PointMap {
  private units = new Map<number, UnitBanks>()
  // command lookup: `${unitId}:${area}:${offset}` -> point (first writable point covering that address)
  private writeIndex = new Map<string, ServerPoint>()
  private points: ServerPoint[] = []

  constructor(private readonly cfg: ModbusServerConnection) {}

  get servedUnits(): number[] {
    return [...this.units.keys()]
  }

  acceptsUnit(unitId: number): boolean {
    if (!this.cfg.strictUnitId) return true
    return (
      this.cfg.serverUnitIds.includes(unitId) || this.units.has(unitId)
    )
  }

  // Rebuild the map from a full set of tag documents.
  rebuild(
    docs: Array<{
      _id: unknown
      tag: string
      type: unknown
      value: unknown
      valueString: unknown
      invalid: unknown
      origin: unknown
      kconv1: unknown
      kconv2: unknown
      protocolSourceConnectionNumber: unknown
      protocolSourceCommonAddress: unknown
      protocolSourceObjectAddress: unknown
      protocolSourceASDU: unknown
      dest: Record<string, unknown>
    }>
  ): void {
    this.units = new Map()
    this.writeIndex = new Map()
    this.points = []

    const defaults = {
      byteOrder16: this.cfg.byteOrder16,
      byteOrder32: this.cfg.byteOrder32,
      byteOrder64: this.cfg.byteOrder64,
      byteOrderStr: this.cfg.byteOrderStr,
      stringEncoding: this.cfg.stringEncoding,
    }

    for (const d of docs) {
      try {
        const objAddr = String(d.dest.protocolDestinationObjectAddress ?? '')
        const addr = parseObjectAddress(objAddr, this.cfg.useModiconAddresses)
        const asdu = parseAsdu(
          (d.dest.protocolDestinationASDU as string) ?? null,
          addr.area,
          defaults
        )
        const unitId = clampUnit(d.dest.protocolDestinationCommonAddress)
        const span = isBitArea(addr.area) ? 1 : Math.max(1, asdu.regCount)
        const isCommand =
          d.origin === 'command' ||
          (d.protocolSourceConnectionNumber !== null &&
            d.protocolSourceConnectionNumber !== undefined)

        const point: ServerPoint = {
          id: d._id,
          pointKey: Number(d._id),
          tag: String(d.tag ?? ''),
          unitId,
          area: addr.area,
          offset: addr.offset,
          bit: addr.bit,
          asdu,
          kconv1: toNum(d.dest.protocolDestinationKConv1, 1),
          kconv2: toNum(d.dest.protocolDestinationKConv2, 0),
          span,
          isCommand,
          tagType: normalizeType(d.type),
          tagKconv1: toNum(d.kconv1, 1),
          tagKconv2: toNum(d.kconv2, 0),
          cmdConnectionNumber: isCommand
            ? toNumOrNull(d.protocolSourceConnectionNumber)
            : null,
          cmdCommonAddress: isCommand
            ? toNumOrNull(d.protocolSourceCommonAddress)
            : null,
          cmdObjectAddress: isCommand
            ? String(d.protocolSourceObjectAddress ?? '')
            : null,
          cmdAsdu: isCommand ? ((d.protocolSourceASDU as string) ?? null) : null,
        }
        this.registerPoint(point)
        this.encodeInto(point, d.value, d.valueString, Boolean(d.invalid))
      } catch (e) {
        Log.log(
          `${this.cfg.name}: skipping destination for tag ${String(d.tag)}: ${
            (e as Error).message
          }`,
          Log.levelDetailed
        )
      }
    }
    Log.log(
      `${this.cfg.name}: mapped ${this.points.length} points across ${this.units.size} unit(s)`
    )
  }

  private registerPoint(point: ServerPoint): void {
    this.points.push(point)
    if (!this.units.has(point.unitId))
      this.units.set(point.unitId, emptyBanks())
    // Index writable addresses for command relay.
    if (point.isCommand && isWritableArea(point.area)) {
      for (let i = 0; i < point.span; i++) {
        const key = `${point.unitId}:${point.area}:${point.offset + i}`
        if (!this.writeIndex.has(key)) this.writeIndex.set(key, point)
      }
    }
  }

  // Encode a tag's current value into the register/coil bank. Only the
  // protocolDestination scaling is applied here: realtimeData.value is already
  // the engineering value (cs_data_processor applied the tag-level kconv when
  // deriving it from valueAtSource), so re-applying tagKconv would double-scale.
  encodeInto(
    point: ServerPoint,
    value: unknown,
    valueString: unknown,
    invalid: boolean
  ): void {
    const banks = this.units.get(point.unitId)
    if (!banks) return
    if (invalid && this.cfg.invalidValuePolicy === 'zero') {
      this.zeroOut(point)
      return
    }

    if (isBitArea(point.area)) {
      let on = Number(value) !== 0
      if (point.kconv1 === -1) on = !on
      const map = point.area === 'co' ? banks.co : banks.di
      map.set(point.offset, on)
      return
    }

    if (point.bit !== null) {
      // Set/clear a single bit within a holding/input register word.
      const map = point.area === 'hr' ? banks.hr : banks.ir
      const cur = map.get(point.offset) ?? 0
      const on = Number(value) !== 0
      const word = on ? cur | (1 << point.bit) : cur & ~(1 << point.bit)
      map.set(point.offset, word & 0xffff)
      return
    }

    try {
      let eng: number | string
      if (point.asdu.type === 'string') {
        eng = String(valueString ?? '')
      } else {
        eng = Number(value) * point.kconv1 + point.kconv2
      }
      const wire = encodeValue(point.asdu.type, eng, point.asdu.perm, point.asdu.str)
      const map = point.area === 'hr' ? banks.hr : banks.ir
      for (let i = 0; i < point.span; i++) {
        map.set(point.offset + i, wire.readUInt16BE(i * 2))
      }
    } catch (e) {
      Log.log(
        `${this.cfg.name}: encode error tag ${point.tag}: ${(e as Error).message}`,
        Log.levelDetailed
      )
    }
  }

  private zeroOut(point: ServerPoint): void {
    const banks = this.units.get(point.unitId)!
    if (isBitArea(point.area)) {
      const map = point.area === 'co' ? banks.co : banks.di
      map.set(point.offset, false)
    } else {
      const map = point.area === 'hr' ? banks.hr : banks.ir
      for (let i = 0; i < point.span; i++) map.set(point.offset + i, 0)
    }
  }

  findById(id: unknown): ServerPoint | undefined {
    const s = String(id)
    return this.points.find((p) => String(p.id) === s)
  }

  // ----- read serving -----

  readBits(unitId: number, area: 'co' | 'di', start: number, qty: number): boolean[] | null {
    const banks = this.units.get(unitId)
    if (!banks && !this.cfg.serveUnmappedAsZero) return null
    const map = banks ? (area === 'co' ? banks.co : banks.di) : null
    const out: boolean[] = []
    for (let i = 0; i < qty; i++) {
      const v = map?.get(start + i)
      if (v === undefined && !this.cfg.serveUnmappedAsZero) return null
      out.push(v ?? false)
    }
    return out
  }

  readRegisters(
    unitId: number,
    area: 'hr' | 'ir',
    start: number,
    qty: number
  ): Buffer | null {
    const banks = this.units.get(unitId)
    if (!banks && !this.cfg.serveUnmappedAsZero) return null
    const map = banks ? (area === 'hr' ? banks.hr : banks.ir) : null
    const buf = Buffer.alloc(qty * 2)
    for (let i = 0; i < qty; i++) {
      const v = map?.get(start + i)
      if (v === undefined && !this.cfg.serveUnmappedAsZero) return null
      buf.writeUInt16BE((v ?? 0) & 0xffff, i * 2)
    }
    return buf
  }

  // ----- write routing -----

  // Look up the command point at a written address, if any.
  lookupWrite(unitId: number, area: Area, offset: number): ServerPoint | undefined {
    return this.writeIndex.get(`${unitId}:${area}:${offset}`)
  }

  // Decode a written coil/register span into the RAW value the master intended,
  // using the point's ASDU byte order but WITHOUT any scaling. A bit-in-register
  // point yields 0/1. The command scaling is applied later by routeCommandValue.
  decodeWrittenValue(
    point: ServerPoint,
    registers: Buffer
  ): number | bigint | boolean | string {
    if (point.bit !== null) {
      const word = registers.readUInt16BE(0)
      return ((word >> point.bit) & 1) === 1 ? 1 : 0
    }
    const dec = decodeValue(
      point.asdu.type,
      registers,
      0,
      point.asdu.perm,
      point.asdu.str
    )
    return dec.value
  }

  // Compute the value to route as a JSON-SCADA command from a raw written value.
  // BOTH the protocolDestination scaling (point.kconv1/kconv2) and the tag-level
  // realtimeData scaling (point.tagKconv1/tagKconv2) are applied:
  //   digital : forced to 1/0, inverted iff exactly one of the two kconv1 is -1
  //   analog  : (raw*destKconv1 + destKconv2)*tagKconv1 + tagKconv2
  //   string  : the decoded string, value 0
  routeCommandValue(
    point: ServerPoint,
    raw: number | bigint | boolean | string
  ): { value: number; valueString: string } {
    if (point.tagType === 'digital') {
      let bit = Number(raw) !== 0 ? 1 : 0
      // Compose the two inversions: destination -1 and tag-level -1 cancel out.
      const invert = (point.kconv1 === -1) !== (point.tagKconv1 === -1)
      if (invert) bit = bit === 1 ? 0 : 1
      return { value: bit, valueString: String(bit) }
    }
    if (point.tagType === 'string') {
      const s = typeof raw === 'string' ? raw : String(raw)
      return { value: 0, valueString: s }
    }
    // analog: destination scaling first, then tag-level scaling
    const dest = Number(raw) * point.kconv1 + point.kconv2
    const value = dest * point.tagKconv1 + point.tagKconv2
    return { value, valueString: String(value) }
  }
}

function clampUnit(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0 || n > 255) return 1
  return n
}
function toNum(v: unknown, dflt: number): number {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function normalizeType(v: unknown): TagType {
  const s = String(v ?? '').toLowerCase()
  if (s === 'digital') return 'digital'
  if (s === 'string') return 'string'
  return 'analog'
}
