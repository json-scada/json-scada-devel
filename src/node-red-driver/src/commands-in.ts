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

// JSON-SCADA -> Node-RED (control direction). Watches commandsQueue for inserts owned
// by this connection (operator commands on tags a flow owns) and delivers them to
// subscribed WS clients. Flow answers with a commandResult, written back to the doc.

import {
  type ChangeStream,
  type Collection,
  type Document,
} from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type { WsServer } from './ws-server.js'
import type { ConnectionDoc } from './types.js'

export class CommandsIn {
  private conn: ConnectionDoc
  private wsServer: WsServer
  private collection: Collection | null = null
  private changeStream: ChangeStream | null = null
  stats = { delivered: 0, discarded: 0, results: 0 }

  constructor(conn: ConnectionDoc, wsServer: WsServer) {
    this.conn = conn
    this.wsServer = wsServer
  }

  start(cmdQueue: Collection): void {
    this.collection = cmdQueue
    this.startChangeStream()
  }

  stop(): void {
    if (this.changeStream) {
      void this.changeStream.close().catch(() => undefined)
      this.changeStream = null
    }
  }

  private startChangeStream(): void {
    if (!this.collection) return
    const pipeline: Document[] = [
      { $project: { documentKey: false } },
      {
        $match: {
          $and: [
            {
              'fullDocument.protocolSourceConnectionNumber': {
                $eq: this.conn.protocolConnectionNumber,
              },
            },
            { operationType: 'insert' },
          ],
        },
      },
    ]

    const cs = this.collection.watch(pipeline, { fullDocument: 'updateLookup' })
    this.changeStream = cs
    cs.on('change', (change: Document) => {
      const doc = (change as { fullDocument?: Document }).fullDocument
      if (doc) this.deliver(doc)
    })
    cs.on('error', (err) => {
      Log.log('CommandsIn - ChangeStream error: ' + err)
      this.restartLater()
    })
    cs.on('close', () =>
      Log.log('CommandsIn - ChangeStream closed', Log.levelDetailed)
    )
    Log.log('CommandsIn - ChangeStream started', Log.levelDetailed)
  }

  private restartLater(): void {
    if (this.changeStream) {
      void this.changeStream.close().catch(() => undefined)
      this.changeStream = null
    }
    setTimeout(() => {
      if (this.collection) this.startChangeStream()
    }, 5000)
  }

  private deliver(doc: Document): void {
    // freshness guard: discard stale commands
    const t = doc.timeTag instanceof Date ? doc.timeTag.getTime() : 0
    if (t > 0 && Date.now() - t > AppDefs.COMMAND_MAX_AGE_MS) {
      Log.log(
        'CommandsIn - Discarding stale command ' + doc.tag,
        Log.levelDetailed
      )
      this.stats.discarded++
      return
    }

    const address = String(doc.protocolSourceObjectAddress ?? doc.tag ?? '')
    const group1 = typeof doc.group1 === 'string' ? doc.group1 : ''
    const delivered = this.wsServer.deliverCommand(
      {
        type: 'command',
        address,
        tag: String(doc.tag ?? ''),
        value: numOf(doc.value),
        valueString: doc.valueString != null ? String(doc.valueString) : '',
        pointKey: numOf(doc.pointKey),
        timestamp:
          doc.timeTag instanceof Date
            ? doc.timeTag.toISOString()
            : new Date().toISOString(),
      },
      group1
    )

    if (delivered > 0) {
      this.stats.delivered++
      Log.log(
        'CommandsIn - Delivered command ' +
          doc.tag +
          ' to ' +
          delivered +
          ' client(s)',
        Log.levelNormal
      )
    } else {
      Log.log(
        'CommandsIn - No subscribed client for command ' + doc.tag,
        Log.levelDetailed
      )
    }
  }

  // Writes a flow's commandResult back onto the command doc (best effort feedback).
  async writeResult(pointKey?: number, tag?: string, ok?: boolean): Promise<void> {
    const cq = this.collection
    if (!cq) return
    const query: Record<string, unknown> = {}
    if (typeof pointKey === 'number') query.pointKey = pointKey
    else if (typeof tag === 'string') query.tag = tag
    else return
    try {
      await cq.updateOne(
        query,
        {
          $set: {
            ack: ok === true,
            ackTimeTag: new Date(),
            resultDescription: ok ? 'delivered to flow' : 'flow reported failure',
          },
        },
        { sort: { timeTag: -1 } }
      )
      this.stats.results++
    } catch (e) {
      Log.log('CommandsIn - Error writing command result: ' + e, Log.levelDetailed)
    }
  }
}

function numOf(v: unknown): number {
  if (typeof v === 'number') return v
  if (v != null && typeof (v as { valueOf?: () => number }).valueOf === 'function') {
    const n = Number((v as { valueOf: () => unknown }).valueOf())
    if (Number.isFinite(n)) return n
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export default CommandsIn
