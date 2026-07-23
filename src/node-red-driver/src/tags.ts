/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// Tag identity helpers: auto-creation of supervised and command tags, key
// allocation, and value routing (analog/digital/string/json). The key scheme
// (_id = connectionNumber*MULT + seq) matches telegraf-listener / DNP3 / IEC.

import { Double, type Collection, type Filter, type Document } from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type { IngestPoint } from './types.js'

export type ResolvedType = 'analog' | 'digital' | 'string' | 'json'

export interface RoutedValue {
  type: ResolvedType
  valueAtSource: number
  valueStringAtSource: string
  valueJsonAtSource: unknown
}

// Determines the JSON-SCADA tag type and the three value projections from a raw
// flow value plus an optional declared pointType.
export function routeValue(
  value: unknown,
  pointType?: string
): RoutedValue {
  let type: ResolvedType
  if (pointType === 'analog' || pointType === 'digital' ||
      pointType === 'string' || pointType === 'json') {
    type = pointType
  } else if (typeof value === 'boolean') {
    type = 'digital'
  } else if (typeof value === 'number') {
    type = 'analog'
  } else if (value !== null && typeof value === 'object') {
    type = 'json'
  } else {
    type = 'string'
  }

  let valueAtSource = 0
  let valueStringAtSource = ''
  let valueJsonAtSource: unknown = null

  switch (type) {
    case 'digital':
      valueAtSource = value ? 1 : 0
      valueStringAtSource = value ? 'true' : 'false'
      break
    case 'analog': {
      const n = typeof value === 'number' ? value : parseFloat(String(value))
      valueAtSource = Number.isFinite(n) ? n : 0
      valueStringAtSource = String(value)
      break
    }
    case 'json':
      valueJsonAtSource =
        value !== null && typeof value === 'object' ? value : safeParse(value)
      valueStringAtSource =
        typeof value === 'string' ? value : JSON.stringify(value)
      valueAtSource = 0
      break
    case 'string':
    default: {
      valueStringAtSource = value === null ? '' : String(value)
      const n = parseFloat(valueStringAtSource)
      valueAtSource = Number.isFinite(n) ? n : 0
      break
    }
  }

  return { type, valueAtSource, valueStringAtSource, valueJsonAtSource }
}

function safeParse(v: unknown): unknown {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

// Splits an address using the '~' grouping separator into group1/2/3 + description,
// mirroring the telegraf-listener convention. Extra segments are folded into group3.
function deriveGroups(
  address: string,
  sep: string,
  point: IngestPoint
): {
  group1: string
  group2: string
  group3: string
  ungroupedDescription: string
} {
  const parts = address.split(sep)
  const group1 = point.group1 ?? (parts.length > 1 ? parts[0]! : '')
  const group2 = point.group2 ?? (parts.length > 2 ? parts[1]! : '')
  const group3 =
    point.group3 ?? (parts.length > 3 ? parts.slice(2, -1).join(sep) : '')
  const ungroupedDescription =
    point.ungroupedDescription ?? (parts.length > 1 ? parts[parts.length - 1]! : address)
  return { group1, group2, group3, ungroupedDescription }
}

// Allocates auto-created tag documents and caches which addresses already exist,
// so the ingest/command paths avoid redundant Mongo round-trips.
export class TagManager {
  private connectionNumber: number
  private groupSep: string
  private autoKeyId: number
  private known = new Set<string>()
  private commandKnown = new Set<string>()

  constructor(connectionNumber: number, groupSep: string) {
    this.connectionNumber = connectionNumber
    this.groupSep = groupSep
    this.autoKeyId = connectionNumber * AppDefs.AUTO_KEY_MULTIPLIER
  }

  markKnown(address: string): void {
    this.known.add(address)
  }
  isKnown(address: string): boolean {
    return this.known.has(address)
  }
  markCommandKnown(address: string): void {
    this.commandKnown.add(address)
  }
  isCommandKnown(address: string): boolean {
    return this.commandKnown.has(address)
  }

  private nextKey(): number {
    this.autoKeyId++
    return this.autoKeyId
  }

  // Ensures the supervised tag for an ingest point exists. Returns true if present
  // (already known, found, or newly created), false only on insert failure.
  async ensureSupervisedTag(
    collection: Collection,
    point: IngestPoint
  ): Promise<boolean> {
    if (this.known.has(point.address)) return true

    const existing = await collection
      .find({
        protocolSourceConnectionNumber: this.connectionNumber,
        protocolSourceObjectAddress: point.address,
      })
      .project({ _id: 1 })
      .toArray()

    if (existing.length > 0) {
      this.known.add(point.address)
      return true
    }

    const doc = this.buildSupervisedDoc(point)
    try {
      const res = await collection.insertOne(doc)
      if (res.acknowledged) {
        this.known.add(point.address)
        Log.log('Tags - Created supervised tag: ' + point.address, Log.levelDetailed)
        return true
      }
    } catch (e) {
      Log.log('Tags - Error inserting supervised tag ' + point.address + ': ' + e)
    }
    return false
  }

  // Ensures a command tag (origin:'command') exists for a commandable point declared
  // by a flow, cross-linking to a supervised twin when supervisedAddress is given.
  async ensureCommandTag(
    collection: Collection,
    point: IngestPoint
  ): Promise<boolean> {
    if (this.commandKnown.has(point.address)) return true

    const existing = await collection
      .find({
        protocolSourceConnectionNumber: this.connectionNumber,
        protocolSourceObjectAddress: point.address,
        origin: 'command',
      })
      .project({ _id: 1 })
      .toArray()

    if (existing.length > 0) {
      this.commandKnown.add(point.address)
      return true
    }

    const key = this.nextKey()
    const doc = this.buildCommandDoc(point, key)
    try {
      const res = await collection.insertOne(doc)
      if (!res.acknowledged) return false
      this.commandKnown.add(point.address)

      // cross-link to supervised twin if requested
      if (point.supervisedAddress) {
        const sup = await collection.findOne(
          {
            protocolSourceConnectionNumber: this.connectionNumber,
            protocolSourceObjectAddress: point.supervisedAddress,
            origin: 'supervised',
          },
          { projection: { _id: 1 } }
        )
        if (sup && typeof sup._id === 'number') {
          await collection.updateOne(idFilter(key), {
            $set: { supervisedOfCommand: new Double(sup._id) },
          })
          await collection.updateOne(idFilter(sup._id), {
            $set: { commandOfSupervised: new Double(key) },
          })
        }
      }
      Log.log('Tags - Created command tag: ' + point.address, Log.levelDetailed)
      return true
    } catch (e) {
      Log.log('Tags - Error inserting command tag ' + point.address + ': ' + e)
    }
    return false
  }

  private buildSupervisedDoc(point: IngestPoint): Record<string, unknown> {
    const key = this.nextKey()
    const g = deriveGroups(point.address, this.groupSep, point)
    const routed = routeValue(point.value, point.pointType)
    return {
      _id: new Double(key),
      protocolSourceASDU: '',
      protocolSourceCommonAddress: '',
      protocolSourceConnectionNumber: new Double(this.connectionNumber),
      protocolSourceObjectAddress: point.address,
      protocolSourceCommandDuration: new Double(0),
      protocolSourceCommandUseSBO: false,
      alarmState: new Double(-1.0),
      alarmRange: new Double(0.0),
      description: point.description || point.address,
      ungroupedDescription: g.ungroupedDescription,
      group1: g.group1,
      group2: g.group2,
      group3: g.group3,
      stateTextFalse: '',
      stateTextTrue: '',
      eventTextFalse: '',
      eventTextTrue: '',
      origin: 'supervised',
      tag: point.address,
      type: routed.type,
      value: new Double(routed.valueAtSource),
      valueString: routed.valueStringAtSource,
      alarmDisabled: false,
      alerted: false,
      alarmed: false,
      alertState: '',
      annotation: '',
      commandBlocked: false,
      commandOfSupervised: new Double(0.0),
      commissioningRemarks: 'Auto created by ' + AppDefs.NAME,
      formula: new Double(0.0),
      frozen: false,
      frozenDetectTimeout: new Double(0.0),
      hiLimit: new Double(Number.MAX_VALUE),
      hihiLimit: new Double(Number.MAX_VALUE),
      hihihiLimit: new Double(Number.MAX_VALUE),
      historianDeadBand: new Double(0.0),
      historianPeriod: new Double(0.0),
      hysteresis: new Double(0.0),
      invalid: point.invalid ? true : false,
      invalidDetectTimeout: new Double(60000.0),
      isEvent: point.isEvent ? true : false,
      kconv1: new Double(1.0),
      kconv2: new Double(0.0),
      location: null,
      loLimit: new Double(-Number.MAX_VALUE),
      loloLimit: new Double(-Number.MAX_VALUE),
      lololoLimit: new Double(-Number.MAX_VALUE),
      notes: '',
      overflow: false,
      parcels: null,
      priority: new Double(0.0),
      protocolDestinations: null,
      sourceDataUpdate: null,
      substituted: false,
      supervisedOfCommand: new Double(0.0),
      timeTag: null,
      timeTagAlarm: null,
      timeTagAtSource: point.timestamp ? toDate(point.timestamp) : null,
      timeTagAtSourceOk: false,
      transient: false,
      unit: point.unit || '',
      updatesCnt: new Double(0.0),
      valueDefault: new Double(0.0),
      zeroDeadband: new Double(0.0),
    }
  }

  private buildCommandDoc(point: IngestPoint, key: number): Record<string, unknown> {
    const g = deriveGroups(point.address, this.groupSep, point)
    const routed = routeValue(point.value ?? 0, point.pointType)
    return {
      _id: new Double(key),
      protocolSourceASDU: '',
      protocolSourceCommonAddress: '',
      protocolSourceConnectionNumber: new Double(this.connectionNumber),
      protocolSourceObjectAddress: point.address,
      protocolSourceCommandDuration: new Double(0),
      protocolSourceCommandUseSBO: false,
      alarmState: new Double(-1.0),
      alarmRange: new Double(0.0),
      description: point.description || point.address,
      ungroupedDescription: g.ungroupedDescription,
      group1: g.group1,
      group2: g.group2,
      group3: g.group3,
      stateTextFalse: '',
      stateTextTrue: '',
      eventTextFalse: '',
      eventTextTrue: '',
      origin: 'command',
      tag: point.address,
      type: routed.type === 'json' ? 'string' : routed.type,
      value: new Double(0),
      valueString: '',
      alarmDisabled: false,
      alerted: false,
      alarmed: false,
      alertState: '',
      annotation: '',
      commandBlocked: false,
      commandOfSupervised: new Double(0.0),
      commissioningRemarks: 'Auto created by ' + AppDefs.NAME,
      formula: new Double(0.0),
      frozen: false,
      frozenDetectTimeout: new Double(0.0),
      hiLimit: new Double(Number.MAX_VALUE),
      hihiLimit: new Double(Number.MAX_VALUE),
      hihihiLimit: new Double(Number.MAX_VALUE),
      historianDeadBand: new Double(0.0),
      historianPeriod: new Double(0.0),
      hysteresis: new Double(0.0),
      invalid: false,
      invalidDetectTimeout: new Double(0.0),
      isEvent: false,
      kconv1: new Double(1.0),
      kconv2: new Double(0.0),
      location: null,
      loLimit: new Double(-Number.MAX_VALUE),
      loloLimit: new Double(-Number.MAX_VALUE),
      lololoLimit: new Double(-Number.MAX_VALUE),
      notes: '',
      overflow: false,
      parcels: null,
      priority: new Double(0.0),
      protocolDestinations: null,
      sourceDataUpdate: null,
      substituted: false,
      supervisedOfCommand: new Double(0.0),
      timeTag: null,
      timeTagAlarm: null,
      timeTagAtSource: null,
      timeTagAtSourceOk: false,
      transient: false,
      unit: point.unit || '',
      updatesCnt: new Double(0.0),
      valueDefault: new Double(0.0),
      zeroDeadband: new Double(0.0),
    }
  }
}

// JSON-SCADA realtimeData _id values are numeric (BSON Double), not ObjectIds; this
// casts a numeric-key filter to satisfy the untyped-collection generic.
function idFilter(id: number): Filter<Document> {
  return { _id: id } as unknown as Filter<Document>
}

// Normalizes assorted timestamp encodings (ISO string, epoch seconds/ms, Date).
export function toDate(ts: string | number | Date): Date {
  if (ts instanceof Date) return ts
  if (typeof ts === 'number')
    return new Date(ts < 1e12 ? ts * 1000 : ts) // seconds vs ms heuristic
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

export default TagManager
