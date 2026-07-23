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

// Node-RED -> JSON-SCADA (monitoring direction). Flow values are queued and flushed
// to realtimeData.sourceDataUpdate on a bulk cycle, exactly like telegraf-listener.
// The driver never touches value/valueOk directly; cs_data_processor does the rest.

import { type Collection } from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import TagManager, { routeValue, toDate } from './tags.js'
import type { IngestPoint } from './types.js'

export class Ingest {
  private connectionNumber: number
  private autoCreateTags: boolean
  private tags: TagManager
  private queue: IngestPoint[] = []
  private timer: NodeJS.Timeout | null = null
  private collection: Collection | null = null
  stats = { received: 0, written: 0, dropped: 0 }

  constructor(
    connectionNumber: number,
    autoCreateTags: boolean,
    tags: TagManager
  ) {
    this.connectionNumber = connectionNumber
    this.autoCreateTags = autoCreateTags
    this.tags = tags
  }

  start(collection: Collection): void {
    this.collection = collection
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.drain()
    }, AppDefs.INGEST_CYCLE_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Validates and enqueues points from a client 'updates' message.
  enqueue(points: IngestPoint[]): void {
    for (const p of points) {
      if (!p || typeof p.address !== 'string' || p.address === '') continue
      if (p.address.length > AppDefs.MAX_ADDRESS_LEN) continue
      if (
        p.pointType === 'json' &&
        JSON.stringify(p.value ?? null).length > AppDefs.MAX_VALUE_JSON_BYTES
      ) {
        Log.log('Ingest - Dropping oversized json value for ' + p.address)
        this.stats.dropped++
        continue
      }
      this.queue.push(p)
      this.stats.received++
    }
  }

  private async drain(): Promise<void> {
    const collection = this.collection
    if (!collection || this.queue.length === 0) return

    const batch = this.queue
    this.queue = []
    let written = 0

    for (const point of batch) {
      try {
        if (this.autoCreateTags && !this.tags.isKnown(point.address)) {
          const ok = await this.tags.ensureSupervisedTag(collection, point)
          if (!ok) {
            this.stats.dropped++
            continue
          }
        }

        const routed = routeValue(point.value, point.pointType)
        const tsOk = point.timestampOk === true && point.timestamp !== undefined
        const updTag = {
          valueAtSource: routed.valueAtSource,
          valueStringAtSource: routed.valueStringAtSource,
          valueJsonAtSource: routed.valueJsonAtSource,
          asduAtSource: '',
          causeOfTransmissionAtSource: '3', // spontaneous
          timeTagAtSource: point.timestamp ? toDate(point.timestamp) : null,
          timeTagAtSourceOk: tsOk,
          timeTag: new Date(),
          originator: AppDefs.NAME + '|' + this.connectionNumber,
          notTopicalAtSource: false,
          invalidAtSource: point.invalid ? true : false,
          overflowAtSource: false,
          blockedAtSource: false,
          substitutedAtSource: false,
        }

        const res = await collection.updateOne(
          {
            protocolSourceConnectionNumber: this.connectionNumber,
            protocolSourceObjectAddress: point.address,
          },
          { $set: { sourceDataUpdate: updTag } }
        )
        if (res.matchedCount > 0) {
          written++
          this.stats.written++
        } else {
          this.stats.dropped++
        }
      } catch (e) {
        Log.log('Ingest - Error updating ' + point.address + ': ' + e)
        this.stats.dropped++
      }
    }

    if (written > 0)
      Log.log('Ingest - Mongo updates: ' + written, Log.levelNormal)
  }
}

export default Ingest
