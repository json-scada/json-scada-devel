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

// Node-RED -> JSON-SCADA (control direction). A flow commands any commandable SCADA
// tag; the driver resolves the command tag and inserts into commandsQueue, applying
// the originator loop guard (never command a tag owned by this same connection).

import { Double, type Collection } from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type { Client } from './ws-server.js'
import type { ConnectionDoc } from './types.js'

export class CommandsOut {
  private conn: ConnectionDoc
  private rtCollection: Collection | null = null
  private cmdQueue: Collection | null = null
  stats = { issued: 0, rejected: 0 }

  constructor(conn: ConnectionDoc) {
    this.conn = conn
  }

  start(rtCollection: Collection, cmdQueue: Collection): void {
    this.rtCollection = rtCollection
    this.cmdQueue = cmdQueue
  }

  async handle(
    client: Client,
    ref: { tag?: string; pointKey?: number; value: unknown }
  ): Promise<void> {
    const rt = this.rtCollection
    const cq = this.cmdQueue
    if (!rt || !cq) return

    const query: Record<string, unknown> = { origin: 'command' }
    if (typeof ref.pointKey === 'number') query._id = ref.pointKey
    else if (typeof ref.tag === 'string') query.tag = ref.tag
    else {
      client.sendNow({
        type: 'commandAck',
        ok: false,
        error: 'command requires tag or pointKey',
      })
      this.stats.rejected++
      return
    }

    const element = await rt.findOne(query, {
      projection: {
        _id: 1,
        tag: 1,
        type: 1,
        origin: 1,
        kconv1: 1,
        kconv2: 1,
        commandBlocked: 1,
        protocolSourceConnectionNumber: 1,
        protocolSourceCommonAddress: 1,
        protocolSourceObjectAddress: 1,
        protocolSourceASDU: 1,
        protocolSourceCommandDuration: 1,
        protocolSourceCommandUseSBO: 1,
      },
    })

    if (!element || element.origin !== 'command') {
      client.sendNow({
        type: 'commandAck',
        ok: false,
        tag: ref.tag,
        error: 'command tag not found',
      })
      this.stats.rejected++
      return
    }

    if (element.commandBlocked === true) {
      client.sendNow({
        type: 'commandAck',
        ok: false,
        tag: element.tag as string,
        error: 'command blocked',
      })
      this.stats.rejected++
      return
    }

    // originator loop guard: refuse to command a tag owned by our own connection
    if (
      element.protocolSourceConnectionNumber ===
      this.conn.protocolConnectionNumber
    ) {
      client.sendNow({
        type: 'commandAck',
        ok: false,
        tag: element.tag as string,
        error: 'refusing to command a tag on the same connection (loop guard)',
      })
      this.stats.rejected++
      return
    }

    let value = parseFloat(String(ref.value))
    if (Number.isNaN(value)) value = ref.value ? 1 : 0
    const kconv1 = numOf(element.kconv1, 1)
    const kconv2 = numOf(element.kconv2, 0)
    value = kconv1 * value + kconv2

    const cmd = {
      protocolSourceConnectionNumber: element.protocolSourceConnectionNumber,
      protocolSourceCommonAddress: element.protocolSourceCommonAddress,
      protocolSourceObjectAddress: element.protocolSourceObjectAddress,
      protocolSourceASDU: element.protocolSourceASDU,
      protocolSourceCommandDuration: element.protocolSourceCommandDuration,
      protocolSourceCommandUseSBO: element.protocolSourceCommandUseSBO,
      pointKey: new Double(numOf(element._id, 0)),
      tag: element.tag,
      value: new Double(value),
      valueString: String(ref.value),
      valueJson: {},
      originatorUserName: AppDefs.NAME + '|' + this.conn.name,
      originatorIpAddress: client.ip,
      timeTag: new Date(),
    }

    try {
      const res = await cq.insertOne(cmd)
      if (res.acknowledged) {
        this.stats.issued++
        client.sendNow({
          type: 'commandAck',
          ok: true,
          tag: element.tag as string,
          error: null,
        })
        Log.log(
          'CommandsOut - Queued command ' + element.tag + ' = ' + value,
          Log.levelNormal
        )
      } else {
        client.sendNow({
          type: 'commandAck',
          ok: false,
          tag: element.tag as string,
          error: 'insert not acknowledged',
        })
      }
    } catch (e) {
      Log.log('CommandsOut - Error inserting command: ' + e)
      client.sendNow({
        type: 'commandAck',
        ok: false,
        tag: element.tag as string,
        error: String(e),
      })
    }
  }
}

function numOf(v: unknown, dflt: number): number {
  if (typeof v === 'number') return v
  if (v != null && typeof (v as { valueOf?: () => number }).valueOf === 'function') {
    const n = Number((v as { valueOf: () => unknown }).valueOf())
    if (Number.isFinite(n)) return n
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export default CommandsOut
