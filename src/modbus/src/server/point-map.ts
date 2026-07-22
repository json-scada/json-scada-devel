/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// In-memory register/coil banks for the server, keyed by (unitId, area). Values
// are pre-encoded so serving a read is a pure memory copy with no Mongo access.
// Also owns the mapping from written addresses back to the command tags.

import Log from '../common/simple-logger.js'
import {
  encodeValue,
  decodeValue,
  type ValueType,
} from '../core/datacodec.js'
import {
  parseObjectAddress,
  parseAsdu,
  isBitArea,
  isWritableArea,
  type Area,
  type ParsedAsdu,
} from '../core/address.js'
import type { ModbusServerConnection } from './conn-config.js'

export interface ServerPoint {
  id: unknown // realtimeData _id
  pointKey: number
  tag: string
  unitId: number
  area: Area
  offset: number
  bit: number | null
  asdu: ParsedAsdu
  kconv1: number
  kconv2: number
  span: number // registers or bits
  isCommand: boolean // has a protocolSource (can relay writes)
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
      value: unknown
      valueString: unknown
      invalid: unknown
      origin: unknown
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

  // Encode a tag's current value into the register/coil bank.
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

  // Decode a written coil/register span back to an engineering value using the
  // point's ASDU. Used by the write handler to build the relayed command value.
  decodeWrittenRegisters(point: ServerPoint, registers: Buffer): {
    value: number | bigint | boolean | string
    valueString: string
    type: ValueType
  } {
    if (point.bit !== null) {
      const word = registers.readUInt16BE(0)
      const on = ((word >> point.bit) & 1) === 1
      return { value: on ? 1 : 0, valueString: on ? '1' : '0', type: 'bool' }
    }
    const dec = decodeValue(point.asdu.type, registers, 0, point.asdu.perm, point.asdu.str)
    let value = dec.value
    if (typeof value === 'number' && point.asdu.type !== 'string') {
      value = value * point.kconv1 + point.kconv2
    }
    return {
      value,
      valueString: typeof value === 'string' ? value : String(value),
      type: point.asdu.type,
    }
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
