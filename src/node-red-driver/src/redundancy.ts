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

// Port of mqtt-sparkplug/redundancy.js. Only the active node processes queues and
// binds the WS server; the standby stays connected to Mongo and takes over on
// keep-alive timeout.

import { Double, type Db, type MongoClient } from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type { DriverConfig } from './types.js'

export interface MongoStatus {
  HintMongoIsConnected: boolean
}

let ProcessActive = false
let redundancyIntervalHandle: NodeJS.Timeout | null = null
let lastActiveNodeKeepAliveTimeTag: string | null = null
let countKeepAliveNotUpdated = 0

const countKeepAliveUpdatesLimit = 4

export function ProcessStateIsActive(): boolean {
  return ProcessActive
}

export function Start(
  interval: number,
  clientMongo: MongoClient,
  db: Db,
  configObj: DriverConfig,
  mongoStatus: MongoStatus
): void {
  void ProcessRedundancy(clientMongo, db, configObj)
  if (redundancyIntervalHandle) clearInterval(redundancyIntervalHandle)
  redundancyIntervalHandle = setInterval(function () {
    if (!mongoStatus.HintMongoIsConnected) {
      ProcessActive = false
      return
    }
    void ProcessRedundancy(clientMongo, db, configObj)
  }, interval)
}

export async function ProcessRedundancy(
  clientMongo: MongoClient | null,
  db: Db | null,
  configObj: DriverConfig
): Promise<void> {
  if (!clientMongo || !db) return

  Log.levelCurrent = configObj.LogLevel
  Log.log(
    'Redundancy - Process ' + (ProcessActive ? 'Active' : 'Inactive'),
    Log.levelDetailed
  )

  try {
    const instance = await db
      .collection(configObj.ProtocolDriverInstancesCollectionName)
      .findOne({
        protocolDriver: AppDefs.NAME,
        protocolDriverInstanceNumber: configObj.Instance,
      })

    if (!instance) {
      // not found, then create and assume active
      ProcessActive = true
      Log.log('Redundancy - Instance config not found, creating one...')
      await db
        .collection(configObj.ProtocolDriverInstancesCollectionName)
        .insertOne({
          protocolDriver: AppDefs.NAME,
          protocolDriverInstanceNumber: new Double(configObj.Instance),
          enabled: true,
          logLevel: new Double(configObj.LogLevel),
          nodeNames: [],
          activeNodeName: configObj.nodeName,
          activeNodeKeepAliveTimeTag: new Date(),
        })
      return
    }

    let instKeepAliveTimeTag: string | null = null
    if (instance.activeNodeKeepAliveTimeTag instanceof Date)
      instKeepAliveTimeTag = instance.activeNodeKeepAliveTimeTag.toISOString()

    if (instance.enabled === false) {
      Log.log('Redundancy - Instance disabled, exiting...')
      process.exit(0)
    }
    if (Array.isArray(instance.nodeNames) && instance.nodeNames.length > 0) {
      if (!instance.nodeNames.includes(configObj.nodeName)) {
        Log.log('Redundancy - Node name not allowed, exiting...')
        process.exit(0)
      }
    }

    if (instance.activeNodeName === configObj.nodeName) {
      if (!ProcessActive) Log.log('Redundancy - Node activated!')
      countKeepAliveNotUpdated = 0
      ProcessActive = true
    } else {
      if (ProcessActive) {
        Log.log('Redundancy - Node deactivated!')
        countKeepAliveNotUpdated = 0
      }
      ProcessActive = false
      if (lastActiveNodeKeepAliveTimeTag === instKeepAliveTimeTag) {
        countKeepAliveNotUpdated++
        Log.log(
          'Redundancy - Keep-alive from active node not updated. ' +
            countKeepAliveNotUpdated
        )
      } else {
        countKeepAliveNotUpdated = 0
        Log.log(
          'Redundancy - Keep-alive updated by active node. Staying inactive.'
        )
      }
      lastActiveNodeKeepAliveTimeTag = instKeepAliveTimeTag
      if (countKeepAliveNotUpdated > countKeepAliveUpdatesLimit) {
        countKeepAliveNotUpdated = 0
        Log.log('Redundancy - Node activated!')
        ProcessActive = true
      }
    }

    if (ProcessActive) {
      await db
        .collection(configObj.ProtocolDriverInstancesCollectionName)
        .updateOne(
          {
            protocolDriver: AppDefs.NAME,
            protocolDriverInstanceNumber: new Double(configObj.Instance),
          },
          {
            $set: {
              activeNodeName: configObj.nodeName,
              activeNodeKeepAliveTimeTag: new Date(),
              softwareVersion: AppDefs.VERSION,
            },
          }
        )
    }
  } catch (err) {
    Log.log('Redundancy - Error: ' + err)
  }
}

export default { Start, ProcessRedundancy, ProcessStateIsActive }
