/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Builds and flushes sourceDataUpdate documents to realtimeData in bulk.

import { Double, type Collection, type AnyBulkWriteOperation } from 'mongodb'
import type { ValueType } from '../core/datacodec.js'

export interface TagUpdate {
  id: unknown
  value: number | bigint | boolean | string
  valueString: string
  valueJson?: unknown
  type: ValueType
  asduLabel: string
  invalid: boolean
  cot: string // cause of transmission: "3" spontaneous, "20" integrity
}

export class RtUpdater {
  private ops: AnyBulkWriteOperation[] = []

  constructor(
    private readonly collection: Collection,
    private readonly connectionNumber: number
  ) {}

  queue(u: TagUpdate): void {
    const isAnalog =
      u.type !== 'bool' && u.type !== 'string' && u.type !== 'bitstring16'
    let valueAtSource: unknown
    if (typeof u.value === 'boolean') valueAtSource = new Double(u.value ? 1 : 0)
    else if (typeof u.value === 'bigint')
      valueAtSource = new Double(Number(u.value))
    else if (typeof u.value === 'string') valueAtSource = new Double(0)
    else valueAtSource = new Double(u.value)

    const sourceDataUpdate: Record<string, unknown> = {
      valueAtSource,
      valueStringAtSource: u.valueString,
      valueJsonAtSource: u.valueJson ?? null,
      invalidAtSource: u.invalid,
      transientAtSource: false,
      notTopicalAtSource: false,
      substitutedAtSource: false,
      blockedAtSource: false,
      overflowAtSource: false,
      timeTagAtSource: null,
      timeTagAtSourceOk: false,
      timeTag: new Date(),
      asduAtSource: u.asduLabel,
      causeOfTransmissionAtSource: u.cot,
      originator: 'MODBUS|' + this.connectionNumber,
    }
    void isAnalog

    this.ops.push({
      updateOne: {
        filter: { _id: u.id as never },
        update: { $set: { sourceDataUpdate } },
      },
    })
  }

  // Mark a set of tags invalid (link down / block read failure).
  queueInvalid(ids: unknown[]): void {
    for (const id of ids) {
      this.ops.push({
        updateOne: {
          filter: { _id: id as never },
          update: {
            $set: {
              'sourceDataUpdate.invalidAtSource': true,
              'sourceDataUpdate.timeTag': new Date(),
              'sourceDataUpdate.originator': 'MODBUS|' + this.connectionNumber,
            },
          },
        },
      })
    }
  }

  get pending(): number {
    return this.ops.length
  }

  async flush(): Promise<void> {
    if (this.ops.length === 0) return
    const batch = this.ops
    this.ops = []
    await this.collection.bulkWrite(batch, { ordered: false })
  }
}
