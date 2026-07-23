/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Auto-creates realtimeData tags from a connection's `topics` list. Modbus has
// no browsing, so discovery is driven by operator-supplied topic descriptors:
//   "TAG_NAME|<area>:<offset>:<type[_byteorder]>[count]"
// e.g. "PLC1_FLOW|hr:4:float32_cdab"  or  "PLC1_STAT|hr:20:uint16[10]"

import { Double, type Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import { parseObjectAddress, parseAsdu, isBitArea } from '../core/address.js'
import type { ModbusClientConnection } from './conn-config.js'

interface TopicSpec {
  tag: string
  objectAddress: string // e.g. "hr:4"
  asdu: string // e.g. "float32_cdab"
  count: number
}

function parseTopic(topic: string): TopicSpec | null {
  // TAG|addrpart:type   where addrpart = area:offset
  const parts = topic.split('|')
  if (parts.length < 2) return null
  const tag = parts[0]!.trim()
  const rest = parts.slice(1).join('|').trim()
  // rest = "<area>:<offset>:<type>[count]" optionally "|byteorder"
  const bar = rest.split('|')
  let body = bar[0]!.trim()
  const orderExtra = bar[1]?.trim()

  const countMatch = /\[(\d+)\]\s*$/.exec(body)
  let count = 1
  if (countMatch) {
    count = parseInt(countMatch[1]!, 10)
    body = body.slice(0, countMatch.index).trim()
  }
  // body = area:offset:type
  const m = /^([a-zA-Z-]+:\d+):(.+)$/.exec(body)
  if (!m) return null
  let asdu = m[2]!.trim()
  if (orderExtra) asdu = asdu.includes('_') ? asdu : `${asdu}_${orderExtra}`
  return { tag, objectAddress: m[1]!, asdu, count }
}

export async function autoCreateTags(
  cfg: ModbusClientConnection,
  rt: Collection
): Promise<void> {
  const defaults = {
    byteOrder16: cfg.byteOrder16,
    byteOrder32: cfg.byteOrder32,
    byteOrder64: cfg.byteOrder64,
    byteOrderStr: cfg.byteOrderStr,
    stringEncoding: cfg.stringEncoding,
  }

  let created = 0
  for (const topic of cfg.topics) {
    const spec = parseTopic(topic)
    if (!spec) {
      Log.log(`${cfg.name}: cannot parse topic "${topic}"`)
      continue
    }
    for (let i = 0; i < spec.count; i++) {
      const tagName = spec.count > 1 ? `${spec.tag}[${i}]` : spec.tag
      const existing = await rt.findOne({ tag: tagName })
      if (existing) continue

      let addr
      try {
        addr = parseObjectAddress(spec.objectAddress, cfg.useModiconAddresses)
        parseAsdu(spec.asdu, addr.area, defaults) // validate
      } catch (e) {
        Log.log(`${cfg.name}: invalid topic "${topic}": ${(e as Error).message}`)
        break
      }
      // offset the address for array elements by the value width
      const parsedAsdu = parseAsdu(spec.asdu, addr.area, defaults)
      const step = isBitArea(addr.area) ? 1 : Math.max(1, parsedAsdu.regCount)
      const objectAddress = `${addr.area}:${addr.offset + i * step}`
      const isDigital = isBitArea(addr.area) || parsedAsdu.type === 'bool'
      const isString = parsedAsdu.type === 'string'

      const key = await nextKey(rt)
      await rt.insertOne(
        buildTagDoc({
          key,
          tag: tagName,
          connectionNumber: cfg.protocolConnectionNumber,
          connectionName: cfg.name,
          objectAddress,
          asdu: spec.asdu,
          commonAddress: 1,
          type: isDigital ? 'digital' : isString ? 'string' : 'analog',
        })
      )
      created++
    }
  }
  if (created > 0) Log.log(`${cfg.name}: auto-created ${created} tags`)
}

async function nextKey(rt: Collection): Promise<number> {
  const top = await rt.find().sort({ _id: -1 }).limit(1).toArray()
  const max = top.length ? Number(top[0]!._id) : 0
  return max + 1
}

function buildTagDoc(p: {
  key: number
  tag: string
  connectionNumber: number
  connectionName: string
  objectAddress: string
  asdu: string
  commonAddress: number
  type: 'analog' | 'digital' | 'string'
}): Record<string, unknown> {
  const now = new Date()
  return {
    _id: new Double(p.key),
    tag: p.tag,
    type: p.type,
    origin: 'supervised',
    description: p.connectionName + '~' + p.tag,
    ungroupedDescription: p.tag,
    group1: p.connectionName,
    group2: '',
    group3: '',
    protocolSourceConnectionNumber: new Double(p.connectionNumber),
    protocolSourceCommonAddress: new Double(p.commonAddress),
    protocolSourceObjectAddress: p.objectAddress,
    protocolSourceASDU: p.asdu,
    protocolSourceCommandDuration: new Double(0),
    protocolSourceCommandUseSBO: false,
    kconv1: new Double(1),
    kconv2: new Double(0),
    value: new Double(0),
    valueString: '',
    valueDefault: new Double(0),
    invalid: true,
    isEvent: p.type === 'digital',
    enabled: true,
    commandOfSupervised: new Double(0),
    supervisedOfCommand: new Double(0),
    timeTag: now,
    alarmDisabled: false,
    hiLimit: null,
    loLimit: null,
    stateTextFalse: '',
    stateTextTrue: '',
    unit: '',
    priority: new Double(0),
  }
}
