/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Feeds realtimeData values into the server's PointMap: full initial load, a
// change stream for live updates, and a periodic full reload for self-healing.

import type { ChangeStream, Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import type { PointMap } from './point-map.js'
import type { ModbusServerConnection } from './conn-config.js'

export class RtWatcher {
  private changeStream: ChangeStream | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private stopped = true

  constructor(
    private readonly cfg: ModbusServerConnection,
    private readonly rt: Collection,
    private readonly map: PointMap
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.fullReload()
    this.watch()
    this.reloadTimer = setInterval(() => void this.fullReload(), 5 * 60 * 1000)
  }

  stop(): void {
    this.stopped = true
    if (this.reloadTimer) clearInterval(this.reloadTimer)
    this.reloadTimer = null
    void this.changeStream?.close()
    this.changeStream = null
  }

  private query(): Record<string, unknown> {
    return {
      'protocolDestinations.protocolDestinationConnectionNumber':
        this.cfg.protocolConnectionNumber,
    }
  }

  async fullReload(): Promise<void> {
    if (this.stopped) return
    try {
      const docs = await this.rt.find(this.query()).toArray()
      const mapped = docs.map((d) => this.extract(d))
      this.map.rebuild(mapped)
    } catch (e) {
      Log.log(`${this.cfg.name}: full reload error: ${(e as Error).message}`)
    }
  }

  private extract(d: Record<string, unknown>): Parameters<PointMap['rebuild']>[0][number] {
    const dests = (d.protocolDestinations as Array<Record<string, unknown>>) ?? []
    const dest =
      dests.find(
        (x) =>
          Number(x.protocolDestinationConnectionNumber) ===
          this.cfg.protocolConnectionNumber
      ) ?? {}
    return {
      _id: d._id,
      tag: String(d.tag ?? ''),
      value: d.value,
      valueString: d.valueString,
      invalid: d.invalid,
      origin: d.origin,
      protocolSourceConnectionNumber: d.protocolSourceConnectionNumber,
      protocolSourceCommonAddress: d.protocolSourceCommonAddress,
      protocolSourceObjectAddress: d.protocolSourceObjectAddress,
      protocolSourceASDU: d.protocolSourceASDU,
      dest,
    }
  }

  private watch(): void {
    if (this.stopped) return
    try {
      const cs = this.rt.watch(
        [
          {
            $match: {
              operationType: { $in: ['update', 'replace', 'insert'] },
            },
          },
        ],
        { fullDocument: 'updateLookup' }
      )
      this.changeStream = cs
      cs.on('change', (change) => {
        const doc = (
          change as { fullDocument?: Record<string, unknown> }
        ).fullDocument
        if (!doc) return
        this.applyUpdate(doc)
      })
      cs.on('error', (err) => {
        Log.log(`${this.cfg.name}: rt change stream error: ${err}`)
        void cs.close()
        this.changeStream = null
        if (!this.stopped) setTimeout(() => this.watch(), 5000)
      })
    } catch (e) {
      Log.log(`${this.cfg.name}: rt watch failed: ${(e as Error).message}`)
      if (!this.stopped) setTimeout(() => this.watch(), 5000)
    }
  }

  private applyUpdate(doc: Record<string, unknown>): void {
    const dests = (doc.protocolDestinations as Array<Record<string, unknown>>) ?? []
    const belongs = dests.some(
      (x) =>
        Number(x.protocolDestinationConnectionNumber) ===
        this.cfg.protocolConnectionNumber
    )
    if (!belongs) return
    const point = this.map.findById(doc._id)
    if (!point) {
      // A newly-relevant tag: trigger a reload to map it.
      void this.fullReload()
      return
    }
    this.map.encodeInto(point, doc.value, doc.valueString, Boolean(doc.invalid))
  }
}
